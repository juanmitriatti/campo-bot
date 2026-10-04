import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../testing/integration/pipeline-harness.js';
import { getOverview, earliestDataDate, resolveFieldIds } from '../overview.service.js';
import { getReviewFindings } from '../review-findings.service.js';
import { campaignRange, campaignsSince } from '../../utils/campaign-range.js';

/**
 * Regresiones del Resumen (Sep 2026). Cada test acá es un número que el
 * dashboard mostró MAL en la copia de prod:
 *
 * - ventas de grano sin campo ni lote que no entraban al resultado de campaña;
 * - "12 animales en total" para un rodeo de 960 cabezas en 12 grupos;
 * - "cosecha antes que su siembra" disparando en una rotación soja→soja normal;
 * - la tarjeta del lote mostrando el cultivo de HOY al mirar la campaña pasada.
 */

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

// Campaña 25/26: 1 sep 2025 → 31 ago 2026.
const RANGE = campaignRange(2025);

describe.skipIf(!dbAvailable)('overview.service — scoping del Resumen', () => {
  let h: PipelineHarness;
  let fieldA: number;
  let fieldB: number;
  let plotA: number;

  beforeAll(async () => {
    h = await createPipelineHarness('overview-scope');
    const fa = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Overview A') RETURNING id`, [h.userId]);
    fieldA = fa[0].id as number;
    const fb = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Overview B') RETURNING id`, [h.userId]);
    fieldB = fb[0].id as number;
    const pa = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Lote 1', 50) RETURNING id`, [fieldA]);
    plotA = pa[0].id as number;

    // Un gasto en el lote, un gasto a nivel campo B, y una venta de soja SIN
    // campo ni lote (como las 37 de la copia de prod).
    await h.q(
      `INSERT INTO expenses (user_id, category, description, amount, currency, field_id, plot_id, expense_date)
       VALUES ($1, 'Combustible', 'gasoil', 100000, 'ARS', $2, $3, '2026-01-10')`,
      [h.userId, fieldA, plotA],
    );
    await h.q(
      `INSERT INTO expenses (user_id, category, description, amount, currency, field_id, plot_id, expense_date)
       VALUES ($1, 'Sueldos', 'peón', 50000, 'ARS', $2, NULL, '2026-02-10')`,
      [h.userId, fieldB],
    );
    await h.q(
      `INSERT INTO incomes (user_id, category, description, amount, currency, field_id, plot_id, income_date, product, quantity, unit)
       VALUES ($1, 'Soja', 'venta a Cargill', 30000, 'USD', NULL, NULL, '2026-05-20', 'Soja', 100, 'tn')`,
      [h.userId],
    );

    // 12 grupos chicos: 960 cabezas, no 12.
    for (let i = 0; i < 12; i++) {
      await h.q(
        `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
         VALUES ($1, $2, $3, 'vaca', 'Angus ${i}', 80)`,
        [h.userId, fieldA, plotA],
      );
    }

    // Cultivo sembrado en 25/26, todavía activo.
    await h.q(
      `INSERT INTO plot_crops (plot_id, crop, season_year, start_date) VALUES ($1, 'Soja', 2025, '2025-11-10')`,
      [plotA],
    );
  });

  afterAll(async () => { await h?.cleanup(); });

  it('con "Todos los campos" entra la venta sin campo ni lote', async () => {
    const all = await getOverview(Number(h.userId), [fieldA, fieldB], RANGE, { includeUnassigned: true });
    expect(all.money.USD.income).toBe(30000);
    expect(all.money.USD.incomeCount).toBe(1);
    expect(all.money.ARS.expense).toBe(150000);
    expect(all.counts.incomes).toBe(1);
    // …y la fila aparece en "qué vendiste" con toneladas y precio por tn.
    const soja = all.incomeProducts.USD.find(r => r.name === 'Soja');
    expect(soja?.kg).toBe(100000);
    expect(soja?.pricePerTn).toBe(300);
  });

  it('con un campo puntual NO entra lo que no tiene ubicación', async () => {
    const one = await getOverview(Number(h.userId), [fieldA], RANGE, { includeUnassigned: false });
    expect(one.money.USD.income).toBe(0);
    expect(one.money.ARS.expense).toBe(100000);
  });

  it('counts.livestock son cabezas, no grupos', async () => {
    const all = await getOverview(Number(h.userId), [fieldA, fieldB], RANGE, { includeUnassigned: true });
    expect(all.counts.livestock).toBe(960);
    expect(all.livestock.total).toBe(960);
    expect(all.livestock.byCategory).toEqual([{ category: 'vaca', count: 960 }]);
    // y respeta el campo elegido
    const b = await getOverview(Number(h.userId), [fieldB], RANGE, { includeUnassigned: false });
    expect(b.counts.livestock).toBe(0);
  });

  it('el cultivo del lote es el de la campaña elegida, no el de hoy', async () => {
    const now = await getOverview(Number(h.userId), [fieldA], RANGE, { includeUnassigned: false });
    expect(now.plots[0].crop).toBe('Soja');
    // Campaña 24/25 (sep 2024 → ago 2025): la soja de nov 2025 todavía no existía.
    const prev = await getOverview(Number(h.userId), [fieldA], campaignRange(2024), { includeUnassigned: false });
    expect(prev.plots[0].crop).toBeNull();
  });

  it('el margen por cultivo y el $/ha salen de las mismas tarjetas', async () => {
    const one = await getOverview(Number(h.userId), [fieldA], RANGE, { includeUnassigned: false });
    const soja = one.cropMargins.ARS.find(r => r.crop === 'Soja');
    expect(soja).toMatchObject({ hectares: 50, plots: 1, expense: 100000, income: 0 });
  });
});

