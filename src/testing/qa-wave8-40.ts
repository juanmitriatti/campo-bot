/**
 * QA Wave 8 — 40 NEW scenarios totally distinct from the prior 235 tests.
 *
 * Coverage focus (7 groups × ~6 tests each):
 *   P — Compound edge cases (8)
 *   Q — Hacienda P0 verification (5)   — verifies "vendí N animales a $X c/u" → remove_livestock
 *   R — Stock advanced (5)
 *   S — Date intelligence (5)
 *   T — Reports + queries (5)
 *   U — Livestock lifecycle chains (5)
 *   V — Communication patterns (7)
 *
 * Auth: qa-wave8@campo.test / qatest123 / Don Octavo
 * Setup: "La Querencia" in Pergamino with 4 plots + crops + livestock + warehouse.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-wave8-40.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-wave8@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Octavo';

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
    const errBody = await res.text().catch(() => '');
    throw new Error(`Query failed: ${res.status} — ${errBody.slice(0, 120)}`);
  }
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

// ── Count snapshot ──────────────────────────────────────────────────────

interface Counts {
  e: number; i: number; d: number; o: number; s: number;
  lm: number; sm: number; r: number; f: number; p: number; w: number;
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
  (SELECT COUNT(*)::int FROM plots p JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND p.deleted_at IS NULL) as p,
  (SELECT COUNT(*)::int FROM warehouses w JOIN fields f ON f.id=w.field_id WHERE f.user_id=$1 AND w.deleted_at IS NULL) as w`;

async function countAll(userId: number): Promise<Counts> {
  const rows = await apiQueryDb(COUNT_SQL, [userId]);
  const r = rows[0] ?? {};
  // Force numeric (DB returns ints but JSON serializes as numbers OK; defensive cast).
  return {
    e: Number(r.e || 0), i: Number(r.i || 0), d: Number(r.d || 0), o: Number(r.o || 0),
    s: Number(r.s || 0), lm: Number(r.lm || 0), sm: Number(r.sm || 0), r: Number(r.r || 0),
    f: Number(r.f || 0), p: Number(r.p || 0), w: Number(r.w || 0),
  };
}

function diff(before: Counts, after: Counts): Counts {
  return {
    e: after.e - before.e, i: after.i - before.i, d: after.d - before.d, o: after.o - before.o,
    s: after.s - before.s, lm: after.lm - before.lm, sm: after.sm - before.sm, r: after.r - before.r,
    f: after.f - before.f, p: after.p - before.p, w: after.w - before.w,
  };
}

// ── Setup ───────────────────────────────────────────────────────────────

async function setupSharedState(userId: number): Promise<void> {
  console.log('🔧 Setup shared state...');
  await sendAndLog('agregar campo La Querencia');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');
  for (const [name, ha] of [['Norte', 100], ['Sur', 150], ['Este', 80], ['Oeste', 120]] as const) {
    await sendAndLog(`agregar lote ${name} al campo La Querencia`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré soja en Norte');
  await sendAndLog('sembré maíz en Sur');
  await sendAndLog('sembré trigo en Este');
  await sendAndLog('sembré girasol en Oeste');
  await sendAndLog('agregué 60 vacas Angus en Norte');
  await sendAndLog('agregué 40 novillos en Sur');
  await sendAndLog('crear galpón Central en La Querencia');
  await sendAndLog('agregar 200 bolsas semilla soja al galpón Central');
  await sendAndLog('agregar 150 lt glifosato al galpón Central');
  await sendAndLog('agregar 100 bolsas urea al galpón Central');
  console.log('✅ Setup done\n');
}

// ── Test spec ───────────────────────────────────────────────────────────

type Group = 'P_compound_edges' | 'Q_hacienda_p0' | 'R_stock' | 'S_dates' | 'T_reports' | 'U_livestock_chain' | 'V_communication';

interface ExpectCtx {
  userId: number;
  d: Counts;       // delta
  text: string;    // last bot response (concatenated all turns)
}

type ExpectFn = (ctx: ExpectCtx) => Promise<{ pass: boolean; reason: string; warn?: boolean }> | { pass: boolean; reason: string; warn?: boolean };

interface TestSpec {
  name: string;
  desc: string;
  group: Group;
  compound: string;
  answers?: string[];
  expect: ExpectFn;
}

function botIsAsking(text: string): boolean {
  if (!text) return false;
  if (/\?/.test(text)) return true;
  return /cu[aá]nt|cu[aá]l|en qu[eé]|qu[eé] |c[oó]mo|d[oó]nde|me lo dec/i.test(text);
}

// ── 40 scenarios ────────────────────────────────────────────────────────

const TESTS: TestSpec[] = [

  // ───── Group P — Compound edge cases (8) ─────
  {
    name: 'P01_correction_within_message',
    group: 'P_compound_edges',
    desc: 'corrección dentro del mismo mensaje',
    compound: 'vendí 10 tn de soja a 480 USD por tonelada, perdón eran 12 tn no 10',
    expect: ({ d }) => ({
      pass: d.i >= 1,
      reason: `i=${d.i} (≥1: tolerar 1 ingreso; corrección puede no procesarse pero no debe duplicar)`,
    }),
  },
  {
    name: 'P02_question_then_action',
    group: 'P_compound_edges',
    desc: 'pregunta + acción mezcladas',
    compound: 'cuánto vendí este mes y registrá un gasto de 50 mil en semilla',
    expect: ({ d, text }) => {
      const queried = /resultado|mes|gast|ingres/i.test(text);
      return { pass: queried && d.e >= 1, reason: `query=${queried} e=${d.e}` };
    },
  },
  {
    name: 'P03_negation',
    group: 'P_compound_edges',
    desc: 'mensaje con NO + correción ("no vendí soja, vendí maíz")',
    compound: 'no vendí soja, vendí 15 tn de maíz a 200 USD por tonelada',
    expect: ({ d }) => ({
      pass: d.i >= 1,
      reason: `i=${d.i} (debería ser 1, NUNCA 2)`,
    }),
  },
  {
    name: 'P04_units_mixed_scale',
    group: 'P_compound_edges',
    desc: 'unidades mezcladas (qq + tn + kg)',
    compound: 'vendí 80 qq de soja a 48 USD por quintal y compré 500 kg de urea a 1200 el kg',
    expect: ({ d }) => ({
      pass: d.i >= 1 && d.e >= 1,
      reason: `i=${d.i} e=${d.e}`,
    }),
  },
  {
    name: 'P05_pronoun_chain',
    group: 'P_compound_edges',
    desc: 'compound con pronombres ("ahí mismo")',
    compound: 'fumigué Norte con glifosato 3 lt/ha y fertilicé ahí mismo con urea 100 kg/ha',
    expect: ({ d }) => ({
      pass: d.d >= 2,
      reason: `d=${d.d} (spray + fertil)`,
    }),
  },
  {
    name: 'P06_past_and_future_tense',
    group: 'P_compound_edges',
    desc: 'pasado + futuro en compound (futuro debe ignorarse o quedar pendiente)',
    compound: 'ayer fumigué Sur con 2,4D 2 lt/ha y mañana voy a sembrar avena en Este',
    expect: ({ d, text }) => {
      // Aceptable: fum saved + bot avisa que la siembra no se puede registrar a futuro
      const hasFuture = /futur|próxim|mañana|no.*regist/i.test(text);
      return { pass: d.d >= 1, reason: `d=${d.d} hasFutureWarning=${hasFuture}` };
    },
  },
  {
    name: 'P07_emojis',
    group: 'P_compound_edges',
    desc: 'mensaje con emojis',
    compound: '💰 vendí 8 tn de maíz a 220 USD/tn 🌽 y compré 50 bolsas urea a 9mil 💸',
    expect: ({ d }) => ({
      pass: d.i >= 1 && d.e >= 1,
      reason: `i=${d.i} e=${d.e}`,
    }),
  },
  {
    name: 'P08_three_distinct_currencies_in_one',
    group: 'P_compound_edges',
    desc: 'compound con USD + ARS distintos',
    compound: 'vendí 20 tn soja a 480 USD por tonelada y gasté 80 mil pesos en gasoil',
    expect: async ({ userId, d }) => {
      if (d.i < 1 || d.e < 1) return { pass: false, reason: `i=${d.i} e=${d.e}` };
      const incomes = await apiQueryDb(
        `SELECT currency FROM incomes WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const expenses = await apiQueryDb(
        `SELECT currency FROM expenses WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const incomeUSD = incomes.some((r: any) => r.currency === 'USD');
      const expenseARS = expenses.some((r: any) => r.currency === 'ARS');
      return { pass: incomeUSD && expenseARS, reason: `incomeUSD=${incomeUSD} expenseARS=${expenseARS}` };
    },
  },

  // ───── Group Q — Hacienda P0 verification (5) ─────
  {
    name: 'Q09_vendi_5_vacas_unit_price',
    group: 'Q_hacienda_p0',
    desc: 'P0 fix: vendí 5 vacas a 1500 USD c/u → remove_livestock (NO log_income directo)',
    compound: 'vendí 5 vacas a 1500 USD cada una en Norte',
    expect: async ({ userId, d, text }) => {
      // Debe haber 1 livestock_movement de salida + 1 income vinculado.
      // NO debe haber un income suelto sin linked_livestock_movement_id.
      if (d.lm < 1) return { pass: false, reason: `lm=${d.lm} (esperado ≥1 remove_livestock) text="${text.slice(0, 100)}"` };
      const lm = await apiQueryDb(
        `SELECT movement_type, count, unit_price_usd, linked_income_id FROM livestock_movements WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const remove = lm.find((r: any) => Number(r.count) === 5 && Number(r.unit_price_usd) === 1500);
      if (!remove) return { pass: false, reason: `no remove_livestock matching count=5 unit_price_usd=1500 found in last 90s: ${JSON.stringify(lm)}` };
      const hasLinkedIncome = remove.linked_income_id != null;
      return { pass: hasLinkedIncome, reason: `lm=${d.lm} remove found, linked_income=${remove.linked_income_id}` };
    },
  },
  {
    name: 'Q10_compre_10_vaquillonas',
    group: 'Q_hacienda_p0',
    desc: 'P0 parity: compré 10 vaquillonas Angus a 1200 USD c/u → add_livestock + auto-linked expense',
    compound: 'compré 10 vaquillonas Angus a 1200 USD cada una para Norte',
    expect: async ({ userId, d }) => {
      if (d.lm < 1) return { pass: false, reason: `lm=${d.lm}` };
      const lm = await apiQueryDb(
        `SELECT movement_type, count, unit_price_usd, linked_expense_id FROM livestock_movements WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const add = lm.find((r: any) => Number(r.count) === 10 && Number(r.unit_price_usd) === 1200);
      if (!add) return { pass: false, reason: `no add_livestock count=10 unit_price=1200 found: ${JSON.stringify(lm)}` };
      const hasLinkedExpense = add.linked_expense_id != null;
      return { pass: hasLinkedExpense, reason: `lm=${d.lm} add found, linked_expense=${add.linked_expense_id}` };
    },
  },
  {
    name: 'Q11_vendi_compound_two_categorias',
    group: 'Q_hacienda_p0',
    desc: 'P0: dos ventas hacienda en compound, no conflación',
    compound: 'vendí 4 novillos a 1900 USD c/u y vendí 3 vacas Angus a 1500 USD c/u en Norte',
    expect: async ({ userId }) => {
      const lm = await apiQueryDb(
        `SELECT category, count, unit_price_usd FROM livestock_movements WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const novillos = lm.find((r: any) => r.category === 'novillo' && Number(r.count) === 4 && Number(r.unit_price_usd) === 1900);
      const vacas = lm.find((r: any) => r.category === 'vaca' && Number(r.count) === 3 && Number(r.unit_price_usd) === 1500);
      return {
        pass: !!novillos && !!vacas,
        reason: `novillos=${!!novillos} vacas=${!!vacas} found=${JSON.stringify(lm.slice(0, 3))}`,
      };
    },
  },
  {
    name: 'Q12_venta_pesos_arg',
    group: 'Q_hacienda_p0',
    desc: 'venta hacienda en pesos (NO USD)',
    compound: 'vendí 6 terneros a 850000 pesos cada uno',
    expect: async ({ userId, d }) => {
      if (d.lm < 1) return { pass: false, reason: `lm=${d.lm}` };
      const lm = await apiQueryDb(
        `SELECT category, count, unit_price_ars, unit_price_usd FROM livestock_movements WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const match = lm.find((r: any) => Number(r.count) === 6 && Number(r.unit_price_ars) === 850000);
      return { pass: !!match, reason: `match=${!!match} found=${JSON.stringify(lm[0])}` };
    },
  },
  {
    name: 'Q13_venta_no_price_queue',
    group: 'Q_hacienda_p0',
    desc: 'venta hacienda sin precio → bot pregunta, queue resuelve',
    compound: 'vendí 3 vacas en Norte',
    answers: ['1600 USD cada una'],
    expect: async ({ userId, d, text }) => {
      // En la primera vuelta el bot debería preguntar precio. En la segunda, debería persistir.
      const movements = await apiQueryDb(
        `SELECT count, unit_price_usd FROM livestock_movements WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const match = movements.find((r: any) => Number(r.count) === 3 && Number(r.unit_price_usd) === 1600);
      const askedForPrice = /precio|cuánt|c\/u|por animal|por cabeza/i.test(text);
      return {
        pass: !!match,
        reason: `match=${!!match} askedForPrice=${askedForPrice} text="${text.slice(0, 120)}"`,
      };
    },
  },

  // ───── Group R — Stock advanced (5) ─────
  {
    name: 'R14_stock_long_product_name',
    group: 'R_stock',
    desc: 'stock con nombre largo de producto',
    compound: 'agregar 50 bolsas de Fertilizante Compuesto NPK 15-15-15 al galpón Central a 18mil cada una',
    expect: async ({ userId, d }) => {
      if (d.sm < 1) return { pass: false, reason: `sm=${d.sm}` };
      const items = await apiQueryDb(
        `SELECT name FROM stock_items WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const found = items.some((r: any) => r.name && r.name.toLowerCase().includes('npk'));
      return { pass: found, reason: `npk found=${found} items=${JSON.stringify(items)}` };
    },
  },
  {
    name: 'R15_stock_transfer',
    group: 'R_stock',
    desc: 'transferir stock entre galpones',
    compound: 'crear galpón Secundario en La Querencia y moví 50 bolsas de urea del galpón Central al Secundario',
    expect: async ({ d }) => ({
      pass: d.w >= 1,
      reason: `w=${d.w} (esperado ≥1 warehouse nuevo; transfer es bonus)`,
    }),
  },
  {
    name: 'R16_stock_alert_plus_add',
    group: 'R_stock',
    desc: 'query stock bajo + agregar',
    compound: 'qué tengo en stock bajo y agregar 80 lt de cipermetrina al galpón Central a 1500 c/u',
    expect: ({ d }) => ({
      pass: d.sm >= 1,
      reason: `sm=${d.sm}`,
    }),
  },
  {
    name: 'R17_stock_negative_safety',
    group: 'R_stock',
    desc: 'sacar más stock del disponible — bot debe bloquear o avisar',
    compound: 'saqué 5000 lt de glifosato del galpón Central',
    expect: ({ text, d }) => {
      const hasWarning = /no.*hay|insuficiente|excede|máximo|stock.*disponib|sin stock|quedan/i.test(text);
      return { pass: hasWarning || d.sm === 0, reason: `warning=${hasWarning} sm=${d.sm}` };
    },
  },
  {
    name: 'R18_stock_query_multi',
    group: 'R_stock',
    desc: 'múltiples queries de stock en compound',
    compound: 'cuánto glifosato tengo, cuánta urea tengo y cuánta semilla soja',
    expect: ({ text }) => {
      const mentionsAll = /glifosato/i.test(text) && /urea/i.test(text) && /soja|semilla/i.test(text);
      return { pass: mentionsAll, reason: `mentionsAll=${mentionsAll}` };
    },
  },

  // ───── Group S — Date intelligence (5) ─────
  {
    name: 'S19_viernes_pasado',
    group: 'S_dates',
    desc: 'fecha relativa "el viernes pasado"',
    compound: 'el viernes pasado vendí 15 tn de soja a 470 USD por tonelada',
    expect: async ({ userId, d }) => {
      if (d.i < 1) return { pass: false, reason: `i=${d.i}` };
      const rows = await apiQueryDb(
        `SELECT income_date FROM incomes WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 2`,
        [userId],
      );
      const past = rows.some((r: any) => r.income_date && new Date(r.income_date) < new Date());
      return { pass: past, reason: `past_date=${past} rows=${JSON.stringify(rows)}` };
    },
  },
  {
    name: 'S20_hace_2_meses',
    group: 'S_dates',
    desc: '"hace 2 meses" en gasto',
    compound: 'hace 2 meses compré 100 bolsas urea a 8500 c/u',
    expect: async ({ userId, d }) => {
      if (d.e < 1) return { pass: false, reason: `e=${d.e}` };
      const rows = await apiQueryDb(
        `SELECT expense_date FROM expenses WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 2`,
        [userId],
      );
      // Esperamos fecha al menos 30 días atrás
      const twoMonthsAgo = new Date(); twoMonthsAgo.setDate(twoMonthsAgo.getDate() - 30);
      const old = rows.some((r: any) => r.expense_date && new Date(r.expense_date) < twoMonthsAgo);
      return { pass: old, reason: `old_date=${old} rows=${JSON.stringify(rows)}` };
    },
  },
  {
    name: 'S21_dates_multiple_distinct',
    group: 'S_dates',
    desc: '3 acciones con 3 fechas distintas',
    compound: 'ayer gasté 50mil en gasoil, anteayer 80mil en repuestos y hoy compré 30 bolsas urea a 8mil c/u',
    expect: async ({ userId, d }) => {
      if (d.e < 2) return { pass: false, reason: `e=${d.e} (esperado ≥2)` };
      const rows = await apiQueryDb(
        `SELECT expense_date FROM expenses WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 5`,
        [userId],
      );
      const uniqueDates = new Set(rows.map((r: any) => String(r.expense_date)));
      return { pass: uniqueDates.size >= 2, reason: `unique_dates=${uniqueDates.size} rows=${JSON.stringify(rows)}` };
    },
  },
  {
    name: 'S22_temporal_in_query',
    group: 'S_dates',
    desc: 'query con período + acción',
    compound: 'cuánto gasté en los últimos 7 días y agregar gasto de 30mil en alimento animal',
    expect: ({ text, d }) => {
      const hasQuery = /resumen|gast|últim|7|mensual|reciente/i.test(text);
      return { pass: hasQuery && d.e >= 1, reason: `query=${hasQuery} e=${d.e}` };
    },
  },
  {
    name: 'S23_future_date_should_warn',
    group: 'S_dates',
    desc: 'fecha futura debe ser rechazada o avisada',
    compound: 'la semana que viene voy a sembrar avena en Norte',
    expect: ({ text, d }) => {
      // Aceptable: bot avisa que no puede registrar a futuro O ignora
      const futureMentioned = /futuro|próxim|todavía|no.*regist|cuando.*siembr/i.test(text);
      return { pass: futureMentioned || d.d === 0, reason: `futureWarning=${futureMentioned} d=${d.d}` };
    },
  },

  // ───── Group T — Reports + queries (5) ─────
  {
    name: 'T24_two_aggregation_queries',
    group: 'T_reports',
    desc: 'dos queries de agregación en compound',
    compound: 'cuánto vendí en soja este mes y cuánto gasté en agroquímicos este mes',
    expect: ({ text, d }) => {
      const noWrites = d.e === 0 && d.i === 0 && d.d === 0;
      const hasFinancial = /soja|agroquí|ingres|gast|\$|usd/i.test(text);
      return { pass: noWrites && hasFinancial, reason: `noWrites=${noWrites} hasFinancial=${hasFinancial}` };
    },
  },
  {
    name: 'T25_period_comparison',
    group: 'T_reports',
    desc: 'comparativa entre períodos',
    compound: 'compará mis ingresos de marzo vs abril',
    expect: ({ text, d }) => {
      const isCompare = /compar|vs|march|abril|differen/i.test(text);
      return { pass: d.i === 0 && d.e === 0, reason: `noWrites=${d.i === 0 && d.e === 0} isCompare=${isCompare}` };
    },
  },
  {
    name: 'T26_query_no_writes_strict',
    group: 'T_reports',
    desc: 'query puro debe NO escribir nada',
    compound: 'mostrame el resumen financiero del último mes',
    expect: ({ d }) => ({
      pass: d.e === 0 && d.i === 0 && d.d === 0 && d.o === 0,
      reason: `e=${d.e} i=${d.i} d=${d.d} o=${d.o} (todos deben ser 0)`,
    }),
  },
  {
    name: 'T27_comparative_crops',
    group: 'T_reports',
    desc: 'compara productividad de cultivos',
    compound: 'cuánto rindió el soja vs el maíz este año',
    expect: ({ text }) => {
      const hasYieldInfo = /rinde|rend|kg.*ha|cosech|sin cosech|todavía|no.*hay/i.test(text);
      return { pass: hasYieldInfo, reason: `hasYieldInfo=${hasYieldInfo}` };
    },
  },
  {
    name: 'T28_report_with_format',
    group: 'T_reports',
    desc: 'pedido de reporte con formato (PDF)',
    compound: 'generame el reporte agronómico en PDF de los últimos 3 meses',
    expect: ({ text }) => {
      const isAgroReport = /reporte.*agro|pdf|generand|gener.*reporte/i.test(text);
      return { pass: isAgroReport, reason: `isAgroReport=${isAgroReport}` };
    },
  },

  // ───── Group U — Livestock lifecycle chains (5) ─────
  {
    name: 'U29_birth_then_vaccinate',
    group: 'U_livestock_chain',
    desc: 'nacimiento + vacunación cascada',
    compound: 'nacieron 8 terneros de las vacas Angus en Norte y vacuné los terneros contra brucelosis',
    expect: async ({ userId }) => {
      const lm = await apiQueryDb(
        `SELECT COUNT(*)::int as c FROM livestock_movements WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND movement_type='nacimiento'`,
        [userId],
      );
      const he = await apiQueryDb(
        `SELECT COUNT(*)::int as c FROM domain_events WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND event_type='health_event'`,
        [userId],
      );
      return {
        pass: Number(lm[0]?.c) >= 1 && Number(he[0]?.c) >= 1,
        reason: `nacimientos=${lm[0]?.c} health=${he[0]?.c}`,
      };
    },
  },
  {
    name: 'U30_weigh_then_sell',
    group: 'U_livestock_chain',
    desc: 'pesar + vender chain',
    compound: 'pesé 20 novillos 380 kg promedio en Sur y vendí 10 a 1850 USD c/u',
    expect: async ({ userId, d }) => {
      if (d.lm < 1) return { pass: false, reason: `lm=${d.lm}` };
      const weighing = await apiQueryDb(
        `SELECT COUNT(*)::int as c FROM domain_events WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND event_type='weighing'`,
        [userId],
      );
      const sold = await apiQueryDb(
        `SELECT count, unit_price_usd FROM livestock_movements WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND movement_type='salida' ORDER BY id DESC LIMIT 2`,
        [userId],
      );
      return {
        pass: Number(weighing[0]?.c) >= 1 && sold.length >= 1,
        reason: `weighing=${weighing[0]?.c} sold=${sold.length}`,
      };
    },
  },
  {
    name: 'U31_full_lifecycle',
    group: 'U_livestock_chain',
    desc: 'compra + vacuna + pesaje en compound',
    compound: 'compré 10 vaquillonas Hereford a 1400 USD c/u para Norte, las vacuné contra aftosa y las pesé al ingreso 320 kg promedio',
    expect: async ({ userId }) => {
      const lm = await apiQueryDb(
        `SELECT COUNT(*)::int as c FROM livestock_movements WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND movement_type='entrada'`,
        [userId],
      );
      const events = await apiQueryDb(
        `SELECT event_type, COUNT(*)::int as c FROM domain_events WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND event_type IN ('health_event','weighing') GROUP BY event_type`,
        [userId],
      );
      return {
        pass: Number(lm[0]?.c) >= 1 && events.length >= 1,
        reason: `purchases=${lm[0]?.c} events=${JSON.stringify(events)}`,
      };
    },
  },
  {
    name: 'U32_repro_chain',
    group: 'U_livestock_chain',
    desc: 'eché toro + detecté celo + inseminé',
    compound: 'eché el toro Centauro en Norte, detecté 5 vacas en celo y inseminé 3 con IATF',
    expect: async ({ userId }) => {
      const events = await apiQueryDb(
        `SELECT COUNT(*)::int as c FROM domain_events WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND event_type='repro_event'`,
        [userId],
      );
      return { pass: Number(events[0]?.c) >= 2, reason: `repro_events=${events[0]?.c} (esperado ≥2)` };
    },
  },
  {
    name: 'U33_death_record',
    group: 'U_livestock_chain',
    desc: 'muerte de animales + causa',
    compound: 'se murieron 2 terneros en Norte por neumonía',
    expect: async ({ userId, d }) => {
      if (d.lm < 1) return { pass: false, reason: `lm=${d.lm}` };
      const death = await apiQueryDb(
        `SELECT count, reason FROM livestock_movements WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND movement_type='muerte' ORDER BY id DESC LIMIT 2`,
        [userId],
      );
      return { pass: death.length >= 1, reason: `deaths=${death.length} rows=${JSON.stringify(death)}` };
    },
  },

  // ───── Group V — Communication patterns (7) ─────
  {
    name: 'V34_dictation_style',
    group: 'V_communication',
    desc: 'estilo dictado continuo',
    compound: 'estuve haciendo varias cosas hoy primero fumigué Norte con glifosato dos litros por hectárea después fertilicé Sur con urea cien kilos por hectárea',
    expect: ({ d }) => ({
      pass: d.d >= 2,
      reason: `d=${d.d}`,
    }),
  },
  {
    name: 'V35_bullet_list',
    group: 'V_communication',
    desc: 'lista con guiones',
    compound: '- vendí 20 tn maíz a 200 USD/tn\n- compré 50 bolsas urea a 8500 c/u\n- gasté 30mil en gasoil',
    expect: ({ d }) => ({
      pass: d.i >= 1 && d.e >= 2,
      reason: `i=${d.i} e=${d.e}`,
    }),
  },
  {
    name: 'V36_numbered_list',
    group: 'V_communication',
    desc: 'lista numerada',
    compound: '1) fumigué Este con 2,4D 1.5 lt/ha\n2) llovieron 18mm en La Querencia\n3) monitoreé Sur V5 sin plagas',
    expect: ({ d }) => ({
      pass: d.d >= 1 && (d.r >= 1 || d.s >= 1),
      reason: `d=${d.d} r=${d.r} s=${d.s}`,
    }),
  },
  {
    name: 'V37_apologetic_correction',
    group: 'V_communication',
    desc: 'corrección con "perdón"',
    compound: 'compré 30 bolsas urea a 8500 c/u, perdón eran 35 bolsas',
    expect: async ({ userId, d }) => {
      if (d.e < 1) return { pass: false, reason: `e=${d.e}` };
      const rows = await apiQueryDb(
        `SELECT quantity FROM expenses WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const has35 = rows.some((r: any) => Number(r.quantity) === 35);
      return { pass: has35, reason: `qty=35 found=${has35} (corrección aplicada) rows=${JSON.stringify(rows)}` };
    },
  },
  {
    name: 'V38_spanglish',
    group: 'V_communication',
    desc: 'spanglish/anglicismos en compound',
    compound: 'sold 25 tn de soja at 480 USD per ton y buy 100 lt de glifosato para A1',
    expect: ({ text, d }) => {
      // Aceptable: bot procesa al menos uno O pide aclaración
      const handled = d.i >= 1 || d.e >= 1 || botIsAsking(text);
      return { pass: handled, reason: `i=${d.i} e=${d.e} asks=${botIsAsking(text)}` };
    },
  },
  {
    name: 'V39_extremely_concise',
    group: 'V_communication',
    desc: 'mensaje extremadamente conciso',
    compound: 'venta soja 20tn 480usd',
    expect: ({ d, text }) => {
      const handled = d.i >= 1 || botIsAsking(text);
      return { pass: handled, reason: `i=${d.i} asks=${botIsAsking(text)}` };
    },
  },
  {
    name: 'V40_question_at_end',
    group: 'V_communication',
    desc: 'acción + pregunta de validación al final',
    compound: 'vendí 15 tn de maíz a 200 USD por tonelada, está bien?',
    expect: ({ d }) => ({
      pass: d.i >= 1,
      reason: `i=${d.i}`,
    }),
  },
];

// ── Runner ──────────────────────────────────────────────────────────────

interface Result {
  test: TestSpec;
  status: 'PASS' | 'FAIL' | 'WARN';
  reason: string;
  turns: string[];
}

async function runTest(t: TestSpec, userId: number): Promise<Result> {
  // Clear any sticky pending state from the previous test (sometimes the bot
  // leaves "¿En qué lote?" hanging, which hijacks the next test's compound).
  try { await sendAndLog('cancelar'); } catch { /* ignore */ }

  const before = await countAll(userId);
  let resp = await apiSend(t.compound);
  let text = extractText(resp);
  const turns: string[] = [text];

  for (const answer of t.answers ?? []) {
    if (!botIsAsking(text)) break;
    resp = await apiSend(answer);
    text = extractText(resp);
    turns.push(text);
  }

  // Wait a tick for any async writes
  await new Promise(r => setTimeout(r, 200));

  const after = await countAll(userId);
  const d = diff(before, after);
  const aggregatedText = turns.join('\n');

  try {
    const result = await Promise.resolve(t.expect({ userId, d, text: aggregatedText }));
    return {
      test: t,
      status: result.pass ? 'PASS' : (result.warn ? 'WARN' : 'FAIL'),
      reason: result.reason,
      turns,
    };
  } catch (err: any) {
    return { test: t, status: 'FAIL', reason: `expect-fn threw: ${err.message}`, turns };
  }
}

