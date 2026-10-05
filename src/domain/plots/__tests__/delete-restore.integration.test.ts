/**
 * Borrar y restaurar (auditoría oct 2026: CAM-4/5/7/18/19, HAC-10/11/17/18/19,
 * FIN-24). Contra la DB real.
 *
 * Decisión de producto: borrar un lote/campo con hacienda, stock o cultivo en
 * curso se permite, pero la confirmación dice lo que se lleva, y restaurarlo
 * trae todo de vuelta.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../../testing/integration/pipeline-harness.js';
import {
  deleteField, restoreField, deletePlot, restorePlot, renameField, getOrCreatePlot, describeDeletionCargo,
} from '../../../services/expenses.js';
import { FeedlotRepository } from '../../feedlot/feedlot.repository.js';
import { LivestockService } from '../../livestock/livestock.service.js';
import { LivestockRepository } from '../../livestock/livestock.repository.js';
import type { UserId } from '../../../types/index.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('borrar y restaurar', () => {
  let h: PipelineHarness;
  let userId: number;
  let seq = 0;

  const newField = async (name: string) => {
    const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, name]);
    await pool.query(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [f.rows[0].id, userId]);
    return f.rows[0].id as number;
  };
  const newPlot = async (fieldId: number, name: string) =>
    (await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, $2, 100) RETURNING id`, [fieldId, name])).rows[0].id as number;
  const newGroup = async (fieldId: number, plotId: number | null, count: number, corralId: number | null = null) =>
    (await pool.query(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, corral_id, category, count) VALUES ($1, $2, $3, $4, 'vaca', $5) RETURNING id`,
      [userId, fieldId, plotId, corralId, count],
    )).rows[0].id as string;

  beforeAll(async () => {
    h = await createPipelineHarness('delete-restore');
    userId = Number(h.userId);
    await pool.query(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [userId]);
  });
  afterAll(async () => h?.cleanup());
  // "borrá el lote X" lo resuelve el regex sin el agente: sin el reset, la tool
  // encolada quedaba para el mensaje del test siguiente.
  beforeEach(() => { seq++; h.fakeAgent.reset(); });

  it('CAM-4: restaurar un campo re-vincula sus gastos, ingresos y lluvias', async () => {
    const fieldId = await newField(`Revincular ${seq}`);
    const plotId = await newPlot(fieldId, 'Norte');
    const e = await pool.query(
      `INSERT INTO expenses (user_id, amount, category, field_id, plot_id, expense_date) VALUES ($1, 1000, 'Gasoil', $2, $3, CURRENT_DATE) RETURNING id`,
      [userId, fieldId, plotId],
    );
    const r = await pool.query(
      `INSERT INTO rainfall (user_id, field_id, millimeters, rainfall_date) VALUES ($1, $2, 20, CURRENT_DATE) RETURNING id`,
      [userId, fieldId],
    );
    expect(await deleteField(userId, `Revincular ${seq}`)).toBe(true);
    expect((await pool.query(`SELECT field_id, plot_id FROM expenses WHERE id = $1`, [e.rows[0].id])).rows[0]).toEqual({ field_id: null, plot_id: null });

    await restoreField(userId, `Revincular ${seq}`);
    expect((await pool.query(`SELECT field_id, plot_id FROM expenses WHERE id = $1`, [e.rows[0].id])).rows[0]).toEqual({ field_id: fieldId, plot_id: plotId });
    expect((await pool.query(`SELECT field_id FROM rainfall WHERE id = $1`, [r.rows[0].id])).rows[0].field_id).toBe(fieldId);
  });

  it('CAM-5: un campo con acento se restaura escribiéndolo sin acento', async () => {
    await newField(`La Peña ${seq}`);
    expect(await deleteField(userId, `La Peña ${seq}`)).toBe(true);
    const restored = await restoreField(userId, `la pena ${seq}`);
    expect(restored?.name).toBe(`La Peña ${seq}`);
  });

  it('CAM-18: un lote borrado se puede volver a crear con el mismo nombre; restaurar el viejo lo explica', async () => {
    const fieldId = await newField(`Recrear ${seq}`);
    const plotId = await newPlot(fieldId, 'Bajo');
    expect(await deletePlot(plotId, userId)).toBe(true);
    const again = await getOrCreatePlot(fieldId, 'Bajo');
    expect(again.id).not.toBe(plotId);
    await expect(restorePlot(userId, 'Bajo', `Recrear ${seq}`)).rejects.toThrow(/Ya tenés un lote/);
  });

  it('CAM-19: renombrar a un nombre que ya existe se explica (no es un error interno)', async () => {
    await newField(`Uno ${seq}`);
    await newField(`Dos ${seq}`);
    await expect(renameField(userId, `Uno ${seq}`, `dos ${seq}`)).rejects.toThrow(/Ya hay un campo/);
  });

  it('CAM-7: la confirmación dice qué se lleva el borrado, y la hacienda vuelve al restaurar', async () => {
    const fieldId = await newField(`Carga ${seq}`);
    const plotId = await newPlot(fieldId, 'Potrero');
    const groupId = await newGroup(fieldId, plotId, 40);
    await pool.query(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date) VALUES ($1, 'soja', 2026, 'gruesa', CURRENT_DATE)`,
      [plotId],
    );
    const cargo = await describeDeletionCargo({ plotId });
    expect(cargo.livestockHeads).toBe(40);
    expect(cargo.activeCrops).toEqual(['soja']);

    const out = h.allText(await h.send(`borrá el lote Potrero del campo Carga ${seq}`));
    expect(out).toMatch(/40 cabezas/);
    expect(out).toMatch(/soja en curso/);

    await deletePlot(plotId, userId);
    const live = await new LivestockRepository().listGroups(userId, { fieldId });
    expect(live.map((g) => g.id)).not.toContain(groupId);

    await restorePlot(userId, 'Potrero', `Carga ${seq}`);
    const back = await new LivestockRepository().listGroups(userId, { fieldId });
    expect(back.find((g) => g.id === groupId)?.count).toBe(40);
  });

  it('HAC-18/19: un corral con hacienda no se borra; vacío se borra y se puede recrear con el mismo nombre', async () => {
    const fieldId = await newField(`Feedlot ${seq}`);
    const repo = new FeedlotRepository();
    const feedlot = await repo.createFeedlot(userId, fieldId, 'Engorde');
    const corral = await repo.createCorral(feedlot.id, 'C1');
    await newGroup(fieldId, null, 15, corral.id);
    await expect(repo.deleteCorral(corral.id)).rejects.toThrow(/15 cabezas/);

    const vacio = await repo.createCorral(feedlot.id, 'C2');
    await repo.deleteCorral(vacio.id);
    const otra = await repo.createCorral(feedlot.id, 'C2');
    expect(otra.id).not.toBe(vacio.id);
  });

  describe('deshacer movimientos de hacienda', () => {
    const svc = new LivestockService();
    const repo = new LivestockRepository();

    it('HAC-11 + HAC-10: deshacer una compra con precio borra el gasto, y el precio tardío no se engancha a la reversa', async () => {
      const fieldId = await newField(`Compra ${seq}`);
      await newPlot(fieldId, 'Sur');
      h.fakeAgent.enqueueTool('add_livestock', { category: 'toro', count: 5, plot: 'Sur', field: `Compra ${seq}`, unit_price_ars: 2_000_000 });
      await h.send(`compré 5 toros a 2 palos c/u en Sur del campo Compra ${seq}`);
      const mov = (await pool.query(
        `SELECT id::text AS id, linked_expense_id FROM livestock_movements WHERE user_id = $1 AND movement_type = 'entrada' ORDER BY created_at DESC LIMIT 1`,
        [userId],
      )).rows[0];
      expect(mov.linked_expense_id).not.toBeNull();

      const r = await svc.undoMovement(userId as UserId, mov.id);
      expect(r.notes).toMatch(/gasto vinculado/);
      const exp = await pool.query(`SELECT deleted_at FROM expenses WHERE id = $1`, [mov.linked_expense_id]);
      expect(exp.rows[0].deleted_at).not.toBeNull();

      // La reversa (una 'salida') no es una venta sin precio.
      const unpriced = await repo.findLatestUnpricedMovement(userId);
      expect(unpriced?.id ?? null).not.toBe(mov.id);
      if (unpriced) {
        const isReversal = await pool.query(`SELECT reverses_movement_id FROM livestock_movements WHERE id = $1`, [unpriced.id]);
        expect(isReversal.rows[0].reverses_movement_id).toBeNull();
      }
    });

    it('FIN-24: borrar el gasto vinculado deja el movimiento listo para volver a preciarse', async () => {
      const fieldId = await newField(`Repreciar ${seq}`);
      await newPlot(fieldId, 'Este');
      h.fakeAgent.enqueueTool('add_livestock', { category: 'vaca', count: 3, plot: 'Este', field: `Repreciar ${seq}`, unit_price_ars: 900_000 });
      await h.send(`compré 3 vacas a 900 mil en Este del campo Repreciar ${seq}`);
      const mov = (await pool.query(
        `SELECT id::text AS id, linked_expense_id FROM livestock_movements WHERE user_id = $1 AND movement_type = 'entrada' ORDER BY created_at DESC LIMIT 1`,
        [userId],
      )).rows[0];
      await pool.query(`UPDATE expenses SET deleted_at = NOW() WHERE id = $1`, [mov.linked_expense_id]);
      const forPricing = await repo.findMovementForPricing(userId, mov.id);
      expect(forPricing?.linked_expense_id ?? null).toBeNull();
    });

    it('HAC-17: revertir una muerte por caravana devuelve el animal a activo', async () => {
      const fieldId = await newField(`Caravana ${seq}`);
      const plotId = await newPlot(fieldId, 'Oeste');
      const groupId = await newGroup(fieldId, plotId, 9);
      const animal = await pool.query(
        `INSERT INTO animals (user_id, category, sex, status, entry_date, source, group_id, field_id, plot_id, exit_date)
         VALUES ($1, 'vaca', 'H', 'muerto', CURRENT_DATE, 'manual', $2, $3, $4, CURRENT_DATE) RETURNING id`,
        [userId, groupId, fieldId, plotId],
      );
      const mov = await pool.query(
        `INSERT INTO livestock_movements (user_id, movement_type, count, movement_date, source, source_group_id)
         VALUES ($1, 'muerte', 1, CURRENT_DATE, 'manual', $2) RETURNING id::text AS id`,
        [userId, groupId],
      );
      await pool.query(
        `INSERT INTO animal_events (user_id, animal_id, event_type, event_date, livestock_movement_id, source, created_by)
         VALUES ($1, $2, 'egreso_muerte', CURRENT_DATE, $3, 'manual', $1)`,
        [userId, animal.rows[0].id, mov.rows[0].id],
      );
      const r = await svc.undoMovement(userId as UserId, mov.rows[0].id);
      expect(r.notes).toMatch(/volvió a estar activo/);
      const a = await pool.query(`SELECT status, exit_date FROM animals WHERE id = $1`, [animal.rows[0].id]);
      expect(a.rows[0]).toEqual({ status: 'activo', exit_date: null });
    });
  });
});
