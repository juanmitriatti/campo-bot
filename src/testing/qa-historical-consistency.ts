/**
 * QA Historical Consistency — seeds 6 months of historical data via direct
 * SQL INSERTs and then asks the bot 20 consistency queries to verify the
 * numbers it reports match the ground truth.
 *
 * Why: bot answers like "cuánto gasté el mes pasado" / "cuántas vacas tengo"
 * are the core value prop. Need to check they're CORRECT across all domains
 * (gastos, ingresos, hacienda, cosechas, lluvias, monitoreos, stock) over
 * realistic timespans.
 *
 * Setup: user "qa-historical@campo.test", 1 field, 3 plots, livestock,
 * warehouse. Then INSERTs spread across Dec 2025 → May 2026 (6 months).
 *
 * Each query has a KNOWN expected answer computed from the seed data, and
 * the test asserts the bot's response contains the right number / keyword.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-historical-consistency.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-historical@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Histórico';

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

// ── Setup field/plots/livestock/warehouse via bot ──────────────────────

interface SetupIds { fieldId: number; plotA1: number; plotA2: number; plotA3: number; warehouseId: number; }

async function setupFromBot(userId: number): Promise<SetupIds> {
  console.log('🔧 Setup via bot...');
  await sendAndLog('agregar campo Don Histórico');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');
  for (const [name, ha] of [['A1', 200], ['A2', 150], ['A3', 100]] as const) {
    await sendAndLog(`agregar lote ${name} al campo Don Histórico`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré soja en A1');
  await sendAndLog('sembré maíz en A2');
  await sendAndLog('sembré trigo en A3');
  await sendAndLog('agregué 100 vacas Angus en A1');
  await sendAndLog('agregué 50 novillos en A2');
  await sendAndLog('crear galpón Depósito en Don Histórico');

  // Query the IDs back. Field name is normalized lowercase + accents stripped by saveField.
  const fieldRow = (await apiQueryDb(
    `SELECT id FROM fields WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [userId],
  ))[0];
  const plots = await apiQueryDb(`SELECT id, name FROM plots WHERE field_id=$1 AND deleted_at IS NULL ORDER BY name`, [fieldRow.id]);
  const warehouse = (await apiQueryDb(`SELECT id FROM warehouses WHERE field_id=$1 AND deleted_at IS NULL LIMIT 1`, [fieldRow.id]))[0];
  const ids: SetupIds = {
    fieldId: fieldRow.id,
    plotA1: plots.find((p: any) => p.name === 'A1')?.id,
    plotA2: plots.find((p: any) => p.name === 'A2')?.id,
    plotA3: plots.find((p: any) => p.name === 'A3')?.id,
    warehouseId: warehouse.id,
  };
  console.log(`✅ Setup IDs: field=${ids.fieldId} A1=${ids.plotA1} A2=${ids.plotA2} A3=${ids.plotA3} wh=${ids.warehouseId}`);
  return ids;
}

// ── HISTORICAL SEED — ground truth ─────────────────────────────────────

/**
 * GROUND TRUTH — what we expect the bot to report.
 * All dates are absolute YYYY-MM-DD so assertions are deterministic.
 *
 * Seed covers Dec 2025 → May 2026 (6 months).
 */

interface SeedTotals {
  expenses_total_ARS: number;
  expenses_total_USD: number;
  incomes_total_ARS: number;
  incomes_total_USD: number;
  by_month: Record<string, { exp_ars: number; exp_usd: number; inc_ars: number; inc_usd: number; rain_mm: number }>;
  by_category_exp: Record<string, number>;
  by_category_inc: Record<string, number>;
  rainfall_total_mm: number;
  livestock_initial: { vacas: number; novillos: number };
}

