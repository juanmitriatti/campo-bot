/**
 * QA Repeated Combos — 20 NEW multi-turn scenarios focused on REPETITION
 *
 * Tests the agent's ability to:
 *   - Emit N tools when the same verb is repeated in one message (no dedup).
 *   - Distinguish prices/plots/products across repeated items (no conflation).
 *   - Drive the serial pending queue when several items in the same compound
 *     need follow-up data.
 *
 * Builds on commit 58ae007 (dedup bug fix in pending-action-processor.ts:69
 * and merged.command carry in controllers). Does NOT repeat the scenarios
 * already covered by qa-serial-conversations-20.ts.
 *
 * State: ONE shared dataset is set up at startup. Tests share state — no
 * reset between tests; we measure DELTAS.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-repeated-combos-20.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-repeated@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Repetido';

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

// ── Setup (ONCE) ────────────────────────────────────────────────────────

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
  await sendAndLog('sembré soja en A1');
  await sendAndLog('sembré maíz en A2');
  await sendAndLog('sembré trigo en A3');
  await sendAndLog('agregué 80 vacas Angus en A1');
  await sendAndLog('agregué 50 novillos en A2');
  await sendAndLog('agregué 40 terneros en A1');
  await sendAndLog('crear galpón Principal en La Esperanza');
  await sendAndLog('agregar 300 bolsas de soja al galpón Principal');
  await sendAndLog('agregar 200 lt de glifosato al galpón Principal');
  await sendAndLog('agregar 100 bolsas de urea al galpón Principal');
  console.log('✅ Setup done\n');
}

// ── Test spec ───────────────────────────────────────────────────────────

interface CountRow {
  e: number; i: number; d: number; o: number; s: number;
  lm: number; sm: number; r: number; f: number; p: number;
  hl: number; he: number;
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
  (SELECT COUNT(*)::int FROM harvest_loads hl JOIN domain_events de ON de.id=hl.domain_event_id WHERE de.user_id=$1) as hl,
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

interface ExpectFn {
  (ctx: { userId: number; diff: Record<keyof CountRow, number>; turns: string[] }): Promise<{ pass: boolean; reason: string }>;
}

interface TestSpec {
  name: string;
  desc: string;
  category: 'repeated-same' | 'repeated-partial' | 'mixed-diverse';
  compound: string;
  /** Planned follow-up answers (consumed only when the bot keeps asking). */
  answers: string[];
  /** Validate end state via DB + diff. Return pass=true/false + reason. */
  expect: ExpectFn;
}

