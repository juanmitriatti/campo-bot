/**
 * animal.repository.ts — SQL de la capa individual (`animals`,
 * `animal_identifications`, `animal_events`).
 *
 * REGLAS DE ESTE ARCHIVO
 *
 * 1. TODO es bulk-first. El caso de uso central es "el productor escaneó 87
 *    caravanas": resolverlas con 87 queries es inaceptable. Se resuelve con UNA
 *    (`= ANY($1::text[])`), y mover N animales son 2 statements, no 2N.
 *
 * 2. Todo filtra por `user_id` Y por campo accesible. Un id que viene del
 *    cliente nunca se usa tal cual: se re-scopea en el WHERE.
 *
 * 3. Usa el `pool` compartido, nunca abre conexión propia. Con el hijack de
 *    AsyncLocalStorage de `config/db.js` eso lo enlista solo en el
 *    `withTransaction` activo (y un BEGIN anidado se vuelve SAVEPOINT).
 *
 * 4. `livestock_groups.individualized_count` se mantiene en la MISMA
 *    transacción que cualquier cambio de `group_id`/`status`. Si se desincroniza,
 *    lo detecta la reconciliación — pero el camino normal no debe desincronizarlo.
 */

import { pool } from '../../config/db.js';
import { accessibleFieldsSql } from '../shared/accessible-fields.js';
import { normalizeAnimalId, parseAnimalId } from '../../utils/animal-id.js';
import type { LivestockCategory } from './livestock.types.js';
import type {
  AnimalRow,
  AnimalIdentificationRow,
  AnimalEventRow,
  AnimalEventType,
  AnimalSex,
  AnimalSource,
  AnimalStatus,
  AnimalIdType,
  IdentificationResolution,
} from './animal.types.js';

/** SELECT base de animal con los nombres de ubicación, raza e identificadores vigentes. */
const ANIMAL_SELECT = `
  SELECT a.*,
         f.name AS field_name,
         p.name AS plot_name,
         c.name AS corral_name,
         b.name AS breed_name,
         (SELECT ai.value FROM animal_identifications ai
           WHERE ai.animal_id = a.id AND ai.is_current AND ai.id_type = 'rfid'
           ORDER BY ai.assigned_date DESC LIMIT 1) AS current_rfid,
         (SELECT ai.value FROM animal_identifications ai
           WHERE ai.animal_id = a.id AND ai.is_current AND ai.id_type = 'caravana_visual'
           ORDER BY ai.assigned_date DESC LIMIT 1) AS current_visual_tag
    FROM animals a
    LEFT JOIN fields  f ON a.field_id  = f.id
    LEFT JOIN plots   p ON a.plot_id   = p.id
    LEFT JOIN corrals c ON a.corral_id = c.id
    LEFT JOIN livestock_breeds b ON a.breed_id = b.id`;

export interface AnimalFilters {
  status?: AnimalStatus;
  category?: LivestockCategory;
  sex?: AnimalSex;
  breedId?: number;
  fieldId?: number;
  plotId?: number;
  corralId?: number;
  groupId?: string;
  /** true = solo con identificación vigente; false = solo sin ninguna. */
  identified?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateAnimalInput {
  userId: number;
  category: LivestockCategory;
  sex: AnimalSex;
  fieldId?: number | null;
  plotId?: number | null;
  corralId?: number | null;
  groupId?: string | null;
  breedId?: number | null;
  breedText?: string | null;
  birthDate?: string | null;
  origin?: string | null;
  entryDate?: string | null;
  motherAnimalId?: string | null;
  notes?: string | null;
  source?: AnimalSource;
  createdBy?: number | null;
}

export class AnimalRepository {
  // ========================
  // LECTURA
  // ========================

  async findById(userId: number, animalId: string): Promise<AnimalRow | null> {
    const { rows } = await pool.query(
      `${ANIMAL_SELECT}
        WHERE a.id = $2 AND a.user_id = $1 AND a.deleted_at IS NULL`,
      [userId, animalId],
    );
    return rows[0] ?? null;
  }

  /**
   * Resuelve UNA lectura a un animal. Acepta el CII de 15 dígitos, el NII de 10
   * suelto (lo que muestra la caravana cinta en machos) y la caravana visual.
   */
  async findByIdentifier(userId: number, rawValue: string): Promise<AnimalRow | null> {
    const found = await this.resolveIdentifiers(userId, [rawValue]);
    return found.get(normalizeAnimalId(rawValue)) ?? null;
  }

