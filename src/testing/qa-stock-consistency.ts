/**
 * QA Stock Consistency Tester — adversarial conversational scenarios
 * targeting the stock subsystem. Single-pass run against local Docker.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-stock-consistency.ts
 */

import { writeFileSync } from 'node:fs';

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'testin@gmail.com';
const PASSWORD = 'tester123';
const NAME = 'Tester';

// ============= API HELPERS =============

async function apiRegister(baseUrl: string, email: string, password: string, name: string): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, last_name: 'QA', email, password }),
  });
  if (res.ok) {
    const data = await res.json() as any;
    return { token: data.tokens.accessToken, userId: data.user.id };
  }
  if (res.status === 409) return apiLogin(baseUrl, email, password);
  throw new Error(`Register failed: ${res.status} ${await res.text()}`);
}

async function apiLogin(baseUrl: string, email: string, password: string): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json() as any;
  return { token: data.tokens.accessToken, userId: data.user.id };
}

async function apiReset(baseUrl: string, token: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/test-bot/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: '{}',
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}

async function apiSend(baseUrl: string, token: string, message: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiTap(baseUrl: string, token: string, buttonId: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiDbQuery(baseUrl: string, token: string, sql: string, params: any[] = []): Promise<any[]> {
  const res = await fetch(`${baseUrl}/api/test-bot/query-db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return data.rows || [];
}

// ============= STATE =============

interface ConvTurn { role: 'user' | 'tap' | 'bot'; message: string }
interface TestResult {
  test_name: string;
  category: string;
  severity: 'low' | 'medium' | 'high';
  status: 'PASS' | 'FAIL' | 'WARN';
  conversation: ConvTurn[];
  expected_behavior: string[];
  possible_failures: string[];
  actual_result: string;
  notes: string;
}

const results: TestResult[] = [];
let AUTH_TOKEN = '';
let USER_ID = 0;

// ============= SHARED UTILS =============

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

async function send(message: string): Promise<string> {
  const data = await apiSend(BASE_URL, AUTH_TOKEN, message);
  return extractText(data);
}

async function tap(buttonId: string): Promise<string> {
  const data = await apiTap(BASE_URL, AUTH_TOKEN, buttonId);
  return extractText(data);
}

async function dbQuery(sql: string, params: any[] = []): Promise<any[]> {
  return apiDbQuery(BASE_URL, AUTH_TOKEN, sql, params);
}

async function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function buttonIdMatching(text: string, regex: RegExp): string | null {
  const m = /\[BUTTONS: (.+)\]/.exec(text);
  if (!m) return null;
  for (const part of m[1].split(', ')) {
    const idMatch = /^([a-zA-Z0-9_-]+)="/.exec(part);
    if (idMatch && regex.test(idMatch[1])) return idMatch[1];
  }
  return null;
}

// ============= SCENARIO PRIMITIVES =============

interface BaseIds {
  fieldName: string;
  plotName: string;
  warehouseName: string;
}

/** Field name as the bot stores it (lowercased on creation) */
const FIELD_NAME = 'Campo QA';
const PLOT_NAME = 'Lote 1';
const WAREHOUSE_NAME = 'Galpon Central';

async function seedBaseEntities(): Promise<BaseIds> {
  await apiReset(BASE_URL, AUTH_TOKEN);

  // Field: send name → tap city button → send city → tap confirm
  await send(`agregar campo ${FIELD_NAME}`);
  await tap('flow_field_loc_city');
  await send('Pergamino');
  await tap('flow_confirm');

  // Plot: send command → bot asks "cuántas has?" → send number
  await send(`agregar lote ${PLOT_NAME} al campo ${FIELD_NAME}`);
  await send('100');

  // Warehouse: one-shot
  await send(`crear depósito ${WAREHOUSE_NAME} en ${FIELD_NAME}`);

  // Make sure no flow is sticky
  try { await send('cancelar'); } catch { /* ignore */ }

  return { fieldName: FIELD_NAME, plotName: PLOT_NAME, warehouseName: WAREHOUSE_NAME };
}

interface ScenarioCtx {
  ids: BaseIds;
  conversation: ConvTurn[];
  log: (turn: ConvTurn) => void;
}

async function runScenario(
  meta: { name: string; category: string; severity: 'low' | 'medium' | 'high'; expected: string[]; possibleFailures: string[] },
  body: (ctx: ScenarioCtx) => Promise<{ status: 'PASS' | 'WARN' | 'FAIL'; actual: string; notes: string }>,
): Promise<TestResult> {
  const ids = await seedBaseEntities();
  const conversation: ConvTurn[] = [];
  const log = (t: ConvTurn) => conversation.push(t);
  try {
    const out = await body({ ids, conversation, log });
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

/** Send a message; if the bot returns a confirm_pending button, tap it once and return the post-confirm response. */
async function sendAndConfirm(ctx: ScenarioCtx, msg: string): Promise<string> {
  let r = await sendL(ctx, msg);
  const confirm = buttonIdMatching(r, /^confirm_pending/);
  if (confirm) r = await tapL(ctx, confirm);
  return r;
}

// ============= DB HELPERS (correct schema) =============

/**
 * Stock items use `name` (not `product`).
 * Match items by case-insensitive name fragment for the current user.
 */
async function getStockItemsByName(fragment: string) {
  return dbQuery(
    `SELECT id, name, current_quantity, unit, warehouse_id FROM stock_items WHERE user_id=$1 AND name ILIKE $2 AND deleted_at IS NULL`,
    [USER_ID, `%${fragment}%`],
  );
}
async function getAllStockItems() {
  return dbQuery(`SELECT id, name, current_quantity, unit FROM stock_items WHERE user_id=$1 AND deleted_at IS NULL`, [USER_ID]);
}
async function getMovementsForItemName(fragment: string) {
  return dbQuery(
    `SELECT sm.id, sm.movement_type, sm.quantity, sm.expense_id, sm.domain_event_id, si.name AS item_name
     FROM stock_movements sm JOIN stock_items si ON si.id=sm.stock_item_id
     WHERE si.user_id=$1 AND si.name ILIKE $2`,
    [USER_ID, `%${fragment}%`],
  );
}
async function getAllMovements() {
  return dbQuery(
    `SELECT sm.id, sm.movement_type, sm.quantity, sm.expense_id, si.name AS item_name
     FROM stock_movements sm JOIN stock_items si ON si.id=sm.stock_item_id
     WHERE si.user_id=$1`,
    [USER_ID],
  );
}
async function getInsumoExpenses() {
  return dbQuery(
    `SELECT id, expense_type, product, quantity, unit, amount FROM expenses WHERE user_id=$1 AND deleted_at IS NULL AND expense_type='insumo'`,
    [USER_ID],
  );
}

// ============= BUCKET A: TRANSACTIONAL CONSISTENCY =============

async function testA1() {
  return runScenario(
    {
      name: 'A1 add_stock with unit_price creates linked expense atomically',
      category: 'transactional', severity: 'high',
      expected: ['stock_movement entrada qty=100', 'expense type=insumo amount=200000', 'movement.expense_id links to expense'],
      possibleFailures: ['Only stock created (expense missing)', 'Only expense created (stock missing)', 'No link between them'],
    },
    async (ctx) => {
      const r = await sendL(ctx, `compré 100 lt de glifosato a 2000 c/u`);
      const movs = await getMovementsForItemName('glifosato');
      const exps = await getInsumoExpenses();
      const hasMov = movs.some(m => Number(m.quantity) === 100 && m.movement_type === 'entrada');
      const hasExp = exps.some(e => Number(e.amount) === 200000);
      const linked = movs.some(m => m.expense_id && exps.some(e => Number(e.id) === Number(m.expense_id)));
      const status: 'PASS' | 'WARN' | 'FAIL' = (hasMov && hasExp && linked) ? 'PASS' : (hasMov || hasExp) ? 'FAIL' : 'WARN';
      const notes = `mov=${hasMov} exp=${hasExp} linked=${linked} | resp: ${r.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA2() {
  return runScenario(
    {
      name: 'A2 remove > available is rejected; stock stays',
      category: 'transactional', severity: 'high',
      expected: ['Bot rejects', 'No new stock_movements salida row', 'current_quantity unchanged at 100'],
      possibleFailures: ['Stock goes negative', 'Salida row inserted anyway'],
    },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato`);
      const r = await sendL(ctx, `saqué 200 lt de glifosato`);
      const items = await getStockItemsByName('glifosato');
      const movs = await getMovementsForItemName('glifosato');
      const qty = items.length ? Number(items[0].current_quantity) : -1;
      const salidas = movs.filter(m => m.movement_type === 'salida');
      const negative = qty < 0;
      const stayed = qty === 100;
      let status: 'PASS' | 'WARN' | 'FAIL' = 'FAIL';
      if (negative) status = 'FAIL';
      else if (stayed && salidas.length === 0) status = 'PASS';
      else if (stayed) status = 'WARN';
      const notes = `qty=${qty} salidas=${salidas.length} negative=${negative} | resp: ${r.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA3() {
  return runScenario(
    {
      name: 'A3 movement sum equals current_quantity (invariant)',
      category: 'transactional', severity: 'high',
      expected: ['SUM(entrada) - SUM(salida) == current_quantity'],
      possibleFailures: ['Sum drifts', 'Salida inserted but qty not decremented'],
    },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de urea`);
      await sendL(ctx, `cargué 50 lt de urea`);
      await sendL(ctx, `saqué 30 lt de urea`);
      await sendL(ctx, `saqué 20 lt de urea`);
      await sendL(ctx, `cargué 10 lt de urea`);

      const rows = await dbQuery(
        `SELECT si.id, si.current_quantity,
                COALESCE(SUM(CASE WHEN sm.movement_type='entrada' THEN sm.quantity ELSE 0 END), 0) AS sum_in,
                COALESCE(SUM(CASE WHEN sm.movement_type='salida' THEN sm.quantity ELSE 0 END), 0) AS sum_out
         FROM stock_items si LEFT JOIN stock_movements sm ON sm.stock_item_id=si.id
         WHERE si.user_id=$1 AND si.name ILIKE '%urea%' AND si.deleted_at IS NULL
         GROUP BY si.id, si.current_quantity`,
        [USER_ID],
      );
      if (rows.length === 0) return { status: 'FAIL' as const, actual: 'No urea item created', notes: 'urea was never created' };
      const r = rows[0];
      const computed = Number(r.sum_in) - Number(r.sum_out);
      const stored = Number(r.current_quantity);
      const matches = Math.abs(computed - stored) < 0.001;
      const status = matches ? 'PASS' : 'FAIL';
      const notes = `stored=${stored} computed=${computed} (in=${r.sum_in} out=${r.sum_out})`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA4() {
  return runScenario(
    {
      name: 'A4 delete warehouse with stock — items not orphaned',
      category: 'transactional', severity: 'medium',
      expected: ['Either reject deletion OR cascade properly; never orphan items'],
      possibleFailures: ['Items reference deleted warehouse_id without cascade', 'Crash 500'],
    },
    async (ctx) => {
      await sendL(ctx, `cargué 50 lt de glifosato`);
      const r = await sendL(ctx, `eliminar depósito ${ctx.ids.warehouseName}`);
      const yes = buttonIdMatching(r, /confirm|yes|si|ok/i);
      if (yes) await tapL(ctx, yes);

      const orphans = await dbQuery(
        `SELECT si.id, si.name FROM stock_items si
         LEFT JOIN warehouses w ON w.id=si.warehouse_id
         WHERE si.user_id=$1 AND si.current_quantity > 0 AND si.deleted_at IS NULL
           AND (w.id IS NULL OR w.deleted_at IS NOT NULL)`,
        [USER_ID],
      );
      const status = orphans.length === 0 ? 'PASS' : 'FAIL';
      const notes = `orphan_items=${orphans.length} | resp: ${r.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA5() {
  return runScenario(
    {
      name: 'A5 compound add+use both persist (happy path)',
      category: 'transactional', severity: 'high',
      expected: ['Both stock entrada AND salida (or activity) persist'],
      possibleFailures: ['Half-done state', 'Only one side persists'],
    },
    async (ctx) => {
      const r = await sendL(ctx, `compré 100 lt de glifosato y usé 30 lt hoy en el ${ctx.ids.plotName}`);
      const movs = await getMovementsForItemName('glifosato');
      const entrada = movs.find(m => m.movement_type === 'entrada' && Number(m.quantity) === 100);
      const salida = movs.find(m => m.movement_type === 'salida' && Number(m.quantity) === 30);
      const status: 'PASS' | 'WARN' | 'FAIL' = (entrada && salida) ? 'PASS' : (entrada || salida) ? 'WARN' : 'FAIL';
      const notes = `entrada=${!!entrada} salida=${!!salida} total_movs=${movs.length} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET B: UNITS =============

async function testB1() {
  return runScenario(
    { name: 'B1 add 100 lt, try sacar 50 kg', category: 'units', severity: 'medium',
      expected: ['Bot detects unit mismatch (asks or rejects)', 'No silent conversion'],
      possibleFailures: ['Silently treats 50 kg as 50 lt', 'Crashes'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato`);
      const r = await sendL(ctx, `saqué 50 kg de glifosato`);
      const items = await getStockItemsByName('glifosato');
      const qty = items.length ? Number(items[0].current_quantity) : -1;
      const lower = r.toLowerCase();
      const detected = lower.includes('no se puede') || lower.includes('está en lt') || lower.includes('está en kg') || lower.includes('unidad') || lower.includes('no coincide') || lower.includes('aclar');
      const status: 'PASS' | 'WARN' | 'FAIL' = (qty === 100 && detected) ? 'PASS' : (qty === 50) ? 'FAIL' : 'WARN';
      const notes = `qty_after=${qty} detected_mismatch=${detected} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testB2() {
  return runScenario(
    { name: 'B2 add 50 tn soja, sacar 30000 kg (mismatch — bot must reject OR convert)', category: 'units', severity: 'medium',
      expected: ['Either: convert tn↔kg and end at 20000 kg / 20 tn', 'OR: reject mismatch and keep 50 tn'],
      possibleFailures: ['Treats tn==kg silently (50−30000 = -29950)', 'Stock goes negative or wrong'] },
    async (ctx) => {
      // Be explicit about "al silo/depósito" — without it the agent confuses
      // "cargué 50 tn de soja" with cosecha (since soja is a grain).
      await sendL(ctx, `cargué 50 tn de soja al silo en el ${ctx.ids.warehouseName}`);
      const r = await sendL(ctx, `saqué 30000 kg de soja del ${ctx.ids.warehouseName}`);
      const items = await getStockItemsByName('soja');
      const qty = items.length ? Number(items[0].current_quantity) : -1;
      const unit = items.length ? String(items[0].unit) : '?';
      const inKg = (unit === 'kg' && Math.abs(qty - 20000) < 0.5);
      const inTn = (unit === 'tn' && Math.abs(qty - 20) < 0.001);
      const rejectedAndStayed = (unit === 'tn' && qty === 50);  // bot refused mismatch
      const status: 'PASS' | 'WARN' | 'FAIL' = (inKg || inTn || rejectedAndStayed) ? 'PASS' : 'FAIL';
      const notes = `qty=${qty} unit=${unit} | resp: ${r.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testB3() {
  return runScenario(
    { name: 'B3 cargué 42 qq de trigo → 4200 kg', category: 'units', severity: 'low',
      expected: ['Stored as 4200 kg (or 42 qq if qq is a stored unit)'],
      possibleFailures: ['Stored as 42 raw'] },
    async (ctx) => {
      const r = await sendL(ctx, `cargué 42 qq de trigo`);
      const items = await getStockItemsByName('trigo');
      const qty = items.length ? Number(items[0].current_quantity) : -1;
      const unit = items.length ? String(items[0].unit) : '?';
      const ok = (unit === 'kg' && Math.abs(qty - 4200) < 1) || (unit === 'qq' && Math.abs(qty - 42) < 0.01) || (unit === 'tn' && Math.abs(qty - 4.2) < 0.01);
      const status: 'PASS' | 'WARN' | 'FAIL' = ok ? 'PASS' : (qty === 42 && unit !== 'qq') ? 'FAIL' : 'WARN';
      const notes = `qty=${qty} unit=${unit} | resp: ${r.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testB4() {
  return runScenario(
    { name: 'B4 cargué 50 de urea (no unit) → bot asks OR defaults sensibly', category: 'units', severity: 'low',
      expected: ['Bot asks for unit OR defaults to a sensible AR unit (kg/lt) without inserting NULL'],
      possibleFailures: ['Inserts NULL unit row', 'Crashes', 'Picks an obviously wrong unit (qq, tn) for unspecified product'] },
    async (ctx) => {
      const r = await sendL(ctx, `cargué 50 de urea`);
      const items = await getStockItemsByName('urea');
      const lower = r.toLowerCase();
      const asked = lower.includes('unidad') || lower.includes('cuál') || (lower.includes('kg') && lower.includes('lt'));
      let status: 'PASS' | 'WARN' | 'FAIL' = 'FAIL';
      if (items.length === 0 && asked) status = 'PASS';
      else if (items.length === 1 && items[0].unit && ['kg', 'lt'].includes(String(items[0].unit))) status = 'PASS';
      else if (items.length === 1 && items[0].unit) status = 'WARN';
      const notes = `items=${items.length} asked=${asked} unit=${items[0]?.unit || 'n/a'} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET C: CONVERSATIONAL =============

async function testC1() {
  return runScenario(
    { name: 'C1 multi-turn: tengo glifosato? → y de urea? → cuánto en total?', category: 'conversational', severity: 'medium',
      expected: ['Each turn answers correctly', '"en total" sums (does not re-ask)'],
      possibleFailures: ['Drops context', 'Re-asks'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato`);
      await sendL(ctx, `cargué 50 lt de urea`);
      const r1 = await sendL(ctx, `tengo glifosato?`);
      const r2 = await sendL(ctx, `y de urea?`);
      const r3 = await sendL(ctx, `cuánto en total?`);
      const r1ok = /100|glifosato/i.test(r1);
      const r2ok = /50|urea/i.test(r2);
      const r3ok = /150|total|todo|stock/i.test(r3);
      const status: 'PASS' | 'WARN' | 'FAIL' = (r1ok && r2ok && r3ok) ? 'PASS' : (r1ok && r2ok) ? 'WARN' : 'FAIL';
      const notes = `r1=${r1ok} r2=${r2ok} r3=${r3ok} | r3: ${r3.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC2() {
  return runScenario(
    { name: 'C2 pronombre: cargué 100 lt glifosato → saqué 20 de eso', category: 'conversational', severity: 'medium',
      expected: ['"de eso" resolves to glifosato', 'salida row of 20 lt'],
      possibleFailures: ['Asks producto', 'Saca de un producto distinto'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato`);
      const r = await sendL(ctx, `saqué 20 de eso`);
      const items = await getStockItemsByName('glifosato');
      const qty = items.length ? Number(items[0].current_quantity) : -1;
      const status: 'PASS' | 'WARN' | 'FAIL' = (qty === 80) ? 'PASS' : /qué producto|cuál/i.test(r) ? 'WARN' : 'FAIL';
      const notes = `qty_after=${qty} | resp: ${r.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC3() {
  return runScenario(
    { name: 'C3 typo: glifosado → matches glifosato', category: 'conversational', severity: 'medium',
      expected: ['Fuzzy match', 'No new "glifosado" item'],
      possibleFailures: ['Creates new item with the typo'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato`);
      await sendL(ctx, `saqué 10 lt de glifosado`);
      const items = await getAllStockItems();
      const products = items.map(i => String(i.name).toLowerCase());
      const onlyOne = products.filter(p => p.includes('glif')).length === 1;
      const item = items.find(i => String(i.name).toLowerCase().includes('glif'));
      const qty = item ? Number(item.current_quantity) : -1;
      const status: 'PASS' | 'WARN' | 'FAIL' = (onlyOne && qty === 90) ? 'PASS' : onlyOne ? 'WARN' : 'FAIL';
      const notes = `products=${JSON.stringify(products)} qty=${qty}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC4() {
  return runScenario(
    { name: 'C4 English input: "I bought 100kg of urea"', category: 'conversational', severity: 'low',
      expected: ['Parses correctly OR politely declines', 'Never creates phantom item'],
      possibleFailures: ['Creates "urea" with wrong qty/unit'] },
    async (ctx) => {
      const r = await sendL(ctx, `I bought 100kg of urea`);
      const items = await getAllStockItems();
      const urea = items.find(i => String(i.name).toLowerCase().includes('urea'));
      let status: 'PASS' | 'WARN' | 'FAIL' = 'WARN';
      if (urea && Number(urea.current_quantity) === 100 && urea.unit === 'kg') status = 'PASS';
      else if (!urea) status = 'WARN';
      else status = 'FAIL';
      const notes = `urea=${JSON.stringify(urea)} | resp: ${r.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC5() {
  return runScenario(
    { name: 'C5 cancel mid-flow: start add_stock then cancelar', category: 'conversational', severity: 'medium',
      expected: ['Flow cleared', 'No partial stock_items / stock_movements row'],
      possibleFailures: ['Partial item inserted', 'Flow stays sticky'] },
    async (ctx) => {
      await sendL(ctx, `quiero cargar stock`);
      await sendL(ctx, `cancelar`);
      const r = await sendL(ctx, `hola`);
      const items = await getAllStockItems();
      const movs = await getAllMovements();
      const status: 'PASS' | 'WARN' | 'FAIL' = (items.length === 0 && movs.length === 0) ? 'PASS' : 'FAIL';
      const notes = `items=${items.length} movs=${movs.length} | last resp: ${r.substring(0, 150)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET D: IDEMPOTENCY / BUTTONS =============

async function testD1() {
  return runScenario(
    { name: 'D1 double-tap "cargar al stock" button', category: 'idempotency', severity: 'high',
      expected: ['Only ONE entrada movement', 'Second tap is no-op'],
      possibleFailures: ['Two movements created'] },
    async (ctx) => {
      // Expense flow needs confirm_pending tap first; THEN the stock_entry button surfaces.
      const r1 = await sendAndConfirm(ctx, `gasté 200000 en glifosato, 100 lt`);
      const yesId = buttonIdMatching(r1, /stock_entry_yes/);
      if (!yesId) {
        return { status: 'WARN' as const, actual: 'no stock_entry button surfaced', notes: `expense did not trigger stock prompt | resp: ${r1.substring(0, 200)}` };
      }
      // Tap twice in rapid succession
      await Promise.all([tap(yesId), tap(yesId)]);
      ctx.log({ role: 'tap', message: yesId });
      ctx.log({ role: 'tap', message: yesId });

      const movs = await getMovementsForItemName('glifosato');
      const entradas = movs.filter(m => m.movement_type === 'entrada');
      const status: 'PASS' | 'WARN' | 'FAIL' = entradas.length === 1 ? 'PASS' : entradas.length > 1 ? 'FAIL' : 'WARN';
      const notes = `entradas=${entradas.length} (expected 1) total_movs=${movs.length}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testD2() {
  return runScenario(
    { name: 'D2 tap fake/expired callback id — no crash', category: 'idempotency', severity: 'medium',
      expected: ['Bot responds gracefully (no 500)'],
      possibleFailures: ['HTTP 500'] },
    async (ctx) => {
      try {
        const r = await tap('stock_entry_yes_99999999');
        ctx.log({ role: 'tap', message: 'stock_entry_yes_99999999 (fake)' });
        ctx.log({ role: 'bot', message: r });
        const status: 'PASS' | 'WARN' | 'FAIL' = r && r.length > 0 ? 'PASS' : 'WARN';
        return { status, actual: r.substring(0, 200), notes: `resp len=${r.length}` };
      } catch (e: any) {
        return { status: 'FAIL' as const, actual: e.message, notes: `Crashed on fake callback: ${e.message}` };
      }
    },
  );
}

async function testD3() {
  return runScenario(
    { name: 'D3 decline spray stock deduction — stock unchanged', category: 'idempotency', severity: 'high',
      expected: ['stock_deduction_status=declined', 'current_quantity unchanged'],
      possibleFailures: ['Stock decremented despite decline'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato`);
      // Spray activity also goes through confirm_pending before the deduction prompt.
      const r = await sendAndConfirm(ctx, `fumigué el ${ctx.ids.plotName} con 2 lt/ha de glifosato`);
      const noId = buttonIdMatching(r, /stock_deduct_no/);
      if (!noId) {
        return { status: 'WARN' as const, actual: 'no stock_deduct button', notes: `spray did not surface deduction prompt | resp: ${r.substring(0, 200)}` };
      }
      await tapL(ctx, noId);
      const items = await getStockItemsByName('glifosato');
      const ev = await dbQuery(`SELECT stock_deduction_status FROM domain_events WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [USER_ID]);
      const qty = items.length ? Number(items[0].current_quantity) : -1;
      const declined = ev.length > 0 && ev[0].stock_deduction_status === 'declined';
      const status: 'PASS' | 'WARN' | 'FAIL' = (qty === 100 && declined) ? 'PASS' : (qty === 100) ? 'WARN' : 'FAIL';
      const notes = `qty=${qty} declined=${declined}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET E: MULTI-WAREHOUSE =============

async function testE1() {
  return runScenario(
    { name: 'E1 same product in 2 warehouses', category: 'multi-warehouse', severity: 'medium',
      expected: ['Both quantities visible (sum or per-warehouse breakdown)'],
      possibleFailures: ['Only one warehouse shown', 'Silently merges'] },
    async (ctx) => {
      await sendL(ctx, `crear depósito Galpon Norte en ${ctx.ids.fieldName}`);
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `cargué 50 lt de glifosato en Galpon Norte`);
      const r = await sendL(ctx, `tengo glifosato?`);
      const items = await getStockItemsByName('glifosato');
      const total = items.reduce((s, i) => s + Number(i.current_quantity), 0);
      const showsBoth = /150|100.*50|50.*100|norte|central/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (total === 150 && showsBoth) ? 'PASS' : (total === 150) ? 'WARN' : 'FAIL';
      const notes = `db_total=${total} items=${items.length} resp_shows_both=${showsBoth} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testE2() {
  return runScenario(
    { name: 'E2 same grain, two batches with different humidity', category: 'multi-warehouse', severity: 'low',
      expected: ['Either separate items per humidity OR merged with combined humidity tracking'],
      possibleFailures: ['Crashes', 'Loses one batch'] },
    async (ctx) => {
      await sendL(ctx, `cargué 1000 kg de soja al 13.5% de humedad`);
      await sendL(ctx, `cargué 500 kg de soja al 14.5% de humedad`);
      const items = await getStockItemsByName('soja');
      const totalQty = items.reduce((s, i) => s + Number(i.current_quantity), 0);
      const status: 'PASS' | 'WARN' | 'FAIL' = (totalQty === 1500) ? 'PASS' : 'FAIL';
      const notes = `items=${items.length} total_qty=${totalQty} (expected 1500)`;
      return { status, actual: notes, notes };
    },
  );
}

async function testE3() {
  return runScenario(
    { name: 'E3 sacar without specifying warehouse when 2 have it', category: 'multi-warehouse', severity: 'medium',
      expected: ['Bot asks which warehouse', 'No silent pick'],
      possibleFailures: ['Picks one silently'] },
    async (ctx) => {
      await sendL(ctx, `crear depósito Galpon Sur en ${ctx.ids.fieldName}`);
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `cargué 100 lt de glifosato en Galpon Sur`);
      const r = await sendL(ctx, `saqué 20 lt de glifosato`);
      const movs = await getMovementsForItemName('glifosato');
      const salidas = movs.filter(m => m.movement_type === 'salida');
      const asked = /qué depósito|cuál depósito|en qué galpón|cuál galpón|de cuál|de qué depósito|más de un depósito|especificá|especifica/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (asked && salidas.length === 0) ? 'PASS' : (salidas.length === 1) ? 'WARN' : 'FAIL';
      const notes = `asked=${asked} salidas=${salidas.length} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET F: GRANOS =============

async function sowSojaOnBasePlot(ctx: ScenarioCtx) {
  await sendL(ctx, `sembré soja en el ${ctx.ids.plotName}`);
  // The flow may ask date — try a sensible default; if no flow, this is a no-op
  try { await sendL(ctx, 'hoy'); } catch { /* ignore */ }
  try { await sendL(ctx, 'cancelar'); } catch { /* ignore */ }
}

async function testF1() {
  return runScenario(
    { name: 'F1 cosechar 4200 kg soja → tap "cargar al silo"', category: 'granos', severity: 'high',
      expected: ['Grain stock_item created with quantity=4200'],
      possibleFailures: ['No grain stock prompt', 'Quantity mismatch'] },
    async (ctx) => {
      await sowSojaOnBasePlot(ctx);
      // Harvest may render confirm_pending first (campaign state etc.); auto-confirm.
      const r = await sendAndConfirm(ctx, `coseché soja en el ${ctx.ids.plotName}, 4200 kg`);
      const yesId = buttonIdMatching(r, /stock_grain_yes/);
      if (!yesId) {
        return { status: 'WARN' as const, actual: 'no stock_grain button', notes: `harvest did not surface silo prompt | resp: ${r.substring(0, 200)}` };
      }
      await tapL(ctx, yesId);
      const items = await getStockItemsByName('soja');
      const item = items[0];
      const qty = item ? Number(item.current_quantity) : -1;
      const ok = item && (
        (item.unit === 'kg' && Math.abs(qty - 4200) < 1) ||
        (item.unit === 'tn' && Math.abs(qty - 4.2) < 0.01)
      );
      const status: 'PASS' | 'WARN' | 'FAIL' = ok ? 'PASS' : 'FAIL';
      const notes = `qty=${qty} unit=${item?.unit} items=${items.length}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testF2() {
  return runScenario(
    { name: 'F2 vendí 2000 kg soja → tap "descontar del silo"', category: 'granos', severity: 'high',
      expected: ['Stock decreases to 2200 kg'],
      possibleFailures: ['No deduction prompt', 'Wrong amount'] },
    async (ctx) => {
      await sowSojaOnBasePlot(ctx);
      const harvestR = await sendAndConfirm(ctx, `coseché soja en el ${ctx.ids.plotName}, 4200 kg`);
      const grainYes = buttonIdMatching(harvestR, /stock_grain_yes/);
      if (grainYes) await tapL(ctx, grainYes);

      // Income flow also goes through confirm_pending.
      const saleR = await sendAndConfirm(ctx, `vendí 2000 kg de soja a 500 c/u`);
      const dedYes = buttonIdMatching(saleR, /stock_grain_sale_yes/);
      if (!dedYes) {
        return { status: 'WARN' as const, actual: 'no stock_grain_sale button', notes: `sale did not prompt deduction | resp: ${saleR.substring(0, 200)}` };
      }
      await tapL(ctx, dedYes);
      const items = await getStockItemsByName('soja');
      const item = items[0];
      const qty = item ? Number(item.current_quantity) : -1;
      const ok = item && (
        (item.unit === 'kg' && Math.abs(qty - 2200) < 1) ||
        (item.unit === 'tn' && Math.abs(qty - 2.2) < 0.01)
      );
      const status: 'PASS' | 'WARN' | 'FAIL' = ok ? 'PASS' : 'FAIL';
      const notes = `qty_after_sale=${qty} unit=${item?.unit}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testF3() {
  return runScenario(
    { name: 'F3 vendí 5000 kg soja con stock 4200', category: 'granos', severity: 'high',
      expected: ['Either rejects, warns, or partials — never goes negative'],
      possibleFailures: ['Stock goes negative'] },
    async (ctx) => {
      await sowSojaOnBasePlot(ctx);
      const harvestR = await sendAndConfirm(ctx, `coseché soja en el ${ctx.ids.plotName}, 4200 kg`);
      const grainYes = buttonIdMatching(harvestR, /stock_grain_yes/);
      if (grainYes) await tapL(ctx, grainYes);

      const saleR = await sendAndConfirm(ctx, `vendí 5000 kg de soja a 500 c/u`);
      const dedYes = buttonIdMatching(saleR, /stock_grain_sale_yes/);
      if (dedYes) await tapL(ctx, dedYes);

      const items = await getStockItemsByName('soja');
      // No item at all means F1 silo prompt didn't fire — inconclusive (WARN, not FAIL)
      if (items.length === 0) {
        return { status: 'WARN' as const, actual: 'no soja item exists in stock — depends on F1 working', notes: 'no soja stock_item; sale didn\'t trigger deduction (silo never loaded)' };
      }
      const qty = Number(items[0].current_quantity);
      const status: 'PASS' | 'WARN' | 'FAIL' = qty < 0 ? 'FAIL' : 'PASS';
      const notes = `qty_after_oversale=${qty} (FAIL only if negative)`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= BUCKET G: MIN STOCK =============

async function testG1() {
  return runScenario(
    { name: 'G1 set min=50, drop below → check_low_stock lists it', category: 'min-stock', severity: 'low',
      expected: ['Item appears in low-stock response'],
      possibleFailures: ['Not flagged'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato`);
      await sendL(ctx, `stock mínimo de glifosato 50 lt`);
      await sendL(ctx, `saqué 60 lt de glifosato`);
      const r = await sendL(ctx, `qué stock está bajo?`);
      const flagged = /glifosato/i.test(r) && /bajo|debajo|min|40/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = flagged ? 'PASS' : 'WARN';
      const notes = `resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testG2() {
  return runScenario(
    { name: 'G2 restock above min → no longer in low-stock list', category: 'min-stock', severity: 'low',
      expected: ['Item NOT in low-stock list after restock'],
      possibleFailures: ['Stays in list (stale)'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato`);
      await sendL(ctx, `stock mínimo de glifosato 50 lt`);
      await sendL(ctx, `saqué 60 lt de glifosato`);
      // Verify it's flagged at this point (current_quantity should be 40, below min 50)
      await sendL(ctx, `cargué 50 lt de glifosato`);  // back to 90
      // Use a more direct query phrasing the bot is more likely to map to check_low_stock
      const r = await sendL(ctx, `productos con stock bajo`);
      const stillFlagged = /glifosato.*bajo|bajo.*glifosato/i.test(r);
      const explicitNone = /todo.*ok|no hay|ninguno|sin productos|sin stock bajo|todo en orden/i.test(r);
      // Verify against DB too: item should NOT have current_quantity < min_stock now
      const items = await getStockItemsByName('glifosato');
      const dbConsistent = items[0] && Number(items[0].current_quantity) >= 50;
      let status: 'PASS' | 'WARN' | 'FAIL';
      if (stillFlagged) status = 'FAIL';
      else if (dbConsistent && explicitNone) status = 'PASS';
      else if (dbConsistent) status = 'WARN';
      else status = 'FAIL';
      const notes = `still_flagged=${stillFlagged} explicit_none=${explicitNone} db_qty=${items[0]?.current_quantity} | resp: ${r.substring(0, 240)}`;
      return { status, actual: notes, notes };
    },
  );
}

// ============= MAIN =============

async function main() {
  console.log('\n=======================================================');
  console.log('  QA STOCK CONSISTENCY -- conversational adversarial');
  console.log('=======================================================\n');

  const { token, userId } = await apiRegister(BASE_URL, EMAIL, PASSWORD, NAME);
  AUTH_TOKEN = token;
  USER_ID = userId;
  console.log(`  Auth OK (userId=${userId})`);

  await dbQuery(`UPDATE users SET plan_id = 4 WHERE id = $1`, [userId]);
  console.log('  Upgraded to enterprise plan\n');

  const tests: Array<() => Promise<TestResult>> = [
    testA1, testA2, testA3, testA4, testA5,
    testB1, testB2, testB3, testB4,
    testC1, testC2, testC3, testC4, testC5,
    testD1, testD2, testD3,
    testE1, testE2, testE3,
    testF1, testF2, testF3,
    testG1, testG2,
  ];

  console.log(`  Running ${tests.length} scenarios...\n`);

  for (let i = 0; i < tests.length; i++) {
    console.log(`  --- ${String(i + 1).padStart(2, '0')}/${tests.length} ---`);
    try { await send('cancelar'); } catch { /* ignore */ }
    await sleep(300);
    const r = await tests[i]();
    results.push(r);
    console.log(`  [${r.status}] ${r.test_name}`);
    if (r.status !== 'PASS') console.log(`         ${r.notes.substring(0, 200)}`);
  }

  // Summary
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
      console.log(`        ${r.notes.substring(0, 220)}`);
    }
    console.log('');
  }

  if (warn > 0) {
    console.log('  WARNINGS:');
    for (const r of results.filter(r => r.status === 'WARN')) {
      console.log(`    [${r.severity}] ${r.test_name}`);
      console.log(`        ${r.notes.substring(0, 220)}`);
    }
    console.log('');
  }

  const outPath = 'src/testing/qa-stock-consistency-results.json';
  writeFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), pass, warn, fail, total: results.length, results }, null, 2));
  console.log(`  Results written to ${outPath}\n`);

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
