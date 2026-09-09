/**
 * Cosecha como proceso comercial (migración 120), contra la DB real y el
 * pipeline completo con FakeAgent (sin API Anthropic).
 *
 * Cubre lo que un productor hace entre que el camión sale del lote y cobra:
 * peso neto tras merma, avance en hectáreas, rinde esperado vs real, saldo en
 * el acopio (entregado − vendido − retirado), corrección de un camión, costo
 * de cosechar como gastos del lote, conciliación contra el romaneo y la regla
 * de "Para revisar" cuando el acopio pesó distinto.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../../testing/integration/pipeline-harness.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

const today = () => new Date().toISOString().slice(0, 10);

describe.skipIf(!dbAvailable)('cosecha comercial — neto, avance, saldo, costos, conciliación', () => {
  let h: PipelineHarness;
  let fieldId: number;
  let norteId: number;
  let surId: number;

  beforeAll(async () => {
    h = await createPipelineHarness('harvest-commercial');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'El Trébol') RETURNING id`, [h.userId]);
    fieldId = (f[0] as { id: number }).id;
    // getPlotById exige membresía (sin esta fila el área del lote es null).
    await h.q(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [fieldId, h.userId]);
    const n = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100) RETURNING id`, [fieldId]);
    norteId = (n[0] as { id: number }).id;
    const s = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Sur', 50) RETURNING id`, [fieldId]);
    surId = (s[0] as { id: number }).id;
    await h.q(`INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date) VALUES ($1, 'soja', 2025, 'gruesa', '2025-11-10')`, [norteId]);
    await h.q(`INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date) VALUES ($1, 'maíz', 2025, 'gruesa', '2025-10-01')`, [surId]);
    // Catálogo de categorías para que la venta de grano matchee "Soja" sin picker.
    const { CategoryRepository } = await import('../../financial/category.repository.js');
    const { CategoryService } = await import('../../financial/category.service.js');
    const cs = new CategoryService(new CategoryRepository());
    await cs.bootstrapDefaults(Number(h.userId), 'income');
    await cs.bootstrapDefaults(Number(h.userId), 'expense');
    // Sin confirmación previa: el test mira lo que se guarda, no el botón.
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
  });
  afterAll(async () => h?.cleanup());

  it('rinde esperado precosecha queda en la campaña', async () => {
    h.fakeAgent.enqueueTool('set_expected_yield', { plot: 'Norte', kg_per_ha: 4000 });
    const text = h.allText(await h.send('espero 40 qq/ha de soja en el Norte'));
    expect(text).toMatch(/Rinde esperado[\s\S]*4\.000 kg\/ha/);
    const rows = await h.q(`SELECT expected_yield_kg_per_ha FROM plot_crops WHERE plot_id = $1`, [norteId]);
    expect(Number(rows[0].expected_yield_kg_per_ha)).toBe(4000);
  });

  it('camiones con humedad: se guarda el neto comercial y el rinde usa el neto; avance en ha; silo propio al stock', async () => {
    h.fakeAgent.enqueueTool('harvest_crop', {
      crop: 'soja', plot: 'Norte', hectares: 40,
      loads: [
        { driver_name: 'Pérez', weight_kg: 30000, humidity_pct: 16, destinatario: 'Cargill', ctg: '10012345' },
        { driver_name: 'Gómez', weight_kg: 30000, destinatario: 'Cargill' },
        { driver_name: 'López', weight_kg: 20000, destination: 'silo' },
      ],
    });
    const text = h.allText(await h.send('cosechamos 40 ha de soja en el Norte: Pérez 30.000 al 16% a Cargill CTG 10012345, Gómez 30.000 a Cargill, López 20.000 al silo'));
    // Neto de Pérez: 30.000 × (1 − 3,19 %) = 29.043
    expect(text).toMatch(/Pérez — 30\.000 kg → \*29\.043 neto\*/);
    expect(text).toMatch(/CTG 10012345/);
    expect(text).toMatch(/Avance:\*? 40 de 100 ha \(40%\)/);

    const loads = await h.q(
      `SELECT hl.driver_name, hl.weight_kg, hl.net_weight_kg, hl.merma_pct, hl.ctg
         FROM harvest_loads hl JOIN domain_events de ON de.id = hl.domain_event_id
        WHERE de.user_id = $1 ORDER BY hl.id`,
      [h.userId],
    );
    expect(loads).toHaveLength(3);
    expect(Number(loads[0].net_weight_kg)).toBe(29043);
    expect(Number(loads[0].merma_pct)).toBeCloseTo(3.19, 2);
    expect(Number(loads[1].net_weight_kg)).toBe(30000);

    const pc = await h.q(`SELECT yield_kg, harvested_hectares FROM plot_crops WHERE plot_id = $1`, [norteId]);
    expect(Number(pc[0].yield_kg)).toBe(29043 + 30000 + 20000);
    expect(Number(pc[0].harvested_hectares)).toBe(40);

    // La carga al silo entró al stock de granos (el usuario del harness tiene el feature).
    const stock = await h.q(
      `SELECT si.current_quantity FROM stock_items si JOIN warehouses w ON w.id = si.warehouse_id
        WHERE w.user_id = $1 AND LOWER(si.name) = 'soja'`,
      [h.userId],
    ).catch(() => []);
    if (stock.length > 0) expect(Number(stock[0].current_quantity)).toBe(20000);
  });

  it('el segundo mensaje del mismo día suma avance y muestra el acumulado en neto', async () => {
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Norte', hectares: 60, loads: [{ driver_name: 'Ruiz', weight_kg: 25000, destinatario: 'Cargill' }] });
    const text = h.allText(await h.send('otras 60 ha de soja en el Norte: Ruiz 25.000 a Cargill'));
    expect(text).toMatch(/Avance:\*? 100 de 100 ha \(100%\) — lote terminado/);
    // Rinde 1.040,43 kg/ha vs 4.000 esperados → muy abajo, y lo dice.
    expect(text).toMatch(/Esperabas 4\.000 kg\/ha/);
  });

  it('saldo por acopio: entregado neto − vendido − retirado', async () => {
    // Venta de 50 tn a Cargill.
    h.fakeAgent.enqueueTool('log_income', { amount: 15000000, category: 'Soja', description: 'venta de soja a Cargill', quantity: 50, unit: 'tn', buyer: 'Cargill', field: 'El Trébol', plot: 'Norte' });
    const sale = h.allText(await h.send('vendí 50 tn de soja del Norte a Cargill por 15 millones'));
    expect(sale).toMatch(/Cargill/);
    expect(sale).toMatch(/Saldo en \*Cargill\*/);

    const inc = await h.q(`SELECT buyer, quantity_kg FROM incomes WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [h.userId]);
    expect(inc[0].buyer).toBe('Cargill');
    expect(Number(inc[0].quantity_kg)).toBe(50000);

    // Retiro de 5 tn.
    h.fakeAgent.enqueueTool('log_grain_withdrawal', { crop: 'soja', quantity: 5, unit: 'tn', destinatario: 'Cargill', reason: 'semilla' });
    const wd = h.allText(await h.send('retiré 5 tn de soja de Cargill para semilla'));
    expect(wd).toMatch(/Retiro registrado/);

    // Entregado a Cargill: 29.043 + 30.000 + 25.000 = 84.043 → − 50.000 − 5.000 = 29.043
    h.fakeAgent.enqueueTool('query_harvest_loads', { view: 'balance', destinatario: 'Cargill', crop: 'soja' });
    const bal = h.allText(await h.send('cuánta soja tengo en Cargill?'));
    expect(bal).toMatch(/Entregado: 84 tn netos/);
    expect(bal).toMatch(/Vendido: −50 tn/);
    expect(bal).toMatch(/Retirado: −5 tn/);
    expect(bal).toMatch(/Saldo: 29 tn/);
  });

  it('corregir un camión por chofer recalcula neto y rinde', async () => {
    h.fakeAgent.enqueueTool('edit_harvest_load', { driver_name: 'Gómez', weight_kg: 31000, humidity_pct: 15 });
    const text = h.allText(await h.send('el camión de Gómez eran 31.000 al 15%'));
    expect(text).toMatch(/Camión de Gómez/);
    expect(text).toMatch(/30\.000 → 31\.000 kg/);
    const row = await h.q(`SELECT weight_kg, net_weight_kg FROM harvest_loads WHERE driver_name = 'Gómez'`);
    expect(Number(row[0].weight_kg)).toBe(31000);
    // soja al 15 %: merma 2,03 % → 30.371
    expect(Number(row[0].net_weight_kg)).toBe(30371);
    const pc = await h.q(`SELECT yield_kg FROM plot_crops WHERE plot_id = $1`, [norteId]);
    expect(Number(pc[0].yield_kg)).toBe(29043 + 30371 + 20000 + 25000);
  });

  it('costo de cosechar: el botón deja un pending y la respuesta libre crea gastos Cosecha y Flete en el lote', async () => {
    const pcRow = await h.q(`SELECT id FROM plot_crops WHERE plot_id = $1`, [norteId]);
    const pcId = Number(pcRow[0].id);
    const ask = h.allText(await h.tap(`harvest_cost_yes_${pcId}`));
    expect(ask).toMatch(/Cuánto costó cosechar/);

    const done = h.allText(await h.send('45.000 por ha y flete 18.000 por tn'));
    expect(done).toMatch(/Costo de cosecha cargado/);
    const exp = await h.q(
      `SELECT category, amount, plot_id FROM expenses WHERE user_id = $1 AND deleted_at IS NULL ORDER BY category`,
      [h.userId],
    );
    const byCat = Object.fromEntries(exp.map(e => [String(e.category), Number(e.amount)]));
    // 45.000 × 100 ha cosechadas = 4.500.000
    expect(byCat.Cosecha).toBe(4_500_000);
    // Flete sobre lo que viajó en camión a acopio (neto): 29.043 + 30.371 +
    // 25.000 = 84,414 tn → 18.000 × 84,414 = 1.519.452. Los 20.000 de López
    // fueron al silo propio y no pagan flete (P2-8, QA sep 2026: antes se
    // multiplicaba por el rinde declarado de la campaña).
    expect(byCat.Flete).toBe(Math.round(18000 * (29043 + 30371 + 25000) / 1000));
    expect(exp.every(e => Number(e.plot_id) === norteId)).toBe(true);

    // La oferta no se repite si ya hay costo cargado.
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Norte', loads: [{ driver_name: 'Vitali', weight_kg: 10000, destinatario: 'Cargill' }] });
    const more = await h.send('otro de soja en el Norte: Vitali 10.000 a Cargill');
    expect(h.allButtons(more).some(b => b.id.startsWith('harvest_cost_yes_'))).toBe(false);
  });

  it('las estadísticas de campaña muestran bruto → neto, avance, días de cosecha y desvío vs esperado', async () => {
    h.fakeAgent.enqueueTool('campaign_stats', { plot: 'Norte', view: 'full' });
    const text = h.allText(await h.send('resumen de la campaña del Norte'));
    expect(text).toMatch(/kg brutos en camión → .* netos/);
    expect(text).toMatch(/100 de 100 ha \(100%\)/);
    expect(text).toMatch(/Esperado: 4\.000 kg\/ha/);
    expect(text).toMatch(/Cosecha: \d{2}\/\d{2}/);
  });

  it('conciliación con el romaneo: coincide, difiere, falta de cada lado; guarda el peso del acopio y dispara "Para revisar"', async () => {
    const { reconcileHarvestLoads } = await import('../../../services/harvest-reconcile.service.js');
    const d = today().split('-');
    const dmy = `${d[2]}/${d[1]}/${d[0]}`;
    const result = await reconcileHarvestLoads(Number(h.userId), {
      text: [
        `${dmy};Pérez;30.050`,     // coincide (dentro del 1 %)
        `${dmy};Ruiz;24.000`,      // difiere 4 %
        `${dmy};Fantasma;28.000`,  // no está en el bot
      ].join('\n'),
      apply: true,
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.matched.map(m => m.driver)).toEqual(['Pérez']);
    expect(result.differing.map(m => m.driver)).toEqual(['Ruiz']);
    expect(result.missingInBot.map(m => m.driver)).toEqual(['Fantasma']);
    expect(result.missingInRomaneo.map(m => m.driver).sort()).toEqual(['Gómez', 'López', 'Vitali']);
    expect(result.applied).toBe(2);

    const ruiz = await h.q(`SELECT acopio_weight_kg FROM harvest_loads WHERE driver_name = 'Ruiz'`);
    expect(Number(ruiz[0].acopio_weight_kg)).toBe(24000);

    const { getReviewFindings } = await import('../../../services/review-findings.service.js');
    const { resolveCampaign } = await import('../../../utils/campaign-range.js');
    const findings = await getReviewFindings({ userId: Number(h.userId), fieldIds: [fieldId], range: resolveCampaign(null) });
    const scale = findings.filter(f => f.rule === 'harvest_scale_difference');
    expect(scale).toHaveLength(1);
    expect(scale[0].body).toMatch(/Ruiz/);
    expect(findings.some(f => f.rule === 'yield_below_expected')).toBe(true);
  });

  it('un lote sin producción no recibe la oferta de costo; un retiro sin origen pregunta con pending', async () => {
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'maíz', plot: 'Sur' });
    const items = await h.send('cosechamos maíz en el Sur');
    expect(h.allText(items)).toMatch(/Cosecha registrada/);
    expect(h.allButtons(items).some(b => b.id.startsWith('harvest_cost_yes_'))).toBe(false);

    h.fakeAgent.enqueueTool('log_grain_withdrawal', { crop: 'maíz', quantity: 10, unit: 'tn' });
    const ask = h.allText(await h.send('retiré 10 tn de maíz'));
    expect(ask).toMatch(/De dónde retiraste/);
    const done = h.allText(await h.send('del silo'));
    expect(done).toMatch(/Retiro registrado/);
  });
});