// ── Helper: detect "is bot asking?" heuristic ───────────────────────────
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
  // ───────── REPEATED SAME ACTION (5) ─────────
  {
    name: '01_2x_compra_distinct_prices',
    desc: '2x compra: urea 30 bolsas a 8mil + glifosato 100 lt a 950',
    category: 'repeated-same',
    compound: 'compré 30 bolsas de urea a 8mil y compré 100 lt de glifosato a 950',
    answers: [],
    expect: async ({ userId, diff }) => {
      const expenses = await apiQueryDb(
        `SELECT category, product, amount, quantity, unit_price
         FROM expenses WHERE user_id=$1 AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY id DESC`,
        [userId],
      );
      const urea = expenses.find((r: any) => /urea/i.test(String(r.product ?? '') + ' ' + String(r.category ?? '')));
      const glifo = expenses.find((r: any) => /glifosato/i.test(String(r.product ?? '') + ' ' + String(r.category ?? '')));
      if (!urea) return { pass: false, reason: `No urea expense. expenses=${JSON.stringify(expenses)}` };
      if (!glifo) return { pass: false, reason: `No glifosato expense. expenses=${JSON.stringify(expenses)}` };
      const ureaP = Number(urea.unit_price);
      const glifoP = Number(glifo.unit_price);
      if (ureaP === 950) return { pass: false, reason: `CONFLATION: urea price=950 (glifo leak). urea=${JSON.stringify(urea)}` };
      if (glifoP === 8000) return { pass: false, reason: `CONFLATION: glifo price=8000 (urea leak). glifo=${JSON.stringify(glifo)}` };
      const ok = diff.e >= 2 && (ureaP === 8000 || Number(urea.amount) >= 200000) && (glifoP === 950 || Number(glifo.amount) >= 90000);
      return { pass: ok, reason: `e=${diff.e}; urea: qty=${urea.quantity} price=${ureaP} amt=${urea.amount}; glifo: qty=${glifo.quantity} price=${glifoP} amt=${glifo.amount}` };
    },
  },
  {
    name: '02_3x_venta_distinct_crops',
    desc: '3x venta: soja 20tn 480USD + maíz 15tn 200USD + trigo 10tn 180USD',
    category: 'repeated-same',
    compound: 'vendí 20 tn de soja a 480 USD, vendí 15 tn de maíz a 200 USD, vendí 10 tn de trigo a 180 USD',
    answers: [],
    expect: async ({ userId, diff }) => {
      // Only look at rows from the LAST 60s (recent test)
      const incomes = await apiQueryDb(
        `SELECT category, amount, quantity, unit_price, currency
         FROM incomes WHERE user_id=$1 AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY id DESC`,
        [userId],
      );
      const soja = incomes.find((r: any) => Number(r.quantity) === 20 && Number(r.unit_price) === 480);
      const maiz = incomes.find((r: any) => Number(r.quantity) === 15 && Number(r.unit_price) === 200);
      const trigo = incomes.find((r: any) => Number(r.quantity) === 10 && Number(r.unit_price) === 180);
      const missing: string[] = [];
      if (!soja) missing.push('soja-20@480');
      if (!maiz) missing.push('maíz-15@200');
      if (!trigo) missing.push('trigo-10@180');
      // Category check (bot may save trigo as "Otros" — known weakness, warn only)
      const categoryIssues: string[] = [];
      if (soja && !/soja/i.test(String(soja.category))) categoryIssues.push(`soja-cat=${soja.category}`);
      if (maiz && !/ma[ií]z/i.test(String(maiz.category))) categoryIssues.push(`maíz-cat=${maiz.category}`);
      if (trigo && !/trigo/i.test(String(trigo.category))) categoryIssues.push(`trigo-cat=${trigo.category}`);
      return {
        pass: diff.i >= 3 && missing.length === 0,
        reason: `i=${diff.i}; ${missing.length ? 'MISSING: ' + missing.join(',') : 'all 3 distinct qty+price'}${categoryIssues.length ? ` CAT: ${categoryIssues.join(',')}` : ''}`,
      };
    },
  },
  {
    name: '03_3x_fumigacion_distinct_plots_products',
    desc: '3x fumigación: A1 glifosato + A2 2,4D + A3 atrazina',
    category: 'repeated-same',
    compound: 'fumigué A1 con glifosato 2 lt/ha, fumigué A2 con 2,4D 1.5 lt/ha, fumigué A3 con atrazina 3 lt/ha',
    answers: [],
    expect: async ({ userId, diff }) => {
      const events = await apiQueryDb(
        `SELECT de.id, de.event_type, p.name as plot_name, de.product as product
         FROM domain_events de LEFT JOIN plots p ON p.id = de.plot_id
         WHERE de.user_id=$1 AND de.event_type='spraying' AND de.deleted_at IS NULL
           AND de.created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY de.id DESC`,
        [userId],
      );
      const a1 = events.find((r: any) => r.plot_name === 'A1' && /glifosato/i.test(String(r.product ?? '')));
      const a2 = events.find((r: any) => r.plot_name === 'A2' && /2[,.]?4[\s-]?d/i.test(String(r.product ?? '')));
      const a3 = events.find((r: any) => r.plot_name === 'A3' && /atrazina/i.test(String(r.product ?? '')));
      const missing: string[] = [];
      if (!a1) missing.push('A1+glifosato');
      if (!a2) missing.push('A2+2,4D');
      if (!a3) missing.push('A3+atrazina');
      return {
        pass: diff.d >= 3 && missing.length === 0,
        reason: `d=${diff.d}; ${missing.length ? 'MISSING: ' + missing.join(', ') + ` events=${JSON.stringify(events)}` : 'all 3 sprays at correct plots+products'}`,
      };
    },
  },
  {
    name: '04_3x_hacienda_add_distinct_plots_categories',
    desc: '3x add livestock: 20 vacas Hereford A1 + 30 novillos Brangus A2 + 15 terneros Angus A3',
    category: 'repeated-same',
    compound: 'agregué 20 vacas Hereford en A1, agregué 30 novillos Brangus en A2, agregué 15 terneros Angus en A3',
    answers: [],
    expect: async ({ userId, diff }) => {
      const movs = await apiQueryDb(
        `SELECT lm.count, lm.movement_type, lg.category, lg.breed, p.name as plot_name
         FROM livestock_movements lm
         LEFT JOIN livestock_groups lg ON lg.id = lm.dest_group_id
         LEFT JOIN plots p ON p.id = lg.plot_id
         WHERE lm.user_id=$1 AND lm.movement_type='entrada'
           AND lm.created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY lm.created_at DESC`,
        [userId],
      );
      const vacas = movs.find((r: any) => Number(r.count) === 20 && r.plot_name === 'A1' && /hereford/i.test(String(r.breed ?? '')));
      const nov = movs.find((r: any) => Number(r.count) === 30 && r.plot_name === 'A2' && /brangus/i.test(String(r.breed ?? '')));
      const tern = movs.find((r: any) => Number(r.count) === 15 && r.plot_name === 'A3' && /angus/i.test(String(r.breed ?? '')));
      const missing: string[] = [];
      if (!vacas) missing.push('20 Hereford A1');
      if (!nov) missing.push('30 Brangus A2');
      if (!tern) missing.push('15 Angus A3');
      return {
        pass: diff.lm >= 3 && missing.length === 0,
        reason: `lm=${diff.lm}; ${missing.length ? 'MISSING: ' + missing.join(', ') + ` movs=${JSON.stringify(movs)}` : 'all 3 at correct plots/breeds'}`,
      };
    },
  },
  {
    name: '05_3x_cosecha_partial_yields',
    desc: '3x cosecha at A1/A2/A3 with rates',
    category: 'repeated-same',
    compound: 'coseché en A1 con 4500, en A2 con 8500, en A3 con 3800',
    answers: ['kg/ha en todas'],
    expect: async ({ userId, diff }) => {
      const events = await apiQueryDb(
        `SELECT de.id, p.name as plot_name, de.crop, de.quantity, de.unit
         FROM domain_events de LEFT JOIN plots p ON p.id = de.plot_id
         WHERE de.user_id=$1 AND de.event_type='harvest' AND de.deleted_at IS NULL
           AND de.created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY de.id DESC`,
        [userId],
      );
      const a1 = events.find((r: any) => r.plot_name === 'A1');
      const a2 = events.find((r: any) => r.plot_name === 'A2');
      const a3 = events.find((r: any) => r.plot_name === 'A3');
      const missing: string[] = [];
      if (!a1) missing.push('A1');
      if (!a2) missing.push('A2');
      if (!a3) missing.push('A3');
      return {
        pass: diff.d >= 3 && missing.length === 0,
        reason: `d=${diff.d}; harvests at A1=${!!a1}, A2=${!!a2}, A3=${!!a3}. events=${JSON.stringify(events)}`,
      };
    },
  },

  // ───────── REPEATED + PARTIAL (5) ─────────
  {
    name: '06_2x_venta_one_no_price',
    desc: 'vendí 15tn soja 480USD + vendí 8tn girasol (no price)',
    category: 'repeated-partial',
    compound: 'vendí 15 tn de soja a 480 USD y vendí 8 tn de girasol',
    answers: ['550 USD por tonelada'],
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, amount, quantity, unit_price, currency
         FROM incomes WHERE user_id=$1 AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY id DESC`,
        [userId],
      );
      const soja = incomes.find((r: any) => Number(r.quantity) === 15);
      const girasol = incomes.find((r: any) => Number(r.quantity) === 8);
      if (!soja) return { pass: false, reason: `No 15tn soja income. incomes=${JSON.stringify(incomes)}` };
      if (!girasol) return { pass: false, reason: `No 8tn girasol income. incomes=${JSON.stringify(incomes)}` };
      const sP = Number(soja.unit_price), gP = Number(girasol.unit_price);
      if (sP === 550) return { pass: false, reason: `CONFLATION: soja price=550 (girasol leak). soja=${JSON.stringify(soja)}` };
      if (gP === 480) return { pass: false, reason: `CONFLATION: girasol price=480 (soja leak). girasol=${JSON.stringify(girasol)}` };
      const ok = sP === 480 && gP === 550;
      return { pass: diff.i >= 2 && ok, reason: `i=${diff.i}; soja price=${sP} (want 480); girasol price=${gP} (want 550)` };
    },
  },
  {
    name: '07_3x_compra_two_partial',
    desc: '3x compra: urea (no qty+price) + 50lt glifo a 1200 + semilla (no qty+price)',
    category: 'repeated-partial',
    compound: 'compré urea, compré 50 lt de glifosato a 1200 y compré semilla',
    answers: ['100 bolsas a 8mil', '300 mil pesos'],
    expect: async ({ userId, diff }) => {
      const expenses = await apiQueryDb(
        `SELECT category, product, amount, quantity, unit_price
         FROM expenses WHERE user_id=$1 AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY id DESC`,
        [userId],
      );
      const urea = expenses.find((r: any) => /urea/i.test(String(r.product ?? '') + ' ' + String(r.category ?? '')));
      const glifo = expenses.find((r: any) => /glifosato/i.test(String(r.product ?? '') + ' ' + String(r.category ?? '')) && Number(r.quantity) === 50);
      const semilla = expenses.find((r: any) => /semilla/i.test(String(r.product ?? '') + ' ' + String(r.category ?? '')) || Number(r.amount) === 300000);
      const missing: string[] = [];
      if (!urea) missing.push('urea');
      if (!glifo) missing.push('glifo 50lt');
      if (!semilla) missing.push('semilla');
      const conflations: string[] = [];
      if (urea && Number(urea.unit_price) === 1200) conflations.push('urea-got-glifo-price');
      if (glifo && Number(glifo.unit_price) === 8000) conflations.push('glifo-got-urea-price');
      if (semilla && Number(semilla.amount) === 8000) conflations.push('semilla-got-urea-amt');
      return {
        pass: diff.e >= 3 && missing.length === 0 && conflations.length === 0,
        reason: `e=${diff.e}; ${missing.length ? 'MISSING: ' + missing.join(',') : ''} ${conflations.length ? 'CONFLATION: ' + conflations.join(',') : ''} urea=${JSON.stringify(urea)} glifo=${JSON.stringify(glifo)} sem=${JSON.stringify(semilla)}`,
      };
    },
  },
  {
    name: '08_2x_add_livestock_no_location',
    desc: 'agregué 25 vacas Brangus + 15 novillos Angus (both no location)',
    category: 'repeated-partial',
    compound: 'agregué 25 vacas Brangus y 15 novillos Angus',
    answers: ['en A2', 'en A3'],
    expect: async ({ userId, diff }) => {
      const movs = await apiQueryDb(
        `SELECT lm.count, lm.movement_type, lg.category, lg.breed, p.name as plot_name, lm.created_at
         FROM livestock_movements lm
         LEFT JOIN livestock_groups lg ON lg.id = lm.dest_group_id
         LEFT JOIN plots p ON p.id = lg.plot_id
         WHERE lm.user_id=$1 AND lm.movement_type='entrada'
           AND lm.created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY lm.created_at DESC`,
        [userId],
      );
      const vacas = movs.find((r: any) => Number(r.count) === 25 && /brangus/i.test(String(r.breed ?? '')));
      const novillos = movs.find((r: any) => Number(r.count) === 15 && /angus/i.test(String(r.breed ?? '')));
      if (!vacas) return { pass: false, reason: `No 25-Brangus add. movs=${JSON.stringify(movs)}` };
      if (!novillos) return { pass: false, reason: `No 15-Angus add. movs=${JSON.stringify(movs)}` };
      const vacasPlot = vacas.plot_name;
      const novPlot = novillos.plot_name;
      // The expected: vacas-25 should be in A2, novillos-15 in A3.
      // Failing condition: both same plot (conflation).
      if (vacasPlot === novPlot) {
        return { pass: false, reason: `CONFLATION: both items at plot=${vacasPlot}. Expected vacas→A2, novillos→A3` };
      }
      const ok = vacasPlot === 'A2' && novPlot === 'A3';
      return {
        pass: diff.lm >= 2 && ok,
        reason: `lm=${diff.lm}; vacas at ${vacasPlot} (want A2), novillos at ${novPlot} (want A3)`,
      };
    },
  },
  {
    name: '09_2x_fumigacion_one_no_product',
    desc: 'fumigué A1 con glifosato 2lt/ha + fumigué A2 (no product)',
    category: 'repeated-partial',
    compound: 'fumigué A1 con glifosato 2 lt/ha y fumigué A2',
    answers: ['con atrazina 3 lt/ha'],
    expect: async ({ userId, diff }) => {
      const events = await apiQueryDb(
        `SELECT de.id, p.name as plot_name, de.product as product
         FROM domain_events de LEFT JOIN plots p ON p.id = de.plot_id
         WHERE de.user_id=$1 AND de.event_type='spraying' AND de.deleted_at IS NULL
           AND de.created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY de.id DESC`,
        [userId],
      );
      const a1 = events.find((r: any) => r.plot_name === 'A1' && /glifosato/i.test(String(r.product ?? '')));
      const a2 = events.find((r: any) => r.plot_name === 'A2' && /atrazina/i.test(String(r.product ?? '')));
      const missing: string[] = [];
      if (!a1) missing.push('A1+glifo');
      if (!a2) missing.push('A2+atrazina');
      // Conflation check: A1 should NOT have atrazina, A2 should NOT have glifosato
      const conflations: string[] = [];
      const a1Bad = events.find((r: any) => r.plot_name === 'A1' && /atrazina/i.test(String(r.product ?? '')));
      const a2Bad = events.find((r: any) => r.plot_name === 'A2' && /glifosato/i.test(String(r.product ?? '')));
      if (a1Bad) conflations.push('A1-got-atrazina');
      if (a2Bad) conflations.push('A2-got-glifo');
      return {
        pass: diff.d >= 2 && missing.length === 0 && conflations.length === 0,
        reason: `d=${diff.d}; ${missing.length ? 'MISSING: ' + missing.join(',') : ''} ${conflations.length ? 'CONFLATION: ' + conflations.join(',') : ''} events=${JSON.stringify(events)}`,
      };
    },
  },
  {
    name: '10_3x_cosecha_all_no_yield',
    desc: '3x cosecha at A1/A2/A3 — all missing yield. Provide one-by-one',
    category: 'repeated-partial',
    compound: 'coseché soja en A1, maíz en A2 y trigo en A3',
    answers: ['4500 kg/ha', '8500 kg/ha', '3800 kg/ha'],
    expect: async ({ userId, diff }) => {
      const events = await apiQueryDb(
        `SELECT de.id, p.name as plot_name, de.crop, de.quantity, de.unit
         FROM domain_events de LEFT JOIN plots p ON p.id = de.plot_id
         WHERE de.user_id=$1 AND de.event_type='harvest' AND de.deleted_at IS NULL
           AND de.created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY de.id DESC`,
        [userId],
      );
      const a1 = events.find((r: any) => r.plot_name === 'A1' && /soja/i.test(String(r.crop ?? '')));
      const a2 = events.find((r: any) => r.plot_name === 'A2' && /ma[ií]z/i.test(String(r.crop ?? '')));
      const a3 = events.find((r: any) => r.plot_name === 'A3' && /trigo/i.test(String(r.crop ?? '')));
      const missing: string[] = [];
      if (!a1) missing.push('A1-soja');
      if (!a2) missing.push('A2-maíz');
      if (!a3) missing.push('A3-trigo');
      // Verify yields not conflated. Quantity may store total kg or kg/ha — check it's the *correct* relative number.
      const conflations: string[] = [];
      const yA1 = Number(a1?.quantity ?? 0);
      const yA2 = Number(a2?.quantity ?? 0);
      const yA3 = Number(a3?.quantity ?? 0);
      // A1=4500 kg/ha × 100ha = 450000 kg total OR 4500 kg/ha. Either way A1 shouldn't equal A2 or A3.
      if (a1 && (yA1 === 8500 || yA1 === 3800)) conflations.push(`A1-got-other-yield(${yA1})`);
      if (a2 && (yA2 === 4500 || yA2 === 3800)) conflations.push(`A2-got-other-yield(${yA2})`);
      if (a3 && (yA3 === 4500 || yA3 === 8500)) conflations.push(`A3-got-other-yield(${yA3})`);
      return {
        pass: diff.d >= 3 && missing.length === 0 && conflations.length === 0,
        reason: `d=${diff.d}; ${missing.length ? 'MISSING: ' + missing.join(',') : ''} ${conflations.length ? 'CONFLATION: ' + conflations.join(',') : ''} events=${JSON.stringify(events)}`,
      };
    },
  },

  // ───────── MIXED DIVERSE COMBOS (10) ─────────
  {
    name: '11_compra_compra_hacienda_scouting',
    desc: '2x compra + 1 livestock + 1 scouting (all complete)',
    category: 'mixed-diverse',
    compound: 'compré 50 bolsas urea a 8mil, compré gasoil 200 lt a 950, agregué 20 vaquillonas Hereford en A2, monitoreé A1 con V4 sin plagas',
    answers: [],
    expect: async ({ diff }) => {
      const total = diff.e + diff.lm + diff.s;
      return { pass: total >= 4, reason: `e=${diff.e} lm=${diff.lm} s=${diff.s} (sum=${total}, want>=4)` };
    },
  },
  {
    name: '12_venta_venta_cosecha_gasto',
    desc: '2x venta + cosecha + gasto (all complete)',
    category: 'mixed-diverse',
    compound: 'vendí 30 tn soja a 480 USD, vendí 25 tn maíz a 200 USD, coseché trigo en A3 con 3500 kg/ha, gasté 150mil en cosechadora',
    answers: [],
    expect: async ({ diff, userId }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes WHERE user_id=$1 AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY id DESC`, [userId]);
      const soja = incomes.find((r: any) => Number(r.quantity) === 30);
      const maiz = incomes.find((r: any) => Number(r.quantity) === 25);
      const issues: string[] = [];
      if (!soja || Number(soja.unit_price) !== 480) issues.push(`soja=${JSON.stringify(soja)}`);
      if (!maiz || Number(maiz.unit_price) !== 200) issues.push(`maíz=${JSON.stringify(maiz)}`);
      return {
        pass: diff.i >= 2 && diff.d >= 1 && diff.e >= 1 && issues.length === 0,
        reason: `i=${diff.i} d=${diff.d} e=${diff.e}; ${issues.length ? 'ISSUES: ' + issues.join('; ') : 'all correct'}`,
      };
    },
  },
  {
    name: '13_3x_livestock_health',
    desc: '3x health: vacuné aftosa + vacuné brucelosis + desparasité ivermectina',
    category: 'mixed-diverse',
    compound: 'vacuné 50 vacas contra aftosa, vacuné 30 novillos contra brucelosis, desparasité 40 terneros con ivermectina',
    answers: [],
    expect: async ({ userId, diff }) => {
      const events = await apiQueryDb(
        `SELECT de.id, de.event_type, de.product, de.notes, de.animals_affected
         FROM domain_events de WHERE de.user_id=$1 AND de.event_type='health_event' AND de.deleted_at IS NULL
           AND de.created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY de.id DESC`,
        [userId],
      );
      const aftosa = events.find((r: any) => /aftosa/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      const bruce = events.find((r: any) => /brucelosis/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      const iver = events.find((r: any) => /ivermectina/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      const missing: string[] = [];
      if (!aftosa) missing.push('aftosa');
      if (!bruce) missing.push('brucelosis');
      if (!iver) missing.push('ivermectina');
      return {
        pass: diff.he >= 3 && missing.length === 0,
        reason: `he=${diff.he}; ${missing.length ? 'MISSING: ' + missing.join(',') : 'all 3 health events found'} events=${JSON.stringify(events)}`,
      };
    },
  },
  {
    name: '14_2x_scouting_1_spray',
    desc: '2x monitoreo + 1 fumigación',
    category: 'mixed-diverse',
    compound: 'monitoreé A1 con V3 con 10% rama negra, monitoreé A2 con V5 sin plagas, fumigué A1 con glifosato 2 lt/ha',
    answers: [],
    expect: async ({ userId, diff }) => {
      const scoutings = await apiQueryDb(
        `SELECT cs.stage_code, cs.weed_coverage_pct, p.name as plot_name
         FROM crop_scoutings cs LEFT JOIN plots p ON p.id = cs.plot_id
         WHERE cs.user_id=$1 AND cs.deleted_at IS NULL
           AND cs.created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY cs.id DESC`,
        [userId],
      );
      const a1 = scoutings.find((r: any) => r.plot_name === 'A1' && /V3/i.test(String(r.stage_code ?? '')));
      const a2 = scoutings.find((r: any) => r.plot_name === 'A2' && /V5/i.test(String(r.stage_code ?? '')));
      return {
        pass: diff.s >= 2 && diff.d >= 1 && !!a1 && !!a2,
        reason: `s=${diff.s} d=${diff.d}; A1+V3=${!!a1} A2+V5=${!!a2} scoutings=${JSON.stringify(scoutings)}`,
      };
    },
  },
  {
    name: '15_lluvia_monitoreo_cosecha_venta_chain',
    desc: 'lluvia + monitoreo + cosecha + venta (4 actions)',
    category: 'mixed-diverse',
    compound: 'llovieron 25mm en La Esperanza, monitoreé A1 V8 normal, coseché soja en A1 4200 kg/ha, vendí 50 tn a 480 USD',
    answers: [],
    expect: async ({ diff }) => {
      const total = diff.r + diff.s + diff.d + diff.i;
      return { pass: total >= 4, reason: `r=${diff.r} s=${diff.s} d=${diff.d} i=${diff.i} (sum=${total}, want>=4)` };
    },
  },
  {
    name: '16_2x_stock_out_2x_venta',
    desc: '2x stock-out + 2x venta',
    category: 'mixed-diverse',
    compound: 'saqué 60 lt de glifosato, saqué 80 bolsas de urea, vendí 20 tn de maíz a 200 USD, vendí 30 tn de trigo a 180 USD',
    answers: [],
    expect: async ({ diff }) => {
      return {
        pass: diff.sm >= 2 && diff.i >= 2,
        reason: `sm=${diff.sm} (want>=2) i=${diff.i} (want>=2)`,
      };
    },
  },
  {
    name: '17_compra_sow_fert_observation',
    desc: 'compra + sembré + fertilicé + observación liebres',
    category: 'mixed-diverse',
    compound: 'compré 100 bolsas semilla soja a 12mil, sembré en A1, fertilicé A2 con urea 100 kg/ha, vi liebres en A3',
    answers: [],
    expect: async ({ diff }) => {
      // 1 expense + 1 sow + 1 fert + 1 observation (or scouting/obs)
      const total = diff.e + diff.d + diff.o + diff.s;
      return { pass: total >= 4, reason: `e=${diff.e} d=${diff.d} o=${diff.o} s=${diff.s} (sum=${total}, want>=4)` };
    },
  },
  {
    name: '18_hacienda_repro_pesaje_sanidad_partial',
    desc: 'add livestock + inseminación + pesaje + vacuna (last partial)',
    category: 'mixed-diverse',
    compound: 'agregué 20 vacas Angus en A1, inseminé 30 vacas con IATF, pesé 40 terneros 250 kg promedio, vacuné contra brucelosis',
    answers: ['50 vacas'],
    expect: async ({ diff }) => {
      // expect at least livestock add + repro + weighing events
      return {
        pass: diff.lm >= 1 && diff.he >= 2,
        reason: `lm=${diff.lm} he=${diff.he} (want lm>=1, he>=2)`,
      };
    },
  },
  {
    name: '19_4_partials_no_conflation',
    desc: '4 partials: vendí soja + compré urea + agregué hacienda + monitoreé',
    category: 'mixed-diverse',
    compound: 'vendí soja, compré urea, agregué hacienda, monitoreé',
    answers: ['25 tn a 460 USD', '40 bolsas a 7mil', '30 vacas Hereford en A3', 'A1 V5 sin plagas'],
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes WHERE user_id=$1 AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY id DESC`, [userId]);
      const expenses = await apiQueryDb(
        `SELECT category, product, quantity, unit_price FROM expenses WHERE user_id=$1 AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY id DESC`, [userId]);
      const soja = incomes.find((r: any) => Number(r.quantity) === 25);
      const urea = expenses.find((r: any) => /urea/i.test(String(r.product ?? '') + ' ' + String(r.category ?? '')) && Number(r.quantity) === 40);
      const conflations: string[] = [];
      if (soja && Number(soja.unit_price) === 7000) conflations.push('soja-got-urea-price');
      if (urea && Number(urea.unit_price) === 460) conflations.push('urea-got-soja-price');
      const writes = diff.i + diff.e + diff.lm + diff.s;
      return {
        pass: writes >= 3 && conflations.length === 0,
        reason: `i=${diff.i} e=${diff.e} lm=${diff.lm} s=${diff.s} (sum=${writes}); ${conflations.length ? 'CONFLATION: ' + conflations.join(',') : 'no conflation'}; soja=${JSON.stringify(soja)} urea=${JSON.stringify(urea)}`,
      };
    },
  },
  {
    name: '20_giant_6_actions_all_complete',
    desc: 'giant compound: 6 actions all complete (venta+compra+spray+livestock+scouting+gasto)',
    category: 'mixed-diverse',
    compound: 'vendí 20 tn soja a 480 USD, compré 80 bolsas urea a 8mil, fumigué A1 con glifosato 3 lt/ha, agregué 15 vacas Hereford en A2, monitoreé A3 V5 sin plagas, gasté 60mil en gasoil',
    answers: [],
    expect: async ({ diff }) => {
      // 6 different domains: i + e (2x) + d + lm + s
      const writes = diff.i + diff.e + diff.d + diff.lm + diff.s;
      return {
        pass: writes >= 5 && diff.e >= 2 && diff.i >= 1 && diff.lm >= 1 && diff.s >= 1 && diff.d >= 1,
        reason: `i=${diff.i} e=${diff.e} d=${diff.d} lm=${diff.lm} s=${diff.s} (sum=${writes}, want>=5 with all domains)`,
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

  turns.push(`USER: ${t.compound}`);
  let resp = await sendAndLog(t.compound);
  turns.push(`BOT: ${resp.substring(0, 280)}${resp.length > 280 ? '...' : ''}`);
  responses.push(resp);

  const remaining = [...t.answers];
  let safety = 8;
  while (remaining.length > 0 && botIsAsking(resp) && safety > 0) {
    const ans = remaining.shift()!;
    turns.push(`USER: ${ans}`);
    resp = await sendAndLog(ans);
    turns.push(`BOT: ${resp.substring(0, 280)}${resp.length > 280 ? '...' : ''}`);
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
    status = v.pass ? 'PASS' : 'FAIL';
    reason = v.reason;
  } catch (err: any) {
    status = 'FAIL';
    reason = `expect-fn threw: ${err.message}`;
  }

  try { await sendAndLog('cancelar'); } catch { /* ignore */ }

  return { test: t, status, reason, turns, responses };
}

async function main(): Promise<void> {
  console.log('🧪 QA Repeated Combos — 20 NEW scenarios on repetition + varied mixes');
  console.log('=====================================================================\n');

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
  const byCat = (c: string) => results.filter(r => r.test.category === c);
  const passOf = (rs: Result[]) => rs.filter(r => r.status === 'PASS').length;
  const failOf = (rs: Result[]) => rs.filter(r => r.status === 'FAIL').length;

  const repSame = byCat('repeated-same');
  const repPart = byCat('repeated-partial');
  const mixDiv = byCat('mixed-diverse');
  console.log(`  REPEATED-SAME   : ${passOf(repSame)}/${repSame.length} pass, ${failOf(repSame)} fail`);
  console.log(`  REPEATED-PARTIAL: ${passOf(repPart)}/${repPart.length} pass, ${failOf(repPart)} fail`);
  console.log(`  MIXED-DIVERSE   : ${passOf(mixDiv)}/${mixDiv.length} pass, ${failOf(mixDiv)} fail`);

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
      console.log(`  ❌ ${r.test.name} (${r.test.category})`);
      console.log(`     ${r.reason}`);
      console.log(`     Compound: ${r.test.compound}`);
      console.log(`     Planned answers: ${JSON.stringify(r.test.answers)}`);
      for (const t of r.turns.slice(0, 14)) {
        console.log(`       ${t}`);
      }
      console.log('');
    }
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-repeated-combos-results.json',
    JSON.stringify(results.map(r => ({
      name: r.test.name, desc: r.test.desc, category: r.test.category,
      compound: r.test.compound, answers: r.test.answers,
      status: r.status, reason: r.reason, turns: r.turns,
    })), null, 2),
  );
  console.log(`📄 Full report: src/testing/qa-repeated-combos-results.json\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