describe.skipIf(!dbAvailable)('review-findings — cosecha antes que su siembra', () => {
  let h: PipelineHarness;
  let fieldId: number;
  let plotId: number;

  const ctx = () => ({ userId: Number(h.userId), fieldIds: [fieldId], range: RANGE });
  const rule = async () => (await getReviewFindings(ctx())).filter(f => f.rule === 'harvest_before_planting');

  beforeAll(async () => {
    h = await createPipelineHarness('review-harvest');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Rotación') RETURNING id`, [h.userId]);
    fieldId = f[0].id as number;
    const p = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Grande', 100) RETURNING id`, [fieldId]);
    plotId = p[0].id as number;
  });

  afterAll(async () => { await h?.cleanup(); });

  it('una rotación soja → cosecha → soja de nuevo NO es un error', async () => {
    await h.q(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, crop) VALUES
         ($1, $2, 'planting', '2025-11-10', 'soja'),
         ($1, $2, 'harvest',  '2026-04-14', 'soja'),
         ($1, $2, 'planting', '2026-04-15', 'soja')`,
      [h.userId, plotId],
    );
    expect(await rule()).toEqual([]);
  });

  it('una cosecha sin ninguna siembra anterior y con una posterior SÍ se reporta', async () => {
    await h.q(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, crop) VALUES
         ($1, $2, 'harvest',  '2026-01-20', 'maíz'),
         ($1, $2, 'planting', '2026-02-01', 'maíz')`,
      [h.userId, plotId],
    );
    const found = await rule();
    expect(found).toHaveLength(1);
    expect(found[0].body).toContain('maíz');
  });

  it('siembra y cosecha el MISMO día no es "cosecha antes que su siembra" (P2-11, QA sep 2026)', async () => {
    await h.q(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, crop) VALUES
         ($1, $2, 'planting', '2026-06-09', 'trigo'),
         ($1, $2, 'harvest',  '2026-06-09', 'trigo')`,
      [h.userId, plotId],
    );
    expect((await rule()).filter(f => f.body.includes('trigo'))).toEqual([]);
  });
});

describe.skipIf(!dbAvailable)('overview.service — cosecha por CAMPAÑA, no por evento (P0-2, QA sep 2026)', () => {
  let h: PipelineHarness;
  let fieldId: number;
  let plotId: number;

  beforeAll(async () => {
    h = await createPipelineHarness('overview-harvest-campaign');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Dos días') RETURNING id`, [h.userId]);
    fieldId = f[0].id as number;
    const p = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100) RETURNING id`, [fieldId]);
    plotId = p[0].id as number;
    // Campaña con rinde declarado el día 1 (168 tn sobre 40 ha) y tres camiones el día 2.
    const pc = await h.q(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, harvested_at, harvest_ended_at, yield_kg, harvested_hectares)
       VALUES ($1, 'soja', 2025, 'gruesa', '2025-11-10', '2026-04-08', '2026-04-09', 168000, 40) RETURNING id`,
      [plotId],
    );
    const pcId = pc[0].id as number;
    await h.q(
      `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop, quantity, unit)
       VALUES ($1, $2, $3, 'harvest', '2026-04-08', 'soja', 168000, 'kg')`,
      [h.userId, plotId, pcId],
    );
    const ev2 = await h.q(
      `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop)
       VALUES ($1, $2, $3, 'harvest', '2026-04-09', 'soja') RETURNING id`,
      [h.userId, plotId, pcId],
    );
    for (const [driver, kg] of [['Pérez', 31320], ['Gómez', 30000], ['López', 20000]] as Array<[string, number]>) {
      await h.q(
        `INSERT INTO harvest_loads (domain_event_id, plot_crop_id, driver_name, weight_kg, net_weight_kg)
         VALUES ($1, $2, $3, $4, $4)`,
        [ev2[0].id, pcId, driver, kg],
      );
    }
  });

  afterAll(async () => { await h?.cleanup(); });

  it('el lote muestra el rinde de la campaña UNA vez (168 tn), no declarado + camiones (249 tn)', async () => {
    const ov = await getOverview(Number(h.userId), [fieldId], RANGE, { includeUnassigned: false });
    const norte = ov.plots.find(p => p.id === plotId);
    expect(norte?.harvestKg).toBe(168000);
    // Con avance parcial (40 de 100 ha) el kg/ha es sobre lo cosechado, igual que
    // el chat: 168 tn / 40 ha. Antes daba 1.680 (sobre las 100 ha) — DSH-5.
    expect(norte?.yieldKgPerHa).toBe(4200);
  });
});

