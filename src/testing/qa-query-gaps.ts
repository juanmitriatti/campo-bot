/**
 * QA Query Gaps Tester — adversarial scenarios for QUERIES about lotes,
 * siembra and cosecha. Read-only: setup once, then probe with questions.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-query-gaps.ts
 *      ONLY=A1,B2,... npx tsx src/testing/qa-query-gaps.ts   (filter)
 */

import { writeFileSync } from 'node:fs';

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'testin@gmail.com';
const PASSWORD = 'tester123';
const NAME = 'Tester';

// ============= API HELPERS =============

async function apiRegister(baseUrl: string, email: string, password: string, name: string): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, last_name: 'QA', email, password }),
  });
  if (res.ok) { const data = await res.json() as any; return { token: data.tokens.accessToken, userId: data.user.id }; }
  if (res.status === 409) return apiLogin(baseUrl, email, password);
  throw new Error(`Register failed: ${res.status} ${await res.text()}`);
}
async function apiLogin(baseUrl: string, email: string, password: string): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json() as any;
  return { token: data.tokens.accessToken, userId: data.user.id };
}
async function apiReset(baseUrl: string, token: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/test-bot/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: '{}',
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}
async function apiSend(baseUrl: string, token: string, message: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function apiTap(baseUrl: string, token: string, buttonId: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function apiDbQuery(baseUrl: string, token: string, sql: string, params: any[] = []): Promise<any[]> {
  const res = await fetch(`${baseUrl}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  return ((await res.json() as any).rows || []);
}

// ============= STATE =============

interface ConvTurn { role: 'user' | 'tap' | 'bot'; message: string }
interface TestResult {
  test_name: string; category: string; severity: 'low' | 'medium' | 'high';
  status: 'PASS' | 'FAIL' | 'WARN';
  conversation: ConvTurn[];
  expected_behavior: string[]; possible_failures: string[];
  actual_result: string; notes: string;
}

const results: TestResult[] = [];
let AUTH_TOKEN = '';
let USER_ID = 0;

function extractButtons(data: any): Array<{ id: string; title: string }> {
  const buttons: Array<{ id: string; title: string }> = [];
  for (const m of (data.messages || [])) {
    if (m.interactive?.buttons) for (const b of m.interactive.buttons) buttons.push(b);
    if (m.interactive?.sections) for (const s of m.interactive.sections) for (const r of (s.rows || [])) buttons.push({ id: r.id, title: r.title });
  }
  return buttons;
}
function extractText(data: any): string {
  const messages = data.messages || [];
  const parts: string[] = [];
  for (const m of messages) {
    if (m.text) parts.push(m.text);
    if (m.interactive?.body) parts.push(m.interactive.body);
  }
  const buttons = extractButtons(data);
  let full = parts.join('\n');
  if (buttons.length > 0) full += '\n[BUTTONS: ' + buttons.map(b => `${b.id}="${b.title}"`).join(', ') + ']';
  return full;
}
async function send(message: string): Promise<string> { return extractText(await apiSend(BASE_URL, AUTH_TOKEN, message)); }
async function tap(buttonId: string): Promise<string> { return extractText(await apiTap(BASE_URL, AUTH_TOKEN, buttonId)); }
async function dbQuery(sql: string, params: any[] = []): Promise<any[]> { return apiDbQuery(BASE_URL, AUTH_TOKEN, sql, params); }
async function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
function buttonIdMatching(text: string, regex: RegExp): string | null {
  const m = /\[BUTTONS: (.+)\]/.exec(text); if (!m) return null;
  for (const part of m[1].split(', ')) {
    const idMatch = /^([a-zA-Z0-9_-]+)="/.exec(part);
    if (idMatch && regex.test(idMatch[1])) return idMatch[1];
  }
  return null;
}

// ============= SCENARIO PRIMITIVES =============

interface ScenarioCtx {
  conversation: ConvTurn[];
  log: (turn: ConvTurn) => void;
}

async function runScenario(
  meta: { name: string; category: string; severity: 'low' | 'medium' | 'high'; expected: string[]; possibleFailures: string[] },
  body: (ctx: ScenarioCtx) => Promise<{ status: 'PASS' | 'WARN' | 'FAIL'; actual: string; notes: string }>,
): Promise<TestResult> {
  // Cancel any sticky flow from a prior scenario before starting.
  try { await send('cancelar'); } catch { /* ignore */ }
  await sleep(200);
  const conversation: ConvTurn[] = [];
  const log = (t: ConvTurn) => conversation.push(t);
  try {
    const out = await body({ conversation, log });
    return { test_name: meta.name, category: meta.category, severity: meta.severity, status: out.status, conversation, expected_behavior: meta.expected, possible_failures: meta.possibleFailures, actual_result: out.actual, notes: out.notes };
  } catch (e: any) {
    return { test_name: meta.name, category: meta.category, severity: meta.severity, status: 'FAIL', conversation, expected_behavior: meta.expected, possible_failures: meta.possibleFailures, actual_result: `EXCEPTION: ${e.message}`, notes: `Crashed: ${e.message}` };
  }
}

async function sendL(ctx: ScenarioCtx, msg: string): Promise<string> {
  ctx.log({ role: 'user', message: msg });
  const r = await send(msg);
  ctx.log({ role: 'bot', message: r });
  return r;
}
async function tapL(ctx: ScenarioCtx, buttonId: string): Promise<string> {
  ctx.log({ role: 'tap', message: buttonId });
  const r = await tap(buttonId);
  ctx.log({ role: 'bot', message: r });
  return r;
}
async function sendAndConfirm(ctx: ScenarioCtx, msg: string): Promise<string> {
  let r = await sendL(ctx, msg);
  const confirm = buttonIdMatching(r, /^confirm_pending/);
  if (confirm) r = await tapL(ctx, confirm);
  return r;
}

// ============= ONE-TIME SETUP =============

const FIELD_NAME = 'Campo QA';

/**
 * Build a fixture with 4 plots in distinct states so we can probe queries
 * without setting up between every scenario:
 *   A1 — sembrado + cosechado CON yield + campaña cerrada
 *   A2 — sembrado + cosechado SIN yield (campaign open)
 *   A3 — sembrado, sin cosechar
 *   A4 — vacío (sin sembrar)
 */
async function setupAll(): Promise<void> {
  console.log('  Setup: resetting + seeding fixture...');
  await apiReset(BASE_URL, AUTH_TOKEN);

  // Field
  await send(`agregar campo ${FIELD_NAME}`);
  await tap('flow_field_loc_city');
  await send('Pergamino');
  await tap('flow_confirm');
  console.log('    field created');

  // Plots
  for (const name of ['A1', 'A2', 'A3', 'A4']) {
    await send(`agregar lote ${name} al campo ${FIELD_NAME}`);
    await send('30');
  }
  console.log('    4 plots created');

  // A1: sow + harvest with yield + close
  await send('sembré soja en el A1');
  // Harvest with yield_kg_per_ha → handler computes total
  let r = await send('cosechamos soja en el A1, 4500 kg/ha');
  // Skip silo prompt if surfaced
  const grainNo = buttonIdMatching(r, /stock_grain_no/);
  if (grainNo) await tap(grainNo);
  await send(`cerrar campaña A1`);
  console.log('    A1 sown+harvested(4500kg/ha)+closed');

  // A2: sow + harvest WITHOUT yield (just "se cosechó")
  await send('sembré soja en el A2');
  r = await send('se cosechó soja en el A2');
  const grainNo2 = buttonIdMatching(r, /stock_grain_no/);
  if (grainNo2) await tap(grainNo2);
  console.log('    A2 sown+harvested(no yield)');

  // A3: sow only
  await send('sembré maíz en el A3');
  console.log('    A3 sown(maíz, no harvest)');

  // A4: untouched (vacío)
  console.log('    A4 left empty');

  // Verify in DB. plots/plot_crops have no user_id column — JOIN via fields.
  const fields = await dbQuery(`SELECT id, name FROM fields WHERE user_id=$1 AND deleted_at IS NULL`, [USER_ID]);
  const plots = await dbQuery(
    `SELECT p.id, p.name FROM plots p JOIN fields f ON f.id=p.field_id
     WHERE f.user_id=$1 AND p.deleted_at IS NULL AND f.deleted_at IS NULL ORDER BY p.name`,
    [USER_ID]);
  const crops = await dbQuery(
    `SELECT pc.crop, p.name AS plot_name, pc.yield_kg, pc.harvested_at, pc.end_date
     FROM plot_crops pc JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id
     WHERE f.user_id=$1 ORDER BY p.name`, [USER_ID]);
  console.log(`    DB: ${fields.length} field, ${plots.length} plots [${plots.map(p => p.name).join(',')}], ${crops.length} crops`);
  for (const c of crops) {
    console.log(`      ${c.plot_name}: ${c.crop} yield=${c.yield_kg} harvested=${!!c.harvested_at} closed=${!!c.end_date}`);
  }
  console.log('  Setup complete\n');
}

// ============= BUCKET A: PLOT FILTER PASS-THROUGH =============

async function testA1_QueSembramosFiltered() {
  return runScenario(
    { name: 'A1 "que sembramos en el A2?" → response only mentions A2', category: 'plot-filter', severity: 'high',
      expected: ['Response mentions A2 (or its crop)', 'Response does NOT list A1 / A3 unrelated'],
      possibleFailures: ['Lists all plots ignoring filter'] },
    async (ctx) => {
      const r = await sendL(ctx, `que sembramos en el A2?`);
      const mentionsA2 = /A2|a2/i.test(r);
      const leakA1 = /\bA1\b|\ba1\b/i.test(r) && !/A1.*A2|A2.*A1/i.test(r);
      const leakA3 = /\bA3\b/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (mentionsA2 && !leakA1 && !leakA3) ? 'PASS' : (mentionsA2 ? 'WARN' : 'FAIL');
      const notes = `mentionsA2=${mentionsA2} leakA1=${leakA1} leakA3=${leakA3} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA2_QueCosechamos() {
  return runScenario(
    { name: 'A2 "que cosechamos en A1?" → response shows A1 harvest only', category: 'plot-filter', severity: 'high',
      expected: ['Response mentions A1 cosecha (or 4500 / soja)', 'Does not list A2 / A3'],
      possibleFailures: ['Returns "todos los lotes"'] },
    async (ctx) => {
      const r = await sendL(ctx, `que cosechamos en A1?`);
      const mentionsA1 = /A1|a1/i.test(r);
      const showsHarvest = /cosech|4500|soja/i.test(r);
      const leakA2 = /\bA2\b/i.test(r) && !/A1/i.test(r.split('A2')[0] || '');
      const todos = /todos los lotes/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (mentionsA1 && showsHarvest && !todos) ? 'PASS' : (mentionsA1 ? 'WARN' : 'FAIL');
      const notes = `A1=${mentionsA1} showsHarvest=${showsHarvest} todos=${todos} leakA2=${leakA2} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA3_ActividadesDelLote() {
  return runScenario(
    { name: 'A3 "actividades del lote A3" → only A3 activities', category: 'plot-filter', severity: 'high',
      expected: ['Response mentions A3 + maíz/sow', 'Does not show A1/A2 activities'],
      possibleFailures: ['Lists activities from all plots'] },
    async (ctx) => {
      const r = await sendL(ctx, `actividades del lote A3`);
      const mentionsA3 = /\bA3\b/i.test(r);
      const showsMaiz = /maíz|maiz/i.test(r);
      const leakA1 = /\bA1\b/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (mentionsA3 && showsMaiz && !leakA1) ? 'PASS' : mentionsA3 ? 'WARN' : 'FAIL';
      const notes = `A3=${mentionsA3} maíz=${showsMaiz} leakA1=${leakA1} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA4_HistorialDelLote() {
  return runScenario(
    { name: 'A4 "historial del lote A1" → A1 events only', category: 'plot-filter', severity: 'high',
      expected: ['Mentions A1', 'Shows siembra + cosecha', 'No A2/A3 entries'],
      possibleFailures: ['Returns all-plots history'] },
    async (ctx) => {
      const r = await sendL(ctx, `historial del lote A1`);
      const mentionsA1 = /\bA1\b/i.test(r);
      const showsSiembraOrCosecha = /siembr|cosech/i.test(r);
      const todos = /todos los lotes/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (mentionsA1 && showsSiembraOrCosecha && !todos) ? 'PASS' : mentionsA1 ? 'WARN' : 'FAIL';
      const notes = `A1=${mentionsA1} sow/harv=${showsSiembraOrCosecha} todos=${todos} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA5_CultivosDelCampo() {
  return runScenario(
    { name: 'A5 "cultivos del campo Campo QA" → lists active crops in this field', category: 'plot-filter', severity: 'medium',
      expected: ['Mentions Campo QA or its plots', 'Lists soja (A2 still open) and maíz (A3 still open)'],
      possibleFailures: ['Returns nothing or wrong crops'] },
    async (ctx) => {
      const r = await sendL(ctx, `cultivos del campo Campo QA`);
      const showsSoja = /soja/i.test(r);
      const showsMaiz = /maíz|maiz/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (showsSoja && showsMaiz) ? 'PASS' : (showsSoja || showsMaiz) ? 'WARN' : 'FAIL';
      const notes = `soja=${showsSoja} maíz=${showsMaiz} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET B: CONTEXT-AWARE QUERIES =============

async function testB1_PromedioAfterInfo() {
  return runScenario(
    { name: 'B1 "info A1" → "promedio?" infers A1 (not tacto)', category: 'context', severity: 'high',
      expected: ['Second turn shows yield/rinde of A1 (4500 kg/ha or 135000 kg)', 'Does NOT return tacto summary'],
      possibleFailures: ['"No hay registros de tacto"', 'Asks which plot'] },
    async (ctx) => {
      await sendL(ctx, `info sobre A1`);
      const r = await sendL(ctx, `promedio?`);
      const showsRinde = /4500|135000|kg\/ha|rinde|rendim/i.test(r);
      const fellToTacto = /tacto|preñ|vacas revisadas/i.test(r);
      const askedAgain = /qué lote|cuál lote|de qué lote/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = showsRinde && !fellToTacto ? 'PASS' : fellToTacto ? 'FAIL' : askedAgain ? 'WARN' : 'WARN';
      const notes = `showsRinde=${showsRinde} tacto=${fellToTacto} asked=${askedAgain} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testB2_YLaCosecha() {
  return runScenario(
    { name: 'B2 "info A2" → "y la cosecha?" infers A2', category: 'context', severity: 'medium',
      expected: ['Second turn mentions A2 cosecha (open or no yield)'],
      possibleFailures: ['Asks "qué lote?"', 'Returns all-plots'] },
    async (ctx) => {
      await sendL(ctx, `info sobre A2`);
      const r = await sendL(ctx, `y la cosecha?`);
      const refersA2 = /\bA2\b|A2/i.test(r);
      const todos = /todos los lotes/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = refersA2 && !todos ? 'PASS' : todos ? 'FAIL' : 'WARN';
      const notes = `refersA2=${refersA2} todos=${todos} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testB3_Pronombre() {
  return runScenario(
    { name: 'B3 "info A1" → "ese lote tiene cuántas has?" → 30 ha for A1', category: 'context', severity: 'medium',
      expected: ['Response mentions 30 ha or A1'],
      possibleFailures: ['Lost reference, asks which lote'] },
    async (ctx) => {
      await sendL(ctx, `info sobre A1`);
      const r = await sendL(ctx, `ese lote cuántas has tiene?`);
      const has30 = /30/.test(r);
      const refersA1 = /\bA1\b|a1/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (has30 && refersA1) ? 'PASS' : has30 ? 'WARN' : 'FAIL';
      const notes = `has30=${has30} A1=${refersA1} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testB4_DrilldownSiembra() {
  return runScenario(
    { name: 'B4 "info A1" → "que sembramos?" → A1 history', category: 'context', severity: 'medium',
      expected: ['Refers to A1 sowing (soja)'],
      possibleFailures: ['Lists all plots history'] },
    async (ctx) => {
      await sendL(ctx, `info sobre A1`);
      const r = await sendL(ctx, `que sembramos?`);
      const refersA1 = /\bA1\b|soja/i.test(r);
      const todos = /todos los lotes/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = refersA1 && !todos ? 'PASS' : todos ? 'FAIL' : 'WARN';
      const notes = `refersA1=${refersA1} todos=${todos} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET C: FUZZY / VARIANTES DE NOMBRE =============

async function testC1_SpaceInName() {
  return runScenario(
    { name: 'C1 "info A 1" (with space) resolves to A1', category: 'fuzzy', severity: 'high',
      expected: ['Response is about Lote A1, not "no encontré"'],
      possibleFailures: ['"no encontré ese lote"'] },
    async (ctx) => {
      const r = await sendL(ctx, `info sobre A 1`);
      const found = /Lote.*A1|A1.*Campo QA|campo qa.*A1/i.test(r);
      const notFound = /no encontré|no encontre/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = found && !notFound ? 'PASS' : notFound ? 'FAIL' : 'WARN';
      const notes = `found=${found} notFound=${notFound} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC2_LowerCase() {
  return runScenario(
    { name: 'C2 "info a1" (lowercase) resolves to A1', category: 'fuzzy', severity: 'medium',
      expected: ['Response is about Lote A1'],
      possibleFailures: ['"no encontré"'] },
    async (ctx) => {
      const r = await sendL(ctx, `info a1`);
      const found = /Lote.*A1|A1.*campo|campo.*A1/i.test(r);
      const notFound = /no encontré/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = found && !notFound ? 'PASS' : notFound ? 'FAIL' : 'WARN';
      const notes = `found=${found} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC3_LotePrefix() {
  return runScenario(
    { name: 'C3 "info lote A1" (con prefijo lote) resolves', category: 'fuzzy', severity: 'medium',
      expected: ['Response is about Lote A1'],
      possibleFailures: ['Bot tries to find a plot literally named "lote A1"'] },
    async (ctx) => {
      const r = await sendL(ctx, `info lote A1`);
      const found = /Lote.*A1/i.test(r);
      const notFound = /no encontré/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = found && !notFound ? 'PASS' : notFound ? 'FAIL' : 'WARN';
      const notes = `found=${found} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC4_TrailingPunct() {
  return runScenario(
    { name: 'C4 "info sobre A1." (con punto final) resolves', category: 'fuzzy', severity: 'low',
      expected: ['Punctuation stripped, A1 found'],
      possibleFailures: ['Searches for plot named "A1."'] },
    async (ctx) => {
      const r = await sendL(ctx, `info sobre A1.`);
      const found = /Lote.*A1/i.test(r);
      const notFound = /no encontré/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = found && !notFound ? 'PASS' : notFound ? 'FAIL' : 'WARN';
      const notes = `found=${found} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET D: DISAMBIGUACIÓN DE "PROMEDIO" =============

async function testD1_PromedioBareNoContext() {
  return runScenario(
    { name: 'D1 "promedio?" stand-alone → asks OR uses context (never picks tacto silently)', category: 'disambig', severity: 'medium',
      expected: ['EITHER asks for clarification', 'OR uses recent plot context (campaign_stats with valid plot)', 'NEVER picks tacto silently'],
      possibleFailures: ['Picks tacto silently when context is agro'] },
    async (ctx) => {
      // "mis campos" doesn't clear conversation_state, so prior tests' plot
      // context bleeds in. The bot doing context-aware inference is the
      // RIGHT call — accept either path. The actual bug to detect is
      // silently routing to tacto when the recent context is agro.
      await sendL(ctx, `mis campos`);
      const r = await sendL(ctx, `promedio?`);
      const asks = /qué promedio|cuál promedio|de qué|qué querés saber|preguntá|aclar/i.test(r);
      const tactoSilent = /vacas revisadas|preñ/i.test(r);
      const usesAgroContext = /campaña|rinde|kg\/ha|rendim/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' =
        tactoSilent ? 'FAIL' : (asks || usesAgroContext) ? 'PASS' : 'WARN';
      const notes = `asks=${asks} tacto=${tactoSilent} agroContext=${usesAgroContext} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testD2_PromedioDelLote() {
  return runScenario(
    { name: 'D2 "promedio del A1" → campaign_stats(A1) NOT tacto', category: 'disambig', severity: 'high',
      expected: ['Response shows A1 yield/campaign info'],
      possibleFailures: ['Returns tacto summary'] },
    async (ctx) => {
      const r = await sendL(ctx, `promedio del A1`);
      const showsRinde = /4500|kg\/ha|rendim|campaña|rinde/i.test(r);
      const fellToTacto = /vacas revisadas|preñ/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = showsRinde && !fellToTacto ? 'PASS' : fellToTacto ? 'FAIL' : 'WARN';
      const notes = `rinde=${showsRinde} tacto=${fellToTacto} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testD3_PromedioPrenez() {
  return runScenario(
    { name: 'D3 "promedio de preñez" → tacto_summary correctly', category: 'disambig', severity: 'medium',
      expected: ['Routes to tacto / says no hay registros (since we have no tacto data)'],
      possibleFailures: ['Returns campaign_stats by mistake'] },
    async (ctx) => {
      const r = await sendL(ctx, `promedio de preñez`);
      const tactoIsh = /tacto|preñ|sin registros|no hay registros/i.test(r);
      const wrongCrop = /cultivo|rinde|kg\/ha/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = tactoIsh && !wrongCrop ? 'PASS' : 'WARN';
      const notes = `tactoIsh=${tactoIsh} wrongCrop=${wrongCrop} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET E: EMPTY DATA DISPLAY =============

async function testE1_LoteVacioNinguno() {
  return runScenario(
    { name: 'E1 info A4 (vacío) → "Cultivo activo: ninguno" + actividades ninguna', category: 'empty-data', severity: 'medium',
      expected: ['Explicit "ninguno" for active crop', 'Explicit "ninguna" for activities'],
      possibleFailures: ['Sections silently omitted'] },
    async (ctx) => {
      const r = await sendL(ctx, `info A4`);
      const sayNinguno = /ninguno/i.test(r);
      const sayNinguna = /ninguna/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (sayNinguno && sayNinguna) ? 'PASS' : (sayNinguno || sayNinguna) ? 'WARN' : 'FAIL';
      const notes = `ninguno=${sayNinguno} ninguna=${sayNinguna} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testE2_LoteSembradoSinCosechar() {
  return runScenario(
    { name: 'E2 campaign_stats A3 (sembrado, sin cosechar) → no rinde + estado activa', category: 'empty-data', severity: 'medium',
      expected: ['State indicates "Activa" (not closed/harvested)', 'Does NOT show "no registrado" yield hint (it is too early)'],
      possibleFailures: ['Pretends a yield exists'] },
    async (ctx) => {
      const r = await sendL(ctx, `estadísticas de la campaña del lote A3`);
      const isActive = /activa|🌱/i.test(r);
      const hasFakeYield = /4500|rendim.*kg|rinde.*kg/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = isActive && !hasFakeYield ? 'PASS' : hasFakeYield ? 'FAIL' : 'WARN';
      const notes = `active=${isActive} fakeYield=${hasFakeYield} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testE3_CosechadoSinYield() {
  return runScenario(
    { name: 'E3 campaign_stats A2 (cosechado sin yield) → "Rendimiento: no registrado"', category: 'empty-data', severity: 'high',
      expected: ['Explicit "Rendimiento: no registrado" line', 'Hint on how to load it'],
      possibleFailures: ['Section silently omitted', 'Shows wrong yield'] },
    async (ctx) => {
      const r = await sendL(ctx, `estadísticas de la campaña del lote A2`);
      const sayNoRegistrado = /no registrado/i.test(r);
      const sayHint = /cargalo con|rindió|cosechamos.*tn/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = sayNoRegistrado ? (sayHint ? 'PASS' : 'WARN') : 'FAIL';
      const notes = `noRegistrado=${sayNoRegistrado} hint=${sayHint} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testE4_LoteInexistente() {
  return runScenario(
    { name: 'E4 "info ZZ99" (inexistente) → "no encontré"', category: 'empty-data', severity: 'low',
      expected: ['Friendly error mentioning the plot wasn\'t found'],
      possibleFailures: ['Crashes, returns empty', 'Auto-creates the plot'] },
    async (ctx) => {
      const r = await sendL(ctx, `info ZZ99`);
      const notFound = /no encontré|no existe|no encontre/i.test(r);
      const noPlotCreated = (await dbQuery(
        `SELECT COUNT(*)::int AS n FROM plots p JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1 AND p.name ILIKE '%ZZ99%' AND p.deleted_at IS NULL AND f.deleted_at IS NULL`, [USER_ID],
      ))[0]?.n === 0;
      const status: 'PASS' | 'WARN' | 'FAIL' = notFound && noPlotCreated ? 'PASS' : !noPlotCreated ? 'FAIL' : 'WARN';
      const notes = `notFound=${notFound} noPlotCreated=${noPlotCreated} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testE5_HistorialLoteVacio() {
  return runScenario(
    { name: 'E5 "historial del lote A4" → "no hay actividades" o similar', category: 'empty-data', severity: 'low',
      expected: ['Explicit empty message', 'Does not list other plots'],
      possibleFailures: ['Lists other plots\' history'] },
    async (ctx) => {
      const r = await sendL(ctx, `historial del lote A4`);
      const empty = /no hay|sin actividades|sin registros|ninguna|no encontré|no encontre/i.test(r);
      const todos = /todos los lotes/i.test(r);
      const leak = /\bA1\b|\bA2\b|\bA3\b/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = empty && !todos && !leak ? 'PASS' : leak ? 'FAIL' : 'WARN';
      const notes = `empty=${empty} todos=${todos} leak=${leak} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET F: CROSS-REFERENCES =============

async function testF1_CampañaAnterior() {
  return runScenario(
    { name: 'F1 "campaña anterior del lote A1" → solo hay una', category: 'cross-ref', severity: 'low',
      expected: ['Tells user there\'s no previous campaign (only the current one)'],
      possibleFailures: ['Returns the current as anterior', 'Crashes'] },
    async (ctx) => {
      const r = await sendL(ctx, `campaña anterior del lote A1`);
      const sayNoPrev = /no hay|no encontré|primera|anterior.*no|sin.*anterior|suficientes campañas|no tiene.*campañas/i.test(r);
      const showsCurrent = /4500|cerrada/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = sayNoPrev ? 'PASS' : showsCurrent ? 'WARN' : 'WARN';
      const notes = `noPrev=${sayNoPrev} showsCurrent=${showsCurrent} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testF2_CompararCampanas() {
  return runScenario(
    { name: 'F2 "compará campaña A1 con A2" → comparison shown', category: 'cross-ref', severity: 'medium',
      expected: ['Mentions both A1 and A2', 'Shows differences (rinde, gastos, etc.)'],
      possibleFailures: ['Returns single plot info', 'Says "no se puede comparar"'] },
    async (ctx) => {
      const r = await sendL(ctx, `compará campaña A1 con campaña A2`);
      const both = /A1.*A2|A2.*A1/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = both ? 'PASS' : /comparación|comparar|vs/i.test(r) ? 'WARN' : 'WARN';
      const notes = `bothMentioned=${both} | resp: ${r.substring(0, 280)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testF3_QueTengoSembrado() {
  return runScenario(
    { name: 'F3 "qué tengo sembrado este año?" → lists active crops', category: 'cross-ref', severity: 'medium',
      expected: ['Mentions soja AND maíz (A2 has soja open, A3 has maíz open)'],
      possibleFailures: ['Returns "list_plots" instead of active_crop', 'Misses one'] },
    async (ctx) => {
      const r = await sendL(ctx, `qué tengo sembrado este año?`);
      const showsSoja = /soja/i.test(r);
      const showsMaiz = /maíz|maiz/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (showsSoja && showsMaiz) ? 'PASS' : (showsSoja || showsMaiz) ? 'WARN' : 'FAIL';
      const notes = `soja=${showsSoja} maíz=${showsMaiz} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testF4_DondeSembre() {
  return runScenario(
    { name: 'F4 "donde sembré soja?" → lists plots with soja (active or recent)', category: 'cross-ref', severity: 'medium',
      expected: ['Mentions at least one of A1 or A2 (both had soja)', 'Does not leak A3 (maíz)'],
      possibleFailures: ['Doesn\'t list plots', 'Lists all plots regardless of crop'] },
    async (ctx) => {
      const r = await sendL(ctx, `donde sembré soja?`);
      const showsA1 = /\bA1\b/i.test(r);
      const showsA2 = /\bA2\b/i.test(r);
      const leakA3 = /\bA3\b/i.test(r);
      // Bot's active_crop only shows ACTIVE — A1's soja is closed, A2 is open.
      // Showing only A2 is acceptable (it's the only ACTIVE soja). Mark PASS if
      // at least one is shown and A3 (maíz) doesn't leak.
      const atLeastOne = showsA1 || showsA2;
      const status: 'PASS' | 'WARN' | 'FAIL' = (atLeastOne && !leakA3) ? 'PASS' : 'WARN';
      const notes = `A1=${showsA1} A2=${showsA2} leakA3=${leakA3} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= MAIN =============

async function main() {
  console.log('\n=======================================================');
  console.log('  QA QUERY GAPS -- queries about plots, siembra, cosecha');
  console.log('=======================================================\n');

  const { token, userId } = await apiRegister(BASE_URL, EMAIL, PASSWORD, NAME);
  AUTH_TOKEN = token;
  USER_ID = userId;
  console.log(`  Auth OK (userId=${userId})`);

  await dbQuery(`UPDATE users SET plan_id = 4 WHERE id = $1`, [userId]);
  console.log('  Upgraded to enterprise plan');

  await setupAll();

  const allTests: Array<[string, () => Promise<TestResult>]> = [
    ['A1', testA1_QueSembramosFiltered], ['A2', testA2_QueCosechamos], ['A3', testA3_ActividadesDelLote],
    ['A4', testA4_HistorialDelLote], ['A5', testA5_CultivosDelCampo],
    ['B1', testB1_PromedioAfterInfo], ['B2', testB2_YLaCosecha], ['B3', testB3_Pronombre], ['B4', testB4_DrilldownSiembra],
    ['C1', testC1_SpaceInName], ['C2', testC2_LowerCase], ['C3', testC3_LotePrefix], ['C4', testC4_TrailingPunct],
    ['D1', testD1_PromedioBareNoContext], ['D2', testD2_PromedioDelLote], ['D3', testD3_PromedioPrenez],
    ['E1', testE1_LoteVacioNinguno], ['E2', testE2_LoteSembradoSinCosechar], ['E3', testE3_CosechadoSinYield],
    ['E4', testE4_LoteInexistente], ['E5', testE5_HistorialLoteVacio],
    ['F1', testF1_CampañaAnterior], ['F2', testF2_CompararCampanas], ['F3', testF3_QueTengoSembrado], ['F4', testF4_DondeSembre],
  ];

  const onlyEnv = (process.env.ONLY || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const tests = onlyEnv.length > 0
    ? allTests.filter(([code]) => onlyEnv.includes(code)).map(([, fn]) => fn)
    : allTests.map(([, fn]) => fn);

  if (onlyEnv.length > 0) console.log(`  Filter ONLY=${onlyEnv.join(',')} → running ${tests.length} of ${allTests.length}\n`);
  else console.log(`  Running ${tests.length} scenarios...\n`);

  for (let i = 0; i < tests.length; i++) {
    console.log(`  --- ${String(i + 1).padStart(2, '0')}/${tests.length} ---`);
    const r = await tests[i]();
    results.push(r);
    console.log(`  [${r.status}] ${r.test_name}`);
    if (r.status !== 'PASS') console.log(`         ${r.notes.substring(0, 220)}`);
  }

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const warn = results.filter(r => r.status === 'WARN').length;

  console.log('\n=======================================================');
  console.log(`  RESULTS: ${pass} PASS | ${warn} WARN | ${fail} FAIL`);
  console.log(`  Pass rate: ${Math.round((pass / results.length) * 100)}%`);
  console.log('=======================================================\n');

  if (fail > 0) {
    console.log('  FAILURES:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`    [${r.severity}] ${r.test_name}`);
      console.log(`        ${r.notes.substring(0, 240)}`);
    }
    console.log('');
  }
  if (warn > 0) {
    console.log('  WARNINGS:');
    for (const r of results.filter(r => r.status === 'WARN')) {
      console.log(`    [${r.severity}] ${r.test_name}`);
      console.log(`        ${r.notes.substring(0, 240)}`);
    }
    console.log('');
  }

  const outPath = 'src/testing/qa-query-gaps-results.json';
  writeFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), pass, warn, fail, total: results.length, results }, null, 2));
  console.log(`  Results written to ${outPath}\n`);

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
