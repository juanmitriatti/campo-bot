/**
 * animal.service.ts — reglas de negocio de la capa individual.
 *
 * PRINCIPIO RECTOR (el que hace que todo esto sea seguro):
 *   El camino por grupos NUNCA depende del camino individual.
 *   Un grupo con 0 animales individualizados se comporta exactamente como antes
 *   de que esta capa existiera. Todo lo de acá es aditivo.
 *
 * Consecuencia práctica: este servicio jamás toca `livestock_groups.count`. Esa
 * columna sigue siendo la proyección del ledger de movimientos y su único dueño
 * sigue siendo `LivestockRepository`. Lo único que este servicio mantiene es
 * `individualized_count`, que es un dato NUEVO y no participa de ninguna
 * decisión vieja.
 */

import { withTransaction } from '../../config/db.js';
import { AnimalRepository, type CreateAnimalInput, type AnimalFilters } from './animal.repository.js';
import { normalizeAnimalId, parseAnimalId } from '../../utils/animal-id.js';
import { normalizeBreed } from '../../utils/livestock-breeds.js';
import { LIVESTOCK_CATEGORY_LABEL, type LivestockCategory } from './livestock.types.js';
import {
  CATEGORY_SEX,
  TERMINAL_STATUSES,
  type AnimalRow,
  type AnimalIdentificationRow,
  type AnimalEventRow,
  type AnimalSex,
  type AnimalSource,
  type AnimalStatus,
  type AnimalIdType,
  type IdentificationResolution,
} from './animal.types.js';

export interface RegisterAnimalInput {
  userId: number;
  category: LivestockCategory;
  sex?: AnimalSex | null;
  rfid?: string | null;
  visualTag?: string | null;
  breed?: string | null;
  birthDate?: string | null;
  fieldId?: number | null;
  plotId?: number | null;
  corralId?: number | null;
  groupId?: string | null;
  origin?: string | null;
  entryDate?: string | null;
  motherAnimalId?: string | null;
  notes?: string | null;
  source?: AnimalSource;
  createdBy?: number | null;
}

export interface RegisterAnimalResult {
  animal: AnimalRow;
  identifications: AnimalIdentificationRow[];
  /** Observaciones no bloqueantes (formato raro, país extranjero). El alta igual se hizo. */
  warnings: string[];
}

export class DuplicateIdentifierError extends Error {
  constructor(public readonly value: string, public readonly existingAnimalId: string) {
    super(`El identificador ${value} ya está asignado a otro animal.`);
    this.name = 'DuplicateIdentifierError';
  }
}

export class AnimalService {
  constructor(private readonly repo: AnimalRepository = new AnimalRepository()) {}

  // ========================
  // ALTA E IDENTIFICACIÓN
  // ========================

