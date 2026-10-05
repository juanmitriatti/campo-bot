/**
 * Campo compartido en el dashboard + lluvias (auditoría oct 2026, causas 13 y
 * 14: DSH-4, DSH-7, AGR-5, AGR-6, AGR-10). Contra la DB real.
 *
 * En un campo compartido cada socio veía en el Resumen, la cosecha y el
 * análisis solo lo que había cargado él: las queries filtraban por `user_id`
 * (el AUTOR) en vez de por campo accesible.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../testing/integration/pipeline-harness.js';
import { getOverview } from '../overview.service.js';
import { getReviewFindings } from '../review-findings.service.js';
import { campaignRange, currentSeasonYear } from '../../utils/campaign-range.js';
import {
  queryHarvestLoads, getHarvestLoadById, saveRainfall, correctLastRainfall, deleteLastRainfall,
} from '../expenses.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

const todayAR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

describe.skipIf(!dbAvailable)('campo compartido en el dashboard', () => {
  let h: PipelineHarness;
  let owner: number;
  let member: number;
  let fieldId: number;
  let plotId: number;
  let loadId: number;
  const range = campaignRange(currentSeasonYear());

  beforeAll(async () => {
    h = await createPipelineHarness('shared-dash');
    owner = Number(h.userId);
    const m = await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id) VALUES ('Socio', 'socio-shared-dash@test.local', 'x', 4) RETURNING id`,
    );
    member = m.rows[0].id;
    const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Compartido') RETURNING id`, [owner]);
    fieldId = f.rows[0].id;
    await pool.query(
      `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2), ($1, $3, 'member', $2)`,
      [fieldId, owner, member],
    );
    const p = await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100) RETURNING id`, [fieldId]);
    plotId = p.rows[0].id;

    // Todo lo cargó el SOCIO en el campo del dueño, dentro de la campaña.
    const day = todayAR();
    const pc = await pool.query(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, yield_kg)
       VALUES ($1, 'soja', $2, 'gruesa', $3, 30000) RETURNING id`,
      [plotId, currentSeasonYear(), range.from],
    );
    const ev = await pool.query(
      `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop)
       VALUES ($1, $2, $3, 'harvest', $4, 'soja') RETURNING id`,
      [member, plotId, pc.rows[0].id, day],
    );
    const hl = await pool.query(
      `INSERT INTO harvest_loads (domain_event_id, plot_crop_id, driver_name, weight_kg, created_by)
       VALUES ($1, $2, 'Pérez', 30000, $3) RETURNING id`,
      [ev.rows[0].id, pc.rows[0].id, member],
    );
    loadId = hl.rows[0].id;
    await pool.query(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, count) VALUES ($1, $2, $3, 'vaca', 40)`,
      [member, fieldId, plotId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM livestock_groups WHERE field_id = $1`, [fieldId]);
    await pool.query(`DELETE FROM harvest_loads WHERE id = $1`, [loadId]);
    await pool.query(`DELETE FROM domain_events WHERE plot_id = $1`, [plotId]);
    await pool.query(`DELETE FROM plot_crops WHERE plot_id = $1`, [plotId]);
    await pool.query(`DELETE FROM field_members WHERE user_id = $1`, [member]);
    await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [member]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [member]);
    await h?.cleanup();
  });

  it('DSH-4: el Resumen del dueño muestra la cosecha, los camiones y la hacienda que cargó el socio', async () => {
    const o = await getOverview(owner, [fieldId], range);
    const plot = o.plots.find((p) => p.id === plotId);
    expect(plot?.harvestKg).toBe(30000);
    expect(o.counts.harvests).toBe(1);
    expect(o.livestock.total).toBe(40);
  });

  it('DSH-4: los camiones del socio aparecen (y se pueden abrir) para el dueño, por chat y por dashboard', async () => {
    const rows = await queryHarvestLoads(owner, { plotId });
    expect(rows.map((r: { id: number }) => r.id)).toContain(loadId);
    expect(await getHarvestLoadById(owner, loadId)).not.toBeNull();
  });

  it('DSH-4: un tercero sin acceso al campo no ve los camiones', async () => {
    const other = await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id) VALUES ('Ajeno', 'ajeno-shared-dash@test.local', 'x', 4) RETURNING id`,
    );
    try {
      expect(await getHarvestLoadById(other.rows[0].id, loadId)).toBeNull();
      expect((await queryHarvestLoads(other.rows[0].id, {})).map((r: { id: number }) => r.id)).not.toContain(loadId);
    } finally {
      await pool.query(`DELETE FROM users WHERE id = $1`, [other.rows[0].id]);
    }
  });

  it('DSH-7: "Para revisar" no marca como vacío un campo donde el socio sí cargó', async () => {
    const findings = await getReviewFindings({ userId: owner, fieldIds: [fieldId], range });
    const hollow = findings.find((f) => f.rule === 'hollow_fields');
    expect(hollow?.body ?? '').not.toMatch(/Compartido/);
  });
});

describe.skipIf(!dbAvailable)('lluvias: corregir y borrar la última carga', () => {
  let h: PipelineHarness;
  let userId: number;
  let campoA: number;
  let campoB: number;

  beforeAll(async () => {
    h = await createPipelineHarness('rain-fix');
    userId = Number(h.userId);
    const a = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Lluvia A') RETURNING id`, [userId]);
    const b = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Lluvia B') RETURNING id`, [userId]);
    campoA = a.rows[0].id;
    campoB = b.rows[0].id;
    await pool.query(
      `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $3, 'owner', $3), ($2, $3, 'owner', $3)`,
      [campoA, campoB, userId],
    );
    await pool.query(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [userId]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM rainfall WHERE user_id = $1`, [userId]);
    await h?.cleanup();
  });

  const rows = async () =>
    (await pool.query(`SELECT field_id, rainfall_date::text AS d, millimeters::float AS mm FROM rainfall WHERE user_id = $1 ORDER BY field_id, rainfall_date`, [userId])).rows;

  it('AGR-6: corregir la última lluvia cambia esa carga, no el total del día', async () => {
    await pool.query(`DELETE FROM rainfall WHERE user_id = $1`, [userId]);
    await saveRainfall(userId, 10, campoA, '2026-09-01');
    await saveRainfall(userId, 20, campoA, '2026-09-01');
    const fixed = await correctLastRainfall(userId, { newMm: 25 });
    expect(fixed).toMatchObject({ beforeMm: 20, mm: 25, total: 35 });
    expect(await rows()).toEqual([{ field_id: campoA, d: '2026-09-01', mm: 35 }]);
  });

  it('AGR-6: la última es la última CARGADA, aunque sea de una fecha anterior', async () => {
    await pool.query(`DELETE FROM rainfall WHERE user_id = $1`, [userId]);
    await saveRainfall(userId, 10, campoA, '2026-09-05');
    await saveRainfall(userId, 20, campoA, '2026-09-04'); // "ayer", cargada después
    await correctLastRainfall(userId, { newMm: 22 });
    expect(await rows()).toEqual([
      { field_id: campoA, d: '2026-09-04', mm: 22 },
      { field_id: campoA, d: '2026-09-05', mm: 10 },
    ]);
  });

  it('AGR-6: borrar la última lluvia resta esa carga y deja las otras del día', async () => {
    await pool.query(`DELETE FROM rainfall WHERE user_id = $1`, [userId]);
    await saveRainfall(userId, 10, campoA, '2026-09-01');
    await saveRainfall(userId, 20, campoA, '2026-09-01');
    const del = await deleteLastRainfall(userId);
    expect(Number(del?.millimeters)).toBe(20);
    expect(await rows()).toEqual([{ field_id: campoA, d: '2026-09-01', mm: 10 }]);
  });

  it('AGR-10: mover la lluvia a un campo que ya tiene lluvia ese día la suma (no choca el índice)', async () => {
    await pool.query(`DELETE FROM rainfall WHERE user_id = $1`, [userId]);
    await saveRainfall(userId, 15, campoB, '2026-09-02');
    await saveRainfall(userId, 30, campoA, '2026-09-02');
    const fixed = await correctLastRainfall(userId, { newFieldId: campoB });
    expect(fixed).toMatchObject({ moved: true, total: 45 });
    expect(await rows()).toEqual([{ field_id: campoB, d: '2026-09-02', mm: 45 }]);
  });

  it('AGR-10: "era en el campo X" (sin lote) por chat mueve la lluvia de verdad', async () => {
    await pool.query(`DELETE FROM rainfall WHERE user_id = $1`, [userId]);
    await saveRainfall(userId, 12, campoA, '2026-09-03');
    h.fakeAgent.enqueueTool('edit_last_rainfall', { new_field: 'Lluvia B' });
    const out = h.allText(await h.send('la última lluvia era en el campo Lluvia B'));
    expect(out).toMatch(/Lluvia B/);
    expect(await rows()).toEqual([{ field_id: campoB, d: '2026-09-03', mm: 12 }]);
  });

  it('AGR-5: el botón de campo de una lluvia conserva la fecha y no se pierde la segunda con los mismos mm', async () => {
    await pool.query(`DELETE FROM rainfall WHERE user_id = $1`, [userId]);
    h.fakeAgent.enqueueTool('log_rainfall', { quantity: 18, event_date: '2026-09-06' });
    const r1 = await h.send('el 6 de septiembre llovieron 18 mm');
    const b1 = h.allButtons(r1).find((b) => b.title.startsWith('Lluvia A'));
    expect(b1?.id).toMatch(/^rainfld_/);
    await h.tap(b1!.id);
    expect(await rows()).toEqual([{ field_id: campoA, d: '2026-09-06', mm: 18 }]);

    // Doble tap u otra opción del mismo teclado: no la carga de nuevo.
    const other = h.allButtons(r1).find((b) => b.title.startsWith('Lluvia B'));
    await h.tap(other!.id);
    expect(await rows()).toHaveLength(1);

    // Otra lluvia con los mismos mm, más tarde: entra (antes el one-shot por id la tiraba).
    h.fakeAgent.enqueueTool('log_rainfall', { quantity: 18, event_date: '2026-09-06' });
    const r2 = await h.send('el 6 de septiembre a la tarde llovieron 18 mm más');
    const b2 = h.allButtons(r2).find((b) => b.title.startsWith('Lluvia A'));
    await h.tap(b2!.id);
    expect(await rows()).toEqual([{ field_id: campoA, d: '2026-09-06', mm: 36 }]);
  });
});