describe.skipIf(!dbAvailable)('earliestDataDate — el picker de campañas', () => {
  let h: PipelineHarness;
  beforeAll(async () => { h = await createPipelineHarness('overview-campanias'); });
  afterAll(async () => h?.cleanup());

  it('usuario nuevo sin registros → null → una sola campaña', async () => {
    expect(await earliestDataDate(Number(h.userId))).toBeNull();
    expect(campaignsSince(null)).toHaveLength(1);
  });

  it('el registro más viejo manda, sin importar la tabla; lo borrado no cuenta', async () => {
    await h.q(
      `INSERT INTO expenses (user_id, category, description, amount, currency, expense_date) VALUES ($1, 'Otros', 'x', 1, 'ARS', '2025-10-01')`,
      [h.userId],
    );
    expect(await earliestDataDate(Number(h.userId))).toBe('2025-10-01');

    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Lluvias') RETURNING id`, [h.userId]);
    await h.q(`INSERT INTO rainfall (user_id, field_id, millimeters, rainfall_date) VALUES ($1, $2, 10, '2024-02-15')`, [h.userId, f[0].id]);
    expect(await earliestDataDate(Number(h.userId))).toBe('2024-02-15');

    await h.q(
      `INSERT INTO expenses (user_id, category, description, amount, currency, expense_date, deleted_at) VALUES ($1, 'Otros', 'borrado', 1, 'ARS', '2019-01-01', NOW())`,
      [h.userId],
    );
    expect(await earliestDataDate(Number(h.userId))).toBe('2024-02-15');
  });
});

/**
 * Campos COMPARTIDOS en el Resumen (Sep 2026).
 *
 * Compartir un campo funcionaba en el bot desde la migración 037, pero el
 * dashboard era owner-only en casi todas sus queries: el socio no veía el campo
 * en el picker, "Todos los campos" lo dejaba afuera, y los eventos agronómicos
 * se filtraban por `d.user_id` a secas, así que cada uno veía solo lo que había
 * cargado él. Compartir no se notaba en NINGUNA pantalla.
 */