  /**
   * Da de alta un animal individual y le asigna sus identificadores.
   *
   * Todo en una transacción: un animal sin su caravana es peor que ningún
   * animal — queda un registro fantasma que nadie puede encontrar después.
   */
  async registerAnimal(input: RegisterAnimalInput): Promise<RegisterAnimalResult> {
    const warnings: string[] = [];

    // El sexo se deriva de la categoría (vaca→H, novillo→M). Pedírselo al
    // usuario sería redundante: la categoría del rodeo argentino ya lo codifica.
    const sex: AnimalSex = input.sex ?? CATEGORY_SEX[input.category];

    const breedDef = normalizeBreed(input.breed);
    if (input.breed && !breedDef) {
      warnings.push(`No reconocí la raza «${input.breed}» — la guardé tal cual.`);
    }

    return withTransaction(async () => {
      // Los duplicados se chequean ANTES de insertar para poder dar un mensaje
      // útil ("ya es del animal X") en vez de un error de constraint.
      const pending: Array<{ idType: AnimalIdType; raw: string }> = [];
      if (input.rfid) pending.push({ idType: 'rfid', raw: input.rfid });
      if (input.visualTag) pending.push({ idType: 'caravana_visual', raw: input.visualTag });

      for (const p of pending) {
        const parsed = parseAnimalId(p.raw);
        const existing = await this.repo.findCurrentIdentification(input.userId, p.idType, parsed.normalized);
        if (existing) throw new DuplicateIdentifierError(parsed.normalized, existing.animal_id);
        if (parsed.warning) warnings.push(parsed.warning);
      }

      const animal = await this.repo.createAnimal({
        userId: input.userId,
        category: input.category,
        sex,
        fieldId: input.fieldId ?? null,
        plotId: input.plotId ?? null,
        corralId: input.corralId ?? null,
        groupId: input.groupId ?? null,
        breedId: breedDef ? await this.breedIdFor(breedDef.code) : null,
        breedText: input.breed ?? null,
        birthDate: input.birthDate ?? null,
        origin: input.origin ?? 'alta_manual',
        entryDate: input.entryDate ?? null,
        motherAnimalId: input.motherAnimalId ?? null,
        notes: input.notes ?? null,
        source: input.source ?? 'manual',
        createdBy: input.createdBy ?? input.userId,
      } satisfies CreateAnimalInput);

      const identifications: AnimalIdentificationRow[] = [];
      for (const p of pending) {
        const parsed = parseAnimalId(p.raw);
        // Un valor que no parsea a lo esperado se guarda igual, con el tipo que
        // el parser dedujo. El sistema registra, no bloquea.
        const idType: AnimalIdType = p.idType === 'rfid' ? parsed.idType : 'caravana_visual';
        identifications.push(await this.repo.insertIdentification({
          userId: input.userId,
          animalId: animal.id,
          idType,
          value: p.raw,
          valueNormalized: parsed.normalized,
          source: input.source ?? 'manual',
          createdBy: input.createdBy ?? input.userId,
        }));
      }

      if (identifications.length > 0) {
        await this.repo.insertEvents(identifications.map((ident) => ({
          userId: input.userId,
          animalId: animal.id,
          eventType: 'identificacion' as const,
          textValue: ident.value,
          toRef: ident.id_type,
          source: input.source ?? 'manual',
          createdBy: input.createdBy ?? input.userId,
        })));
      }

      await this.repo.insertEvents([{
        userId: input.userId,
        animalId: animal.id,
        eventType: input.origin === 'nacimiento' ? 'nacimiento' : 'ingreso',
        eventDate: input.entryDate ?? null,
        textValue: input.origin ?? 'alta_manual',
        source: input.source ?? 'manual',
        createdBy: input.createdBy ?? input.userId,
      }]);

      const fresh = await this.repo.findById(input.userId, animal.id);
      return { animal: fresh ?? animal, identifications, warnings };
    });
  }

  /**
   * Reemplaza la identificación de un animal conservando el historial.
   *
   * Res. SENASA 841/2025 Art. 11: perder el componente electrónico obliga a
   * sustituir el binomio, y 11(d) exige que la nueva identificación referencie
   * la anterior. Por eso la vieja se RETIRA (`is_current=false` + motivo) y la
   * nueva apunta a ella con `replaces_identification_id`. Nunca se borra ni se
   * pisa: ese encadenamiento ES la trazabilidad.
   */
  async replaceIdentification(input: {
    userId: number;
    animalId: string;
    newValue: string;
    idType?: AnimalIdType;
    reason?: string;
    deviceType?: string | null;
    source?: AnimalSource;
    createdBy?: number | null;
  }): Promise<{ retired: AnimalIdentificationRow | null; created: AnimalIdentificationRow; warnings: string[] }> {
    const warnings: string[] = [];
    const parsed = parseAnimalId(input.newValue);
    if (parsed.warning) warnings.push(parsed.warning);
    const idType: AnimalIdType = input.idType ?? parsed.idType;

    return withTransaction(async () => {
      const animal = await this.repo.findById(input.userId, input.animalId);
      if (!animal) throw new Error('No encontré ese animal.');

      const clash = await this.repo.findCurrentIdentification(input.userId, idType, parsed.normalized);
      if (clash && clash.animal_id !== input.animalId) {
        throw new DuplicateIdentifierError(parsed.normalized, clash.animal_id);
      }

      const current = (await this.repo.listIdentifications(input.userId, input.animalId))
        .find((i) => i.is_current && i.id_type === idType) ?? null;

      if (current) {
        await this.repo.retireIdentification(
          input.userId, current.id, input.reason ?? 'reemplazo',
        );
      }

      const created = await this.repo.insertIdentification({
        userId: input.userId,
        animalId: input.animalId,
        idType,
        value: input.newValue,
        valueNormalized: parsed.normalized,
        deviceType: input.deviceType ?? null,
        replacesId: current?.id ?? null,
        source: input.source ?? 'manual',
        createdBy: input.createdBy ?? input.userId,
      });

      await this.repo.insertEvents([{
        userId: input.userId,
        animalId: input.animalId,
        eventType: current ? 'reidentificacion' : 'identificacion',
        fromRef: current?.value ?? null,
        toRef: created.value,
        textValue: input.reason ?? 'reemplazo',
        source: input.source ?? 'manual',
        createdBy: input.createdBy ?? input.userId,
      }]);

      return { retired: current, created, warnings };
    });
  }