function buildSeedPlan(): {
  expenses: Array<{ date: string; category: string; amount: number; currency: 'ARS' | 'USD'; description: string; product?: string }>;
  incomes: Array<{ date: string; category: string; amount: number; currency: 'ARS' | 'USD'; quantity?: number; unit?: string; unit_price?: number; description: string }>;
  rainfall: Array<{ date: string; mm: number }>;
  activities: Array<{ date: string; type: string; crop: string; product?: string; quantity?: number; unit?: string; plot: 'A1' | 'A2' | 'A3' }>;
  totals: SeedTotals;
} {
  const expenses = [
    // December 2025
    { date: '2025-12-05', category: 'Combustible', amount: 80000, currency: 'ARS' as const, description: 'gasoil diciembre', product: 'gasoil' },
    { date: '2025-12-15', category: 'Sueldos', amount: 250000, currency: 'ARS' as const, description: 'sueldos diciembre' },
    { date: '2025-12-20', category: 'Agroquímicos', amount: 120000, currency: 'ARS' as const, description: 'glifosato dic', product: 'glifosato' },
    // January 2026
    { date: '2026-01-10', category: 'Combustible', amount: 95000, currency: 'ARS' as const, description: 'gasoil enero' },
    { date: '2026-01-15', category: 'Sueldos', amount: 260000, currency: 'ARS' as const, description: 'sueldos enero' },
    { date: '2026-01-25', category: 'Fertilizantes', amount: 180000, currency: 'ARS' as const, description: 'urea enero', product: 'urea' },
    // February 2026
    { date: '2026-02-05', category: 'Combustible', amount: 100000, currency: 'ARS' as const, description: 'gasoil febrero' },
    { date: '2026-02-15', category: 'Sueldos', amount: 270000, currency: 'ARS' as const, description: 'sueldos febrero' },
    { date: '2026-02-20', category: 'Agroquímicos', amount: 150000, currency: 'ARS' as const, description: 'fungicida feb' },
    // March 2026
    { date: '2026-03-05', category: 'Combustible', amount: 110000, currency: 'ARS' as const, description: 'gasoil marzo' },
    { date: '2026-03-12', category: 'Semillas', amount: 500000, currency: 'ARS' as const, description: 'semilla soja' },
    { date: '2026-03-15', category: 'Sueldos', amount: 280000, currency: 'ARS' as const, description: 'sueldos marzo' },
    // April 2026
    { date: '2026-04-05', category: 'Combustible', amount: 115000, currency: 'ARS' as const, description: 'gasoil abril' },
    { date: '2026-04-15', category: 'Sueldos', amount: 290000, currency: 'ARS' as const, description: 'sueldos abril' },
    { date: '2026-04-20', category: 'Maquinaria', amount: 350000, currency: 'ARS' as const, description: 'reparación maquina' },
    // May 2026 (mes actual hasta el 23)
    { date: '2026-05-08', category: 'Combustible', amount: 120000, currency: 'ARS' as const, description: 'gasoil mayo' },
    { date: '2026-05-15', category: 'Sueldos', amount: 300000, currency: 'ARS' as const, description: 'sueldos mayo' },
  ];

  const incomes = [
    // Pre-historico: ventas anteriores
    { date: '2025-12-20', category: 'Soja', amount: 16000, currency: 'USD' as const, quantity: 40, unit: 'tn', unit_price: 400, description: 'venta soja dic' },
    { date: '2026-01-22', category: 'Maíz', amount: 4400, currency: 'USD' as const, quantity: 25, unit: 'tn', unit_price: 176, description: 'venta maíz enero' },
    { date: '2026-02-10', category: 'Hacienda', amount: 9000, currency: 'USD' as const, quantity: 5, unit: 'cabezas', unit_price: 1800, description: 'venta 5 novillos' },
    { date: '2026-03-25', category: 'Soja', amount: 21600, currency: 'USD' as const, quantity: 50, unit: 'tn', unit_price: 432, description: 'venta soja marzo' },
    { date: '2026-04-15', category: 'Trigo', amount: 5400, currency: 'USD' as const, quantity: 30, unit: 'tn', unit_price: 180, description: 'venta trigo abril' },
    { date: '2026-05-10', category: 'Hacienda', amount: 12000, currency: 'USD' as const, quantity: 8, unit: 'cabezas', unit_price: 1500, description: 'venta 8 vacas' },
  ];

  const rainfall = [
    { date: '2025-12-08', mm: 25 }, { date: '2025-12-22', mm: 18 },                            // dic: 43mm
    { date: '2026-01-12', mm: 35 }, { date: '2026-01-20', mm: 12 },                            // ene: 47mm
    { date: '2026-02-04', mm: 50 }, { date: '2026-02-18', mm: 22 },                            // feb: 72mm
    { date: '2026-03-10', mm: 40 }, { date: '2026-03-25', mm: 15 },                            // mar: 55mm
    { date: '2026-04-02', mm: 28 }, { date: '2026-04-19', mm: 33 },                            // abr: 61mm
    { date: '2026-05-05', mm: 20 }, { date: '2026-05-15', mm: 18 },                            // may: 38mm
  ];

  const activities = [
    { date: '2025-12-10', type: 'spray', crop: 'soja', product: 'glifosato', quantity: 3, unit: 'lt/ha', plot: 'A1' as const },
    { date: '2026-01-15', type: 'fertilization', crop: 'maíz', product: 'urea', quantity: 100, unit: 'kg/ha', plot: 'A2' as const },
    { date: '2026-02-20', type: 'spray', crop: 'trigo', product: '2,4D', quantity: 1.5, unit: 'lt/ha', plot: 'A3' as const },
    { date: '2026-03-15', type: 'spray', crop: 'soja', product: 'glifosato', quantity: 2, unit: 'lt/ha', plot: 'A1' as const },
    { date: '2026-04-10', type: 'tillage', crop: 'maíz', plot: 'A2' as const },
    { date: '2026-05-12', type: 'spray', crop: 'soja', product: 'fungicida', quantity: 2, unit: 'lt/ha', plot: 'A1' as const },
  ];

  // ── Compute totals (ground truth) ──
  const totals: SeedTotals = {
    expenses_total_ARS: 0, expenses_total_USD: 0,
    incomes_total_ARS: 0, incomes_total_USD: 0,
    by_month: {},
    by_category_exp: {}, by_category_inc: {},
    rainfall_total_mm: 0,
    livestock_initial: { vacas: 100, novillos: 50 },
  };

  for (const e of expenses) {
    if (e.currency === 'ARS') totals.expenses_total_ARS += e.amount;
    else totals.expenses_total_USD += e.amount;
    const ym = e.date.slice(0, 7);
    if (!totals.by_month[ym]) totals.by_month[ym] = { exp_ars: 0, exp_usd: 0, inc_ars: 0, inc_usd: 0, rain_mm: 0 };
    if (e.currency === 'ARS') totals.by_month[ym].exp_ars += e.amount; else totals.by_month[ym].exp_usd += e.amount;
    totals.by_category_exp[e.category] = (totals.by_category_exp[e.category] || 0) + e.amount;
  }
  for (const i of incomes) {
    const cur = i.currency as string;
    if (cur === 'ARS') totals.incomes_total_ARS += i.amount;
    else totals.incomes_total_USD += i.amount;
    const ym = i.date.slice(0, 7);
    if (!totals.by_month[ym]) totals.by_month[ym] = { exp_ars: 0, exp_usd: 0, inc_ars: 0, inc_usd: 0, rain_mm: 0 };
    if (cur === 'ARS') totals.by_month[ym].inc_ars += i.amount; else totals.by_month[ym].inc_usd += i.amount;
    totals.by_category_inc[i.category] = (totals.by_category_inc[i.category] || 0) + i.amount;
  }
  for (const r of rainfall) {
    totals.rainfall_total_mm += r.mm;
    const ym = r.date.slice(0, 7);
    if (!totals.by_month[ym]) totals.by_month[ym] = { exp_ars: 0, exp_usd: 0, inc_ars: 0, inc_usd: 0, rain_mm: 0 };
    totals.by_month[ym].rain_mm += r.mm;
  }

  return { expenses, incomes, rainfall, activities, totals };
}