describe.skipIf(!dbAvailable)('overview.service — campos compartidos', () => {
  let owner: PipelineHarness;
  let member: PipelineHarness;
  let fieldId: number;
  let plotId: number;

  beforeAll(async () => {
    owner = await createPipelineHarness('overview-share-owner');
    member = await createPipelineHarness('overview-share-member');

    const f = await owner.q(
      `INSERT INTO fields (user_id, name) VALUES ($1, 'Campo Compartido') RETURNING id`,
      [owner.userId],
    );
    fieldId = f[0].id as number;
    await owner.q(
      `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`,
      [fieldId, owner.userId],
    );
    const p = await owner.q(
      `INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Lote Compartido', 100) RETURNING id`,
      [fieldId],
    );
    plotId = p[0].id as number;

    // El DUEÑO carga un gasto y una siembra.
    await owner.q(
      `INSERT INTO expenses (user_id, category, description, amount, currency, field_id, plot_id, expense_date)
       VALUES ($1, 'Semillas', 'semilla', 200000, 'ARS', $2, $3, '2026-01-15')`,
      [owner.userId, fieldId, plotId],
    );
    await owner.q(
      `INSERT INTO domain_events (user_id, event_type, plot_id, event_date, crop)
       VALUES ($1, 'planting', $2, '2026-01-15', 'Soja')`,
      [owner.userId, plotId],
    );

    // El MIEMBRO carga lo suyo en el MISMO lote del dueño.
    await member.q(
      `INSERT INTO expenses (user_id, category, description, amount, currency, field_id, plot_id, expense_date)
       VALUES ($1, 'Combustible', 'gasoil del socio', 75000, 'ARS', $2, $3, '2026-02-20')`,
      [member.userId, fieldId, plotId],
    );
    await member.q(
      `INSERT INTO domain_events (user_id, event_type, plot_id, event_date, crop)
       VALUES ($1, 'spraying', $2, '2026-02-20', 'Soja')`,
      [member.userId, plotId],
    );

    // Y recién ACÁ se comparte.
    await owner.q(
      `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'member', $3)`,
      [fieldId, member.userId, owner.userId],
    );
  });

  afterAll(async () => {
    // El campo y el lote se crearon a mano, así que hay que sacarlos ANTES de
    // borrar los usuarios: si no, la FK `fields_user_id_fkey` frena el cleanup
    // del harness. Se borra de adentro hacia afuera.
    await owner.q(`DELETE FROM expenses WHERE field_id = $1`, [fieldId]).catch(() => {});
    await owner.q(`DELETE FROM domain_events WHERE plot_id = $1`, [plotId]).catch(() => {});
    await owner.q(`DELETE FROM field_members WHERE field_id = $1`, [fieldId]).catch(() => {});
    await owner.q(`DELETE FROM plots WHERE field_id = $1`, [fieldId]).catch(() => {});
    await owner.q(`DELETE FROM fields WHERE id = $1`, [fieldId]).catch(() => {});
    await owner?.cleanup();
    await member?.cleanup();
  });

  it('"Todos los campos" del miembro INCLUYE el campo compartido', async () => {
    const ids = await resolveFieldIds(Number(member.userId), null);
    expect(ids).toContain(fieldId);
  });

  it('un campo AJENO (sin compartir) no entra al alcance ni pidiéndolo explícito', async () => {
    const otra = await owner.q(
      `INSERT INTO fields (user_id, name) VALUES ($1, 'Solo Del Dueño') RETURNING id`,
      [owner.userId],
    );
    const ajeno = otra[0].id as number;
    const ids = await resolveFieldIds(Number(member.userId), ajeno);
    // -1 = "ningún campo": se responde como si no existiera, sin filtrar datos.
    expect(ids).toEqual([-1]);
    await owner.q(`DELETE FROM fields WHERE id = $1`, [ajeno]);
  });

  it('el miembro ve el GASTO del dueño en el campo compartido', async () => {
    const ov = await getOverview(Number(member.userId), [fieldId], RANGE, { includeUnassigned: false });
    // 200.000 del dueño + 75.000 del miembro.
    expect(ov.money.ARS.expense).toBe(275000);
    expect(ov.money.ARS.expenseCount).toBe(2);
  });

  it('el miembro ve la ACTIVIDAD agronómica del dueño (el bug de eventScope)', async () => {
    const ov = await getOverview(Number(member.userId), [fieldId], RANGE, { includeUnassigned: false });
    // Antes contaba 1: solo la pulverización que había cargado él.
    expect(ov.activities.count).toBe(2);
  });

  it('el DUEÑO ve lo que cargó el miembro', async () => {
    const ov = await getOverview(Number(owner.userId), [fieldId], RANGE, { includeUnassigned: false });
    expect(ov.money.ARS.expense).toBe(275000);
    expect(ov.activities.count).toBe(2);
  });

  it('un campo propio SIN fila en field_members sigue siendo del dueño', async () => {
    // La fila `owner` la crea `getOrCreateField` como efecto colateral. El
    // Resumen no puede depender de que ese insert haya corrido alguna vez.
    const solo = await owner.q(
      `INSERT INTO fields (user_id, name) VALUES ($1, 'Sin Membresia') RETURNING id`,
      [owner.userId],
    );
    const soloId = solo[0].id as number;
    const ids = await resolveFieldIds(Number(owner.userId), soloId);
    expect(ids).toEqual([soloId]);
    await owner.q(`DELETE FROM fields WHERE id = $1`, [soloId]);
  });
});