  // ========================
  // CONSULTA
  // ========================

  async findByIdentifier(userId: number, rawValue: string): Promise<AnimalRow | null> {
    return this.repo.findByIdentifier(userId, rawValue);
  }

  async getById(userId: number, animalId: string): Promise<AnimalRow | null> {
    return this.repo.findById(userId, animalId);
  }

  async list(userId: number, filters: AnimalFilters = {}): Promise<AnimalRow[]> {
    return this.repo.listAnimals(userId, filters);
  }

  async count(userId: number, filters: AnimalFilters = {}): Promise<number> {
    return this.repo.countAnimals(userId, filters);
  }

  async getTimeline(
    userId: number, animalId: string,
    opts: { limit?: number; beforeDate?: string; beforeId?: string } = {},
  ): Promise<AnimalEventRow[]> {
    return this.repo.getTimeline(userId, animalId, opts);
  }

  async getIdentificationHistory(userId: number, animalId: string): Promise<AnimalIdentificationRow[]> {
    return this.repo.listIdentifications(userId, animalId);
  }

  /**
   * Ganancia diaria de peso entre pesajes consecutivos.
   *
   * NO asume periodicidad uniforme: cada tramo se calcula sobre los días reales
   * transcurridos. Dos pesajes el mismo día se descartan (división por cero, y
   * además no significan nada como ganancia).
   */
  async getWeightGain(userId: number, animalId: string): Promise<{
    weighings: Array<{ date: Date; weightKg: number }>;
    segments: Array<{ fromDate: Date; toDate: Date; days: number; gainKg: number; gdpKgDay: number }>;
    overallGdpKgDay: number | null;
  }> {
    const rows = await this.repo.getWeighings(userId, animalId);
    // El repo devuelve DESC; para la serie temporal se necesita ASC.
    const weighings = rows
      .map((r) => ({ date: new Date(r.event_date), weightKg: Number(r.numeric_value) }))
      .filter((w) => Number.isFinite(w.weightKg))
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    const segments: Array<{ fromDate: Date; toDate: Date; days: number; gainKg: number; gdpKgDay: number }> = [];
    for (let i = 1; i < weighings.length; i++) {
      const prev = weighings[i - 1];
      const cur = weighings[i];
      const days = Math.round((cur.date.getTime() - prev.date.getTime()) / 86_400_000);
      if (days <= 0) continue;
      const gainKg = cur.weightKg - prev.weightKg;
      segments.push({ fromDate: prev.date, toDate: cur.date, days, gainKg, gdpKgDay: gainKg / days });
    }

    let overallGdpKgDay: number | null = null;
    if (weighings.length >= 2) {
      const first = weighings[0];
      const last = weighings[weighings.length - 1];
      const days = Math.round((last.date.getTime() - first.date.getTime()) / 86_400_000);
      if (days > 0) overallGdpKgDay = (last.weightKg - first.weightKg) / days;
    }

    return { weighings, segments, overallGdpKgDay };
  }

  // ========================
  // MOVIMIENTO Y ESTADO
  // ========================

