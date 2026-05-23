/**
 * QA Broad Coverage — 30 NEW multi-turn scenarios spanning 5 domain groups
 *
 * Goal: regression-test today's three fixes (commit 44460f3) and find new
 * failure patterns at scale:
 *   1. bulkMode threshold includes partials (`actionable + partials >= 2`)
 *   2. add_livestock in bulkMode emits `savedRecordsWithoutPlot`
 *   3. log_health_event + log_repro_event in bulkMode auto-pick the first
 *      location option
 *
 * Test groups (5–10 scenarios each):
 *   A — Financial-heavy (5)
 *   B — Agronomy-heavy (5)
 *   C — Hacienda-heavy (5)
 *   D — Stock-heavy (5)
 *   E — Mixed cross-domain (10)
 *
 * Setup runs ONCE; tests share state and measure DB deltas via a 90-second
 * `created_at` window.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-broad-coverage-30.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-broad@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Amplio';

// ── API helpers ─────────────────────────────────────────────────────────

async function apiRegister(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  if (!res.ok) throw new Error(`Query failed: ${res.status}`);
  const d = await res.json() as any;
  return d.rows ?? [];
}

function extractText(data: any): string {
  const parts: string[] = [];
  for (const m of (data.messages || [])) {
    if (m.text) parts.push(m.text);
    if (m.interactive?.body) parts.push(m.interactive.body);
  }
  return parts.join('\n');
}
function firstButtonId(data: any): string | null {
  for (const m of (data.messages || [])) {
    const buttons = m.interactive?.buttons;
    if (Array.isArray(buttons) && buttons.length > 0 && buttons[0]?.id) return String(buttons[0].id);
    const sections = m.interactive?.sections;
    if (Array.isArray(sections)) {
      for (const s of sections) {
        if (Array.isArray(s.rows) && s.rows.length > 0 && s.rows[0]?.id) return String(s.rows[0].id);
      }
    }
  }
  return null;
}
async function sendAndLog(message: string): Promise<string> {
  return extractText(await apiSend(message));
}

// ── Setup (ONCE) ────────────────────────────────────────────────────────

async function setupState(): Promise<void> {
  console.log('🔧 Setting up shared state...');
  // Field La Pampa in Pergamino
  await sendAndLog('agregar campo La Pampa');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');

  // Plots: Norte 120ha, Centro 200ha, Sur 90ha, Este 60ha
  for (const [name, ha] of [['Norte', 120], ['Centro', 200], ['Sur', 90], ['Este', 60]] as const) {
    await sendAndLog(`agregar lote ${name} al campo La Pampa`);
    await sendAndLog(String(ha));
  }

  // Sow crops
  await sendAndLog('sembré soja en Norte');
  await sendAndLog('sembré maíz en Centro');
  await sendAndLog('sembré trigo en Sur');
  await sendAndLog('sembré girasol en Este');

  // Livestock
  await sendAndLog('agregué 100 vacas Angus en Norte');
  await sendAndLog('agregué 60 novillos en Centro');
  await sendAndLog('agregué 50 terneros en Sur');
  await sendAndLog('agregué 25 toros en Este');

  // Warehouse + stock
  await sendAndLog('crear galpón Central en La Pampa');
  await sendAndLog('agregar 500 bolsas de soja al galpón Central');
  await sendAndLog('agregar 300 lt de glifosato al galpón Central');
  await sendAndLog('agregar 200 bolsas de urea al galpón Central');
  await sendAndLog('agregar 100 lt de atrazina al galpón Central');

  console.log('✅ Setup done\n');
}

// ── Counters ────────────────────────────────────────────────────────────

interface CountRow {
  e: number; i: number; d: number; o: number; s: number;
  lm: number; sm: number; r: number; f: number; p: number;
  he: number; // health/repro/weighing events
}

const COUNT_SQL = `SELECT
  (SELECT COUNT(*)::int FROM expenses WHERE user_id=$1 AND deleted_at IS NULL) as e,
  (SELECT COUNT(*)::int FROM incomes WHERE user_id=$1 AND deleted_at IS NULL) as i,
  (SELECT COUNT(*)::int FROM domain_events WHERE user_id=$1 AND deleted_at IS NULL) as d,
  (SELECT COUNT(*)::int FROM agro_observations WHERE user_id=$1) as o,
  (SELECT COUNT(*)::int FROM crop_scoutings WHERE user_id=$1 AND deleted_at IS NULL) as s,
  (SELECT COUNT(*)::int FROM livestock_movements WHERE user_id=$1) as lm,
  (SELECT COUNT(*)::int FROM stock_movements WHERE user_id=$1) as sm,
  (SELECT COUNT(*)::int FROM rainfall WHERE user_id=$1) as r,
  (SELECT COUNT(*)::int FROM fields WHERE user_id=$1 AND deleted_at IS NULL) as f,
  (SELECT COUNT(*)::int FROM plots p JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND p.deleted_at IS NULL) as p,
  (SELECT COUNT(*)::int FROM domain_events WHERE user_id=$1 AND deleted_at IS NULL AND event_type IN ('health_event','repro_event','weighing')) as he`;

async function countAll(userId: number): Promise<CountRow> {
  const rows = await apiQueryDb(COUNT_SQL, [userId]);
  return rows[0] as CountRow;
}
function diffCounts(before: CountRow, after: CountRow): Record<keyof CountRow, number> {
  const out: any = {};
  for (const k of Object.keys(after) as Array<keyof CountRow>) {
    out[k] = Number(after[k]) - Number(before[k]);
  }
  return out;
}

// ── Test spec ───────────────────────────────────────────────────────────

type Group = 'A_financial' | 'B_agronomy' | 'C_livestock' | 'D_stock' | 'E_mixed';

interface ExpectCtx { userId: number; diff: Record<keyof CountRow, number>; turns: string[] }
type ExpectFn = (ctx: ExpectCtx) => Promise<{ pass: boolean; reason: string; warn?: boolean }>;

interface TestSpec {
  name: string;
  desc: string;
  group: Group;
  compound: string;
  answers?: string[];
  /** When true, after the first response, tap the first button rendered (used
   *  for bulk-plot "¿A qué lote?" prompts). */
  tapFirstButton?: boolean;
  expect: ExpectFn;
}