  /**
   * EL camino caliente: N identificadores → N animales en UNA query.
   *
   * Devuelve un Map indexado por el valor normalizado. El NII de 10 dígitos se
   * busca también como CII completo (`032` + `01` + NII) y viceversa, porque el
   * mismo animal puede haber sido cargado en cualquiera de las dos formas.
   */
  async resolveIdentifiers(userId: number, rawValues: string[]): Promise<Map<string, AnimalRow>> {
    const result = new Map<string, AnimalRow>();
    if (rawValues.length === 0) return result;

    // Cada lectura puede buscarse por más de una forma; se arma la lista de
    // candidatos y un índice inverso para devolver el resultado bajo la forma
    // que pidió el llamador.
    const lookupToRequested = new Map<string, string>();
    const candidates: string[] = [];
    for (const raw of rawValues) {
      const normalized = normalizeAnimalId(raw);
      if (!normalized) continue;
      const parsed = parseAnimalId(raw);
      const forms = new Set<string>([normalized]);
      if (parsed.nii) {
        forms.add(parsed.nii);
        forms.add(`032${parsed.speciesCode ?? '01'}${parsed.nii}`);
      }
      for (const f of forms) {
        if (!lookupToRequested.has(f)) lookupToRequested.set(f, normalized);
        candidates.push(f);
      }
    }
    if (candidates.length === 0) return result;

    const { rows } = await pool.query(
      `${ANIMAL_SELECT}
         WHERE a.user_id = $1
           AND a.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM animal_identifications ai
              WHERE ai.animal_id = a.id
                AND ai.is_current
                AND ai.value_normalized = ANY($2::text[])
           )`,
      [userId, candidates],
    );

    // Se re-mapea cada fila a TODAS las formas pedidas que la alcanzan.
    const idsByAnimal = await this.currentIdentifierValues(rows.map((r: AnimalRow) => r.id));
    for (const row of rows as AnimalRow[]) {
      for (const value of idsByAnimal.get(row.id) ?? []) {
        const requested = lookupToRequested.get(value);
        if (requested) result.set(requested, row);
      }
    }
    return result;
  }

  /** Valores normalizados vigentes de cada animal, para el remapeo del lookup. */
  private async currentIdentifierValues(animalIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (animalIds.length === 0) return out;
    const { rows } = await pool.query(
      `SELECT animal_id, value_normalized FROM animal_identifications
        WHERE animal_id = ANY($1::uuid[]) AND is_current`,
      [animalIds],
    );
    for (const r of rows as Array<{ animal_id: string; value_normalized: string }>) {
      const list = out.get(r.animal_id);
      if (list) list.push(r.value_normalized);
      else out.set(r.animal_id, [r.value_normalized]);
    }
    return out;
  }

  /**
   * WHERE + params compartidos por `listAnimals` y `countAnimals`. Compartirlos
   * no es cosmético: si divergen, el total y las filas de la página dejan de
   * corresponderse y la paginación miente.
   */
  private buildAnimalWhere(userId: number, filters: AnimalFilters): { where: string; params: Array<string | number | boolean> } {
    const params: Array<string | number | boolean> = [userId];
    let where = `a.user_id = $1 AND a.deleted_at IS NULL
                 AND (a.field_id IS NULL OR a.field_id IN (${accessibleFieldsSql(1)}))`;

    const add = (sql: string, value: string | number | boolean) => {
      params.push(value);
      where += ` AND ${sql.replace('$?', `$${params.length}`)}`;
    };

    if (filters.status) add('a.status = $?', filters.status);
    if (filters.category) add('a.category = $?', filters.category);
    if (filters.sex) add('a.sex = $?', filters.sex);
    if (filters.breedId) add('a.breed_id = $?', filters.breedId);
    if (filters.fieldId) add('a.field_id = $?', filters.fieldId);
    if (filters.plotId) add('a.plot_id = $?', filters.plotId);
    if (filters.corralId) add('a.corral_id = $?', filters.corralId);
    if (filters.groupId) add('a.group_id = $?', filters.groupId);
    if (filters.identified === true) {
      where += ` AND EXISTS (SELECT 1 FROM animal_identifications ai WHERE ai.animal_id = a.id AND ai.is_current)`;
    } else if (filters.identified === false) {
      where += ` AND NOT EXISTS (SELECT 1 FROM animal_identifications ai WHERE ai.animal_id = a.id AND ai.is_current)`;
    }

    return { where, params };
  }