  /**
   * Mueve animales individuales a una ubicación/grupo y deja la traza en la
   * línea de tiempo de cada uno.
   *
   * Rechaza los que ya salieron del rodeo: mover un animal vendido o muerto es
   * un dato imposible. Se devuelven aparte en `skipped` en vez de fallar toda la
   * operación — que 3 de 87 caravanas correspondan a animales ya vendidos no
   * puede impedir mover los otros 84.
   */
  async moveAnimals(input: {
    userId: number;
    animalIds: string[];
    destFieldId?: number | null;
    destPlotId?: number | null;
    destCorralId?: number | null;
    destGroupId?: string | null;
    destCategory?: LivestockCategory;
    destLabel?: string;
    eventDate?: string | null;
    source?: AnimalSource;
    createdBy?: number | null;
    livestockMovementId?: string | null;
  }): Promise<{ moved: number; skipped: Array<{ animalId: string; reason: string }> }> {
    if (input.animalIds.length === 0) return { moved: 0, skipped: [] };

    return withTransaction(async () => {
      const skipped: Array<{ animalId: string; reason: string }> = [];
      const movable: AnimalRow[] = [];

      for (const id of input.animalIds) {
        const a = await this.repo.findById(input.userId, id);
        if (!a) { skipped.push({ animalId: id, reason: 'no encontrado' }); continue; }
        if (TERMINAL_STATUSES.includes(a.status)) {
          skipped.push({ animalId: id, reason: `está ${a.status}` });
          continue;
        }
        movable.push(a);
      }
      if (movable.length === 0) return { moved: 0, skipped };

      const fromLabelOf = (a: AnimalRow) => a.plot_name ?? a.corral_name ?? a.field_name ?? null;
      const froms = new Map(movable.map((a) => [a.id, fromLabelOf(a)]));
      const oldCategories = new Map(movable.map((a) => [a.id, a.category]));

      const { moved } = await this.repo.relocateAnimals(
        input.userId,
        movable.map((a) => a.id),
        {
          fieldId: input.destFieldId ?? null,
          plotId: input.destPlotId ?? null,
          corralId: input.destCorralId ?? null,
          groupId: input.destGroupId ?? null,
          category: input.destCategory,
        },
      );

      await this.repo.insertEvents(movable.map((a) => ({
        userId: input.userId,
        animalId: a.id,
        eventType: 'movimiento' as const,
        eventDate: input.eventDate ?? null,
        livestockMovementId: input.livestockMovementId ?? null,
        fromRef: froms.get(a.id) ?? null,
        toRef: input.destLabel ?? null,
        source: input.source ?? 'manual',
        createdBy: input.createdBy ?? input.userId,
      })));

      // La recategorización es un hecho distinto del movimiento y merece su
      // propia entrada: "pasó de ternero a novillito" es lo que el productor
      // busca en el historial, no "cambió de lote".
      const destCategory = input.destCategory;
      if (destCategory) {
        const recategorized = movable.filter((a) => oldCategories.get(a.id) !== destCategory);
        if (recategorized.length > 0) {
          await this.repo.insertEvents(recategorized.map((a) => ({
            userId: input.userId,
            animalId: a.id,
            eventType: 'cambio_categoria' as const,
            eventDate: input.eventDate ?? null,
            fromRef: LIVESTOCK_CATEGORY_LABEL[oldCategories.get(a.id)!] ?? null,
            toRef: LIVESTOCK_CATEGORY_LABEL[destCategory] ?? destCategory,
            source: input.source ?? 'manual',
            createdBy: input.createdBy ?? input.userId,
          })));
        }
      }

      return { moved, skipped };
    });
  }

  /** Marca la salida del rodeo (venta, muerte, extravío, transferencia externa). */
  async setStatus(input: {
    userId: number;
    animalIds: string[];
    status: AnimalStatus;
    exitDate?: string | null;
    reason?: string | null;
    source?: AnimalSource;
    createdBy?: number | null;
    livestockMovementId?: string | null;
  }): Promise<{ updated: number }> {
    if (input.animalIds.length === 0) return { updated: 0 };

    return withTransaction(async () => {
      const { updated } = await this.repo.setStatus(
        input.userId, input.animalIds, input.status, input.exitDate ?? null,
      );

      const eventType = input.status === 'vendido' ? 'egreso_venta'
        : input.status === 'muerto' ? 'egreso_muerte'
        : 'otro';

      await this.repo.insertEvents(input.animalIds.map((animalId) => ({
        userId: input.userId,
        animalId,
        eventType: eventType as 'egreso_venta' | 'egreso_muerte' | 'otro',
        eventDate: input.exitDate ?? null,
        livestockMovementId: input.livestockMovementId ?? null,
        toRef: input.status,
        textValue: input.reason ?? null,
        source: input.source ?? 'manual',
        createdBy: input.createdBy ?? input.userId,
      })));

      return { updated };
    });
  }