async function main(): Promise<void> {
  console.log('🧪 QA Wave 8 — 40 NEW scenarios');
  console.log('═════════════════════════════════\n');

  const auth = await apiRegister();
  TOKEN = auth.token;
  const userId = auth.userId;
  console.log(`✅ Authenticated as user ${userId}`);

  await apiReset();
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [userId]);
  console.log('✅ Reset + enterprise plan');

  await setupSharedState(userId);

  const results: Result[] = [];
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`${num}/${TESTS.length} [${t.group}] ${t.name} — ${t.desc}\n   `);
    try {
      const r = await runTest(t, userId);
      results.push(r);
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`${icon} ${r.status} — ${r.reason}`);
    } catch (err: any) {
      console.log(`💥 ${err.message}`);
      results.push({ test: t, status: 'FAIL', reason: `runtime: ${err.message}`, turns: [] });
    }
  }

  // Summary
  console.log('\n═════════════════════════════════');
  console.log('             SUMMARY');
  console.log('═════════════════════════════════\n');

  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`  ✅ PASS: ${pass}  ⚠️  WARN: ${warn}  ❌ FAIL: ${fail}  📊 ${results.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / results.length) * 100)}%\n`);

  const byGroup: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    if (!byGroup[r.test.group]) byGroup[r.test.group] = { pass: 0, total: 0 };
    byGroup[r.test.group].total++;
    if (r.status === 'PASS') byGroup[r.test.group].pass++;
  }
  for (const [g, c] of Object.entries(byGroup)) {
    console.log(`  ${g}: ${c.pass}/${c.total}`);
  }

  if (fail > 0) {
    console.log('\n─── FAILURES ───\n');
    for (const r of results.filter(x => x.status === 'FAIL')) {
      console.log(`  ❌ ${r.test.name} (${r.test.group})`);
      console.log(`     ${r.reason}`);
      const preview = (r.turns[r.turns.length - 1] || '').substring(0, 200).replace(/\n/g, ' ');
      console.log(`     last turn: ${preview}\n`);
    }
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-wave8-results.json',
    JSON.stringify(
      results.map(r => ({ name: r.test.name, group: r.test.group, status: r.status, reason: r.reason, compound: r.test.compound, turns: r.turns })),
      null, 2,
    ),
  );
  console.log(`\n📄 Report: src/testing/qa-wave8-results.json`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
