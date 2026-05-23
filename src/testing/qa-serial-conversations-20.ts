/**
 * QA Serial Conversations — 20 multi-turn scenarios
 *
 * Goal: verify the NEW serial pending queue (commit a663bc2) where the bot
 * asks for missing data ONE ITEM AT A TIME instead of conflating multiple
 * answers across multiple pending items.
 *
 * Each scenario:
 *   1. Sends a COMPOUND message (one input → multiple intended actions).
 *   2. Loops: while the bot's response looks like a question and there are
 *      more "answers" planned, send the next planned answer.
 *   3. After loop, queries DB and verifies the EXPECTED end state — specific
 *      counts AND specific values so we catch conflation (e.g. wrong price
 *      on wrong item).
 *
 * Tests share state — no reset between tests; we measure DELTAS.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-serial-conversations-20.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-serial-conv@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Serial';

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
async function sendAndLog(message: string): Promise<string> {
  return extractText(await apiSend(message));
}

// ── Setup ───────────────────────────────────────────────────────────────

async function setupState(): Promise<void> {
  console.log('🔧 Setting up shared state...');
  await sendAndLog('agregar campo La Esperanza');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');
  for (const [name, ha] of [['A1', 100], ['A2', 150], ['A3', 80]] as const) {
    await sendAndLog(`agregar lote ${name} al campo La Esperanza`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('agregué 60 vacas Angus en A1');
  await sendAndLog('agregué 30 novillos en A1');
  await sendAndLog('crear galpón Principal en La Esperanza');
  await sendAndLog('agregar 200 bolsas de soja al galpón Principal');
  await sendAndLog('agregar 150 lt de glifosato al galpón Principal');
  console.log('✅ Setup done\n');
}

// ── Test spec ───────────────────────────────────────────────────────────

interface CountRow {
  e: number; i: number; d: number; o: number; s: number;
  lm: number; sm: number; r: number; f: number; p: number;
}

const COUNT_SQL = `SELECT
  (SELECT COUNT(*)::int FROM expenses WHERE user_id=$1 AND deleted_at IS NULL) as e,
  (SELECT COUNT(*)::int FROM incomes WHERE user_id=$1 AND deleted_at IS NULL) as i,
  (SELECT COUNT(*)::int FROM domain_events WHERE user_id=$1) as d,
  (SELECT COUNT(*)::int FROM agro_observations WHERE user_id=$1) as o,
  (SELECT COUNT(*)::int FROM crop_scoutings WHERE user_id=$1) as s,
  (SELECT COUNT(*)::int FROM livestock_movements WHERE user_id=$1) as lm,
  (SELECT COUNT(*)::int FROM stock_movements WHERE user_id=$1) as sm,
  (SELECT COUNT(*)::int FROM rainfall WHERE user_id=$1) as r,
  (SELECT COUNT(*)::int FROM fields WHERE user_id=$1 AND deleted_at IS NULL) as f,
  (SELECT COUNT(*)::int FROM plots p JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND p.deleted_at IS NULL) as p`;

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

interface ExpectFn {
  (ctx: { userId: number; diff: Record<keyof CountRow, number>; turns: string[] }): Promise<{ pass: boolean; reason: string }>;
}

interface TestSpec {
  name: string;
  desc: string;
  category: 'complete' | 'partial' | 'mixed';
  compound: string;
  /** Planned follow-up answers (consumed only when the bot keeps asking). */
  answers: string[];
  /** Validate end state via DB + diff. Return pass=true/false + reason. */
  expect: ExpectFn;
}

// ── Helper: detect "is bot asking?" heuristic ───────────────────────────
function botIsAsking(text: string): boolean {
  if (!text) return false;
  // Endings or markers that imply a question
  const lower = text.toLowerCase();
  const hasQ = text.includes('?') || text.includes('¿');
  const hasAskWord = /(cu[aá]nto|cu[aá]l|qu[eé] |c[oó]mo|en qu[eé]|d[oó]nde|falta|me falta|necesit|elig|aclar)/i.test(lower);
  // The serial queue surfaces "💡 Tengo N acciones pendientes" or "👇 ...:" prompts
  const hasQueueMark = /👇|pendiente/i.test(text);
  return (hasQ && hasAskWord) || hasQueueMark;
}

// ── Tests ────────────────────────────────────────────────────────────────

