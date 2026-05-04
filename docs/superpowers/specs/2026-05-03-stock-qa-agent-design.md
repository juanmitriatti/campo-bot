# Stock QA Agent — Conversational Consistency Tester

**Date:** 2026-05-03
**Status:** Approved by user, ready for implementation
**Owner:** Juan Pablo Mitriatti

## Goal

Build a standalone TypeScript test script that exercises the entire stock subsystem against the running local Docker stack via the test-bot HTTP API, with the explicit goal of **breaking consistency invariants** through adversarial conversational input. Run it once, produce a markdown report of findings.

## Non-goals

- Not a unit test suite (vitest already covers that).
- Not added to CI / `npm run eval`. Standalone like `qa-adversarial-30.ts`.
- Does not modify any stock code; it only probes existing behavior.
- No production / Railway testing — local Docker only.

## Architecture

Single file: `src/testing/qa-stock-consistency.ts`. Mirrors the existing pattern from `src/testing/qa-adversarial-advanced-40.ts`:

1. **Auth.** `apiRegister` / `apiLogin` with `testin@gmail.com` / `tester123` (auto-falls-through to login on 409).
2. **Plan upgrade.** One-time `UPDATE users SET plan_id=4 WHERE id=$1` via `POST /api/test-bot/query-db`. Stock feature is gated to `pro_plus+`; without this every scenario gets a paywall response.
3. **Per-scenario reset.** `POST /api/test-bot/reset` (hard-deletes all data for this user).
4. **Per-scenario setup.** Helper `seedBaseEntities()` creates: 1 field, 1 plot, 1 warehouse, optionally 1 stock item. Returns the names so the scenario body can use them.
5. **Conversation loop.** `apiSend(msg)` → response text + buttons. `apiTap(buttonId)` for callbacks. Multi-turn within a scenario.
6. **DB verification.** `dbQuery(sql, params)` via the same `/query-db` endpoint (SELECT/UPDATE only — by server design, no DELETE/INSERT). Used to assert post-state.
7. **Result accumulation.** Each scenario pushes a `TestResult` (test_name, category, severity, status, conversation log, expected_behavior, actual_result, notes).
8. **Output.** `src/testing/qa-stock-consistency-results.json` (raw) + markdown report pasted to chat.

### Why a new file (not extending `qa-adversarial-advanced-40.ts`)

- Different account (`testin@gmail.com` vs `qa-adversarial@campo.test`), different reset blast radius — keeping them separate avoids accidentally wiping the wrong account.
- Stock-specific helpers (warehouse seed, stock-table verification queries) bloat the existing 40-scenario file.
- Two scripts, two `npx tsx` invocations, no coupling.

## Scenarios

≈25 scenarios across 7 buckets. Each scenario sets `severity: 'low' | 'medium' | 'high'` so the report can sort.

### A. Transactional consistency (5, severity high)

| ID | Description | Pass criteria |
|----|-------------|---------------|
| A1 | `add_stock 100 lt glifosato a $2000` | Both `stock_movements` (entrada, qty=100) AND `expenses` (insumo, total=200000) exist; movement.expense_id links to that expense |
| A2 | Try `saqué 200 lt de glifosato` when stock=100 | Bot rejects, no `stock_movements` row inserted, `current_quantity` unchanged at 100 |
| A3 | Run 5 mixed entradas/salidas, then `SELECT SUM(quantity * sign) FROM stock_movements WHERE item_id=$1` | Sum equals `stock_items.current_quantity` exactly |
| A4 | Try to delete a warehouse that has stock_items inside | Either: (a) reject with clear message, or (b) cascade — assert which path the system takes; FAIL only if items are orphaned with the warehouse hard-deleted |
| A5 | Compound: `compré 100 lt y usé 30 hoy en el lote` | Both rows persist (atomicity through `withTransaction`); on synthetic failure (skip — too invasive without code mods), only verify the success path |

### B. Units / mismatch (4, severity medium)

| ID | Description | Pass criteria |
|----|-------------|---------------|
| B1 | Add 100 **lt**, ask `sacar 50 kg del mismo` | Bot detects unit mismatch and either rejects or asks for clarification; no silent conversion to 50 lt |
| B2 | Add 50 **tn** soja, sacar 30000 **kg** | Final stock = 20000 kg (or 20 tn). DB shows consistent unit |
| B3 | Add 42 **qq** trigo | Stored as 4200 kg (per `normalizeToKg`) |
| B4 | `cargué 50 de urea` (no unit) | Bot asks for unit; no row inserted with NULL/default unit |

### C. Conversational / reference (5, severity medium)

