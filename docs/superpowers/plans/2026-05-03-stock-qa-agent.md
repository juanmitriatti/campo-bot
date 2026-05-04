# Stock QA Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/testing/qa-stock-consistency.ts` — an adversarial conversational tester targeting the stock subsystem, run it against local Docker with `testin@gmail.com`, produce a markdown report.

**Architecture:** Standalone TypeScript script following the exact pattern of `src/testing/qa-adversarial-advanced-40.ts`. One file, ~25 scenario functions, single `main()` runner, JSON output, exits 1 on FAIL.

**Tech Stack:** Node 20+ via `tsx`, native `fetch`, no test framework (this script IS the test). Targets `http://localhost:3000` (campo-bot Docker).

**Spec:** `docs/superpowers/specs/2026-05-03-stock-qa-agent-design.md`

---

## TDD note

This script is itself a test suite. Classical TDD (red→green→refactor against a unit) doesn't apply. The verification step for each task is: **the new scenario function runs end-to-end against a live `docker compose up` stack without throwing** (regardless of whether the bot's behavior PASSes/WARNs/FAILs — that's the data we're collecting).

Each task ends with a smoke-run command that exercises only the new scenario(s) and a commit.

## File structure

- **NEW** `src/testing/qa-stock-consistency.ts` — the entire script
- **NEW** `src/testing/qa-stock-consistency-results.json` — output (committed alongside the others; the existing `qa-adversarial-results.json` is committed)

---

### Task 1: Skeleton + auth + DB + reset helpers

**Files:**
- Create: `src/testing/qa-stock-consistency.ts`

- [ ] **Step 1: Create the file with API helpers and types**

```typescript
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

async function sendRaw(message: string): Promise<any> {
  return apiSend(BASE_URL, AUTH_TOKEN, message);
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

// ============= MAIN (skeleton) =============

async function main() {
  console.log('\n=======================================================');
  console.log('  QA STOCK CONSISTENCY -- conversational adversarial');
  console.log('=======================================================\n');

  const { token, userId } = await apiRegister(BASE_URL, EMAIL, PASSWORD, NAME);
  AUTH_TOKEN = token;
  USER_ID = userId;
  console.log(`  Auth OK (userId=${userId})`);

  // Upgrade to enterprise so the stock feature is gated open
  await dbQuery(`UPDATE users SET plan_id = 4 WHERE id = $1`, [userId]);
  console.log('  Upgraded to enterprise plan');

  // Smoke test: reset + simple ping
  await apiReset(BASE_URL, AUTH_TOKEN);
  console.log('  Reset OK');

  const ping = await send('hola');
  console.log('  Bot replied to "hola":', ping.substring(0, 80).replace(/\n/g, ' '));

  console.log('\n  Skeleton ready (no scenarios yet).\n');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-run the skeleton**

Run:
```bash
docker compose up -d && sleep 5 && npx tsx src/testing/qa-stock-consistency.ts
```

Expected output (last 4 lines):
```
  Auth OK (userId=N)
  Upgraded to enterprise plan
  Reset OK
  Bot replied to "hola": <some greeting>
  Skeleton ready (no scenarios yet).
```

If reset fails with 500 or auth fails, stop and debug — the rest of the plan depends on these primitives working.

- [ ] **Step 3: Commit**

```bash
git add src/testing/qa-stock-consistency.ts
git commit -m "test(stock): skeleton for QA stock consistency tester

Auth + reset + DB query + send/tap helpers. Smoke-tested against
local Docker with testin@gmail.com.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Setup helper + per-scenario primitives

**Files:**
- Modify: `src/testing/qa-stock-consistency.ts` (add `seedBaseEntities`, `runScenario` wrapper, replace `main` body to skip ping smoke and use new helpers)

- [ ] **Step 1: Add `seedBaseEntities` and `runScenario` helpers above `main()`**

Insert after `buttonIdMatching` and before `// ============= MAIN`:

```typescript
// ============= SCENARIO PRIMITIVES =============

interface BaseIds {
  fieldName: string;
  plotName: string;
  warehouseName: string;
}

/**
 * Resets the user, then creates 1 field + 1 plot + 1 warehouse so each
 * scenario starts from an identical clean baseline.
 */
async function seedBaseEntities(): Promise<BaseIds> {
  await apiReset(BASE_URL, AUTH_TOKEN);

  const fieldName = 'Campo QA';
  const plotName = 'Lote 1';
  const warehouseName = 'Galpon Central';

  // Field — agent flow asks for city
  await send(`agregar campo ${fieldName}`);
  // The flow may use a city callback or accept the city directly. Try the direct path first.
  const cityResp = await send('Pergamino');
  // If it's still asking for confirmation, tap confirm
  const confirmId = buttonIdMatching(cityResp, /^flow_confirm/);
  if (confirmId) await tap(confirmId);
  await send('cancelar'); // make sure no flow is sticky

  // Plot
  await send(`agregar lote ${plotName} al campo ${fieldName}`);
  await send('100'); // hectares
  await send('cancelar');

  // Warehouse
  await send(`crear depósito ${warehouseName} en ${fieldName}`);
  await send('cancelar');

  return { fieldName, plotName, warehouseName };
}

interface ScenarioCtx {
  ids: BaseIds;
  conversation: ConvTurn[];
  log: (turn: ConvTurn) => void;
}

/**
 * Standard wrapper for scenarios. Resets + seeds, runs the body,
 * builds a TestResult, swallows runtime errors as FAIL.
 */
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

/** send + log in one call */
async function sendL(ctx: ScenarioCtx, msg: string): Promise<string> {
  ctx.log({ role: 'user', message: msg });
  const r = await send(msg);
  ctx.log({ role: 'bot', message: r });
  return r;
}

/** tap + log */
async function tapL(ctx: ScenarioCtx, buttonId: string): Promise<string> {
  ctx.log({ role: 'tap', message: buttonId });
  const r = await tap(buttonId);
  ctx.log({ role: 'bot', message: r });
  return r;
}
```

- [ ] **Step 2: Replace the body of `main()` with a single seeding smoke check**

Replace the contents of `main()` after the `await dbQuery(... plan_id ...)` line with:

