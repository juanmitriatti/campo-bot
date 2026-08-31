/**
 * animal-batch.service.ts — ciclo de vida de un LOTE de lecturas de caravanas.
 *
 * Es la materialización de `AnimalIdentificationSource` (§18 del spec): los
 * cuatro orígenes — lista pegada por chat, import CSV, formulario Mini App y
 * alta manual — producen lo mismo (un array de strings crudos) y confluyen acá.
 * Agregar un lector RFID mañana es agregar un `source`, no un camino nuevo.
 *
 * FLUJO: preview → confirmar → aplicar. Nunca se ejecuta una operación masiva
 * sin que el productor haya visto el desglose. "Encontré 87 de 90" con el
 * detalle por ubicación es la diferencia entre una herramienta en la que confiar
 * y una que mueve 87 animales a donde no era.
 *
 * IDEMPOTENCIA: el estado del batch es la guarda. Aplicar dos veces movería los
 * animales dos veces; la transición `previewed → applied` ocurre dentro de la
 * misma transacción que el movimiento, con un UPDATE condicionado al estado
 * anterior. Es el bug de lluvia acumulada de Ago 2026 en su versión ganadera.
 */

import { pool, withTransaction } from '../../config/db.js';
import { AnimalService } from './animal.service.js';
import { splitIdLines } from '../../utils/animal-id.js';
import type { AnimalSource, IdentificationResolution } from './animal.types.js';

export type BatchStatus = 'pending' | 'previewed' | 'applied' | 'discarded';
export type BatchAction = 'alta' | 'movimiento' | 'sanidad' | 'pesaje' | 'conciliacion';

export interface BatchRow {
  id: string;
  user_id: number;
  source: AnimalSource;
  status: BatchStatus;
  intended_action: BatchAction | null;
  raw_count: number;
  matched_count: number;
  unknown_count: number;
  invalid_count: number;
  duplicate_count: number;
  payload: { values: string[]; matchedAnimalIds: string[]; unknown: string[] };
  target: Record<string, unknown> | null;
  created_at: Date;
  applied_at: Date | null;
}

/** Un batch vive 30 minutos, igual que las sesiones de formulario. */
const TTL_MINUTES = 30;

export class AnimalBatchService {
  constructor(private readonly animals: AnimalService = new AnimalService()) {}

  /**
   * Crea un batch a partir de texto crudo (lista pegada) o de valores ya
   * separados (CSV, formulario). Devuelve la resolución para poder mostrarla
   * inmediatamente.
   */
  async createFromValues(
    userId: number,
    values: string[],
    opts: { source: AnimalSource; intendedAction?: BatchAction; createdBy?: number } = { source: 'manual' },
  ): Promise<{ batch: BatchRow; resolution: IdentificationResolution }> {
    const resolution = await this.animals.resolveBatch(userId, values);

    const { rows } = await pool.query(
      `INSERT INTO animal_id_batches
         (user_id, source, status, intended_action, raw_count, matched_count,
          unknown_count, invalid_count, duplicate_count, payload, created_by, expires_at)
       VALUES ($1,$2,'previewed',$3,$4,$5,$6,$7,$8,$9,$10, NOW() + ($11 || ' minutes')::interval)
       RETURNING *`,
      [
        userId,
        opts.source,
        opts.intendedAction ?? null,
        resolution.rawCount,
        resolution.matched.length,
        resolution.unknown.length,
        resolution.invalid.length,
        resolution.duplicates.length,
        JSON.stringify({
          values,
          matchedAnimalIds: resolution.matched.map((m) => m.animal.id),
          unknown: resolution.unknown,
        }),
        opts.createdBy ?? userId,
        String(TTL_MINUTES),
      ],
    );

    console.log(
      `[RFID BATCH] user=${userId} source=${opts.source} leidos=${resolution.rawCount} ` +
      `encontrados=${resolution.matched.length} desconocidos=${resolution.unknown.length} ` +
      `repetidos=${resolution.duplicates.length} ilegibles=${resolution.invalid.length}`,
    );

    return { batch: rows[0], resolution };
  }

  /**
   * Igual que `createFromValues` pero partiendo del texto pegado por el usuario.
   *
   * Usa `splitIdLines` (partir y nada más), NO `extractIdList`: este último
   * deduplica y descarta los fragmentos cortos, y entonces el resumen reportaba
   * "leí 2" sobre 4 líneas pegadas. La clasificación en
   * encontrados/desconocidos/repetidos/ilegibles la hace `resolveBatch`, que es
   * el único lugar donde las cuatro categorías cierran contra el total.
   */
  async createFromText(
    userId: number, text: string,
    opts: { source: AnimalSource; intendedAction?: BatchAction; createdBy?: number } = { source: 'whatsapp' },
  ): Promise<{ batch: BatchRow; resolution: IdentificationResolution }> {
    return this.createFromValues(userId, splitIdLines(text), opts);
  }

  async findById(userId: number, batchId: string): Promise<BatchRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM animal_id_batches WHERE id = $1 AND user_id = $2`,
      [batchId, userId],
    );
    return rows[0] ?? null;
  }

  /** El batch abierto más reciente del usuario. Permite "movelos al Sur" sin repetir la lista. */
  async findLatestOpen(userId: number): Promise<BatchRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM animal_id_batches
        WHERE user_id = $1 AND status = 'previewed'
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /**
   * Aplica el batch como un movimiento. La transición de estado es la guarda de
   * idempotencia: el UPDATE exige `status = 'previewed'`, así que un segundo tap
   * no mueve nada y se puede reportar honestamente.
   */
  async applyAsMove(
    userId: number,
    batchId: string,
    dest: { fieldId?: number | null; plotId?: number | null; corralId?: number | null; label?: string },
  ): Promise<{ applied: boolean; moved: number; skipped: Array<{ animalId: string; reason: string }>; alreadyApplied: boolean }> {
    return withTransaction(async () => {
      const { rows: claimed } = await pool.query(
        `UPDATE animal_id_batches
            SET status = 'applied', applied_at = NOW(), target = $3
          WHERE id = $1 AND user_id = $2 AND status = 'previewed'
        RETURNING *`,
        [batchId, userId, JSON.stringify(dest)],
      );

      if (claimed.length === 0) {
        // O no existe, o ya se aplicó/descartó. El llamador distingue mirando la fila.
        const existing = await this.findById(userId, batchId);
        return {
          applied: false, moved: 0, skipped: [],
          alreadyApplied: existing?.status === 'applied',
        };
      }

      const batch = claimed[0] as BatchRow;
      const animalIds: string[] = batch.payload?.matchedAnimalIds ?? [];
      if (animalIds.length === 0) return { applied: true, moved: 0, skipped: [], alreadyApplied: false };

      const { moved, skipped } = await this.animals.moveAnimals({
        userId,
        animalIds,
        destFieldId: dest.fieldId ?? null,
        destPlotId: dest.plotId ?? null,
        destCorralId: dest.corralId ?? null,
        destLabel: dest.label,
        source: batch.source,
      });

      return { applied: true, moved, skipped, alreadyApplied: false };
    });
  }

  async discard(userId: number, batchId: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE animal_id_batches SET status = 'discarded'
        WHERE id = $1 AND user_id = $2 AND status = 'previewed'`,
      [batchId, userId],
    );
    return (rowCount ?? 0) > 0;
  }
}