| ID | Description | Pass criteria |
|----|-------------|---------------|
| C1 | Multi-turn: `tengo glifosato?` → `y de urea?` → `cuánto en total?` | Each turn answers correctly; "en total" sums (not asks again) |
| C2 | Add 100 lt glifosato → `saqué 20 de eso` | Pronombre resolves to glifosato; movement created |
| C3 | Type `glifosado` (typo) when stock has glifosato | Fuzzy-matches; no NEW item created |
| C4 | `I bought 100kg of urea` | Either parses (anglicism) or politely declines — FAIL only if it creates `urea` with quantity 0 or wrong unit |
| C5 | Start `add_stock` flow → midway send `cancelar` | Flow cleared, no partial row in DB |

### D. Idempotency / buttons (3, severity high)

| ID | Description | Pass criteria |
|----|-------------|---------------|
| D1 | Log expense type=insumo → "cargar al stock?" button → tap **Sí twice in rapid succession** | Only ONE `stock_movements` row; second tap is no-op or shows "ya cargado" |
| D2 | Tap a fake/expired callback id (`stock_entry_yes_99999999`) | Bot responds gracefully (not 500) |
| D3 | Spraying activity → "descontar del stock?" button → tap **No** | `domain_events.stock_deduction_status='declined'`, `stock_items.current_quantity` UNCHANGED |

### E. Multi-warehouse / multi-batch (3, severity medium)

| ID | Description | Pass criteria |
|----|-------------|---------------|
| E1 | Same product in 2 warehouses | `tengo glifosato?` either sums or shows per-warehouse breakdown — FAIL if it shows only one and silently ignores the other |
| E2 | Same grain product, 2 entries with different `humidity_pct` | Either separate items or merged with weighted-avg humidity — assert which |
| E3 | Try `sacar X de glifosato` without specifying warehouse when 2 have it | Bot asks which (no silent pick) |

### F. Granos: harvest → silo → venta (3, severity high)

| ID | Description | Pass criteria |
|----|-------------|---------------|
| F1 | `coseché soja, 4200 kg` → tap "cargar al silo" Sí | Grain stock_item created with quantity=4200 kg |
| F2 | `vendí 2000 kg soja` → tap "descontar del silo" Sí | stock decreases to 2200 kg |
| F3 | `vendí 5000 kg soja` (more than stock) → tap Sí | Either rejects, or warns; FAIL if stock goes negative |

### G. Min stock + alertas (2, severity low)

| ID | Description | Pass criteria |
|----|-------------|---------------|
| G1 | Set min_stock=50 lt, current=100, then sacar 60 → `check_low_stock` | Item appears in low-stock list |
| G2 | After G1, add 50 lt back → `check_low_stock` | Item NOT in list |

## Test execution flow per scenario

```
for each scenario:
  reset(token)                           # hard-delete all data
  ids = seedBaseEntities()               # field + plot + warehouse
  conversation_log = []
  try:
    for step in scenario.steps:
      if step.type == 'send':
        resp = apiSend(step.text)
      else:
        resp = apiTap(step.buttonId)
      conversation_log.push({role, msg, resp})
    db_state = scenario.verify(dbQuery)  # SELECT-only checks
    status = evaluate(conversation_log, db_state, scenario.expected)
  catch (e):
    status = 'FAIL'
    notes = e.message
  results.push({...scenario, status, conversation_log, ...})
```

## Pass / Warn / Fail rubric

- **PASS:** all expected_behavior items present in either response text or DB state.
- **WARN:** core behavior correct but cosmetic issue (response phrasing odd, missing one expected line, button label off). No data corruption.
- **FAIL:** any of:
  - Stock goes negative
  - DB state contradicts response (bot says "cargado" but no row exists, or vice versa)
  - HTTP 500 / unhandled exception
  - Compound expense+stock left half-done
  - Movement sum ≠ current_quantity
  - Idempotency violation (duplicate row from double-tap)

## Files touched

- **NEW** `src/testing/qa-stock-consistency.ts` — the script
- **NEW** `src/testing/qa-stock-consistency-results.json` — output (gitignored? same as the other results files — currently those ARE committed; mirror that)

## How to run

```bash
docker compose up -d                                      # if not running
npx tsx src/testing/qa-stock-consistency.ts
```

Exits 0 if no FAIL, exits 1 if any FAIL (CI-friendly even though we're not adding it to CI yet).

## Risks / known limitations

1. **Reset wipes the testin@gmail.com account each scenario.** User confirmed OK.
2. **Plan upgrade is destructive of the user's plan setting.** Restored to plan 4 (enterprise) at start; not reverted at end.
3. **Some "consistency" properties (true concurrency races) cannot be tested via single-threaded HTTP calls.** Best we can do is rapid sequential calls (D1 double-tap). True concurrency would need parallel `fetch` and is mostly futile against a single-process Node app — flagged as out of scope.
4. **`/api/test-bot/query-db` only allows SELECT/UPDATE.** All verification is read-only; no test fixtures via raw INSERT.
5. **The agent is non-deterministic** (Claude). A scenario may PASS on one run and WARN on the next. Single run is a snapshot, not a guarantee.