  // ========================
  // LOTES DE LECTURA (RFID / CSV / lista pegada)
  // ========================

  /**
   * Clasifica una lectura cruda contra el padrón. Es la base del flujo
   * preview → confirmar: nunca se aplica una operación masiva sin que el
   * productor haya visto el desglose.
   */
  async resolveBatch(userId: number, rawValues: string[]): Promise<IdentificationResolution> {
    return this.repo.resolveBatch(userId, rawValues);
  }

  /**
   * Resumen en castellano de una resolución, para el mensaje del bot.
   * Ejemplo: "Encontré 87 de 90. 82 en Lote Norte, 3 en Lote Sur, 2 sin ubicación."
   */
  summarizeResolution(res: IdentificationResolution): string {
    const lines: string[] = [];
    lines.push(`🔎 Leí ${res.rawCount} identificadores y encontré ${res.matched.length} animales.`);

    const byLocation = new Map<string, number>();
    for (const m of res.matched) {
      const loc = m.animal.plot_name
        ? `Lote ${m.animal.plot_name}`
        : m.animal.corral_name
          ? `Corral ${m.animal.corral_name}`
          : 'sin ubicación conocida';
      byLocation.set(loc, (byLocation.get(loc) ?? 0) + 1);
    }
    for (const [loc, n] of [...byLocation.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  • ${n} en ${loc}`);
    }

    if (res.unknown.length > 0) lines.push(`  • ${res.unknown.length} sin registrar en tu rodeo`);
    if (res.duplicates.length > 0) lines.push(`  • ${res.duplicates.length} repetidos en la lectura`);
    if (res.invalid.length > 0) lines.push(`  • ${res.invalid.length} ilegibles`);

    return lines.join('\n');
  }

  // ========================
  // CONSISTENCIA (advisory)
  // ========================

  /**
   * Discrepancias del modelo híbrido. Es ADVISORY y no corrige nada solo: el
   * spec pide detectar y explicar, no modificar en silencio.
   *
   * Ojo con lo que NO se reporta: un grupo de 100 con 60 individualizados es
   * VÁLIDO (individualización parcial), no una inconsistencia. Solo el exceso
   * (más individuales que cabezas declaradas) es siempre un error.
   */
  async findInconsistencies(userId: number): Promise<Array<{ kind: string; message: string }>> {
    const out: Array<{ kind: string; message: string }> = [];

    const discrepancies = await this.repo.findGroupCountDiscrepancies(userId);
    for (const d of discrepancies) {
      const loc = d.plot_name ? `lote ${d.plot_name}` : d.corral_name ? `corral ${d.corral_name}` : (d.field_name ?? 'sin ubicación');
      out.push({
        kind: 'grupo_vs_individuales',
        message: `El grupo de ${d.category} en ${loc} declara ${d.declared} animales, pero hay ${d.individual} individuales asociados.`,
      });
    }

    const afterExit = await this.repo.findEventsAfterExit(userId);
    for (const e of afterExit) {
      out.push({
        kind: 'evento_despues_de_baja',
        message: `Un animal ${e.status} registró un evento de ${e.event_type} posterior a su salida.`,
      });
    }

    return out;
  }

  /** Recuenta `individualized_count` de todos los grupos. Devuelve cuántos estaban desviados. */
  async reconcile(userId: number): Promise<number> {
    return this.repo.reconcileAllGroups(userId);
  }

  // ========================
  // INTERNOS
  // ========================

  private breedIdCache = new Map<string, number | null>();

  /** id de `livestock_breeds` para un code canónico. Cacheado: el catálogo es estático. */
  private async breedIdFor(code: string): Promise<number | null> {
    if (this.breedIdCache.has(code)) return this.breedIdCache.get(code)!;
    const { pool } = await import('../../config/db.js');
    const { rows } = await pool.query(`SELECT id FROM livestock_breeds WHERE code = $1`, [code]);
    const id = rows[0]?.id ?? null;
    this.breedIdCache.set(code, id);
    return id;
  }
}

/** Normaliza un identificador para comparar/guardar. Re-export para los handlers. */
export { normalizeAnimalId };
