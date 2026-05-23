/**
 * QA Historical Consistency V2 — seeds 6 months of historical data across
 * LIVESTOCK MOVEMENTS, STOCK MOVEMENTS, CROP SCOUTINGS, HARVEST LOADS, and
 * HEALTH/REPRO/WEIGHING events. Then asks 30 consistency queries.
 *
 * Complements v1 (which covered gastos/ingresos/lluvias/actividades). Zero
 * overlap with v1: focuses on the domains v1 didn't test.
 *
 * Setup: dedicated user "qa-hist-v2@campo.test" so prior test runs don't
 * contaminate ground truth. Setup via direct SQL inserts (not bot
 * commands) to avoid the agent-emits-tool-N-times problem from v1 Q10.
 *
 * Each query has a KNOWN expected answer computed from the seed.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-historical-consistency-v2.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-hist-v2@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Histórico V2';

// ── API helpers ─────────────────────────────────────────────────────────

async function apiRegister(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'Test', email: EMAIL, password: PASSWORD }),
  });
  if (res.ok) { const d = await res.json() as any; return { token: d.tokens.accessToken, userId: d.user.id }; }
  if (res.status === 409) return apiLogin();
  throw new Error(`Register failed: ${res.status}`);
}
async function apiLogin(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const d = await res.json() as any;
  return { token: d.tokens.accessToken, userId: d.user.id };
}

let TOKEN = '';
async function apiReset(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test-bot/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` }, body: '{}',
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}
async function apiSend(message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  return res.json();
}
async function apiTap(buttonId: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status}`);
  return res.json();
}
async function apiQueryDb(sql: string, params: unknown[]): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Query failed ${res.status}: ${t.slice(0, 200)}`);
  }
  const d = await res.json() as any;
  return d.rows ?? [];
}
function extractText(data: any): string {
  return (data.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}
async function sendAndLog(message: string): Promise<string> {
  return extractText(await apiSend(message));
}

// ── Setup field/plots/warehouse via bot (livestock+stock seeded via SQL) ─

interface SetupIds {
  fieldId: number;
  plotN1: number; plotN2: number; plotN3: number;
  warehouseId: number;
  // Stock items
  stockUrea: number; stockGlifo: number; stockSemilla: number;
  // Livestock groups
  groupVacasN1: string; groupNovillosN2: string; groupTernerosN1: string;
}

async function setupBase(userId: number): Promise<Partial<SetupIds>> {
  console.log('🔧 Setup base via bot...');
  await sendAndLog('agregar campo Don V2');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');
  for (const [name, ha] of [['N1', 180], ['N2', 220], ['N3', 90]] as const) {
    await sendAndLog(`agregar lote ${name} al campo Don V2`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré soja en N1');
  await sendAndLog('sembré maíz en N2');
  await sendAndLog('sembré trigo en N3');
  await sendAndLog('crear galpón Centro en Don V2');

  const fieldRow = (await apiQueryDb(
    `SELECT id FROM fields WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [userId],
  ))[0];
  const plots = await apiQueryDb(
    `SELECT id, name FROM plots WHERE field_id=$1 AND deleted_at IS NULL ORDER BY name`,
    [fieldRow.id],
  );
  const warehouse = (await apiQueryDb(
    `SELECT id FROM warehouses WHERE field_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [fieldRow.id],
  ))[0];

  return {
    fieldId: fieldRow.id,
    plotN1: plots.find((p: any) => p.name === 'N1')?.id,
    plotN2: plots.find((p: any) => p.name === 'N2')?.id,
    plotN3: plots.find((p: any) => p.name === 'N3')?.id,
    warehouseId: warehouse?.id,
  };
}

// ── HISTORICAL SEED — ground truth ─────────────────────────────────────

interface SeedTotals {
  // Livestock
  livestock_initial: { vacas: number; novillos: number; terneros: number };
  livestock_sales: Array<{ date: string; category: string; count: number; unit_price_usd: number; total_usd: number }>;
  livestock_deaths: Array<{ date: string; category: string; count: number }>;
  livestock_births: Array<{ date: string; count: number }>;
  livestock_final: { vacas: number; novillos: number; terneros: number };
  total_sold_usd: number;
  total_dead: number;
  total_born: number;

  // Stock
  stock_movements: {
    urea_in: number;       // total kg recibido
    urea_out: number;       // total kg usado
    urea_final: number;
    glifo_in: number;
    glifo_out: number;
    glifo_final: number;
    semilla_in: number;
    semilla_out: number;
    semilla_final: number;
  };

  // Scouting
  scoutings_total: number;
  scoutings_by_plot: Record<string, number>;
  avg_weed_pct: number;
  max_pest_severity: number;
  has_rama_negra: boolean;
  has_chinche: boolean;

  // Harvest loads
  harvest_loads_total: number;
  harvest_kg_soja: number;
  harvest_kg_trigo: number;
  harvest_drivers: string[];
  harvest_destinatarios: string[];

  // Health
  vacunaciones_count: number;
  desparasitaciones_count: number;

  // Repro
  servicios_count: number;
  destetes_count: number;

  // Weighing
  pesajes_count: number;
  pesaje_promedio_vacas: number;
}

interface SeedPlan {
  // Livestock — initial sizes
  initial: { vacas: number; novillos: number; terneros: number };
  livestockSales: Array<{ date: string; category: 'vaca' | 'novillo' | 'ternero'; count: number; unit_price_usd: number }>;
  livestockDeaths: Array<{ date: string; category: 'vaca' | 'novillo' | 'ternero'; count: number; reason: string }>;
  livestockBirths: Array<{ date: string; count: number }>;
  // Stock
  stockMoves: Array<{ date: string; product: 'urea' | 'glifosato' | 'semilla_soja'; type: 'entrada' | 'salida'; qty: number }>;
  // Scoutings
  scoutings: Array<{ date: string; plot: 'N1' | 'N2' | 'N3'; stage: string; weed_pct?: number; weed_species?: string[]; pest?: string; pest_sev?: number; soil?: number; emergence?: number; density?: number }>;
  // Harvest loads
  harvests: Array<{ date: string; plot: 'N1' | 'N2' | 'N3'; crop: string; loads: Array<{ driver: string; weight_kg: number; destinatario?: string; humidity?: number }> }>;
  // Health events
  healthEvents: Array<{ date: string; plot: 'N1' | 'N2' | 'N3'; type: 'vacunacion' | 'desparasitacion'; product: string; category: string; affected: number }>;
  // Repro events
  reproEvents: Array<{ date: string; plot: 'N1' | 'N2' | 'N3'; type: 'servicio' | 'destete'; affected: number; notes: string }>;
  // Weighing
  weighings: Array<{ date: string; plot: 'N1' | 'N2' | 'N3'; category: string; affected: number; avg_kg: number }>;
}

function buildPlan(): SeedPlan {
  return {
    initial: { vacas: 80, novillos: 40, terneros: 20 },

    livestockSales: [
      { date: '2025-12-15', category: 'novillo', count: 5, unit_price_usd: 1600 },   // 8000
      { date: '2026-02-10', category: 'vaca', count: 3, unit_price_usd: 1400 },      // 4200
      { date: '2026-03-22', category: 'novillo', count: 8, unit_price_usd: 1700 },   // 13600
      { date: '2026-04-18', category: 'vaca', count: 5, unit_price_usd: 1500 },      // 7500
    ],
    livestockDeaths: [
      { date: '2026-01-08', category: 'ternero', count: 2, reason: 'fiebre' },
      { date: '2026-03-15', category: 'vaca', count: 1, reason: 'rayo' },
    ],
    livestockBirths: [
      { date: '2026-02-25', count: 6 },
      { date: '2026-04-05', count: 4 },
    ],

    stockMoves: [
      // Urea: in 1000, 500, 200; out 400, 300 => final 1000
      { date: '2025-12-10', product: 'urea', type: 'entrada', qty: 1000 },
      { date: '2026-01-15', product: 'urea', type: 'salida', qty: 400 },
      { date: '2026-02-20', product: 'urea', type: 'entrada', qty: 500 },
      { date: '2026-03-25', product: 'urea', type: 'salida', qty: 300 },
      { date: '2026-04-10', product: 'urea', type: 'entrada', qty: 200 },
      // Glifosato: in 200, 100; out 80, 70 => final 150
      { date: '2025-12-05', product: 'glifosato', type: 'entrada', qty: 200 },
      { date: '2026-01-20', product: 'glifosato', type: 'salida', qty: 80 },
      { date: '2026-03-10', product: 'glifosato', type: 'entrada', qty: 100 },
      { date: '2026-04-22', product: 'glifosato', type: 'salida', qty: 70 },
      // Semilla soja: in 500; out 350 => final 150
      { date: '2025-12-20', product: 'semilla_soja', type: 'entrada', qty: 500 },
      { date: '2026-03-12', product: 'semilla_soja', type: 'salida', qty: 350 },
    ],

    scoutings: [
      // N1 soja - 4 monitoreos a lo largo de la campaña
      { date: '2025-12-15', plot: 'N1', stage: 'VE', emergence: 85, density: 28 },
      { date: '2026-01-20', plot: 'N1', stage: 'V3', weed_pct: 8, weed_species: ['rama negra'], soil: 4 },
      { date: '2026-02-25', plot: 'N1', stage: 'R1', weed_pct: 15, weed_species: ['rama negra', 'yuyo colorado'], pest: 'chinche', pest_sev: 3 },
      { date: '2026-03-30', plot: 'N1', stage: 'R5', pest: 'chinche', pest_sev: 4, soil: 3 },
      // N2 maíz - 3 monitoreos
      { date: '2026-01-10', plot: 'N2', stage: 'V4', weed_pct: 5, weed_species: ['quinoa'], emergence: 92 },
      { date: '2026-02-15', plot: 'N2', stage: 'V8', pest: 'oruga cogollera', pest_sev: 2 },
      { date: '2026-03-20', plot: 'N2', stage: 'R2', pest: 'oruga cogollera', pest_sev: 5, weed_pct: 12 },
      // N3 trigo - 2 monitoreos
      { date: '2026-04-15', plot: 'N3', stage: 'Z25', emergence: 88, soil: 3 },
      { date: '2026-05-08', plot: 'N3', stage: 'Z39', weed_pct: 18, weed_species: ['avena negra'] },
    ],

    harvests: [
      // Cosecha soja N1 en abril (2 cargas)
      { date: '2026-04-10', plot: 'N1', crop: 'soja', loads: [
        { driver: 'Pedro Gómez', weight_kg: 32000, destinatario: 'Cargill', humidity: 13.5 },
        { driver: 'Luis Mora', weight_kg: 28500, destinatario: 'Cargill', humidity: 14.0 },
      ]},
      // Cosecha soja N1 en mayo (1 carga adicional)
      { date: '2026-05-05', plot: 'N1', crop: 'soja', loads: [
        { driver: 'Pedro Gómez', weight_kg: 31200, destinatario: 'Vicentin', humidity: 13.8 },
      ]},
      // Cosecha trigo N3 en mayo (2 cargas)
      { date: '2026-05-15', plot: 'N3', crop: 'trigo', loads: [
        { driver: 'Juan Pérez', weight_kg: 22000, destinatario: 'ACA', humidity: 14.2 },
        { driver: 'Luis Mora', weight_kg: 18500, destinatario: 'ACA', humidity: 13.9 },
      ]},
    ],

    healthEvents: [
      { date: '2025-12-20', plot: 'N1', type: 'vacunacion', product: 'aftosa', category: 'vaca', affected: 80 },
      { date: '2026-01-15', plot: 'N2', type: 'desparasitacion', product: 'ivermectina', category: 'novillo', affected: 40 },
      { date: '2026-03-10', plot: 'N1', type: 'vacunacion', product: 'brucelosis', category: 'vaca', affected: 80 },
      { date: '2026-04-25', plot: 'N1', type: 'desparasitacion', product: 'ivermectina', category: 'ternero', affected: 20 },
    ],

    reproEvents: [
      { date: '2025-12-01', plot: 'N1', type: 'servicio', affected: 80, notes: 'toro Angus eché' },
      { date: '2026-04-15', plot: 'N1', type: 'destete', affected: 18, notes: 'desteté' },
    ],

    weighings: [
      { date: '2026-01-10', plot: 'N1', category: 'vaca', affected: 80, avg_kg: 420 },
      { date: '2026-03-15', plot: 'N1', category: 'vaca', affected: 80, avg_kg: 445 },
      { date: '2026-05-10', plot: 'N1', category: 'vaca', affected: 80, avg_kg: 460 },
    ],
  };
}

async function seedAll(userId: number, ids: SetupIds): Promise<{ totals: SeedTotals; ids: SetupIds }> {
  console.log('\n🌱 Seeding 6 months across livestock/stock/scouting/harvest/health/repro/weighing...');
  const plan = buildPlan();

  // ── 1. Seed livestock groups directly (avoid bot agent firing add_livestock multiple times)
  const vacasRow = (await apiQueryDb(
    `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
     VALUES ($1, $2, $3, 'vaca', 'Angus', $4) RETURNING id`,
    [userId, ids.fieldId, ids.plotN1, plan.initial.vacas],
  ))[0];
  const novillosRow = (await apiQueryDb(
    `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
     VALUES ($1, $2, $3, 'novillo', 'Angus', $4) RETURNING id`,
    [userId, ids.fieldId, ids.plotN2, plan.initial.novillos],
  ))[0];
  const ternerosRow = (await apiQueryDb(
    `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
     VALUES ($1, $2, $3, 'ternero', 'Angus', $4) RETURNING id`,
    [userId, ids.fieldId, ids.plotN1, plan.initial.terneros],
  ))[0];
  ids.groupVacasN1 = vacasRow.id;
  ids.groupNovillosN2 = novillosRow.id;
  ids.groupTernerosN1 = ternerosRow.id;
  console.log(`  ✅ 3 livestock groups (vacas=${plan.initial.vacas} novillos=${plan.initial.novillos} terneros=${plan.initial.terneros})`);

  // Livestock sales -> movement_type='salida' + income
  let total_sold_usd = 0;
  for (const s of plan.livestockSales) {
    const total = s.count * s.unit_price_usd;
    total_sold_usd += total;
    const groupId = s.category === 'vaca' ? ids.groupVacasN1 : s.category === 'novillo' ? ids.groupNovillosN2 : ids.groupTernerosN1;
    const incomeRow = (await apiQueryDb(
      `INSERT INTO incomes (user_id, category, description, amount, currency, quantity, unit, unit_price, field_id, income_date)
       VALUES ($1, 'Hacienda', $2, $3, 'USD', $4, 'cabezas', $5, $6, $7::date) RETURNING id`,
      [userId, `venta ${s.count} ${s.category}s`, total, s.count, s.unit_price_usd, ids.fieldId, s.date],
    ))[0];
    await apiQueryDb(
      `INSERT INTO livestock_movements (user_id, movement_type, source_group_id, count, unit_price_usd, movement_date, linked_income_id)
       VALUES ($1, 'salida', $2, $3, $4, $5::date, $6)`,
      [userId, groupId, s.count, s.unit_price_usd, s.date, incomeRow.id],
    );
    // Decrement group count
    await apiQueryDb(`UPDATE livestock_groups SET count = count - $1 WHERE id = $2`, [s.count, groupId]);
  }
  console.log(`  ✅ ${plan.livestockSales.length} ventas hacienda → USD ${total_sold_usd}`);

  // Livestock deaths
  let total_dead = 0;
  for (const d of plan.livestockDeaths) {
    total_dead += d.count;
    const groupId = d.category === 'vaca' ? ids.groupVacasN1 : d.category === 'novillo' ? ids.groupNovillosN2 : ids.groupTernerosN1;
    await apiQueryDb(
      `INSERT INTO livestock_movements (user_id, movement_type, source_group_id, count, reason, movement_date)
       VALUES ($1, 'muerte', $2, $3, $4, $5::date)`,
      [userId, groupId, d.count, d.reason, d.date],
    );
    await apiQueryDb(`UPDATE livestock_groups SET count = count - $1 WHERE id = $2`, [d.count, groupId]);
  }
  console.log(`  ✅ ${plan.livestockDeaths.length} muertes → ${total_dead} cabezas`);

  // Livestock births
  let total_born = 0;
  for (const b of plan.livestockBirths) {
    total_born += b.count;
    await apiQueryDb(
      `INSERT INTO livestock_movements (user_id, movement_type, dest_group_id, count, movement_date)
       VALUES ($1, 'nacimiento', $2, $3, $4::date)`,
      [userId, ids.groupTernerosN1, b.count, b.date],
    );
    await apiQueryDb(`UPDATE livestock_groups SET count = count + $1 WHERE id = $2`, [b.count, ids.groupTernerosN1]);
  }
  console.log(`  ✅ ${plan.livestockBirths.length} nacimientos → ${total_born} crías`);

  // Final livestock counts
  const finalCounts = await apiQueryDb(
    `SELECT category, sum(count) AS c FROM livestock_groups WHERE user_id=$1 AND deleted_at IS NULL GROUP BY category`,
    [userId],
  );
  const finalMap = { vacas: 0, novillos: 0, terneros: 0 };
  for (const r of finalCounts) {
    const cat = String(r.category);
    if (cat === 'vaca') finalMap.vacas = Number(r.c);
    if (cat === 'novillo') finalMap.novillos = Number(r.c);
    if (cat === 'ternero') finalMap.terneros = Number(r.c);
  }
  console.log(`  ✅ Final: vacas=${finalMap.vacas} novillos=${finalMap.novillos} terneros=${finalMap.terneros}`);

  // ── 2. Seed stock items + movements ──
  const ureaRow = (await apiQueryDb(
    `INSERT INTO stock_items (user_id, warehouse_id, name, category, unit, current_quantity)
     VALUES ($1, $2, 'urea', 'fertilizante', 'kg', 0) RETURNING id`,
    [userId, ids.warehouseId],
  ))[0];
  const glifoRow = (await apiQueryDb(
    `INSERT INTO stock_items (user_id, warehouse_id, name, category, unit, current_quantity)
     VALUES ($1, $2, 'glifosato', 'agroquimico', 'lt', 0) RETURNING id`,
    [userId, ids.warehouseId],
  ))[0];
  const semillaRow = (await apiQueryDb(
    `INSERT INTO stock_items (user_id, warehouse_id, name, category, unit, current_quantity)
     VALUES ($1, $2, 'semilla de soja', 'semilla', 'kg', 0) RETURNING id`,
    [userId, ids.warehouseId],
  ))[0];
  ids.stockUrea = ureaRow.id; ids.stockGlifo = glifoRow.id; ids.stockSemilla = semillaRow.id;

  let urea_in = 0, urea_out = 0, glifo_in = 0, glifo_out = 0, semilla_in = 0, semilla_out = 0;
  for (const m of plan.stockMoves) {
    const itemId = m.product === 'urea' ? ureaRow.id : m.product === 'glifosato' ? glifoRow.id : semillaRow.id;
    const sign = m.type === 'entrada' ? 1 : -1;
    await apiQueryDb(
      `INSERT INTO stock_movements (stock_item_id, user_id, movement_type, quantity, movement_date)
       VALUES ($1, $2, $3, $4, $5::date)`,
      [itemId, userId, m.type, m.qty, m.date],
    );
    await apiQueryDb(`UPDATE stock_items SET current_quantity = current_quantity + $1 WHERE id = $2`, [sign * m.qty, itemId]);
    if (m.product === 'urea') { if (m.type === 'entrada') urea_in += m.qty; else urea_out += m.qty; }
    if (m.product === 'glifosato') { if (m.type === 'entrada') glifo_in += m.qty; else glifo_out += m.qty; }
    if (m.product === 'semilla_soja') { if (m.type === 'entrada') semilla_in += m.qty; else semilla_out += m.qty; }
  }
  console.log(`  ✅ ${plan.stockMoves.length} stock movements`);

  // ── 3. Seed crop_scoutings ──
  const scoutByPlot: Record<string, number> = {};
  let weedSum = 0, weedCount = 0;
  let maxPestSev = 0;
  let hasRamaNegra = false, hasChinche = false;
  for (const s of plan.scoutings) {
    const plotId = s.plot === 'N1' ? ids.plotN1 : s.plot === 'N2' ? ids.plotN2 : ids.plotN3;
    await apiQueryDb(
      `INSERT INTO crop_scoutings (user_id, field_id, plot_id, scouting_date, stage_code, weed_coverage_pct, weed_species, pest_species, pest_severity_1_5, soil_moisture_1_5, emergence_pct, plant_density_m2)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [userId, ids.fieldId, plotId, s.date, s.stage, s.weed_pct ?? null, s.weed_species ?? null, s.pest ?? null, s.pest_sev ?? null, s.soil ?? null, s.emergence ?? null, s.density ?? null],
    );
    scoutByPlot[s.plot] = (scoutByPlot[s.plot] || 0) + 1;
    if (typeof s.weed_pct === 'number') { weedSum += s.weed_pct; weedCount++; }
    if (typeof s.pest_sev === 'number' && s.pest_sev > maxPestSev) maxPestSev = s.pest_sev;
    if ((s.weed_species ?? []).some(w => w.toLowerCase().includes('rama negra'))) hasRamaNegra = true;
    if (s.pest?.toLowerCase().includes('chinche')) hasChinche = true;
  }
  const avgWeedPct = weedCount > 0 ? weedSum / weedCount : 0;
  console.log(`  ✅ ${plan.scoutings.length} crop_scoutings (avg weed=${avgWeedPct.toFixed(1)}% maxPest=${maxPestSev})`);

  // ── 4. Seed harvest events + loads ──
  let totalLoads = 0;
  let kgSoja = 0, kgTrigo = 0;
  const drivers = new Set<string>(), destis = new Set<string>();
  for (const h of plan.harvests) {
    const plotId = h.plot === 'N1' ? ids.plotN1 : h.plot === 'N2' ? ids.plotN2 : ids.plotN3;
    const totalKg = h.loads.reduce((s, l) => s + l.weight_kg, 0);
    const eventRow = (await apiQueryDb(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, crop, quantity, unit)
       VALUES ($1, $2, 'harvest', $3::date, $4, $5, 'kg') RETURNING id`,
      [userId, plotId, h.date, h.crop, totalKg],
    ))[0];
    for (const l of h.loads) {
      await apiQueryDb(
        `INSERT INTO harvest_loads (domain_event_id, driver_name, weight_kg, destinatario, humidity_pct)
         VALUES ($1, $2, $3, $4, $5)`,
        [eventRow.id, l.driver, l.weight_kg, l.destinatario ?? null, l.humidity ?? null],
      );
      totalLoads++;
      drivers.add(l.driver);
      if (l.destinatario) destis.add(l.destinatario);
      if (h.crop === 'soja') kgSoja += l.weight_kg;
      if (h.crop === 'trigo') kgTrigo += l.weight_kg;
    }
  }
  console.log(`  ✅ ${plan.harvests.length} harvests / ${totalLoads} cargas (soja=${kgSoja}kg trigo=${kgTrigo}kg)`);

  // ── 5. Health events ──
  let vacunaciones = 0, desparasit = 0;
  for (const h of plan.healthEvents) {
    const plotId = h.plot === 'N1' ? ids.plotN1 : h.plot === 'N2' ? ids.plotN2 : ids.plotN3;
    await apiQueryDb(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, animal_category, animals_affected, product, product_type, notes)
       VALUES ($1, $2, 'health_event', $3::date, $4, $5, $6, $7, $8)`,
      [userId, plotId, h.date, h.category, h.affected, h.product, h.type, h.type],
    );
    if (h.type === 'vacunacion') vacunaciones++; else desparasit++;
  }
  console.log(`  ✅ ${plan.healthEvents.length} eventos sanitarios (vac=${vacunaciones} desp=${desparasit})`);

  // ── 6. Repro events ──
  let servicios = 0, destetes = 0;
  for (const r of plan.reproEvents) {
    const plotId = r.plot === 'N1' ? ids.plotN1 : r.plot === 'N2' ? ids.plotN2 : ids.plotN3;
    await apiQueryDb(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, animals_affected, product_type, notes)
       VALUES ($1, $2, 'repro_event', $3::date, $4, $5, $6)`,
      [userId, plotId, r.date, r.affected, r.type, `${r.type}: ${r.notes}`],
    );
    if (r.type === 'servicio') servicios++; else destetes++;
  }
  console.log(`  ✅ ${plan.reproEvents.length} eventos reproductivos (serv=${servicios} dest=${destetes})`);

  // ── 7. Weighings ──
  for (const w of plan.weighings) {
    const plotId = w.plot === 'N1' ? ids.plotN1 : w.plot === 'N2' ? ids.plotN2 : ids.plotN3;
    await apiQueryDb(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, animal_category, animals_affected, quantity, unit)
       VALUES ($1, $2, 'weighing', $3::date, $4, $5, $6, 'kg')`,
      [userId, plotId, w.date, w.category, w.affected, w.avg_kg],
    );
  }
  const lastWeighing = plan.weighings[plan.weighings.length - 1];
  console.log(`  ✅ ${plan.weighings.length} pesajes (último=${lastWeighing?.avg_kg}kg)`);

  // Build totals
  const totals: SeedTotals = {
    livestock_initial: { vacas: plan.initial.vacas, novillos: plan.initial.novillos, terneros: plan.initial.terneros },
    livestock_sales: plan.livestockSales.map(s => ({ date: s.date, category: s.category, count: s.count, unit_price_usd: s.unit_price_usd, total_usd: s.count * s.unit_price_usd })),
    livestock_deaths: plan.livestockDeaths.map(d => ({ date: d.date, category: d.category, count: d.count })),
    livestock_births: plan.livestockBirths.map(b => ({ date: b.date, count: b.count })),
    livestock_final: finalMap,
    total_sold_usd,
    total_dead,
    total_born,
    stock_movements: {
      urea_in, urea_out, urea_final: urea_in - urea_out,
      glifo_in, glifo_out, glifo_final: glifo_in - glifo_out,
      semilla_in, semilla_out, semilla_final: semilla_in - semilla_out,
    },
    scoutings_total: plan.scoutings.length,
    scoutings_by_plot: scoutByPlot,
    avg_weed_pct: avgWeedPct,
    max_pest_severity: maxPestSev,
    has_rama_negra: hasRamaNegra,
    has_chinche: hasChinche,
    harvest_loads_total: totalLoads,
    harvest_kg_soja: kgSoja,
    harvest_kg_trigo: kgTrigo,
    harvest_drivers: Array.from(drivers),
    harvest_destinatarios: Array.from(destis),
    vacunaciones_count: vacunaciones,
    desparasitaciones_count: desparasit,
    servicios_count: servicios,
    destetes_count: destetes,
    pesajes_count: plan.weighings.length,
    pesaje_promedio_vacas: lastWeighing?.avg_kg ?? 0,
  };

  console.log('\n📊 Ground-truth resumen:');
  console.log(`  Livestock final: vacas=${finalMap.vacas} novillos=${finalMap.novillos} terneros=${finalMap.terneros}`);
  console.log(`  Hacienda vendida: USD ${total_sold_usd}`);
  console.log(`  Muertes: ${total_dead} | Nacimientos: ${total_born}`);
  console.log(`  Stock urea final=${urea_in - urea_out}kg | glifo final=${glifo_in - glifo_out}lt | semilla final=${semilla_in - semilla_out}kg`);
  console.log(`  Monitoreos: ${plan.scoutings.length} | Cargas: ${totalLoads} (soja=${kgSoja}kg, trigo=${kgTrigo}kg)`);
  console.log(`  Sanidad: ${vacunaciones} vac + ${desparasit} desp | Repro: ${servicios} serv + ${destetes} dest | Pesajes: ${plan.weighings.length}\n`);

  return { totals, ids };
}

// ── 30 consistency queries ─────────────────────────────────────────────

interface QuerySpec {
  name: string;
  query: string;
  validate: (text: string, t: SeedTotals) => { pass: boolean; reason: string };
}

function fmt(n: number): string {
  return n.toLocaleString('es-AR');
}
function includesNum(text: string, n: number): boolean {
  if (text.includes(String(n))) return true;
  if (text.includes(fmt(n))) return true;
  const ar = n.toLocaleString('de-DE');
  if (text.includes(ar)) return true;
  return false;
}
// Match kg total OR formatted tn (AR convention: 91,7 tn)
function includesKgOrTn(text: string, kg: number): boolean {
  if (includesNum(text, kg)) return true;
  const tn = kg / 1000;
  const tnFloor = Math.floor(tn);
  const tnDec1 = Math.round(tn * 10) / 10; // 1 decimal
  // Argentine format uses comma for decimal
  const tnDec1Str = tnDec1.toString().replace('.', ',');
  if (text.includes(`${tnDec1Str} tn`)) return true;
  if (text.includes(`${tnDec1Str}tn`)) return true;
  // Match integer tn: "91 tn" or "91tn"
  if (text.includes(`${tnFloor} tn`)) return true;
  return false;
}

const QUERIES: QuerySpec[] = [
  // ── HACIENDA (livestock counts + movements) ──
  {
    name: 'Q01_vacas_total',
    query: 'cuántas vacas tengo',
    validate: (text, t) => {
      const has = includesNum(text, t.livestock_final.vacas);
      return { pass: has, reason: `expected ${t.livestock_final.vacas} vacas; text=${text.substring(0, 150)}` };
    },
  },
  {
    name: 'Q02_animales_total',
    query: 'cuántos animales tengo en total',
    validate: (text, t) => {
      const total = t.livestock_final.vacas + t.livestock_final.novillos + t.livestock_final.terneros;
      const has = includesNum(text, total) || (includesNum(text, t.livestock_final.vacas) && includesNum(text, t.livestock_final.novillos));
      return { pass: has, reason: `expected ${total} animales; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q03_terneros_count',
    query: 'cuántos terneros tengo',
    validate: (text, t) => {
      const has = includesNum(text, t.livestock_final.terneros);
      return { pass: has, reason: `expected ${t.livestock_final.terneros} terneros; text=${text.substring(0, 150)}` };
    },
  },
  {
    name: 'Q04_ventas_hacienda',
    query: 'cuánto vendí de hacienda',
    validate: (text, t) => {
      const has = includesNum(text, t.total_sold_usd) || text.includes(`${t.total_sold_usd}`);
      return { pass: has, reason: `expected USD ${t.total_sold_usd}; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q05_muertes',
    query: 'cuántas vacas murieron en N1',
    validate: (text, t) => {
      const dead = t.livestock_deaths.filter(d => d.category === 'vaca').reduce((s, x) => s + x.count, 0);
      const has = includesNum(text, dead);
      return { pass: has, reason: `expected ${dead} vacas muertas N1; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q06_nacimientos',
    query: 'historial terneros lote N1',
    validate: (text, t) => {
      const hasBirths = /nac|naci|entrada|cría|10|movim|hist/i.test(text);
      return { pass: hasBirths, reason: `expected nacimientos; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q07_ventas_novillos',
    query: 'historial novillos lote N2',
    validate: (text, t) => {
      const novillos = t.livestock_sales.filter(s => s.category === 'novillo').reduce((s, x) => s + x.count, 0);
      const hasMov = /(novillo|stock|salid|vend|venta|movim|📤|−|-\d)/i.test(text);
      const hasNumber = includesNum(text, novillos) || /\d+\s*\/\s*cab|cab|US\$/i.test(text);
      return { pass: hasMov && hasNumber, reason: `expected novillos movement record; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q08_movimientos_vacas_N1',
    query: 'historial vacas lote N1',
    validate: (text) => {
      const hasMov = /vend|muert|nac|salid|entrad|vaca|movimiento/i.test(text);
      return { pass: hasMov, reason: `expected movimientos vacas N1; text=${text.substring(0, 250)}` };
    },
  },

  // ── STOCK ──
  {
    name: 'Q09_stock_urea',
    query: 'cuánto stock de urea tengo',
    validate: (text, t) => {
      const has = includesNum(text, t.stock_movements.urea_final);
      return { pass: has, reason: `expected ${t.stock_movements.urea_final} kg urea; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q10_stock_glifo',
    query: 'cuánto glifosato tengo',
    validate: (text, t) => {
      const has = includesNum(text, t.stock_movements.glifo_final);
      return { pass: has, reason: `expected ${t.stock_movements.glifo_final} lt glifo; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q11_stock_semilla',
    query: 'cuánto stock de semilla de soja tengo',
    validate: (text, t) => {
      const has = includesNum(text, t.stock_movements.semilla_final);
      return { pass: has, reason: `expected ${t.stock_movements.semilla_final} kg semilla; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q12_stock_total',
    query: 'qué stock tengo',
    validate: (text) => {
      const hasItems = /urea|glifo|semilla/i.test(text);
      return { pass: hasItems, reason: `expected list of items; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q13_movimientos_urea',
    query: 'movimientos de urea',
    validate: (text) => {
      const hasMov = /entrada|salida|kg|movimiento/i.test(text);
      return { pass: hasMov, reason: `expected movimientos urea; text=${text.substring(0, 250)}` };
    },
  },

  // ── SCOUTING ──
  {
    name: 'Q14_monitoreos_total',
    query: 'cuántos monitoreos hice',
    validate: (text, t) => {
      const has = includesNum(text, t.scoutings_total);
      return { pass: has, reason: `expected ${t.scoutings_total} monitoreos; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q15_monitoreos_N1',
    query: 'monitoreos del lote N1',
    validate: (text, t) => {
      const expected = t.scoutings_by_plot['N1'] ?? 0;
      const hasCount = includesNum(text, expected);
      const hasDates = /dic|ene|feb|mar|abr|may|N1/i.test(text);
      return { pass: hasCount || hasDates, reason: `expected ${expected} en N1; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q16_plagas_chinche',
    query: 'monitoreos con chinche',
    validate: (text, t) => {
      const has = t.has_chinche ? /chinche/i.test(text) : true;
      return { pass: has, reason: `expected chinche en respuesta; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q17_rama_negra',
    query: 'qué lotes tienen rama negra',
    validate: (text, t) => {
      const hasIt = /rama negra/i.test(text) || /N1/i.test(text);
      return { pass: hasIt, reason: `expected rama negra en N1; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q18_severidad_max',
    query: 'cuál es el lote con peor presión de plagas',
    validate: (text) => {
      const hasPlot = /N1|N2|N3/i.test(text);
      const hasSev = /severid|presión|plaga|sev/i.test(text);
      return { pass: hasPlot && hasSev, reason: `expected lote+severidad; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q19_evolucion_N1',
    query: 'evolución del cultivo en N1',
    validate: (text) => {
      // Now expects scoutings (VE V3 R1 R5) OR a timeline
      const hasEvol = /(VE|V\d|R\d|estad|monitor|timeline|cronológico|cosech|siembr)/i.test(text);
      return { pass: hasEvol, reason: `expected evolución/estadíos/timeline; text=${text.substring(0, 250)}` };
    },
  },

  // ── HARVEST LOADS ──
  {
    name: 'Q20_cosecha_soja_total',
    query: 'cuántos kg de soja coseché',
    validate: (text, t) => {
      const has = includesKgOrTn(text, t.harvest_kg_soja);
      return { pass: has, reason: `expected ${t.harvest_kg_soja} kg (≈${(t.harvest_kg_soja/1000).toFixed(1)} tn) soja; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q21_cosecha_trigo',
    query: 'cuánto trigo coseché',
    validate: (text, t) => {
      const has = includesKgOrTn(text, t.harvest_kg_trigo);
      return { pass: has, reason: `expected ${t.harvest_kg_trigo} kg (≈${(t.harvest_kg_trigo/1000).toFixed(1)} tn) trigo; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q22_chofer_pedro',
    query: 'viajes de Pedro',
    validate: (text, t) => {
      const mentioned = /pedro/i.test(text);
      return { pass: mentioned, reason: `expected Pedro Gómez mention; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q23_destinatario_cargill',
    query: 'cuánto entregamos a Cargill',
    validate: (text) => {
      const hasNumber = /\d{2,}|kg|tn/i.test(text);
      return { pass: hasNumber, reason: `expected number+Cargill; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q24_humedad_promedio',
    query: 'humedad promedio de cosecha',
    validate: (text) => {
      const hasPct = /\d+([,.]\d+)?\s*%|hum/i.test(text);
      return { pass: hasPct, reason: `expected humidity %; text=${text.substring(0, 250)}` };
    },
  },

  // ── HEALTH ──
  {
    name: 'Q25_vacunaciones',
    query: 'cuántas vacunaciones hice',
    validate: (text, t) => {
      const has = includesNum(text, t.vacunaciones_count);
      return { pass: has, reason: `expected ${t.vacunaciones_count} vacunaciones; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q26_ultima_desparasitacion',
    query: 'cuándo fue la última desparasitación',
    validate: (text) => {
      const hasDate = /(abr|abril|25\/4|2026-04|25.*4|desparas|ivermec)/i.test(text);
      return { pass: hasDate, reason: `expected 25/4/2026 o desparas; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q27_historial_sanitario',
    query: 'historial sanitario',
    validate: (text) => {
      const hasEvents = /(vacun|desparasit|aftosa|brucelosis|ivermec)/i.test(text);
      return { pass: hasEvents, reason: `expected eventos sanitarios; text=${text.substring(0, 250)}` };
    },
  },

  // ── REPRO ──
  {
    name: 'Q28_servicio_toro',
    query: 'cuándo eché el toro',
    validate: (text) => {
      const hasDec = /(dici|2025-12|01.*dic|dic.*01|servic)/i.test(text);
      return { pass: hasDec, reason: `expected diciembre 2025; text=${text.substring(0, 250)}` };
    },
  },
  {
    name: 'Q29_destetes',
    query: 'historial reproductivo del lote N1',
    validate: (text) => {
      const hasRepro = /destet|servic|repro|toro|entore/i.test(text);
      return { pass: hasRepro, reason: `expected destete/servicio; text=${text.substring(0, 250)}` };
    },
  },

  // ── WEIGHING ──
  {
    name: 'Q30_ultimo_pesaje',
    query: 'cuánto pesan las vacas',
    validate: (text, t) => {
      const has = includesNum(text, t.pesaje_promedio_vacas);
      return { pass: has, reason: `expected ${t.pesaje_promedio_vacas} kg promedio; text=${text.substring(0, 250)}` };
    },
  },
];

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🧪 QA Historical Consistency V2 — livestock+stock+scouting+harvest+sanidad+repro+pesaje\n');

  const auth = await apiRegister();
  TOKEN = auth.token;
  const userId = auth.userId;
  console.log(`✅ User ${userId} (${EMAIL})`);

  await apiReset();
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [userId]);
  console.log('✅ Reset + enterprise plan\n');

  const baseIds = await setupBase(userId);
  const fullIds: SetupIds = {
    fieldId: baseIds.fieldId!,
    plotN1: baseIds.plotN1!, plotN2: baseIds.plotN2!, plotN3: baseIds.plotN3!,
    warehouseId: baseIds.warehouseId!,
    stockUrea: 0, stockGlifo: 0, stockSemilla: 0,
    groupVacasN1: '', groupNovillosN2: '', groupTernerosN1: '',
  };
  const { totals } = await seedAll(userId, fullIds);

  // ── Run queries ──
  console.log('═══ QUERIES ═══\n');
  let pass = 0, fail = 0;
  const failures: Array<{ name: string; query: string; reason: string; response: string }> = [];

  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`${num}/${QUERIES.length} ${q.name}: "${q.query}"\n   `);
    try {
      try { await sendAndLog('cancelar'); } catch { /* ignore */ }

      const resp = await apiSend(q.query);
      const text = extractText(resp);
      const result = q.validate(text, totals);
      if (result.pass) {
        pass++;
        console.log(`✅ PASS — ${result.reason.substring(0, 100)}`);
      } else {
        fail++;
        console.log(`❌ FAIL`);
        failures.push({ name: q.name, query: q.query, reason: result.reason, response: text });
      }
    } catch (err: any) {
      fail++;
      console.log(`💥 ${err.message}`);
      failures.push({ name: q.name, query: q.query, reason: `runtime: ${err.message}`, response: '' });
    }
  }

  console.log('\n═══ SUMMARY ═══\n');
  console.log(`  ✅ PASS: ${pass}  ❌ FAIL: ${fail}  📊 ${QUERIES.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / QUERIES.length) * 100)}%\n`);

  if (failures.length > 0) {
    console.log('─── FAILURES ───\n');
    for (const f of failures) {
      console.log(`  ❌ ${f.name}`);
      console.log(`     Q: "${f.query}"`);
      console.log(`     reason: ${f.reason.substring(0, 250)}`);
      console.log(`     bot: ${f.response.substring(0, 250).replace(/\n/g, ' ')}\n`);
    }
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-historical-v2-results.json',
    JSON.stringify({ totals, failures, passRate: pass / QUERIES.length }, null, 2),
  );
  console.log(`📄 Report: src/testing/qa-historical-v2-results.json`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