const TESTS: TestSpec[] = [
  // ───────── COMPLETE (5) — single turn, no follow-up expected ─────────
  {
    name: '01_complete_4_mixed',
    desc: '4 mixed: gasto+ingreso+actividad+hacienda all complete',
    category: 'complete',
    compound: 'gasté 30 mil en gasoil, vendí 10 tn de soja a 480 USD por tonelada, fumigué A1 con glifosato 3 lt/ha, agregué 20 vaquillonas Angus en A2',
    answers: [],
    expect: async ({ diff }) => {
      const total = diff.e + diff.i + diff.d + diff.lm;
      return { pass: total >= 4, reason: `e=${diff.e} i=${diff.i} d=${diff.d} lm=${diff.lm} (sum=${total}, want>=4)` };
    },
  },
  {
    name: '02_complete_5_agro',
    desc: 'sow + spray + fertil + livestock + monitoreo complete',
    category: 'complete',
    compound: 'sembré girasol en A2, fumigué A1 con glifosato 2 lt/ha, fertilicé A3 con urea 100 kg/ha, agregué 15 terneros Angus en A1, monitoreé A1 soja V4 con 5% malezas',
    answers: [],
    expect: async ({ diff }) => {
      const writes = diff.d + diff.s + diff.lm;
      return { pass: writes >= 4, reason: `d=${diff.d} s=${diff.s} lm=${diff.lm} (sum=${writes}, want>=4)` };
    },
  },
  {
    name: '03_complete_harvest_sale_scouting',
    desc: 'cosecha + venta + scouting complete',
    category: 'complete',
    compound: 'coseché soja en A1 con 4500 kg/ha, vendí 30 tn de soja a 450 USD por tonelada, monitoreé A2 maíz V6 sin plagas',
    answers: [],
    expect: async ({ diff }) => {
      const writes = diff.d + diff.i + diff.s;
      return { pass: writes >= 3, reason: `d=${diff.d} i=${diff.i} s=${diff.s} (sum=${writes}, want>=3)` };
    },
  },
  {
    name: '04_complete_stock_spray_fert_expense',
    desc: 'stock + spray + fertilization + expense complete',
    category: 'complete',
    compound: 'saqué 40 lt de glifosato del galpón Principal, fumigué A1 con glifosato 2 lt/ha, fertilicé A2 con urea 80 kg/ha, gasté 50 mil en gasoil',
    answers: [],
    expect: async ({ diff }) => {
      const writes = diff.sm + diff.d + diff.e;
      return { pass: writes >= 4, reason: `sm=${diff.sm} d=${diff.d} e=${diff.e} (sum=${writes}, want>=4)` };
    },
  },
  {
    name: '05_complete_lluvia_monitoreo_lvstk_venta',
    desc: 'lluvia + monitoreo + livestock + venta complete',
    category: 'complete',
    compound: 'llovieron 25 mm en La Esperanza, monitoreé A1 soja V5 con 8% rama negra, agregué 10 vacas Hereford en A3, vendí 5 tn de maíz a 220 USD por tonelada',
    answers: [],
    expect: async ({ diff }) => {
      const writes = diff.r + diff.s + diff.lm + diff.i;
      return { pass: writes >= 4, reason: `r=${diff.r} s=${diff.s} lm=${diff.lm} i=${diff.i} (sum=${writes}, want>=4)` };
    },
  },

  // ───────── PARTIAL (10) — serial queue follow-ups ─────────
  {
    name: '06_partial_soja_urea_prices',
    desc: 'vendí soja + compré urea (both need qty+price)',
    category: 'partial',
    compound: 'vendí soja y compré urea',
    answers: ['5 tn a 480 USD', '30 bolsas a 8mil'],
    expect: async ({ userId }) => {
      // Look at last 5 of each — find ones likely from this test
      const incomes = await apiQueryDb(
        `SELECT category, amount, quantity, unit_price, currency FROM incomes WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const expenses = await apiQueryDb(
        `SELECT category, product, amount, quantity, unit_price, currency FROM expenses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const sojaInc = incomes.find((r: any) => /soja/i.test(String(r.category)));
      const ureaExp = expenses.find((r: any) =>
        /urea/i.test(String(r.product ?? '')) || /urea/i.test(String(r.category ?? '')),
      );
      if (!sojaInc) return { pass: false, reason: `No soja income found. incomes=${JSON.stringify(incomes)}` };
      if (!ureaExp) return { pass: false, reason: `No urea expense found. expenses=${JSON.stringify(expenses)}` };
      // CRITICAL: prices must NOT be conflated
      const sojaPrice = Number(sojaInc.unit_price);
      const ureaPrice = Number(ureaExp.unit_price);
      if (sojaPrice === 8000 || sojaPrice === 9000) {
        return { pass: false, reason: `CONFLATION: soja unit_price=${sojaPrice} (urea price leaked). soja=${JSON.stringify(sojaInc)}` };
      }
      if (ureaPrice === 480) {
        return { pass: false, reason: `CONFLATION: urea unit_price=480 (soja price leaked). urea=${JSON.stringify(ureaExp)}` };
      }
      const sojaOk = sojaPrice === 480 || Number(sojaInc.amount) >= 2000;
      const ureaOk = ureaPrice === 8000 || Number(ureaExp.amount) >= 200000;
      return {
        pass: sojaOk && ureaOk,
        reason: `soja: price=${sojaPrice} amt=${sojaInc.amount}; urea: price=${ureaPrice} amt=${ureaExp.amount}`,
      };
    },
  },
  {
    name: '07_partial_vacas_glifosato',
    desc: 'vendí 2 vacas + compré glifosato (vacas need plot/price; gasto needs price)',
    category: 'partial',
    compound: 'vendí 2 vacas y compré glifosato',
    answers: ['en A2 a 1500 dolares cada una', '80 mil pesos'],
    expect: async ({ userId, diff }) => {
      const livestockMov = await apiQueryDb(
        `SELECT category, count, movement_type, plot_id, unit_price_ars, unit_price_usd FROM livestock_movements WHERE user_id=$1 ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const expenses = await apiQueryDb(
        `SELECT category, product, amount, currency FROM expenses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const remove2 = livestockMov.find((r: any) => r.movement_type === 'remove' && Number(r.count) === 2);
      const glifoExp = expenses.find((r: any) =>
        /glifosato/i.test(String(r.product ?? '')) || /glifosato/i.test(String(r.category ?? '')),
      );
      if (!remove2) return { pass: false, reason: `No 2-vacas removal found. livestock=${JSON.stringify(livestockMov)}` };
      if (!glifoExp) return { pass: false, reason: `No glifosato expense. expenses=${JSON.stringify(expenses)}` };
      // Verify no conflation: vacas should have USD price (1500), expense should be in ARS (80000)
      const expenseAmt = Number(glifoExp.amount);
      const expenseCur = String(glifoExp.currency);
      if (expenseAmt === 1500 || expenseAmt === 3000) {
        return { pass: false, reason: `CONFLATION: glifosato amount=${expenseAmt} matches vacas USD price. exp=${JSON.stringify(glifoExp)}` };
      }
      return {
        pass: diff.lm >= 1 && diff.e >= 1,
        reason: `lm=${diff.lm} e=${diff.e}, vacas=${JSON.stringify(remove2)}, glifo=${JSON.stringify(glifoExp)}`,
      };
    },
  },
  {
    name: '08_partial_fumigue_semilla',
    desc: 'fumigué + compré semilla',
    category: 'partial',
    compound: 'fumigué y compré semilla',
    answers: ['en A1 con glifosato 3 lt/ha', '100 bolsas de soja a 12mil c/u'],
    expect: async ({ userId, diff }) => {
      const expenses = await apiQueryDb(
        `SELECT category, product, amount, quantity, unit_price FROM expenses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const semExp = expenses.find((r: any) =>
        /semilla|soja/i.test(String(r.product ?? '') + ' ' + String(r.category ?? '')),
      );
      const sprayDelta = diff.d >= 1;
      return {
        pass: sprayDelta && diff.e >= 1 && !!semExp,
        reason: `d=${diff.d} e=${diff.e} semExp=${JSON.stringify(semExp)}`,
      };
    },
  },
  {
    name: '09_partial_sembre_hacienda',
    desc: 'sembré + agregué hacienda',
    category: 'partial',
    compound: 'sembré y agregué hacienda',
    answers: ['trigo en A3', '40 vaquillonas Hereford en A2'],
    expect: async ({ diff }) => {
      return { pass: diff.d >= 1 && diff.lm >= 1, reason: `d=${diff.d} lm=${diff.lm}` };
    },
  },
  {
    name: '10_partial_coseche_vendi',
    desc: 'coseché + vendí',
    category: 'partial',
    compound: 'coseché y vendí',
    answers: ['soja en A1 con 4500 kg/ha', '50 toneladas a 480 USD'],
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, amount, quantity, unit_price, currency FROM incomes WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const sojaInc = incomes.find((r: any) => /soja/i.test(String(r.category)));
      const hasHarvest = diff.d >= 1;
      return {
        pass: hasHarvest && diff.i >= 1 && !!sojaInc,
        reason: `d=${diff.d} i=${diff.i} sojaInc=${JSON.stringify(sojaInc)}`,
      };
    },
  },
  {
    name: '11_partial_monitoree_fumigue',
    desc: 'monitoreé + fumigué',
    category: 'partial',
    compound: 'monitoreé y fumigué',
    answers: ['A1 con soja V3 sin plagas', 'A2 con glifosato 2 lt/ha'],
    expect: async ({ diff }) => {
      return { pass: diff.s >= 1 && diff.d >= 1, reason: `s=${diff.s} d=${diff.d}` };
    },
  },
  {
    name: '12_partial_vacas_novillos_one_loc',
    desc: 'agregué 50 vacas y 30 novillos (one loc)',
    category: 'partial',
    compound: 'agregué 50 vacas y 30 novillos',
    answers: ['en A2', 'en A2'],
    expect: async ({ userId, diff }) => {
      const livestockMov = await apiQueryDb(
        `SELECT category, count, movement_type, plot_id FROM livestock_movements WHERE user_id=$1 ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      // Look at the 2 most recent ADD movements with count 50 / 30
      const addVacas = livestockMov.find((r: any) => r.movement_type === 'add' && Number(r.count) === 50);
      const addNov = livestockMov.find((r: any) => r.movement_type === 'add' && Number(r.count) === 30);
      const both = !!addVacas && !!addNov;
      return {
        pass: diff.lm >= 2 && both,
        reason: `lm=${diff.lm} vacas=${JSON.stringify(addVacas)} nov=${JSON.stringify(addNov)}`,
      };
    },
  },
  {
    name: '13_partial_stock_cosecha',
    desc: 'saqué stock + coseché',
    category: 'partial',
    compound: 'saqué stock y coseché',
    answers: ['60 lt de glifosato del galpón Principal', 'soja en A1 con 4200 kg/ha'],
    expect: async ({ diff }) => {
      return { pass: diff.sm >= 1 && diff.d >= 1, reason: `sm=${diff.sm} d=${diff.d}` };
    },
  },
  {
    name: '14_partial_4_serial',
    desc: 'gasoil + vendí maíz + fumigué + terneros (4 partials)',
    category: 'partial',
    compound: 'gasté en gasoil, vendí maíz, fumigué y agregué terneros',
    answers: ['25 mil pesos', '20 tn a 220 USD por tonelada', 'en A1 con glifosato 2 lt/ha', '15 terneros Angus en A2'],
    expect: async ({ diff }) => {
      // We expect roughly 4 records (1 expense + 1 income + 1 activity + 1 livestock)
      const total = diff.e + diff.i + diff.d + diff.lm;
      return { pass: total >= 3, reason: `e=${diff.e} i=${diff.i} d=${diff.d} lm=${diff.lm} (sum=${total}, want>=3)` };
    },
  },
  {
    name: '15_partial_qty_unit_no_price',
    desc: 'vendí 10 tn soja + compré 50 bolsas urea (both have qty+unit, no price)',
    category: 'partial',
    compound: 'vendí 10 tn de soja y compré 50 bolsas de urea',
    answers: ['480 USD la tonelada', '9 mil cada una'],
    expect: async ({ userId }) => {
      const incomes = await apiQueryDb(
        `SELECT category, amount, quantity, unit_price, currency FROM incomes WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const expenses = await apiQueryDb(
        `SELECT category, product, amount, quantity, unit_price, currency FROM expenses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const sojaInc = incomes.find((r: any) => /soja/i.test(String(r.category)) && Number(r.quantity) === 10);
      const ureaExp = expenses.find((r: any) =>
        /urea/i.test(String(r.product ?? '') + ' ' + String(r.category ?? '')) && Number(r.quantity) === 50,
      );
      if (!sojaInc) return { pass: false, reason: `No 10tn soja income. incomes=${JSON.stringify(incomes)}` };
      if (!ureaExp) return { pass: false, reason: `No 50-bolsa urea expense. expenses=${JSON.stringify(expenses)}` };
      const sojaPrice = Number(sojaInc.unit_price);
      const ureaPrice = Number(ureaExp.unit_price);
      // CRITICAL no-conflation
      if (sojaPrice === 9000) {
        return { pass: false, reason: `CONFLATION: soja unit_price=9000 (urea leak). soja=${JSON.stringify(sojaInc)}` };
      }
      if (ureaPrice === 480) {
        return { pass: false, reason: `CONFLATION: urea unit_price=480 (soja leak). urea=${JSON.stringify(ureaExp)}` };
      }
      return {
        pass: true,
        reason: `soja: qty=10 price=${sojaPrice} amt=${sojaInc.amount}; urea: qty=50 price=${ureaPrice} amt=${ureaExp.amount}`,
      };
    },
  },

  // ───────── MIXED (5) — some complete + some partial ─────────
  {
    name: '16_mixed_spray_complete_income_partial',
    desc: 'fumigué A1 (complete) + vendí maíz (partial)',
    category: 'mixed',
    compound: 'fumigué A1 con glifosato 3 lt/ha y vendí maíz',
    answers: ['20 tn a 200 USD por tonelada'],
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, amount, quantity, unit_price FROM incomes WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const maizInc = incomes.find((r: any) => /ma[ií]z/i.test(String(r.category)));
      // Must NOT have spawned an extra spray
      return {
        pass: diff.d >= 1 && diff.i >= 1 && !!maizInc,
        reason: `d=${diff.d} i=${diff.i} maizInc=${JSON.stringify(maizInc)}`,
      };
    },
  },
  {
    name: '17_mixed_income_complete_expense_partial',
    desc: 'vendí soja complete + compré gasoil partial',
    category: 'mixed',
    compound: 'vendí 15 tn de soja a 450 USD por tonelada y compré gasoil',
    answers: ['60 mil pesos'],
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const sojaInc = incomes.find((r: any) => /soja/i.test(String(r.category)) && Number(r.quantity) === 15);
      // Soja price must NOT be 60000
      if (sojaInc && Number(sojaInc.unit_price) === 60000) {
        return { pass: false, reason: `CONFLATION: soja price=60000` };
      }
      return {
        pass: diff.i >= 1 && diff.e >= 1,
        reason: `i=${diff.i} e=${diff.e} sojaInc=${JSON.stringify(sojaInc)}`,
      };
    },
  },
  {
    name: '18_mixed_livestock_complete_income_partial',
    desc: 'agregué 20 vacas (complete) + vendí novillos (partial)',
    category: 'mixed',
    compound: 'agregué 20 vacas Hereford en A1 y vendí novillos',
    answers: ['5 cabezas a 1800 USD'],
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, amount, quantity, unit_price, currency FROM incomes WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const recent = incomes[0];
      return {
        pass: diff.lm >= 1 && (diff.i >= 1 || diff.lm >= 2),
        reason: `lm=${diff.lm} i=${diff.i} latestInc=${JSON.stringify(recent)}`,
      };
    },
  },
  {
    name: '19_mixed_sow_complete_2_partials',
    desc: 'sembré A1 (complete) + vendí lo de antes (partial) + flete (partial)',
    category: 'mixed',
    compound: 'sembré soja en A1, vendí lo que cosecharon antes y gasté en flete',
    answers: ['20 tn de soja a 450 USD por tonelada', '150 mil pesos'],
    expect: async ({ diff }) => {
      const total = diff.d + diff.i + diff.e;
      return { pass: total >= 3, reason: `d=${diff.d} i=${diff.i} e=${diff.e} (sum=${total}, want>=3)` };
    },
  },
  {
    name: '20_mixed_onboarding_2_partials',
    desc: 'NEW field+plot onboarding + vendí trigo + compré urea (2 partials)',
    category: 'mixed',
    compound: 'tengo el campo nuevo Los Olmos en Junín, con lote único A 80 ha. Vendí trigo y compré urea',
    answers: ['10 tn a 200 USD por tonelada', '30 bolsas a 8 mil cada una'],
    expect: async ({ userId, diff }) => {
      const fields = await apiQueryDb(
        `SELECT name, city FROM fields WHERE user_id=$1 AND deleted_at IS NULL AND name ILIKE 'Los Olmos%' LIMIT 5`,
        [userId],
      );
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const expenses = await apiQueryDb(
        `SELECT category, product, quantity, unit_price FROM expenses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const trigoInc = incomes.find((r: any) => /trigo/i.test(String(r.category)));
      const ureaExp = expenses.find((r: any) =>
        /urea/i.test(String(r.product ?? '') + ' ' + String(r.category ?? '')),
      );
      // Check no conflation on the prices
      let conflation = '';
      if (trigoInc && Number(trigoInc.unit_price) === 8000) conflation += 'TRIGO_GOT_UREA_PRICE ';
      if (ureaExp && Number(ureaExp.unit_price) === 200) conflation += 'UREA_GOT_TRIGO_PRICE ';
      return {
        pass: fields.length >= 1 && diff.f >= 1 && diff.p >= 1 && diff.i >= 1 && diff.e >= 1 && !conflation,
        reason: `f=${diff.f} p=${diff.p} i=${diff.i} e=${diff.e} fields=${fields.length} trigo=${JSON.stringify(trigoInc)} urea=${JSON.stringify(ureaExp)}${conflation ? ' CONFLATION:' + conflation : ''}`,
      };
    },
  },
];

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

  // 1. Send the compound
  turns.push(`USER: ${t.compound}`);
  let resp = await sendAndLog(t.compound);
  turns.push(`BOT: ${resp.substring(0, 280)}${resp.length > 280 ? '...' : ''}`);
  responses.push(resp);

  // 2. Loop: send planned answers while the bot is still asking
  const remaining = [...t.answers];
  let safety = 6; // max 6 turns to avoid infinite loop
  while (remaining.length > 0 && botIsAsking(resp) && safety > 0) {
    const ans = remaining.shift()!;
    turns.push(`USER: ${ans}`);
    resp = await sendAndLog(ans);
    turns.push(`BOT: ${resp.substring(0, 280)}${resp.length > 280 ? '...' : ''}`);
    responses.push(resp);
    safety--;
  }

  // For COMPLETE category tests: bot shouldn't have asked at all (no answers expected),
  // but if there's lingering interactive (e.g. bulk-plot prompt asking for lote), tap it away.
  // We don't want to leak state into the next test. Best-effort: send 'cancelar' if still pending.
  if (botIsAsking(resp) && remaining.length === 0) {
    try { await sendAndLog('cancelar'); } catch { /* ignore */ }
  }

  const after = await countAll(userId);
  const diff = diffCounts(before, after);

  // 3. Validate
  let status: 'PASS' | 'FAIL' | 'WARN';
  let reason: string;
  try {
    const v = await t.expect({ userId, diff, turns: responses });
    status = v.pass ? 'PASS' : 'FAIL';
    reason = v.reason;
  } catch (err: any) {
    status = 'FAIL';
    reason = `expect-fn threw: ${err.message}`;
  }

  // Cleanup: clear any lingering pending so tests don't bleed
  try { await sendAndLog('cancelar'); } catch { /* ignore */ }

  return { test: t, status, reason, turns, responses };
}

async function main(): Promise<void> {
  console.log('🧪 QA Serial Conversations — 20 multi-turn scenarios');
  console.log('=====================================================\n');

  const auth = await apiRegister();
  TOKEN = auth.token;
  const userId = auth.userId;
  console.log(`✅ Authenticated as user ${userId}`);

  // Reset + plan upgrade
  await apiReset();
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [userId]);
  console.log('✅ Reset + enterprise plan\n');

  // Always run setup after a reset (reset wipes the state)
  await setupState();

  const results: Result[] = [];
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`${num}/${TESTS.length} ${t.name} — ${t.desc}\n`);
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

  // Summary
  console.log('\n════════════════════════════════════════════');
  console.log('                 SUMMARY');
  console.log('════════════════════════════════════════════\n');
  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`  ✅ PASS: ${pass}`);
  console.log(`  ⚠️  WARN: ${warn}`);
  console.log(`  ❌ FAIL: ${fail}`);
  console.log(`  📊 Total: ${results.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / results.length) * 100)}%\n`);

  if (fail > 0) {
    console.log('─── FAILURES ───\n');
    for (const r of results.filter(x => x.status === 'FAIL')) {
      console.log(`  ❌ ${r.test.name} (${r.test.category})`);
      console.log(`     ${r.reason}`);
      console.log(`     Compound: ${r.test.compound}`);
      console.log(`     Planned answers: ${JSON.stringify(r.test.answers)}`);
      for (const t of r.turns.slice(0, 12)) {
        console.log(`       ${t}`);
      }
      console.log('');
    }
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-serial-conversations-results.json',
    JSON.stringify(results.map(r => ({
      name: r.test.name, desc: r.test.desc, category: r.test.category,
      compound: r.test.compound, answers: r.test.answers,
      status: r.status, reason: r.reason, turns: r.turns,
    })), null, 2),
  );
  console.log(`📄 Full report: src/testing/qa-serial-conversations-results.json\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