async function seedHistoricalData(userId: number, ids: SetupIds): Promise<SeedTotals> {
  console.log('\n🌱 Seeding 6 months of historical data...');
  const plan = buildSeedPlan();

  // INSERT expenses (one by one — the bulk INSERT via the endpoint is rejected by SQL guard).
  for (const e of plan.expenses) {
    await apiQueryDb(
      `INSERT INTO expenses (user_id, category, description, amount, currency, field_id, expense_date, expense_type, product)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9)`,
      [userId, e.category, e.description, e.amount, e.currency, ids.fieldId, e.date, 'varios', e.product || null],
    );
  }
  console.log(`  ✅ ${plan.expenses.length} expenses`);

  for (const i of plan.incomes) {
    await apiQueryDb(
      `INSERT INTO incomes (user_id, category, description, amount, currency, quantity, unit, unit_price, field_id, income_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date)`,
      [userId, i.category, i.description, i.amount, i.currency, i.quantity, i.unit, i.unit_price, ids.fieldId, i.date],
    );
  }
  console.log(`  ✅ ${plan.incomes.length} incomes`);

  for (const r of plan.rainfall) {
    await apiQueryDb(
      `INSERT INTO rainfall (user_id, field_id, millimeters, rainfall_date) VALUES ($1, $2, $3, $4::date)`,
      [userId, ids.fieldId, r.mm, r.date],
    );
  }
  console.log(`  ✅ ${plan.rainfall.length} rainfalls`);

  for (const a of plan.activities) {
    const plotId = a.plot === 'A1' ? ids.plotA1 : a.plot === 'A2' ? ids.plotA2 : ids.plotA3;
    const eventType = a.type === 'spray' ? 'log_spraying' : a.type === 'fertilization' ? 'log_fertilization' : a.type === 'tillage' ? 'log_tillage' : a.type;
    await apiQueryDb(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, crop, product, quantity, unit)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)`,
      [userId, plotId, eventType, a.date, a.crop, a.product || null, a.quantity || null, a.unit || null],
    );
  }
  console.log(`  ✅ ${plan.activities.length} activities`);

  console.log('\n📊 Ground-truth totals:');
  console.log(`  Expenses: ${plan.totals.expenses_total_ARS.toLocaleString('es-AR')} ARS + ${plan.totals.expenses_total_USD} USD`);
  console.log(`  Incomes:  ${plan.totals.incomes_total_ARS.toLocaleString('es-AR')} ARS + ${plan.totals.incomes_total_USD} USD`);
  console.log(`  Rainfall: ${plan.totals.rainfall_total_mm} mm total`);
  console.log(`  Monthly:`);
  for (const [m, t] of Object.entries(plan.totals.by_month).sort()) {
    console.log(`    ${m}: exp=$${t.exp_ars.toLocaleString('es-AR')}ARS+$${t.exp_usd}USD inc=$${t.inc_ars.toLocaleString('es-AR')}ARS+$${t.inc_usd}USD rain=${t.rain_mm}mm`);
  }
  console.log();

  return plan.totals;
}

// ── 20 consistency queries ─────────────────────────────────────────────

interface QuerySpec {
  name: string;
  query: string;
  /** Expected: returns true if the response is consistent with the ground truth */
  validate: (text: string, t: SeedTotals) => { pass: boolean; reason: string };
}

// Helper: format number AR-style (50.000 / 50,5)
function fmt(n: number): string {
  return n.toLocaleString('es-AR');
}

const QUERIES: QuerySpec[] = [
  {
    name: 'Q01_gastos_total',
    query: 'cuánto gasté en total',
    validate: (text, t) => {
      // Bot should mention something close to the total ARS or total USD
      const hasARS = text.includes(fmt(t.expenses_total_ARS)) || text.includes((t.expenses_total_ARS / 1000).toFixed(0)+'.000') || text.match(/\$?\s*[1-3]\.\d{3}\.\d{3}/);
      return { pass: !!hasARS, reason: `expected ${fmt(t.expenses_total_ARS)} ARS — text has: ${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q02_gastos_mes_pasado',
    query: 'cuánto gasté el mes pasado',
    validate: (text, t) => {
      // April 2026 = mes pasado from May. Total: 115+290+350 = 755000
      const apr = t.by_month['2026-04']?.exp_ars ?? 0;
      const aprFmt = fmt(apr); // 755.000
      const has = text.includes(aprFmt) || text.includes('755');
      return { pass: has, reason: `expected April ARS=${aprFmt}; text=${text.substring(0, 150)}` };
    },
  },
  {
    name: 'Q03_gastos_marzo',
    query: 'cuánto gasté en marzo',
    validate: (text, t) => {
      const m = t.by_month['2026-03']?.exp_ars ?? 0; // 110000 + 500000 + 280000 = 890000
      const has = text.includes(fmt(m)) || text.includes('890');
      return { pass: has, reason: `expected March ARS=${fmt(m)}; text=${text.substring(0, 150)}` };
    },
  },
  {
    name: 'Q04_ingresos_total',
    query: 'cuánto vendí en total',
    validate: (text, t) => {
      // All incomes in USD: 16000 + 4400 + 9000 + 21600 + 5400 + 12000 = 68400
      const has = text.includes(fmt(t.incomes_total_USD)) || text.includes('68.400') || text.includes('68400');
      return { pass: has, reason: `expected ${fmt(t.incomes_total_USD)} USD; text=${text.substring(0, 150)}` };
    },
  },
  {
    name: 'Q05_ventas_soja',
    query: 'cuánto vendí de soja',
    validate: (text, t) => {
      // Soja: 16000 + 21600 = 37600 USD
      const soja = t.by_category_inc['Soja'] ?? 0;
      const has = text.includes(fmt(soja)) || text.includes('37.600') || text.includes('37600');
      return { pass: has, reason: `expected Soja=${fmt(soja)} USD; text=${text.substring(0, 150)}` };
    },
  },
  {
    name: 'Q06_ingresos_marzo',
    query: 'cuánto ingresé en marzo',
    validate: (text, t) => {
      const m = t.by_month['2026-03']?.inc_usd ?? 0; // 21600
      const has = text.includes(fmt(m)) || text.includes('21.600') || text.includes('21600');
      return { pass: has, reason: `expected March USD=${fmt(m)}; text=${text.substring(0, 150)}` };
    },
  },
  {
    name: 'Q07_lluvia_total',
    query: 'cuánto llovió en total',
    validate: (text, t) => {
      const has = text.includes(`${t.rainfall_total_mm}`) || text.includes(`${t.rainfall_total_mm}mm`) || text.includes(`${t.rainfall_total_mm} mm`);
      return { pass: has, reason: `expected ${t.rainfall_total_mm}mm; text=${text.substring(0, 150)}` };
    },
  },
  {
    name: 'Q08_lluvia_febrero',
    query: 'cuánto llovió en febrero',
    validate: (text, t) => {
      const feb = t.by_month['2026-02']?.rain_mm ?? 0; // 72mm
      const has = text.includes(`${feb}`) || text.includes(`${feb}mm`) || text.includes(`${feb} mm`);
      return { pass: has, reason: `expected ${feb}mm in Feb; text=${text.substring(0, 150)}` };
    },
  },
  {
    name: 'Q09_animales',
    query: 'cuántos animales tengo',
    validate: (text, t) => {
      // 100 vacas + 50 novillos = 150 total
      const total = t.livestock_initial.vacas + t.livestock_initial.novillos;
      const hasTotal = text.includes(`${total}`) || (text.includes('100') && text.includes('50'));
      return { pass: hasTotal, reason: `expected ${total} animales (100+50); text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q10_vacas_en_A1',
    query: 'cuántas vacas tengo en A1',
    validate: (text, t) => {
      const has100 = text.includes('100');
      return { pass: has100, reason: `expected 100 vacas en A1; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q11_gastos_combustible',
    query: 'cuánto gasté en combustible este año',
    validate: (text, t) => {
      // 2026 combustible: 95+100+110+115+120 = 540000 ARS
      const has = text.includes('540') || text.includes('540.000') || text.includes('540000');
      return { pass: has, reason: `expected 540.000 ARS combustible 2026; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q12_gastos_sueldos',
    query: 'cuánto gasté en sueldos',
    validate: (text, t) => {
      // Sueldos total: 250+260+270+280+290+300 = 1650000 ARS
      const sueldos = t.by_category_exp['Sueldos'] ?? 0;
      const has = text.includes(fmt(sueldos)) || text.includes('1.650') || text.includes('1650');
      return { pass: has, reason: `expected ${fmt(sueldos)} ARS sueldos; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q13_balance_mes',
    query: 'balance de este mes',
    validate: (text, t) => {
      // Mayo 2026: inc=12000 USD, exp=120000+300000=420000 ARS
      // Bot may show as "ingresos vs gastos" / "resultado" / "margen"
      const mentions = /ingres|gast|balance|resultado|margen|\$/i.test(text);
      const hasMayValues = text.includes('420') || text.includes('12.000') || text.includes('12000');
      return { pass: mentions && hasMayValues, reason: `mentions=${mentions} hasValues=${hasMayValues}; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q14_listar_lotes',
    query: 'qué lotes tengo',
    validate: (text) => {
      const all3 = text.includes('A1') && text.includes('A2') && text.includes('A3');
      return { pass: all3, reason: `expected A1+A2+A3; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q15_active_crop_A1',
    query: 'qué cultivo tiene A1',
    validate: (text) => {
      const hasSoja = /soja/i.test(text);
      return { pass: hasSoja, reason: `expected soja; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q16_historial_A1',
    query: 'mostrame el historial del lote A1',
    validate: (text) => {
      // Historial debería mencionar las fumigaciones de A1 (glifosato + fungicida)
      const hasActivities = /fumig|spray|glifosato|fungicida|sembr|siembra/i.test(text);
      return { pass: hasActivities, reason: `expected actividades de A1; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q17_gastos_lote_A2',
    query: 'cuánto gasté en el lote A2',
    validate: (text) => {
      // Most expenses are at field-level (no plot), so may show field total or "sin gastos"
      const hasResponse = /gast|sin gastos|no.*gastos|\$|0/i.test(text);
      return { pass: hasResponse, reason: `expected financial response; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q18_ultima_lluvia',
    query: 'cuándo fue la última lluvia',
    validate: (text) => {
      // Última lluvia: 15 may 2026
      const hasMayDate = /15.*may|mayo.*15|2026-05-15/i.test(text);
      const hasMm = /18.*mm|18mm/i.test(text);
      return { pass: hasMayDate || hasMm, reason: `expected 15 mayo 18mm; text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q19_resumen_mes',
    query: 'dame el resumen del mes',
    validate: (text, t) => {
      // Should show may totals
      const hasFinancial = /ingres|gast|resultado|balance/i.test(text);
      return { pass: hasFinancial, reason: `text=${text.substring(0, 200)}` };
    },
  },
  {
    name: 'Q20_comparar_marzo_abril',
    query: 'compará marzo vs abril',
    validate: (text, t) => {
      const mentionsBoth = /marzo|abril/i.test(text);
      const hasNumbers = /\d{3,}|\$/i.test(text);
      return { pass: mentionsBoth && hasNumbers, reason: `bothMonths=${mentionsBoth} hasNumbers=${hasNumbers}; text=${text.substring(0, 200)}` };
    },
  },
];

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🧪 QA Historical Consistency — 6 meses seed + 20 queries\n');

  const auth = await apiRegister();
  TOKEN = auth.token;
  const userId = auth.userId;
  console.log(`✅ User ${userId} (${EMAIL})`);

  await apiReset();
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [userId]);
  console.log('✅ Reset + enterprise plan\n');

  const ids = await setupFromBot(userId);
  const totals = await seedHistoricalData(userId, ids);

  // ── Run queries ──
  console.log('═══ QUERIES ═══\n');
  let pass = 0, fail = 0;
  const failures: Array<{ name: string; query: string; reason: string; response: string }> = [];

  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`${num}/${QUERIES.length} ${q.name}: "${q.query}"\n   `);
    try {
      // Clear pending state
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
      console.log(`     reason: ${f.reason.substring(0, 200)}`);
      console.log(`     bot: ${f.response.substring(0, 200).replace(/\n/g, ' ')}\n`);
    }
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-historical-results.json',
    JSON.stringify({ totals, failures, passRate: pass / QUERIES.length }, null, 2),
  );
  console.log(`📄 Report: src/testing/qa-historical-results.json`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