function botIsAsking(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasQ = text.includes('?') || text.includes('¿');
  const hasAskWord = /(cu[aá]nto|cu[aá]l|qu[eé] |c[oó]mo|en qu[eé]|d[oó]nde|falta|me falta|necesit|elig|aclar)/i.test(lower);
  const hasQueueMark = /👇|pendiente/i.test(text);
  return (hasQ && hasAskWord) || hasQueueMark;
}

// ── Tests ────────────────────────────────────────────────────────────────

const TESTS: TestSpec[] = [
  // ───────── A — FINANCIAL-HEAVY (5) ─────────
  {
    name: 'A01_5x_expense_chain',
    desc: '5 compras complete',
    group: 'A_financial',
    compound: 'compré 100 bolsas urea a 8mil, compré 200 lt glifosato a 950, compré 50 bolsas semilla soja a 12mil, compré 200 lt gasoil a 800, compré 50 bolsas atrazina a 5mil',
    expect: async ({ diff }) => ({
      pass: diff.e >= 5,
      reason: `e=${diff.e} (want>=5)`,
    }),
  },
  {
    name: 'A02_3sales_2expenses_mix',
    desc: '3 ventas USD + 2 gastos ARS',
    group: 'A_financial',
    compound: 'vendí 30 tn soja a 480 USD, vendí 20 tn maíz a 200 USD, vendí 15 tn trigo a 180 USD, compré urea por 200mil, gasté 80mil en gasoil',
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price, currency FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC`, [userId]);
      const soja = incomes.find((r: any) => /soja/i.test(String(r.category)) && Number(r.quantity) === 30);
      const maiz = incomes.find((r: any) => /ma[ií]z/i.test(String(r.category)) && Number(r.quantity) === 20);
      const trigo = incomes.find((r: any) => /trigo/i.test(String(r.category)) && Number(r.quantity) === 15);
      const conflations: string[] = [];
      if (soja && Number(soja.unit_price) !== 480) conflations.push(`soja-price=${soja.unit_price}`);
      if (maiz && Number(maiz.unit_price) !== 200) conflations.push(`maiz-price=${maiz.unit_price}`);
      if (trigo && Number(trigo.unit_price) !== 180) conflations.push(`trigo-price=${trigo.unit_price}`);
      return {
        pass: diff.i >= 3 && diff.e >= 2 && !!soja && !!maiz && !!trigo && conflations.length === 0,
        reason: `i=${diff.i} e=${diff.e}; soja=${!!soja} maiz=${!!maiz} trigo=${!!trigo}${conflations.length ? ' CONFLATION: ' + conflations.join(',') : ''}`,
      };
    },
  },
  {
    name: 'A03_3_financial_field_level',
    desc: '3 financial sin plot (bulk-plot prompt expected)',
    group: 'A_financial',
    compound: 'gasté 50mil en gasoil, vendí 10 tn soja a 480 USD, gasté 30mil en repuestos',
    expect: async ({ diff }) => ({
      pass: diff.e >= 2 && diff.i >= 1,
      reason: `e=${diff.e} (want>=2) i=${diff.i} (want>=1)`,
    }),
  },
  {
    name: 'A04_2_ventas_one_no_price',
    desc: '2 ventas, una sin precio → serial follow-up',
    group: 'A_financial',
    compound: 'vendí 25 tn maíz a 200 USD y vendí 8 tn girasol',
    answers: ['550 USD por tonelada'],
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC`, [userId]);
      const maiz = incomes.find((r: any) => /ma[ií]z/i.test(String(r.category)) && Number(r.quantity) === 25);
      const girasol = incomes.find((r: any) => /girasol/i.test(String(r.category)) && Number(r.quantity) === 8);
      if (!maiz) return { pass: false, reason: `No maíz income. incomes=${JSON.stringify(incomes)}` };
      if (!girasol) return { pass: false, reason: `No girasol income. incomes=${JSON.stringify(incomes)}` };
      const mP = Number(maiz.unit_price), gP = Number(girasol.unit_price);
      if (mP === 550) return { pass: false, reason: `CONFLATION: maíz=550 (girasol price leaked)` };
      if (gP === 200) return { pass: false, reason: `CONFLATION: girasol=200 (maíz price leaked)` };
      return {
        pass: diff.i >= 2 && mP === 200 && gP === 550,
        reason: `i=${diff.i}; maíz=${mP} (want 200) girasol=${gP} (want 550)`,
      };
    },
  },
  {
    name: 'A05_gasto_recurrente_mix',
    desc: 'creá gasto fijo + compré urea (mix templates + expense)',
    group: 'A_financial',
    compound: 'creá gasto fijo de 50mil pesos en sueldos mensual y compré 30 bolsas urea a 8mil',
    expect: async ({ userId, diff }) => {
      // Expense should be recorded; template creation may or may not occur via this path
      const expenses = await apiQueryDb(
        `SELECT product, category, amount, quantity FROM expenses
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC`, [userId]);
      const urea = expenses.find((r: any) => /urea/i.test(String(r.product ?? '') + ' ' + String(r.category ?? '')));
      return {
        pass: diff.e >= 1 && !!urea,
        reason: `e=${diff.e} urea=${!!urea}`,
        warn: !urea, // soft fail if urea missing
      };
    },
  },

  // ───────── B — AGRONOMY-HEAVY (5) ─────────
  {
    name: 'B06_3_actividades_distinct_plots',
    desc: 'fumi + fert + siembra (3 distintos)',
    group: 'B_agronomy',
    compound: 'fumigué Norte con glifosato 3 lt/ha, fertilicé Centro con urea 100 kg/ha, sembré avena en Este',
    expect: async ({ diff }) => ({
      pass: diff.d >= 3,
      reason: `d=${diff.d} (want>=3)`,
    }),
  },
  {
    name: 'B07_siembra_spray_scout_same_plot',
    desc: 'sembré + fumigué + monitoreé al mismo plot Sur',
    group: 'B_agronomy',
    compound: 'sembré sorgo en Sur, fumigué Sur con atrazina 2 lt/ha y monitoreé Sur V3 con 5% rama negra',
    expect: async ({ diff }) => ({
      pass: diff.d >= 2 && diff.s >= 1,
      reason: `d=${diff.d} (want>=2) s=${diff.s} (want>=1)`,
    }),
  },
  {
    name: 'B08_2scouts_cosecha_obs',
    desc: '2 monitoreos + cosecha + observación liebres',
    group: 'B_agronomy',
    compound: 'monitoreé Norte con V6 sin plagas, monitoreé Centro V7 con 10% chinches, coseché soja en Norte 4200 kg/ha, vi liebres en Sur',
    expect: async ({ diff }) => {
      const total = diff.s + diff.d + diff.o;
      return {
        pass: diff.s >= 2 && diff.d >= 1 && total >= 4,
        reason: `s=${diff.s} d=${diff.d} o=${diff.o} (sum=${total}, want s>=2,d>=1,sum>=4)`,
      };
    },
  },
  {
    name: 'B09_labranza_riego_2_sprays',
    desc: 'aré + regué + 2 sprays distintos',
    group: 'B_agronomy',
    compound: 'aré Norte ayer, regué Centro con 30mm de riego, fumigué Sur con glifosato 2 lt/ha, fumigué Este con 2,4D 1 lt/ha',
    expect: async ({ diff }) => ({
      pass: diff.d >= 4,
      reason: `d=${diff.d} (want>=4 activities: aré, regué, 2 fumi)`,
    }),
  },
  {
    name: 'B10_lluvia_cosecha_chain',
    desc: 'lluvia + monitoreo + cosecha + venta',
    group: 'B_agronomy',
    compound: 'llovieron 35mm en La Pampa, monitoreé Norte V8 normal, coseché soja en Norte 4500 kg/ha, vendí 60 tn a 480 USD',
    expect: async ({ diff }) => {
      const total = diff.r + diff.s + diff.d + diff.i;
      return {
        pass: total >= 4 && diff.r >= 1 && diff.i >= 1,
        reason: `r=${diff.r} s=${diff.s} d=${diff.d} i=${diff.i} (sum=${total}, want>=4)`,
      };
    },
  },

  // ───────── C — HACIENDA-HEAVY (5) ─────────
  {
    name: 'C11_3_add_distinct_plots',
    desc: '3 add livestock distinct breed/plot',
    group: 'C_livestock',
    compound: 'agregué 30 vaquillonas Hereford en Norte, agregué 20 novillos Brangus en Centro, agregué 15 terneros Angus en Sur',
    expect: async ({ userId, diff }) => {
      const movs = await apiQueryDb(
        `SELECT lm.count, lg.breed, p.name as plot_name
         FROM livestock_movements lm
         LEFT JOIN livestock_groups lg ON lg.id = lm.dest_group_id
         LEFT JOIN plots p ON p.id = lg.plot_id
         WHERE lm.user_id=$1 AND lm.created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY lm.created_at DESC`, [userId]);
      const v = movs.find((r: any) => Number(r.count) === 30 && r.plot_name === 'Norte' && /hereford/i.test(String(r.breed ?? '')));
      const n = movs.find((r: any) => Number(r.count) === 20 && r.plot_name === 'Centro' && /brangus/i.test(String(r.breed ?? '')));
      const t = movs.find((r: any) => Number(r.count) === 15 && r.plot_name === 'Sur' && /angus/i.test(String(r.breed ?? '')));
      const missing: string[] = [];
      if (!v) missing.push('30 Hereford Norte');
      if (!n) missing.push('20 Brangus Centro');
      if (!t) missing.push('15 Angus Sur');
      return {
        pass: diff.lm >= 3 && missing.length === 0,
        reason: `lm=${diff.lm}; ${missing.length ? 'MISSING: ' + missing.join(', ') : 'all 3 correct'}`,
      };
    },
  },
  {
    name: 'C12_2vac_1desparasit',
    desc: '2 vacunas + 1 desparasitación',
    group: 'C_livestock',
    compound: 'vacuné 80 vacas contra aftosa en Norte, vacuné 60 novillos contra brucelosis en Centro, desparasité 50 terneros con ivermectina en Sur',
    expect: async ({ userId, diff }) => {
      const events = await apiQueryDb(
        `SELECT product, notes FROM domain_events
         WHERE user_id=$1 AND event_type='health_event' AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC`, [userId]);
      const aftosa = events.find((r: any) => /aftosa/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      const bruce = events.find((r: any) => /brucelosis/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      const iver = events.find((r: any) => /ivermectina/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      const missing: string[] = [];
      if (!aftosa) missing.push('aftosa');
      if (!bruce) missing.push('brucelosis');
      if (!iver) missing.push('ivermectina');
      return {
        pass: diff.he >= 3 && missing.length === 0,
        reason: `he=${diff.he}; ${missing.length ? 'MISSING: ' + missing.join(',') : 'all 3'} events=${JSON.stringify(events.slice(0, 3))}`,
      };
    },
  },
  {
    name: 'C13_repro_chain',
    desc: 'toro + IATF + detección celo (3 repro events)',
    group: 'C_livestock',
    compound: 'eché el toro Don Pancho en Norte, inseminé 30 vacas con IATF en Centro, detecté celo en 15 vaquillonas en Sur',
    expect: async ({ userId, diff }) => {
      const events = await apiQueryDb(
        `SELECT event_type, product, notes FROM domain_events
         WHERE user_id=$1 AND event_type='repro_event' AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC`, [userId]);
      return {
        pass: diff.he >= 3,
        reason: `he=${diff.he} (want>=3); repro_events=${events.length} events=${JSON.stringify(events.slice(0, 3))}`,
        warn: diff.he < 3 && events.length >= 2, // some bots count differently
      };
    },
  },
  {
    name: 'C14_pesaje_venta_sanidad',
    desc: 'pesaje + venta hacienda USD + vacuna',
    group: 'C_livestock',
    compound: 'pesé 50 terneros 250 kg promedio en Sur, vendí 10 novillos a 1800 USD cada uno en Centro, vacuné 80 vacas contra ibr en Norte',
    expect: async ({ userId, diff }) => {
      const pesaje = await apiQueryDb(
        `SELECT id FROM domain_events
         WHERE user_id=$1 AND event_type='weighing' AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '90 seconds'`, [userId]);
      const removeMovs = await apiQueryDb(
        `SELECT count, movement_type, unit_price_usd FROM livestock_movements
         WHERE user_id=$1 AND movement_type IN ('remove','salida') AND count=10
           AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const hasPesaje = pesaje.length >= 1;
      const hasRemove = removeMovs.length >= 1;
      return {
        pass: hasPesaje && hasRemove && diff.he >= 2,
        reason: `pesaje=${hasPesaje} remove=${hasRemove} he=${diff.he} (want pesaje + remove + he>=2)`,
        warn: !hasPesaje || !hasRemove,
      };
    },
  },
  {
    name: 'C15_add_remove_repro',
    desc: 'add + venta (remove) + toro',
    group: 'C_livestock',
    compound: 'agregué 20 vacas Angus en Norte, vendí 5 vacas a 1500 USD cada una en Norte, eché el toro Camilo en Norte',
    expect: async ({ userId, diff }) => {
      const movs = await apiQueryDb(
        `SELECT count, movement_type FROM livestock_movements
         WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 5`, [userId]);
      const add = movs.find((r: any) => Number(r.count) === 20 && /entrada|add/i.test(String(r.movement_type)));
      const rem = movs.find((r: any) => Number(r.count) === 5 && /remove|salida/i.test(String(r.movement_type)));
      return {
        pass: diff.lm >= 2 && !!add && !!rem && diff.he >= 1,
        reason: `lm=${diff.lm} add20=${!!add} rem5=${!!rem} he=${diff.he}`,
      };
    },
  },

  // ───────── D — STOCK-HEAVY (5) ─────────
  {
    name: 'D16_3_in_1_out',
    desc: '3 entradas + 1 salida stock',
    group: 'D_stock',
    compound: 'agregué 100 bolsas semilla maíz al galpón Central a 15mil c/u, agregué 50 lt fipronil al galpón Central, agregué 30 lt cipermetrina al galpón Central, saqué 50 lt de glifosato del galpón Central',
    expect: async ({ diff }) => ({
      pass: diff.sm >= 4,
      reason: `sm=${diff.sm} (want>=4)`,
    }),
  },
  {
    name: 'D17_stockout_activity_chain',
    desc: 'stock-out → fumigación → stock-out → fertilización',
    group: 'D_stock',
    compound: 'saqué 60 lt de glifosato del galpón Central, fumigué Norte con eso 3 lt/ha, saqué 30 bolsas urea del galpón Central, fertilicé Centro 100 kg/ha',
    expect: async ({ diff }) => ({
      pass: diff.sm >= 2 && diff.d >= 2,
      reason: `sm=${diff.sm} (want>=2) d=${diff.d} (want>=2)`,
    }),
  },
  {
    name: 'D18_grano_sale',
    desc: 'venta de granos (income, no stock movement guaranteed)',
    group: 'D_stock',
    compound: 'vendí 100 tn de soja a 480 USD por tonelada',
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const soja = incomes.find((r: any) => /soja/i.test(String(r.category)) && Number(r.quantity) === 100);
      return {
        pass: diff.i >= 1 && !!soja && Number(soja.unit_price) === 480,
        reason: `i=${diff.i} soja=${JSON.stringify(soja)}`,
      };
    },
  },
  {
    name: 'D19_stock_partial_chain',
    desc: 'saqué stock + agregué stock (both partial)',
    group: 'D_stock',
    compound: 'saqué glifosato y agregué semilla',
    answers: ['60 lt glifosato', '50 bolsas semilla soja a 12mil c/u'],
    expect: async ({ diff }) => {
      // Expect at least one stock_movement; if both succeed, more
      return {
        pass: diff.sm >= 1,
        reason: `sm=${diff.sm} (want>=1, ideally 2)`,
        warn: diff.sm < 2,
      };
    },
  },
  {
    name: 'D20_stock_multi_chain',
    desc: 'add stock + saqué + compré (expense+stock)',
    group: 'D_stock',
    compound: 'agregué 200 lt gasoil al galpón Central a 850 el litro, saqué 50 lt para fumigación, compré 100 lt extras a 950 c/u',
    expect: async ({ diff }) => {
      const total = diff.sm + diff.e;
      return {
        pass: total >= 2,
        reason: `sm=${diff.sm} e=${diff.e} (sum=${total}, want>=2)`,
      };
    },
  },

  // ───────── E — MIXED CROSS-DOMAIN (10) ─────────
  {
    name: 'E21_6action_mega',
    desc: '6-action mega: gasto+venta+spray+livestock+scout+gasto',
    group: 'E_mixed',
    compound: 'compré 100 bolsas urea a 8mil, vendí 20 tn soja a 480 USD, fumigué Norte glifosato 3 lt/ha, agregué 15 vacas en Centro, monitoreé Sur V5 sin plagas, gasté 60mil en gasoil',
    expect: async ({ diff }) => {
      const sum = diff.e + diff.i + diff.d + diff.lm + diff.s;
      return {
        pass: diff.e >= 2 && diff.i >= 1 && diff.d >= 1 && diff.lm >= 1 && diff.s >= 1 && sum >= 6,
        reason: `e=${diff.e} i=${diff.i} d=${diff.d} lm=${diff.lm} s=${diff.s} (sum=${sum}, want>=6 with all domains)`,
      };
    },
  },
  {
    name: 'E22_partial_complete_no_conflation',
    desc: '2 ventas (1 sin price) + 1 expense + 1 livestock',
    group: 'E_mixed',
    compound: 'vendí 10 tn maíz a 200 USD, vendí 8 tn trigo, compré gasoil por 60mil, agregué 12 terneros en Sur',
    answers: ['180 USD por tonelada'],
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC`, [userId]);
      const maiz = incomes.find((r: any) => /ma[ií]z/i.test(String(r.category)) && Number(r.quantity) === 10);
      const trigo = incomes.find((r: any) => /trigo/i.test(String(r.category)) && Number(r.quantity) === 8);
      const conflations: string[] = [];
      if (maiz && Number(maiz.unit_price) !== 200) conflations.push(`maiz=${maiz.unit_price}`);
      if (trigo && Number(trigo.unit_price) !== 180) conflations.push(`trigo=${trigo.unit_price}`);
      return {
        pass: diff.i >= 2 && diff.e >= 1 && diff.lm >= 1 && !!maiz && !!trigo && conflations.length === 0,
        reason: `i=${diff.i} e=${diff.e} lm=${diff.lm}; maiz=${maiz?.unit_price} trigo=${trigo?.unit_price}${conflations.length ? ' CONFLATION: ' + conflations.join(',') : ''}`,
      };
    },
  },
  {
    name: 'E23_2_add_livestock_no_location',
    desc: 'REGRESSION: 2 add_livestock sin location → bulk-plot prompt',
    group: 'E_mixed',
    compound: 'agregué 30 vaquillonas Hereford y agregué 25 novillos Charolais',
    tapFirstButton: true,
    expect: async ({ userId, diff }) => {
      const movs = await apiQueryDb(
        `SELECT lm.count, lg.breed, p.name as plot_name
         FROM livestock_movements lm
         LEFT JOIN livestock_groups lg ON lg.id = lm.dest_group_id
         LEFT JOIN plots p ON p.id = lg.plot_id
         WHERE lm.user_id=$1 AND lm.created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY lm.created_at DESC`, [userId]);
      const v = movs.find((r: any) => Number(r.count) === 30 && /hereford/i.test(String(r.breed ?? '')));
      const n = movs.find((r: any) => Number(r.count) === 25 && /charolais/i.test(String(r.breed ?? '')));
      // FIX REGRESSION CHECK: both must exist (savedRecordsWithoutPlot fix)
      return {
        pass: diff.lm >= 2 && !!v && !!n,
        reason: `lm=${diff.lm}; vaquillonas-30=${!!v} (plot=${v?.plot_name}) novillos-25=${!!n} (plot=${n?.plot_name})`,
      };
    },
  },
  {
    name: 'E24_health_no_location',
    desc: 'REGRESSION: 2 health events sin location → auto-pick first',
    group: 'E_mixed',
    compound: 'vacuné contra aftosa y desparasité con ivermectina',
    expect: async ({ userId, diff }) => {
      const events = await apiQueryDb(
        `SELECT product, notes FROM domain_events
         WHERE user_id=$1 AND event_type='health_event' AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC`, [userId]);
      const aftosa = events.find((r: any) => /aftosa/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      const iver = events.find((r: any) => /ivermectina/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      // FIX REGRESSION CHECK: both events saved (auto-pick first location)
      return {
        pass: diff.he >= 2 && !!aftosa && !!iver,
        reason: `he=${diff.he}; aftosa=${!!aftosa} iver=${!!iver} events=${JSON.stringify(events.slice(0, 3))}`,
      };
    },
  },
  {
    name: 'E25_4_all_partials',
    desc: '4 partials serial',
    group: 'E_mixed',
    compound: 'compré algo, vendí cosecha, fumigué, agregué hacienda',
    answers: [
      '50 bolsas urea a 8mil',
      '20 tn soja a 480 USD',
      'Norte con glifosato 2 lt/ha',
      '20 terneros Angus en Sur',
    ],
    expect: async ({ diff }) => {
      const sum = diff.e + diff.i + diff.d + diff.lm;
      return {
        pass: sum >= 3,
        reason: `e=${diff.e} i=${diff.i} d=${diff.d} lm=${diff.lm} (sum=${sum}, want>=3)`,
        warn: sum < 4,
      };
    },
  },
  {
    name: 'E26_agronomy_rain_chain',
    desc: 'lluvia + spray + fert + scout',
    group: 'E_mixed',
    compound: 'llovieron 20mm, fumigué Norte con glifosato 2 lt/ha, fertilicé Centro con urea 100 kg/ha, monitoreé Sur V4 con 15% malezas',
    expect: async ({ diff }) => {
      const sum = diff.r + diff.d + diff.s;
      return {
        pass: diff.r >= 1 && diff.d >= 2 && diff.s >= 1 && sum >= 4,
        reason: `r=${diff.r} d=${diff.d} s=${diff.s} (sum=${sum}, want r>=1,d>=2,s>=1)`,
      };
    },
  },
  {
    name: 'E27_compound_with_dates',
    desc: 'ayer fumigué + hoy sembré + anteayer llovieron',
    group: 'E_mixed',
    compound: 'ayer fumigué Norte con glifosato 3 lt/ha, hoy sembré avena en Sur, anteayer llovieron 12mm',
    expect: async ({ diff }) => {
      const sum = diff.d + diff.r;
      return {
        pass: diff.d >= 2 && diff.r >= 1 && sum >= 3,
        reason: `d=${diff.d} r=${diff.r} (sum=${sum}, want d>=2,r>=1)`,
      };
    },
  },
  {
    name: 'E28_stock_sale_harvest',
    desc: 'cosecha + venta + add stock',
    group: 'E_mixed',
    compound: 'coseché trigo en Sur 3500 kg/ha, vendí 20 tn de trigo a 180 USD por tonelada, agregué 200 bolsas trigo al galpón Central',
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const trigo = incomes.find((r: any) => /trigo/i.test(String(r.category)) && Number(r.quantity) === 20);
      return {
        pass: diff.d >= 1 && diff.i >= 1 && diff.sm >= 1 && !!trigo,
        reason: `d=${diff.d} i=${diff.i} sm=${diff.sm} trigo=${JSON.stringify(trigo)}`,
      };
    },
  },
  {
    name: 'E29_livestock_financial_chain',
    desc: 'compra vacas + venta novillos + vacuna',
    group: 'E_mixed',
    compound: 'compré 10 vacas Hereford a 1500 USD c/u en Norte, vendí 5 novillos a 1800 USD cada uno en Centro, vacuné 50 vacas contra aftosa en Norte',
    expect: async ({ userId, diff }) => {
      const movs = await apiQueryDb(
        `SELECT count, movement_type FROM livestock_movements
         WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 5`, [userId]);
      const add = movs.find((r: any) => Number(r.count) === 10 && /entrada|add/i.test(String(r.movement_type)));
      const rem = movs.find((r: any) => Number(r.count) === 5 && /remove|salida/i.test(String(r.movement_type)));
      return {
        pass: diff.lm >= 2 && !!add && !!rem && diff.he >= 1,
        reason: `lm=${diff.lm} add10=${!!add} rem5=${!!rem} he=${diff.he}`,
      };
    },
  },
  {
    name: 'E30_stress_7_same_plot',
    desc: '7 actions, mostly same plot Norte',
    group: 'E_mixed',
    compound: 'fumigué Norte con glifosato 3 lt/ha, fertilicé Norte con urea 100 kg/ha, monitoreé Norte V5 sin plagas, observé liebres en Norte, vi malezas en Norte, gasté 50mil en gasoil, llovieron 15mm',
    expect: async ({ diff }) => {
      const sum = diff.d + diff.s + diff.o + diff.e + diff.r;
      return {
        pass: diff.d >= 2 && diff.s >= 1 && diff.e >= 1 && diff.r >= 1 && sum >= 6,
        reason: `d=${diff.d} s=${diff.s} o=${diff.o} e=${diff.e} r=${diff.r} (sum=${sum}, want d>=2,s>=1,e>=1,r>=1,sum>=6)`,
        warn: diff.o < 1, // observations sometimes go to scouting
      };
    },
  },
];

// ── Runner ──────────────────────────────────────────────────────────────

interface Result {
  test: TestSpec;
  status: 'PASS' | 'FAIL' | 'WARN';
  reason: string;
  turns: string[];
  responses: string[];
}

async function runTest(t: TestSpec, userId: number): Promise<Result> {
  const before = await countAll(userId);
  const turns: string[] = [];
  const responses: string[] = [];

  turns.push(`USER: ${t.compound}`);
  let respObj = await apiSend(t.compound);
  let resp = extractText(respObj);
  turns.push(`BOT: ${resp.substring(0, 320)}${resp.length > 320 ? '...' : ''}`);
  responses.push(resp);

  // If test wants to tap the first button (bulk-plot prompt), do it once.
  if (t.tapFirstButton) {
    const btn = firstButtonId(respObj);
    if (btn) {
      turns.push(`TAP: ${btn}`);
      respObj = await apiTap(btn);
      resp = extractText(respObj);
      turns.push(`BOT: ${resp.substring(0, 320)}${resp.length > 320 ? '...' : ''}`);
      responses.push(resp);
    }
  }

  const remaining = [...(t.answers ?? [])];
  let safety = 8;
  while (remaining.length > 0 && botIsAsking(resp) && safety > 0) {
    const ans = remaining.shift()!;
    turns.push(`USER: ${ans}`);
    respObj = await apiSend(ans);
    resp = extractText(respObj);
    turns.push(`BOT: ${resp.substring(0, 320)}${resp.length > 320 ? '...' : ''}`);
    responses.push(resp);
    safety--;
  }

  if (botIsAsking(resp) && remaining.length === 0) {
    try { await sendAndLog('cancelar'); } catch { /* ignore */ }
  }

  const after = await countAll(userId);
  const diff = diffCounts(before, after);

  let status: 'PASS' | 'FAIL' | 'WARN';
  let reason: string;
  try {
    const v = await t.expect({ userId, diff, turns: responses });
    if (v.pass && v.warn) status = 'WARN';
    else status = v.pass ? 'PASS' : 'FAIL';
    reason = v.reason;
  } catch (err: any) {
    status = 'FAIL';
    reason = `expect-fn threw: ${err.message}`;
  }

  try { await sendAndLog('cancelar'); } catch { /* ignore */ }

  return { test: t, status, reason, turns, responses };
}

async function main(): Promise<void> {
  console.log('🧪 QA Broad Coverage — 30 scenarios across 5 groups (regression for commit 44460f3)');
  console.log('=====================================================================================\n');

  const auth = await apiRegister();
  TOKEN = auth.token;
  const userId = auth.userId;
  console.log(`✅ Authenticated as user ${userId}`);

  await apiReset();
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [userId]);
  console.log('✅ Reset + enterprise plan\n');

  await setupState();

  const results: Result[] = [];
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`${num}/${TESTS.length} [${t.group}] ${t.name} — ${t.desc}\n`);
    process.stdout.write('   ');
    try {
      const r = await runTest(t, userId);
      results.push(r);
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`${icon} ${r.status} — ${r.reason}`);
    } catch (err: any) {
      console.log(`💥 ERROR: ${err.message}`);
      results.push({ test: t, status: 'FAIL', reason: `runtime: ${err.message}`, turns: [], responses: [] });
    }
  }

  // ── Summary ──
  console.log('\n════════════════════════════════════════════');
  console.log('                 SUMMARY');
  console.log('════════════════════════════════════════════\n');
  const byGroup = (g: Group) => results.filter(r => r.test.group === g);
  const passOf = (rs: Result[]) => rs.filter(r => r.status === 'PASS').length;
  const failOf = (rs: Result[]) => rs.filter(r => r.status === 'FAIL').length;
  const warnOf = (rs: Result[]) => rs.filter(r => r.status === 'WARN').length;

  for (const g of ['A_financial', 'B_agronomy', 'C_livestock', 'D_stock', 'E_mixed'] as Group[]) {
    const rs = byGroup(g);
    console.log(`  ${g.padEnd(15)}: ${passOf(rs)}/${rs.length} pass, ${warnOf(rs)} warn, ${failOf(rs)} fail`);
  }

  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n  ✅ PASS: ${pass}`);
  console.log(`  ⚠️  WARN: ${warn}`);
  console.log(`  ❌ FAIL: ${fail}`);
  console.log(`  📊 Total: ${results.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / results.length) * 100)}%\n`);

  if (fail > 0) {
    console.log('─── FAILURES ───\n');
    for (const r of results.filter(x => x.status === 'FAIL')) {
      console.log(`  ❌ ${r.test.name} (${r.test.group})`);
      console.log(`     ${r.reason}`);
      console.log(`     Compound: ${r.test.compound}`);
      console.log(`     Planned answers: ${JSON.stringify(r.test.answers ?? [])}`);
      for (const t of r.turns.slice(0, 14)) {
        console.log(`       ${t}`);
      }
      console.log('');
    }
  }

  if (warn > 0) {
    console.log('─── WARNINGS ───\n');
    for (const r of results.filter(x => x.status === 'WARN')) {
      console.log(`  ⚠️  ${r.test.name} (${r.test.group}): ${r.reason}`);
    }
    console.log('');
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-broad-coverage-results.json',
    JSON.stringify(results.map(r => ({
      name: r.test.name, desc: r.test.desc, group: r.test.group,
      compound: r.test.compound, answers: r.test.answers ?? [],
      status: r.status, reason: r.reason, turns: r.turns,
    })), null, 2),
  );
  console.log(`📄 Full report: src/testing/qa-broad-coverage-results.json\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