  async listAnimals(userId: number, filters: AnimalFilters = {}): Promise<AnimalRow[]> {
    const { where, params } = this.buildAnimalWhere(userId, filters);

    // El id desempata: sin él dos animales creados en el mismo instante pueden
    // alternar de página y uno se repite mientras otro se pierde.
    let sql = `${ANIMAL_SELECT} WHERE ${where} ORDER BY a.created_at DESC, a.id DESC`;
    if (filters.limit != null) {
      params.push(filters.limit);
      sql += ` LIMIT $${params.length}`;
      if (filters.offset) {
        params.push(filters.offset);
        sql += ` OFFSET $${params.length}`;
      }
    }

    const { rows } = await pool.query(sql, params);
    return rows;
  }

  /** COUNT real en la base. Traer todas las filas para medir su largo no escala a 100k animales. */
  async countAnimals(userId: number, filters: AnimalFilters = {}): Promise<number> {
    const { where, params } = this.buildAnimalWhere(userId, filters);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM animals a WHERE ${where}`,
      params,
    );
    return rows[0].n;
  }

  // ========================
  // ESCRITURA — animales
  // ========================

  async createAnimal(input: CreateAnimalInput): Promise<AnimalRow> {
    const { rows } = await pool.query(
      `INSERT INTO animals
         (user_id, field_id, plot_id, corral_id, group_id, category, sex,
          breed_id, breed_text, birth_date, origin, entry_date,
          mother_animal_id, notes, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::date, CURRENT_DATE),$13,$14,$15,$16)
       RETURNING *`,
      [
        input.userId,
        input.fieldId ?? null,
        input.plotId ?? null,
        input.corralId ?? null,
        input.groupId ?? null,
        input.category,
        input.sex,
        input.breedId ?? null,
        input.breedText ?? null,
        input.birthDate ?? null,
        input.origin ?? null,
        input.entryDate ?? null,
        input.motherAnimalId ?? null,
        input.notes ?? null,
        input.source ?? 'manual',
        input.createdBy ?? input.userId,
      ],
    );
    if (input.groupId) await this.recountGroup(input.groupId);
    return rows[0];
  }

  /**
   * Recalcula `individualized_count` de un grupo desde la verdad (las filas de
   * `animals`). Se llama dentro de la misma transacción que el cambio, así que
   * el contador nunca queda a mitad de camino. Es un recount, no un `+1`: un
   * incremento se pierde ante cualquier camino que no lo llame.
   */
  async recountGroup(groupId: string): Promise<void> {
    await pool.query(
      `UPDATE livestock_groups lg
          SET individualized_count = (
                SELECT COUNT(*) FROM animals a
                 WHERE a.group_id = lg.id AND a.deleted_at IS NULL AND a.status = 'activo'
              ),
              updated_at = NOW()
        WHERE lg.id = $1`,
      [groupId],
    );
  }

  async recountGroups(groupIds: Array<string | null | undefined>): Promise<void> {
    const ids = [...new Set(groupIds.filter((g): g is string => !!g))];
    if (ids.length === 0) return;
    await pool.query(
      `UPDATE livestock_groups lg
          SET individualized_count = (
                SELECT COUNT(*) FROM animals a
                 WHERE a.group_id = lg.id AND a.deleted_at IS NULL AND a.status = 'activo'
              ),
              updated_at = NOW()
        WHERE lg.id = ANY($1::uuid[])`,
      [ids],
    );
  }

  /**
   * Mueve N animales a una ubicación/grupo en 2 statements. Devuelve los grupos
   * afectados (origen y destino) para que el llamador recuente.
   */
  async relocateAnimals(
    userId: number,
    animalIds: string[],
    dest: { fieldId?: number | null; plotId?: number | null; corralId?: number | null; groupId?: string | null; category?: LivestockCategory },
  ): Promise<{ moved: number; affectedGroupIds: string[] }> {
    if (animalIds.length === 0) return { moved: 0, affectedGroupIds: [] };

    const { rows: before } = await pool.query(
      `SELECT DISTINCT group_id FROM animals
        WHERE id = ANY($1::uuid[]) AND user_id = $2 AND deleted_at IS NULL`,
      [animalIds, userId],
    );

    const { rows: moved } = await pool.query(
      `UPDATE animals
          SET field_id = $3, plot_id = $4, corral_id = $5, group_id = $6,
              category = COALESCE($7::livestock_category, category),
              updated_at = NOW()
        WHERE id = ANY($1::uuid[])
          AND user_id = $2
          AND deleted_at IS NULL
          AND status = 'activo'
        RETURNING id`,
      [
        animalIds, userId,
        dest.fieldId ?? null, dest.plotId ?? null, dest.corralId ?? null,
        dest.groupId ?? null, dest.category ?? null,
      ],
    );

    const affected = [
      ...before.map((r: { group_id: string | null }) => r.group_id),
      dest.groupId ?? null,
    ].filter((g): g is string => !!g);

    await this.recountGroups(affected);
    return { moved: moved.length, affectedGroupIds: [...new Set(affected)] };
  }

  /** Cambia el estado de N animales (venta, muerte, extravío). */
  async setStatus(
    userId: number,
    animalIds: string[],
    status: AnimalStatus,
    exitDate?: string | null,
  ): Promise<{ updated: number; affectedGroupIds: string[] }> {
    if (animalIds.length === 0) return { updated: 0, affectedGroupIds: [] };

    const { rows } = await pool.query(
      // `$3` se castea explícitamente: sin el cast Postgres lo deduce como
      // animal_status en el SET y como text en el IN, y falla con
      // "inconsistent types deduced for parameter $3".
      `UPDATE animals
          SET status = $3::animal_status,
              exit_date = CASE WHEN $3::animal_status IN ('vendido','muerto','transferido')
                               THEN COALESCE($4::date, CURRENT_DATE) ELSE NULL END,
              updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND user_id = $2 AND deleted_at IS NULL
        RETURNING id, group_id`,
      [animalIds, userId, status, exitDate ?? null],
    );

    const affected = rows
      .map((r: { group_id: string | null }) => r.group_id)
      .filter((g: string | null): g is string => !!g);
    await this.recountGroups(affected);
    return { updated: rows.length, affectedGroupIds: [...new Set(affected)] };
  }

  // ========================
  // IDENTIFICACIONES
  // ========================

  async listIdentifications(userId: number, animalId: string): Promise<AnimalIdentificationRow[]> {
    const { rows } = await pool.query(
      `SELECT * FROM animal_identifications
        WHERE animal_id = $2 AND user_id = $1
        ORDER BY assigned_date DESC, created_at DESC`,
      [userId, animalId],
    );
    return rows;
  }

  /** ¿Este valor ya está vigente en el padrón del usuario? Para detectar duplicados ANTES de insertar. */
  async findCurrentIdentification(
    userId: number, idType: AnimalIdType, valueNormalized: string,
  ): Promise<AnimalIdentificationRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM animal_identifications
        WHERE user_id = $1 AND id_type = $2 AND value_normalized = $3
          AND is_current AND removed_date IS NULL
        LIMIT 1`,
      [userId, idType, valueNormalized],
    );
    return rows[0] ?? null;
  }

  async insertIdentification(input: {
    userId: number;
    animalId: string;
    idType: AnimalIdType;
    value: string;
    valueNormalized: string;
    deviceType?: string | null;
    assignedDate?: string | null;
    replacesId?: string | null;
    source?: AnimalSource;
    notes?: string | null;
    createdBy?: number | null;
  }): Promise<AnimalIdentificationRow> {
    const { rows } = await pool.query(
      `INSERT INTO animal_identifications
         (user_id, animal_id, id_type, device_type, value, value_normalized,
          assigned_date, replaces_identification_id, source, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date, CURRENT_DATE),$8,$9,$10,$11)
       RETURNING *`,
      [
        input.userId, input.animalId, input.idType, input.deviceType ?? null,
        input.value, input.valueNormalized, input.assignedDate ?? null,
        input.replacesId ?? null, input.source ?? 'manual', input.notes ?? null,
        input.createdBy ?? input.userId,
      ],
    );
    return rows[0];
  }

  /**
   * Retira una identificación vigente. NO borra la fila: el historial de
   * identificaciones es el activo regulatorio (Res. 841/2025 Art. 11(d) exige
   * poder referenciar el número anterior).
   */
  async retireIdentification(
    userId: number, identificationId: string, reason: string, removedDate?: string | null,
  ): Promise<void> {
    await pool.query(
      `UPDATE animal_identifications
          SET is_current = FALSE,
              removed_date = COALESCE($4::date, CURRENT_DATE),
              removal_reason = $3
        WHERE id = $2 AND user_id = $1 AND is_current`,
      [userId, identificationId, reason, removedDate ?? null],
    );
  }

  // ========================
  // EVENTOS
  // ========================

  /**
   * Inserta N eventos individuales de una vez. Se usa para expandir un hecho
   * agregado (una vacunación de 50 vacas) a los animales que participaron: 1
   * INSERT, no 50.
   */
  async insertEvents(events: Array<{
    userId: number;
    animalId: string;
    eventType: AnimalEventType;
    eventDate?: string | null;
    domainEventId?: number | null;
    livestockMovementId?: string | null;
    numericValue?: number | null;
    textValue?: string | null;
    unit?: string | null;
    fromRef?: string | null;
    toRef?: string | null;
    relatedAnimalId?: string | null;
    source?: AnimalSource;
    notes?: string | null;
    createdBy?: number | null;
  }>): Promise<number> {
    if (events.length === 0) return 0;

    const cols = 14;
    const values: unknown[] = [];
    const tuples = events.map((e, i) => {
      const b = i * cols;
      values.push(
        e.userId, e.animalId, e.eventType, e.eventDate ?? null,
        e.domainEventId ?? null, e.livestockMovementId ?? null,
        e.numericValue ?? null, e.textValue ?? null, e.unit ?? null,
        e.fromRef ?? null, e.toRef ?? null, e.relatedAnimalId ?? null,
        e.source ?? 'manual', e.createdBy ?? e.userId,
      );
      return `($${b + 1},$${b + 2},$${b + 3},COALESCE($${b + 4}::date, CURRENT_DATE),` +
             `$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14})`;
    });

    const { rowCount } = await pool.query(
      `INSERT INTO animal_events
         (user_id, animal_id, event_type, event_date, domain_event_id,
          livestock_movement_id, numeric_value, text_value, unit,
          from_ref, to_ref, related_animal_id, source, created_by)
       VALUES ${tuples.join(',')}`,
      values,
    );
    return rowCount ?? 0;
  }

  /**
   * Línea de tiempo de un animal, paginada por keyset. `before` es el
   * `{event_date, id}` del último item de la página anterior.
   */
  async getTimeline(
    userId: number,
    animalId: string,
    opts: { limit?: number; beforeDate?: string; beforeId?: string } = {},
  ): Promise<AnimalEventRow[]> {
    const params: Array<string | number> = [userId, animalId];
    let where = `ae.user_id = $1 AND ae.animal_id = $2 AND ae.deleted_at IS NULL`;

    if (opts.beforeDate && opts.beforeId) {
      params.push(opts.beforeDate, opts.beforeId);
      where += ` AND (ae.event_date, ae.id) < ($${params.length - 1}::date, $${params.length}::uuid)`;
    }
    params.push(opts.limit ?? 50);

    const { rows } = await pool.query(
      `SELECT ae.* FROM animal_events ae
        WHERE ${where}
        ORDER BY ae.event_date DESC, ae.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  /** Pesajes individuales ordenados, para calcular GDP. */
  async getWeighings(userId: number, animalId: string, limit = 50): Promise<AnimalEventRow[]> {
    const { rows } = await pool.query(
      `SELECT * FROM animal_events
        WHERE user_id = $1 AND animal_id = $2
          AND event_type = 'pesaje' AND deleted_at IS NULL
          AND numeric_value IS NOT NULL
        ORDER BY event_date DESC, id DESC
        LIMIT $3`,
      [userId, animalId, limit],
    );
    return rows;
  }

  // ========================
  // CONSISTENCIA
  // ========================

  /**
   * Grupos donde `count` (agregado) y la cantidad de animales individuales no
   * cuadran. Es ADVISORY: el modelo híbrido permite grupos parcialmente
   * individualizados, así que solo se reporta el EXCESO (más individuales que
   * cabezas declaradas), que sí es siempre un error.
   */
  async findGroupCountDiscrepancies(userId: number): Promise<Array<{
    group_id: string; declared: number; individual: number;
    category: string; field_name: string | null; plot_name: string | null; corral_name: string | null;
  }>> {
    const { rows } = await pool.query(
      `SELECT lg.id AS group_id, lg.count AS declared,
              COUNT(a.id)::int AS individual, lg.category::text AS category,
              f.name AS field_name, p.name AS plot_name, c.name AS corral_name
         FROM livestock_groups lg
         LEFT JOIN animals a
                ON a.group_id = lg.id AND a.deleted_at IS NULL AND a.status = 'activo'
         LEFT JOIN fields  f ON lg.field_id  = f.id
         LEFT JOIN plots   p ON lg.plot_id   = p.id
         LEFT JOIN corrals c ON lg.corral_id = c.id
        WHERE lg.user_id = $1 AND lg.deleted_at IS NULL
        GROUP BY lg.id, lg.count, lg.category, f.name, p.name, c.name
       HAVING COUNT(a.id) > lg.count`,
      [userId],
    );
    return rows;
  }

  /**
   * Animales con estado terminal (vendido/muerto/transferido) que registraron un
   * evento POSTERIOR a su salida. Un animal muerto que se mueve es un dato
   * imposible que hay que poder investigar.
   *
   * Solo cuentan los eventos que implican que al animal se lo TRABAJÓ. Su propia
   * contabilidad (identificación, ingreso, nacimiento) y los egresos quedan
   * afuera a propósito: dar de alta un animal hoy y fechar su venta en mayo es
   * carga retroactiva legítima, y reportarla dispararía en el uso normal.
   */
  async findEventsAfterExit(userId: number): Promise<Array<{
    animal_id: string; status: string; exit_date: Date; event_type: string; event_date: Date;
  }>> {
    const { rows } = await pool.query(
      `SELECT a.id AS animal_id, a.status::text, a.exit_date,
              ae.event_type::text, ae.event_date
         FROM animals a
         JOIN animal_events ae ON ae.animal_id = a.id AND ae.deleted_at IS NULL
        WHERE a.user_id = $1
          AND a.deleted_at IS NULL
          AND a.status IN ('vendido','muerto','transferido')
          AND a.exit_date IS NOT NULL
          AND ae.event_date > a.exit_date
          AND ae.event_type IN (
            'movimiento','cambio_grupo','cambio_categoria','cambio_establecimiento',
            'vacunacion','desparasitacion','tratamiento','revision_sanitaria',
            'pesaje','condicion_corporal',
            'servicio','inseminacion','diagnostico_prenez','parto','destete'
          )
        ORDER BY ae.event_date DESC
        LIMIT 100`,
      [userId],
    );
    return rows;
  }

  /** Recuenta TODOS los grupos del usuario. Reconciliación, no camino caliente. */
  async reconcileAllGroups(userId: number): Promise<number> {
    const { rowCount } = await pool.query(
      `UPDATE livestock_groups lg
          SET individualized_count = sub.n, updated_at = NOW()
         FROM (
           SELECT lg2.id, COUNT(a.id)::int AS n
             FROM livestock_groups lg2
             LEFT JOIN animals a
                    ON a.group_id = lg2.id AND a.deleted_at IS NULL AND a.status = 'activo'
            WHERE lg2.user_id = $1 AND lg2.deleted_at IS NULL
            GROUP BY lg2.id
         ) sub
        WHERE lg.id = sub.id AND lg.individualized_count IS DISTINCT FROM sub.n`,
      [userId],
    );
    return rowCount ?? 0;
  }

  // ========================
  // RESOLUCIÓN DE LOTES DE LECTURA
  // ========================

  /**
   * Clasifica una lista cruda de lecturas en matched / unknown / invalid /
   * duplicates. Las cuatro categorías son disjuntas y suman `rawCount`: el
   * productor tiene que poder cuadrar "leí 90, encontré 87" sin adivinar dónde
   * fueron los otros 3.
   */
  async resolveBatch(userId: number, rawValues: string[]): Promise<IdentificationResolution> {
    const res: IdentificationResolution = {
      matched: [], unknown: [], invalid: [], duplicates: [], rawCount: rawValues.length,
    };

    const seen = new Set<string>();
    const toLookup: string[] = [];

    for (const raw of rawValues) {
      const parsed = parseAnimalId(raw);
      if (!parsed.normalized || parsed.normalized.length < 4) {
        res.invalid.push({ value: raw, reason: parsed.warning ?? 'Identificador demasiado corto.' });
        continue;
      }
      if (seen.has(parsed.normalized)) {
        res.duplicates.push(parsed.normalized);
        continue;
      }
      seen.add(parsed.normalized);
      toLookup.push(parsed.normalized);
    }

    const found = await this.resolveIdentifiers(userId, toLookup);
    for (const value of toLookup) {
      const animal = found.get(value);
      if (animal) res.matched.push({ value, animal });
      else res.unknown.push(value);
    }
    return res;
  }
}