```typescript
  // Smoke test: seed base entities once, verify they exist
  console.log('\n  Seeding base entities (smoke test)...');
  const ids = await seedBaseEntities();
  console.log(`    field="${ids.fieldName}" plot="${ids.plotName}" warehouse="${ids.warehouseName}"`);

  const fields = await dbQuery('SELECT id, name FROM fields WHERE user_id=$1 AND deleted_at IS NULL', [USER_ID]);
  const plots = await dbQuery('SELECT id, name FROM plots WHERE user_id=$1 AND deleted_at IS NULL', [USER_ID]);
  const wh = await dbQuery('SELECT id, name FROM warehouses WHERE user_id=$1 AND deleted_at IS NULL', [USER_ID]);
  console.log(`    DB: ${fields.length} field(s), ${plots.length} plot(s), ${wh.length} warehouse(s)`);

  if (fields.length === 0 || plots.length === 0 || wh.length === 0) {
    console.error('    Seeding failed — one or more entities not created. Inspect logs above.');
    process.exit(1);
  }
  console.log('  Seeding OK\n');
```

- [ ] **Step 3: Smoke-run**

Run:
```bash
npx tsx src/testing/qa-stock-consistency.ts
```

Expected: prints "Seeding OK" with all three counts ≥ 1. If a count is 0, the seed flow needs fixing before continuing — most likely cause: the field/plot/warehouse flow expects an extra confirmation step. Inspect the bot's responses by adding a `console.log(r)` inside `seedBaseEntities` and adjust.

If the warehouse table doesn't exist, that means the DB schema is older than expected — run `docker compose down && docker compose up --build -d` to apply migrations.

- [ ] **Step 4: Commit**

```bash
git add src/testing/qa-stock-consistency.ts
git commit -m "test(stock): seedBaseEntities + runScenario wrapper

Each scenario now starts from a deterministic baseline (1 field, 1 plot,
1 warehouse). Smoke-verified against local DB.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Bucket A — Transactional consistency (5 scenarios)

**Files:**
- Modify: `src/testing/qa-stock-consistency.ts`

- [ ] **Step 1: Add bucket A scenarios**

Insert before `// ============= MAIN`:

```typescript
// ============= BUCKET A: TRANSACTIONAL CONSISTENCY =============

async function testA1_AddStockWithPriceCreatesLinkedExpense() {
  return runScenario(
    {
      name: 'A1 add_stock with unit_price creates linked expense atomically',
      category: 'transactional',
      severity: 'high',
      expected: ['stock_movement entrada qty=100', 'expense type=insumo total=200000', 'movement.expense_id links to expense'],
      possibleFailures: ['Only stock created (expense missing)', 'Only expense created (stock missing)', 'No link between them'],
    },
    async (ctx) => {
      const r = await sendL(ctx, `compré 100 lt de glifosato a 2000 c/u en ${ctx.ids.warehouseName}`);
      const movs = await dbQuery(
        `SELECT sm.id, sm.movement_type, sm.quantity, sm.expense_id, si.product, si.unit, si.current_quantity
         FROM stock_movements sm JOIN stock_items si ON si.id=sm.stock_item_id
         WHERE si.user_id=$1 ORDER BY sm.id DESC LIMIT 5`,
        [USER_ID],
      );
      const exps = await dbQuery(
        `SELECT id, expense_type, product, quantity, unit, total_ars FROM expenses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
        [USER_ID],
      );
      const hasMov = movs.some(m => Number(m.quantity) === 100 && m.movement_type === 'entrada');
      const hasExp = exps.some(e => Number(e.total_ars) === 200000 && e.expense_type === 'insumo');
      const linked = movs.some(m => m.expense_id && exps.some(e => e.id === m.expense_id));
      const status = (hasMov && hasExp && linked) ? 'PASS' : (hasMov || hasExp) ? 'FAIL' : 'WARN';
      const notes = `mov=${hasMov} exp=${hasExp} linked=${linked} | response excerpt: ${r.substring(0, 150)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA2_RemoveMoreThanAvailableRejected() {
  return runScenario(
    {
      name: 'A2 remove > available is rejected; stock stays',
      category: 'transactional',
      severity: 'high',
      expected: ['Bot rejects', 'No new stock_movements salida row', 'current_quantity unchanged at 100'],
      possibleFailures: ['Stock goes negative', 'Salida row inserted anyway', 'Bot says "ok" silently'],
    },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      const r = await sendL(ctx, `saqué 200 lt de glifosato del ${ctx.ids.warehouseName}`);
      const item = await dbQuery(`SELECT current_quantity FROM stock_items WHERE user_id=$1 AND product ILIKE '%glifosato%' LIMIT 1`, [USER_ID]);
      const salidas = await dbQuery(
        `SELECT sm.quantity FROM stock_movements sm JOIN stock_items si ON si.id=sm.stock_item_id
         WHERE si.user_id=$1 AND sm.movement_type='salida'`,
        [USER_ID],
      );
      const qty = item.length ? Number(item[0].current_quantity) : -1;
      const negative = qty < 0;
      const stayed = qty === 100;
      const noSalida = salidas.length === 0;
      let status: 'PASS' | 'WARN' | 'FAIL' = 'FAIL';
      if (negative) status = 'FAIL';
      else if (stayed && noSalida) status = 'PASS';
      else if (stayed) status = 'WARN';
      const notes = `current_quantity=${qty} salidas=${salidas.length} negative=${negative} | resp: ${r.substring(0, 150)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA3_MovementSumEqualsCurrentQuantity() {
  return runScenario(
    {
      name: 'A3 movement sum equals current_quantity (invariant)',
      category: 'transactional',
      severity: 'high',
      expected: ['SUM(entrada) - SUM(salida) == current_quantity for the item'],
      possibleFailures: ['Sum drifts from current_quantity', 'Salida inserted but current_quantity not decremented'],
    },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de urea en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `cargué 50 lt de urea en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `saqué 30 lt de urea del ${ctx.ids.warehouseName}`);
      await sendL(ctx, `saqué 20 lt de urea del ${ctx.ids.warehouseName}`);
      await sendL(ctx, `cargué 10 lt de urea en ${ctx.ids.warehouseName}`);

      const rows = await dbQuery(
        `SELECT si.id, si.current_quantity,
                COALESCE(SUM(CASE WHEN sm.movement_type='entrada' THEN sm.quantity ELSE 0 END), 0) AS sum_in,
                COALESCE(SUM(CASE WHEN sm.movement_type='salida' THEN sm.quantity ELSE 0 END), 0) AS sum_out
         FROM stock_items si LEFT JOIN stock_movements sm ON sm.stock_item_id=si.id
         WHERE si.user_id=$1 AND si.product ILIKE '%urea%'
         GROUP BY si.id, si.current_quantity`,
        [USER_ID],
      );
      if (rows.length === 0) return { status: 'FAIL' as const, actual: 'No urea item found', notes: 'urea was never created' };
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

async function testA4_DeleteWarehouseWithStock() {
  return runScenario(
    {
      name: 'A4 delete warehouse with stock — items not orphaned',
      category: 'transactional',
      severity: 'medium',
      expected: ['Either reject deletion OR cascade properly; never orphan items'],
      possibleFailures: ['Items reference deleted warehouse_id', 'Crash 500'],
    },
    async (ctx) => {
      await sendL(ctx, `cargué 50 lt de glifosato en ${ctx.ids.warehouseName}`);
      const r = await sendL(ctx, `eliminar depósito ${ctx.ids.warehouseName}`);
      // Some delete flows ask for confirmation
      const yes = buttonIdMatching(r, /confirm|yes|si|ok/i);
      if (yes) await tapL(ctx, yes);

      const orphans = await dbQuery(
        `SELECT si.id, si.product FROM stock_items si
         LEFT JOIN warehouses w ON w.id=si.warehouse_id
         WHERE si.user_id=$1 AND si.current_quantity > 0 AND (w.id IS NULL OR w.deleted_at IS NOT NULL)`,
        [USER_ID],
      );
      const status = orphans.length === 0 ? 'PASS' : 'FAIL';
      const notes = `orphan_items=${orphans.length} | resp: ${r.substring(0, 150)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testA5_CompoundAddAndUseAtomic() {
  return runScenario(
    {
      name: 'A5 compound add+use both persist (happy path)',
      category: 'transactional',
      severity: 'high',
      expected: ['Both stock entrada AND salida (or activity) persist'],
      possibleFailures: ['Half-done state', 'Only one side persists'],
    },
    async (ctx) => {
      const r = await sendL(ctx, `compré 100 lt de glifosato y usé 30 lt hoy en ${ctx.ids.plotName}`);
      const movs = await dbQuery(
        `SELECT sm.movement_type, sm.quantity FROM stock_movements sm JOIN stock_items si ON si.id=sm.stock_item_id WHERE si.user_id=$1 ORDER BY sm.id`,
        [USER_ID],
      );
      const entrada = movs.find(m => m.movement_type === 'entrada' && Number(m.quantity) === 100);
      const salida = movs.find(m => m.movement_type === 'salida' && Number(m.quantity) === 30);
      const status = (entrada && salida) ? 'PASS' : (entrada || salida) ? 'WARN' : 'FAIL';
      const notes = `entrada=${!!entrada} salida=${!!salida} total_movs=${movs.length} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}
```

- [ ] **Step 2: Wire bucket A into `main()`**

Replace the Task 2 smoke block in `main()` with:

```typescript
  console.log('\n  Running scenarios...\n');

  const tests: Array<() => Promise<TestResult>> = [
    testA1_AddStockWithPriceCreatesLinkedExpense,
    testA2_RemoveMoreThanAvailableRejected,
    testA3_MovementSumEqualsCurrentQuantity,
    testA4_DeleteWarehouseWithStock,
    testA5_CompoundAddAndUseAtomic,
  ];

  for (let i = 0; i < tests.length; i++) {
    console.log(`  --- ${String(i + 1).padStart(2, '0')}/${tests.length} ---`);
    try { await send('cancelar'); } catch { /* ignore */ }
    await sleep(300);
    const r = await tests[i]();
    results.push(r);
    console.log(`  [${r.status}] ${r.test_name}`);
    if (r.status !== 'PASS') console.log(`         ${r.notes.substring(0, 180)}`);
  }
```

- [ ] **Step 3: Smoke-run bucket A**

Run:
```bash
npx tsx src/testing/qa-stock-consistency.ts
```

Expected: 5 scenarios run end-to-end (each prints PASS/WARN/FAIL). If any throw an unhandled error, inspect the response. Don't worry about achieving 5/5 PASS yet — we're verifying the harness works, not that the bot is bug-free.

- [ ] **Step 4: Commit**

```bash
git add src/testing/qa-stock-consistency.ts
git commit -m "test(stock): bucket A — transactional consistency scenarios

5 scenarios: linked expense atomicity, negative stock rejection,
movement-sum invariant, warehouse delete with items, compound add+use.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Bucket B — Units / mismatch (4 scenarios)

**Files:**
- Modify: `src/testing/qa-stock-consistency.ts`

- [ ] **Step 1: Add bucket B scenarios**

Insert after bucket A:

```typescript
// ============= BUCKET B: UNITS =============

async function testB1_UnitMismatch_LtVsKg() {
  return runScenario(
    { name: 'B1 add 100 lt, try sacar 50 kg', category: 'units', severity: 'medium',
      expected: ['Bot detects unit mismatch (asks or rejects)', 'No silent conversion'],
      possibleFailures: ['Silently treats 50 kg as 50 lt', 'Crashes'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      const r = await sendL(ctx, `saqué 50 kg de glifosato del ${ctx.ids.warehouseName}`);
      const item = await dbQuery(`SELECT current_quantity, unit FROM stock_items WHERE user_id=$1 AND product ILIKE '%glifosato%' LIMIT 1`, [USER_ID]);
      const qty = item.length ? Number(item[0].current_quantity) : -1;
      const lower = r.toLowerCase();
      const detected = lower.includes('unidad') || lower.includes('kg') || lower.includes('lt') || lower.includes('no coincide') || lower.includes('aclar');
      // PASS: bot detected mismatch AND quantity unchanged at 100
      const status: 'PASS' | 'WARN' | 'FAIL' = (qty === 100 && detected) ? 'PASS' : (qty === 50) ? 'FAIL' : 'WARN';
      const notes = `qty_after=${qty} detected_mismatch=${detected} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testB2_TonToKgConversion() {
  return runScenario(
    { name: 'B2 add 50 tn soja, sacar 30000 kg → 20000 kg / 20 tn', category: 'units', severity: 'medium',
      expected: ['Final stock equals 20000 kg or 20 tn (consistent unit)'],
      possibleFailures: ['Treats tn==kg', 'Final stock wrong'] },
    async (ctx) => {
      await sendL(ctx, `cargué 50 tn de soja en ${ctx.ids.warehouseName}`);
      const r = await sendL(ctx, `saqué 30000 kg de soja del ${ctx.ids.warehouseName}`);
      const item = await dbQuery(`SELECT current_quantity, unit FROM stock_items WHERE user_id=$1 AND product ILIKE '%soja%' LIMIT 1`, [USER_ID]);
      const qty = item.length ? Number(item[0].current_quantity) : -1;
      const unit = item.length ? String(item[0].unit) : '?';
      // Acceptable: 20000 kg, or 20 tn
      const inKg = (unit === 'kg' && Math.abs(qty - 20000) < 0.5);
      const inTn = (unit === 'tn' && Math.abs(qty - 20) < 0.001);
      const status = (inKg || inTn) ? 'PASS' : 'FAIL';
      const notes = `qty=${qty} unit=${unit} | resp: ${r.substring(0, 150)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testB3_QuintalToKg() {
  return runScenario(
    { name: 'B3 cargué 42 qq de trigo → 4200 kg', category: 'units', severity: 'low',
      expected: ['Stored as 4200 kg (or 42 qq if qq is a stored unit)'],
      possibleFailures: ['Stored as 42 (raw), no conversion'] },
    async (ctx) => {
      const r = await sendL(ctx, `cargué 42 qq de trigo en ${ctx.ids.warehouseName}`);
      const item = await dbQuery(`SELECT current_quantity, unit FROM stock_items WHERE user_id=$1 AND product ILIKE '%trigo%' LIMIT 1`, [USER_ID]);
      const qty = item.length ? Number(item[0].current_quantity) : -1;
      const unit = item.length ? String(item[0].unit) : '?';
      const ok = (unit === 'kg' && Math.abs(qty - 4200) < 1) || (unit === 'qq' && Math.abs(qty - 42) < 0.01) || (unit === 'tn' && Math.abs(qty - 4.2) < 0.01);
      const status: 'PASS' | 'WARN' | 'FAIL' = ok ? 'PASS' : (qty === 42 && unit !== 'qq') ? 'FAIL' : 'WARN';
      const notes = `qty=${qty} unit=${unit} | resp: ${r.substring(0, 150)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testB4_NoUnitProvided() {
  return runScenario(
    { name: 'B4 cargué 50 de urea (no unit) → bot asks', category: 'units', severity: 'medium',
      expected: ['Bot asks for unit, no row inserted with NULL/default'],
      possibleFailures: ['Silently picks a unit', 'Inserts NULL unit row'] },
    async (ctx) => {
      const r = await sendL(ctx, `cargué 50 de urea en ${ctx.ids.warehouseName}`);
      const items = await dbQuery(`SELECT current_quantity, unit FROM stock_items WHERE user_id=$1 AND product ILIKE '%urea%'`, [USER_ID]);
      const lower = r.toLowerCase();
      const asked = lower.includes('unidad') || lower.includes('kg') || lower.includes('lt') || lower.includes('cuál');
      // PASS: bot asked AND nothing was inserted
      // WARN: inserted with a sensible default (kg) without asking
      // FAIL: NULL unit row
      let status: 'PASS' | 'WARN' | 'FAIL' = 'FAIL';
      if (items.length === 0 && asked) status = 'PASS';
      else if (items.length === 1 && items[0].unit && items[0].unit !== 'null') status = 'WARN';
      const notes = `items=${items.length} asked=${asked} unit=${items[0]?.unit || 'n/a'} | resp: ${r.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}
```

- [ ] **Step 2: Append to the `tests` array in `main()`**

```typescript
    testB1_UnitMismatch_LtVsKg,
    testB2_TonToKgConversion,
    testB3_QuintalToKg,
    testB4_NoUnitProvided,
```

- [ ] **Step 3: Smoke-run**

Run: `npx tsx src/testing/qa-stock-consistency.ts`. Expect 9 scenarios total to complete.

- [ ] **Step 4: Commit**

```bash
git add src/testing/qa-stock-consistency.ts
git commit -m "test(stock): bucket B — unit mismatch and conversion scenarios

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Bucket C — Conversational / reference (5 scenarios)

**Files:**
- Modify: `src/testing/qa-stock-consistency.ts`

- [ ] **Step 1: Add bucket C scenarios**

```typescript
// ============= BUCKET C: CONVERSATIONAL =============

async function testC1_MultiTurnQueries() {
  return runScenario(
    { name: 'C1 multi-turn: tengo glifosato? → y de urea? → cuánto en total?', category: 'conversational', severity: 'medium',
      expected: ['Each turn answers the right product', '"en total" sums (does not re-ask)'],
      possibleFailures: ['Drops context', 'Re-asks on third turn'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `cargué 50 lt de urea en ${ctx.ids.warehouseName}`);
      const r1 = await sendL(ctx, `tengo glifosato?`);
      const r2 = await sendL(ctx, `y de urea?`);
      const r3 = await sendL(ctx, `cuánto en total?`);
      const r1ok = /100|glifosato/i.test(r1);
      const r2ok = /50|urea/i.test(r2);
      const r3ok = /150|total|todo/i.test(r3);
      const status: 'PASS' | 'WARN' | 'FAIL' = (r1ok && r2ok && r3ok) ? 'PASS' : (r1ok && r2ok) ? 'WARN' : 'FAIL';
      const notes = `r1=${r1ok} r2=${r2ok} r3=${r3ok} | r3 excerpt: ${r3.substring(0, 150)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC2_Pronombre() {
  return runScenario(
    { name: 'C2 pronombre: cargué 100 lt glifosato → saqué 20 de eso', category: 'conversational', severity: 'medium',
      expected: ['"de eso" resolves to glifosato', 'salida row of 20 lt'],
      possibleFailures: ['Asks "qué producto?"', 'Saca de un producto distinto'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      const r = await sendL(ctx, `saqué 20 de eso del ${ctx.ids.warehouseName}`);
      const item = await dbQuery(`SELECT current_quantity FROM stock_items WHERE user_id=$1 AND product ILIKE '%glifosato%' LIMIT 1`, [USER_ID]);
      const qty = item.length ? Number(item[0].current_quantity) : -1;
      const status: 'PASS' | 'WARN' | 'FAIL' = (qty === 80) ? 'PASS' : /qué producto|cuál/i.test(r) ? 'WARN' : 'FAIL';
      const notes = `qty_after=${qty} | resp: ${r.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC3_TypoFuzzyMatch() {
  return runScenario(
    { name: 'C3 typo: glifosado → matches glifosato', category: 'conversational', severity: 'medium',
      expected: ['Fuzzy match', 'No new "glifosado" item'],
      possibleFailures: ['Creates a new item with the typo'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `saqué 10 lt de glifosado del ${ctx.ids.warehouseName}`);
      const items = await dbQuery(`SELECT product, current_quantity FROM stock_items WHERE user_id=$1`, [USER_ID]);
      const products = items.map(i => i.product.toLowerCase());
      const onlyOne = products.filter(p => p.includes('glif')).length === 1;
      const qty = items.find(i => i.product.toLowerCase().includes('glif'))?.current_quantity;
      const status: 'PASS' | 'WARN' | 'FAIL' = (onlyOne && Number(qty) === 90) ? 'PASS' : onlyOne ? 'WARN' : 'FAIL';
      const notes = `products=${JSON.stringify(products)} qty=${qty}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC4_AnglicismInput() {
  return runScenario(
    { name: 'C4 English input: "I bought 100kg of urea"', category: 'conversational', severity: 'low',
      expected: ['Either parses correctly OR politely declines', 'Never creates a phantom item'],
      possibleFailures: ['Creates "urea" with qty 0 or wrong unit', 'Crashes'] },
    async (ctx) => {
      const r = await sendL(ctx, `I bought 100kg of urea`);
      const items = await dbQuery(`SELECT product, current_quantity, unit FROM stock_items WHERE user_id=$1`, [USER_ID]);
      const urea = items.find(i => i.product.toLowerCase().includes('urea'));
      let status: 'PASS' | 'WARN' | 'FAIL' = 'WARN';
      if (urea && Number(urea.current_quantity) === 100 && urea.unit === 'kg') status = 'PASS';
      else if (!urea) status = 'WARN'; // declined gracefully
      else status = 'FAIL'; // phantom
      const notes = `urea=${JSON.stringify(urea)} | resp: ${r.substring(0, 180)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testC5_CancelMidFlow() {
  return runScenario(
    { name: 'C5 cancel mid-flow: start add_stock then cancelar', category: 'conversational', severity: 'medium',
      expected: ['Flow cleared', 'No partial stock_items / stock_movements row'],
      possibleFailures: ['Partial item inserted', 'Flow stays sticky'] },
    async (ctx) => {
      // Trigger an add_stock flow that probably asks a follow-up
      await sendL(ctx, `quiero cargar stock`);
      await sendL(ctx, `cancelar`);
      // After cancel, an unrelated message should NOT be interpreted as a flow continuation
      const r = await sendL(ctx, `hola`);
      const items = await dbQuery(`SELECT id FROM stock_items WHERE user_id=$1`, [USER_ID]);
      const movs = await dbQuery(`SELECT id FROM stock_movements sm JOIN stock_items si ON si.id=sm.stock_item_id WHERE si.user_id=$1`, [USER_ID]);
      const status: 'PASS' | 'WARN' | 'FAIL' = (items.length === 0 && movs.length === 0) ? 'PASS' : 'FAIL';
      const notes = `items=${items.length} movs=${movs.length} | last resp: ${r.substring(0, 150)}`;
      return { status, actual: notes, notes };
    },
  );
}
```

- [ ] **Step 2: Append to the `tests` array**

```typescript
    testC1_MultiTurnQueries,
    testC2_Pronombre,
    testC3_TypoFuzzyMatch,
    testC4_AnglicismInput,
    testC5_CancelMidFlow,
```

- [ ] **Step 3: Smoke-run + commit**

```bash
npx tsx src/testing/qa-stock-consistency.ts
git add src/testing/qa-stock-consistency.ts
git commit -m "test(stock): bucket C — conversational scenarios (multi-turn, pronombre, typo, anglicism, cancel)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Bucket D — Idempotency / buttons (3 scenarios)

**Files:**
- Modify: `src/testing/qa-stock-consistency.ts`

- [ ] **Step 1: Add bucket D scenarios**

```typescript
// ============= BUCKET D: IDEMPOTENCY / BUTTONS =============

async function testD1_DoubleTapStockEntryButton() {
  return runScenario(
    { name: 'D1 double-tap "cargar al stock" button', category: 'idempotency', severity: 'high',
      expected: ['Only ONE stock_movements row', 'Second tap is no-op or shows "ya cargado"'],
      possibleFailures: ['Two movements created (duplicate)'] },
    async (ctx) => {
      const r1 = await sendL(ctx, `gasté 200000 en glifosato, 100 lt`);
      const yesId = buttonIdMatching(r1, /stock_entry_yes/);
      if (!yesId) {
        return { status: 'WARN' as const, actual: 'no stock_entry button surfaced', notes: `expense did not trigger stock prompt | resp: ${r1.substring(0, 200)}` };
      }
      // Tap twice in rapid succession
      const [_t1, _t2] = await Promise.all([tap(yesId), tap(yesId)]);
      ctx.log({ role: 'tap', message: yesId });
      ctx.log({ role: 'tap', message: yesId });

      const movs = await dbQuery(
        `SELECT sm.id, sm.movement_type, sm.quantity FROM stock_movements sm
         JOIN stock_items si ON si.id=sm.stock_item_id
         WHERE si.user_id=$1 AND si.product ILIKE '%glifosato%'`,
        [USER_ID],
      );
      const entradas = movs.filter(m => m.movement_type === 'entrada');
      const status: 'PASS' | 'WARN' | 'FAIL' = entradas.length === 1 ? 'PASS' : entradas.length > 1 ? 'FAIL' : 'WARN';
      const notes = `entradas=${entradas.length} (expected 1) total_movs=${movs.length}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testD2_FakeCallbackId() {
  return runScenario(
    { name: 'D2 tap fake/expired callback id — no crash', category: 'idempotency', severity: 'medium',
      expected: ['Bot responds gracefully (no 500)'],
      possibleFailures: ['HTTP 500', 'Cryptic stack trace to user'] },
    async (ctx) => {
      try {
        const r = await tap('stock_entry_yes_99999999');
        ctx.log({ role: 'tap', message: 'stock_entry_yes_99999999 (fake)' });
        ctx.log({ role: 'bot', message: r });
        // Any non-empty graceful response is acceptable
        const status: 'PASS' | 'WARN' | 'FAIL' = r && r.length > 0 ? 'PASS' : 'WARN';
        return { status, actual: r.substring(0, 200), notes: `resp len=${r.length}` };
      } catch (e: any) {
        return { status: 'FAIL' as const, actual: e.message, notes: `Crashed on fake callback: ${e.message}` };
      }
    },
  );
}

async function testD3_DeclineSprayDeduction() {
  return runScenario(
    { name: 'D3 decline spray stock deduction — stock unchanged', category: 'idempotency', severity: 'high',
      expected: ['stock_deduction_status=declined', 'current_quantity unchanged'],
      possibleFailures: ['Stock decremented despite decline'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      const r = await sendL(ctx, `fumigué el ${ctx.ids.plotName} con 2 lt/ha de glifosato`);
      const noId = buttonIdMatching(r, /stock_deduct_no/);
      if (!noId) {
        return { status: 'WARN' as const, actual: 'no stock_deduct button', notes: `spray did not surface deduction prompt | resp: ${r.substring(0, 200)}` };
      }
      await tapL(ctx, noId);
      const item = await dbQuery(`SELECT current_quantity FROM stock_items WHERE user_id=$1 AND product ILIKE '%glifosato%' LIMIT 1`, [USER_ID]);
      const ev = await dbQuery(`SELECT stock_deduction_status FROM domain_events WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [USER_ID]);
      const qty = item.length ? Number(item[0].current_quantity) : -1;
      const declined = ev.length > 0 && ev[0].stock_deduction_status === 'declined';
      const status: 'PASS' | 'WARN' | 'FAIL' = (qty === 100 && declined) ? 'PASS' : (qty === 100) ? 'WARN' : 'FAIL';
      const notes = `qty=${qty} declined=${declined}`;
      return { status, actual: notes, notes };
    },
  );
}
```

- [ ] **Step 2: Append to `tests`**

```typescript
    testD1_DoubleTapStockEntryButton,
    testD2_FakeCallbackId,
    testD3_DeclineSprayDeduction,
```

- [ ] **Step 3: Smoke-run + commit**

```bash
npx tsx src/testing/qa-stock-consistency.ts
git add src/testing/qa-stock-consistency.ts
git commit -m "test(stock): bucket D — idempotency and button callbacks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Bucket E — Multi-warehouse / multi-batch (3 scenarios)

**Files:**
- Modify: `src/testing/qa-stock-consistency.ts`

- [ ] **Step 1: Add bucket E scenarios**

```typescript
// ============= BUCKET E: MULTI-WAREHOUSE / MULTI-BATCH =============

async function testE1_SameProductTwoWarehouses() {
  return runScenario(
    { name: 'E1 same product in 2 warehouses', category: 'multi-warehouse', severity: 'medium',
      expected: ['Both quantities visible (sum or per-warehouse breakdown)'],
      possibleFailures: ['Only one warehouse shown', 'Silently merges into one'] },
    async (ctx) => {
      // Second warehouse
      await sendL(ctx, `crear depósito Galpon Norte en ${ctx.ids.fieldName}`);
      await sendL(ctx, `cancelar`);
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `cargué 50 lt de glifosato en Galpon Norte`);
      const r = await sendL(ctx, `tengo glifosato?`);
      const items = await dbQuery(`SELECT w.name AS wh, si.current_quantity FROM stock_items si JOIN warehouses w ON w.id=si.warehouse_id WHERE si.user_id=$1 AND si.product ILIKE '%glifosato%'`, [USER_ID]);
      const total = items.reduce((s, i) => s + Number(i.current_quantity), 0);
      const showsBoth = /150|100.*50|50.*100|galpon norte|galpon central/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (total === 150 && showsBoth) ? 'PASS' : (total === 150) ? 'WARN' : 'FAIL';
      const notes = `db_total=${total} items=${items.length} resp_shows_both=${showsBoth} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testE2_SameGrainDifferentHumidity() {
  return runScenario(
    { name: 'E2 same grain, two batches with different humidity', category: 'multi-warehouse', severity: 'low',
      expected: ['Either separate items per humidity OR merged with combined humidity tracking'],
      possibleFailures: ['Crashes', 'Loses one batch'] },
    async (ctx) => {
      await sendL(ctx, `cargué 1000 kg de soja al 13.5% en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `cargué 500 kg de soja al 14.5% en ${ctx.ids.warehouseName}`);
      const items = await dbQuery(`SELECT current_quantity, humidity_pct FROM stock_items WHERE user_id=$1 AND product ILIKE '%soja%'`, [USER_ID]);
      const totalQty = items.reduce((s, i) => s + Number(i.current_quantity), 0);
      const status: 'PASS' | 'WARN' | 'FAIL' = (totalQty === 1500) ? 'PASS' : 'FAIL';
      const notes = `items=${items.length} total_qty=${totalQty} (expected 1500) humidities=${items.map(i => i.humidity_pct).join(',')}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testE3_AmbiguousWarehouseRemoval() {
  return runScenario(
    { name: 'E3 sacar without specifying warehouse when 2 have it', category: 'multi-warehouse', severity: 'medium',
      expected: ['Bot asks which warehouse', 'No silent pick'],
      possibleFailures: ['Picks one silently'] },
    async (ctx) => {
      await sendL(ctx, `crear depósito Galpon Sur en ${ctx.ids.fieldName}`);
      await sendL(ctx, `cancelar`);
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `cargué 100 lt de glifosato en Galpon Sur`);
      const r = await sendL(ctx, `saqué 20 lt de glifosato`);
      const movs = await dbQuery(`SELECT sm.movement_type, sm.quantity, w.name AS wh FROM stock_movements sm JOIN stock_items si ON si.id=sm.stock_item_id JOIN warehouses w ON w.id=si.warehouse_id WHERE si.user_id=$1`, [USER_ID]);
      const salidas = movs.filter(m => m.movement_type === 'salida');
      const asked = /qué depósito|cuál depósito|en qué galpón|cuál galpón|de cuál|de qué depósito/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (asked && salidas.length === 0) ? 'PASS' : (salidas.length === 1) ? 'WARN' : 'FAIL';
      const notes = `asked=${asked} salidas=${salidas.length} | resp: ${r.substring(0, 200)}`;
      return { status, actual: notes, notes };
    },
  );
}
```

- [ ] **Step 2: Append to `tests` + commit pattern**

```typescript
    testE1_SameProductTwoWarehouses,
    testE2_SameGrainDifferentHumidity,
    testE3_AmbiguousWarehouseRemoval,
```

```bash
npx tsx src/testing/qa-stock-consistency.ts
git add src/testing/qa-stock-consistency.ts
git commit -m "test(stock): bucket E — multi-warehouse and multi-batch scenarios

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Bucket F — Granos: harvest → silo → venta (3 scenarios)

**Files:**
- Modify: `src/testing/qa-stock-consistency.ts`

- [ ] **Step 1: Add bucket F scenarios**

```typescript
// ============= BUCKET F: GRANOS =============

/** Sows soja on the base plot — required for harvest scenarios */
async function sowSojaOnBasePlot(ctx: ScenarioCtx) {
  await sendL(ctx, `sembré soja en el ${ctx.ids.plotName}`);
  // The flow may ask date — try a sensible default
  await sendL(ctx, `hoy`);
  await sendL(ctx, `cancelar`);
}

async function testF1_HarvestToSilo() {
  return runScenario(
    { name: 'F1 cosechar 4200 kg soja → tap "cargar al silo"', category: 'granos', severity: 'high',
      expected: ['Grain stock_item created with quantity=4200'],
      possibleFailures: ['No grain stock prompt', 'Quantity mismatch'] },
    async (ctx) => {
      await sowSojaOnBasePlot(ctx);
      const r = await sendL(ctx, `coseché soja en el ${ctx.ids.plotName}, 4200 kg`);
      const yesId = buttonIdMatching(r, /stock_grain_yes/);
      if (!yesId) {
        return { status: 'WARN' as const, actual: 'no stock_grain button', notes: `harvest did not surface silo prompt | resp: ${r.substring(0, 200)}` };
      }
      await tapL(ctx, yesId);
      const items = await dbQuery(`SELECT current_quantity, unit FROM stock_items WHERE user_id=$1 AND product ILIKE '%soja%'`, [USER_ID]);
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

async function testF2_GrainSaleDeducts() {
  return runScenario(
    { name: 'F2 vendí 2000 kg soja → tap "descontar del silo"', category: 'granos', severity: 'high',
      expected: ['Stock decreases to 2200 kg (or 2.2 tn)'],
      possibleFailures: ['No deduction prompt', 'Wrong amount deducted'] },
    async (ctx) => {
      await sowSojaOnBasePlot(ctx);
      const harvestR = await sendL(ctx, `coseché soja en el ${ctx.ids.plotName}, 4200 kg`);
      const grainYes = buttonIdMatching(harvestR, /stock_grain_yes/);
      if (grainYes) await tapL(ctx, grainYes);

      const saleR = await sendL(ctx, `vendí 2000 kg de soja a 500 c/u`);
      const dedYes = buttonIdMatching(saleR, /stock_grain_sale_yes/);
      if (!dedYes) {
        return { status: 'WARN' as const, actual: 'no stock_grain_sale button', notes: `sale did not prompt deduction | resp: ${saleR.substring(0, 200)}` };
      }
      await tapL(ctx, dedYes);
      const items = await dbQuery(`SELECT current_quantity, unit FROM stock_items WHERE user_id=$1 AND product ILIKE '%soja%'`, [USER_ID]);
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

async function testF3_SaleMoreThanStock() {
  return runScenario(
    { name: 'F3 vendí 5000 kg soja con stock 4200', category: 'granos', severity: 'high',
      expected: ['Either rejects, warns, or partials — never goes negative'],
      possibleFailures: ['Stock goes negative'] },
    async (ctx) => {
      await sowSojaOnBasePlot(ctx);
      const harvestR = await sendL(ctx, `coseché soja en el ${ctx.ids.plotName}, 4200 kg`);
      const grainYes = buttonIdMatching(harvestR, /stock_grain_yes/);
      if (grainYes) await tapL(ctx, grainYes);

      const saleR = await sendL(ctx, `vendí 5000 kg de soja a 500 c/u`);
      const dedYes = buttonIdMatching(saleR, /stock_grain_sale_yes/);
      if (dedYes) await tapL(ctx, dedYes);

      const items = await dbQuery(`SELECT current_quantity FROM stock_items WHERE user_id=$1 AND product ILIKE '%soja%'`, [USER_ID]);
      const qty = items[0] ? Number(items[0].current_quantity) : -1;
      const status: 'PASS' | 'WARN' | 'FAIL' = qty < 0 ? 'FAIL' : 'PASS';
      const notes = `qty_after_oversale=${qty} (FAIL only if negative)`;
      return { status, actual: notes, notes };
    },
  );
}
```

- [ ] **Step 2: Append to `tests` + commit**

```typescript
    testF1_HarvestToSilo,
    testF2_GrainSaleDeducts,
    testF3_SaleMoreThanStock,
```

```bash
npx tsx src/testing/qa-stock-consistency.ts
git add src/testing/qa-stock-consistency.ts
git commit -m "test(stock): bucket F — granos (harvest → silo → venta)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Bucket G — Min stock + alertas (2 scenarios)

**Files:**
- Modify: `src/testing/qa-stock-consistency.ts`

- [ ] **Step 1: Add bucket G scenarios**

```typescript
// ============= BUCKET G: MIN STOCK / ALERTAS =============

async function testG1_LowStockAppearsInList() {
  return runScenario(
    { name: 'G1 set min=50, drop below → check_low_stock lists it', category: 'min-stock', severity: 'low',
      expected: ['Item appears in low-stock response'],
      possibleFailures: ['Not flagged', 'set_min_stock not parsed'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `stock mínimo de glifosato 50 lt`);
      await sendL(ctx, `saqué 60 lt de glifosato del ${ctx.ids.warehouseName}`);
      const r = await sendL(ctx, `qué stock está bajo?`);
      const flagged = /glifosato/i.test(r) && (/bajo|debajo|min|40/i.test(r));
      const status: 'PASS' | 'WARN' | 'FAIL' = flagged ? 'PASS' : 'WARN';
      const notes = `resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}

async function testG2_RestoredStockNotInLowList() {
  return runScenario(
    { name: 'G2 restock above min → no longer in low-stock list', category: 'min-stock', severity: 'low',
      expected: ['Item NOT in low-stock list after restock'],
      possibleFailures: ['Stays in list (stale)'] },
    async (ctx) => {
      await sendL(ctx, `cargué 100 lt de glifosato en ${ctx.ids.warehouseName}`);
      await sendL(ctx, `stock mínimo de glifosato 50 lt`);
      await sendL(ctx, `saqué 60 lt de glifosato del ${ctx.ids.warehouseName}`);
      await sendL(ctx, `cargué 50 lt de glifosato en ${ctx.ids.warehouseName}`);
      const r = await sendL(ctx, `qué stock está bajo?`);
      const stillFlagged = /glifosato.*bajo|bajo.*glifosato/i.test(r);
      const explicitNone = /todo.*ok|no hay|ninguno|sin productos/i.test(r);
      const status: 'PASS' | 'WARN' | 'FAIL' = (!stillFlagged) ? (explicitNone ? 'PASS' : 'WARN') : 'FAIL';
      const notes = `still_flagged=${stillFlagged} explicit_none=${explicitNone} | resp: ${r.substring(0, 220)}`;
      return { status, actual: notes, notes };
    },
  );
}
```

- [ ] **Step 2: Append to `tests` + commit**

```typescript
    testG1_LowStockAppearsInList,
    testG2_RestoredStockNotInLowList,
```

```bash
npx tsx src/testing/qa-stock-consistency.ts
git add src/testing/qa-stock-consistency.ts
git commit -m "test(stock): bucket G — min stock and low-stock alerts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Final reporting — JSON output + summary + exit code

**Files:**
- Modify: `src/testing/qa-stock-consistency.ts` (replace the `main()` summary section)

- [ ] **Step 1: Add summary + JSON dump after the test loop**

Append this after the `for` loop in `main()`:

```typescript
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
      console.log(`        ${r.notes.substring(0, 200)}`);
    }
    console.log('');
  }

  if (warn > 0) {
    console.log('  WARNINGS:');
    for (const r of results.filter(r => r.status === 'WARN')) {
      console.log(`    [${r.severity}] ${r.test_name}`);
      console.log(`        ${r.notes.substring(0, 200)}`);
    }
    console.log('');
  }

  const outPath = 'src/testing/qa-stock-consistency-results.json';
  writeFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), pass, warn, fail, total: results.length, results }, null, 2));
  console.log(`  Results written to ${outPath}\n`);

  if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Full run**

Run:
```bash
npx tsx src/testing/qa-stock-consistency.ts
```

Expected: 25 scenarios run end-to-end, summary printed, JSON file written. Exit code 0 if no FAIL, 1 if any FAIL.

If any scenario throws an unhandled exception (not caught by `runScenario`), find which one (the script will stop) and fix.

- [ ] **Step 3: Commit**

```bash
git add src/testing/qa-stock-consistency.ts src/testing/qa-stock-consistency-results.json
git commit -m "test(stock): final summary + JSON output + exit code

Full 25-scenario run produces qa-stock-consistency-results.json and
exits 1 on any FAIL.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Run + write markdown report for the user

**Files:**
- Read: `src/testing/qa-stock-consistency-results.json`
- Output: a markdown report (paste in chat — do NOT commit a separate report file unless the user asks)

- [ ] **Step 1: Final clean run**

```bash
docker compose up -d
sleep 5
npx tsx src/testing/qa-stock-consistency.ts | tee /tmp/qa-stock-run.log
```

- [ ] **Step 2: Build the markdown report**

Read the JSON output and produce a report with:

1. **Header line:** "QA Stock Consistency — N PASS / M WARN / K FAIL (run: <ts>)"
2. **FAIL section** — for each FAIL: test_name, severity, expected vs actual, notes, last 3-4 conversation turns
3. **WARN section** — short table of test_name + one-line notes
4. **PASS section** — collapsed list of names only
5. **Recommendations** — for each FAIL, a 1-line guess at the likely root cause (file/area to investigate)

Paste this report in the chat directly. Don't write it to a file.

- [ ] **Step 3: No commit needed for the report** (it's chat output). The JSON results file from Task 10 is the persistent artifact.

---

## Self-review notes

**Spec coverage:**
- ✅ A (5), B (4), C (5), D (3), E (3), F (3), G (2) = 25 scenarios across 7 buckets — matches spec
- ✅ Reset between scenarios (in `runScenario`)
- ✅ Plan upgrade in `main()`
- ✅ DB verification via `dbQuery`
- ✅ JSON output + exit code
- ✅ A4/E2 acknowledge "either path is fine" per spec
- ✅ A5 only happy path (synthetic failure noted as out of scope in spec)

**Placeholders:** none — every step has full code or full commands.

**Type consistency:** `TestResult`, `BaseIds`, `ScenarioCtx`, `ConvTurn` defined once and reused; helper signatures (`sendL`, `tapL`, `dbQuery`) match between definition (Task 1/2) and use (Tasks 3-9).

**Known fragilities flagged:**
- `seedBaseEntities` (Task 2) makes assumptions about the field/plot/warehouse flow shapes. Step 3 of Task 2 tells the implementer to inspect responses if seeding fails and adjust — accepted risk.
- Bucket G uses regex on bot text; the bot's exact wording may differ. PASS/WARN/FAIL fall through gracefully (default WARN if uncertain, FAIL only on clear data corruption).
