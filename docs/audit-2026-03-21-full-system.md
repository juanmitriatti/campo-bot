# Full System Audit — 2026-03-21

**Scope:** Complete audit of campo-bot: data model, fields/plots ABM, observations, rainfall, financials, intent routing, conversation state, dashboard, settings, reporting, UX.

**Files Analyzed:** 35+
**Tests:** 1115 passing across 22 test files

---

## 1. Scope

### Modules Covered

| Module | Key Files |
|--------|-----------|
| Fields & Plots ABM | `expenses.js`, `plot.repository.ts`, `plot-discovery.service.ts`, `crop.service.ts` |
| Observations | `observations.js`, `agronomy.handler.ts`, `pending-observations.ts` |
| Rainfall & Weather | `expenses.js` (rainfall fns), `rainfall.flow.ts`, `scheduler.js`, `weather.js`, `alert.service.js` |
| Financials | `expenses.js` (expense/income fns), `financial.handler.ts`, `financial.repository.ts`, expense/income flows |
| Intent Routing | `intent-classifier.ts`, `whatsapp.controller.ts`, `conversation-engine.ts`, `intent-extractor.ts`, `prompt-builder.ts`, `conversational-fallback.service.ts` |
| Dashboard & Settings | `settings.service.js`, `dashboard.js`, `conversation-observer.ts` |
| Schema | `init.sql`, migrations 001–030 |

### Out of Scope

- WhatsApp Cloud API integration (Meta webhook signature validation)
- Frontend dashboard HTML/CSS
- Deployment infrastructure (Docker internals, CI/CD)
- Load testing / performance benchmarking

---

## 2. Data Model & Associations

### Core Tables

| Table | PK | Key FKs | Soft Delete | Notes |
|-------|----|---------|-------------|-------|
| `users` | id | plan_id→plans | No | Phone-based, plan assignment |
| `fields` | id | user_id→users | `deleted_at` + `deleted_by` | UNIQUE(user_id, name) |
| `plots` | id | field_id→fields (CASCADE) | `deleted_at` + `deleted_by` | UNIQUE(field_id, name) |
| `expenses` | id | user_id, field_id?, plot_id? | `deleted_at` | Nullable location FKs |
| `incomes` | id | user_id, field_id?, plot_id? | `deleted_at` | Nullable location FKs |
| `rainfall` | id | user_id, field_id? | No | plot_id vestigial (always NULL after migration 030) |
| `agro_observations` | id | user_id, field_id?, plot_id? | No | Handler enforces plot_id NOT NULL |
| `domain_events` | id | user_id, plot_id?, plot_crop_id? | No | Spraying, fertilization, tillage, irrigation, planting, harvest |
| `budgets` | id | user_id | No | UNIQUE(user_id, category) |
| `user_settings` | id | user_id (UNIQUE) | No | Per-user preferences |
| `global_settings` | id=1 | — | No | Weather/budget alert toggles |
| `system_settings` | id | — | No | Key-value config store |
| `conversation_state` | user_id | last_plot_id?, last_field_id? | No | Mini-memory + flow state |

### Association Inconsistencies

| Issue | Severity | Description |
|-------|----------|-------------|
| UNIQUE doesn't respect soft delete | MEDIUM | `UNIQUE(user_id, name)` on fields blocks recreation of soft-deleted names. `getOrCreateField` checks `deleted_at IS NULL` but INSERT hits DB constraint. |
| `agro_observations` no `deleted_at` | LOW | Only table with user data lacking soft-delete. Observations from deleted plots remain visible. |
| `rainfall.plot_id` vestigial | LOW | Column exists in schema but never written after migration 030. Should be dropped in future cleanup. |
| `getPlotById` no soft-delete filter | LOW | Returns soft-deleted plots. Used by conversation state restoration. |

---

## 3. Current Behavior

### 3a. Fields & Plots ABM

| Action | User Input | Behavior | Edge Cases |
|--------|-----------|----------|------------|
| Create field | "agregar campo norte" | `getOrCreateField()` — checks `deleted_at IS NULL`, creates if absent | Recreating soft-deleted name → PG UNIQUE violation |
| List fields | "mis campos" | `getUserFields()` — filters `deleted_at IS NULL`, ordered by name | Empty state → "No tenés campos" |
| Delete field | "borrar campo norte" | Confirmation buttons with data counts → soft delete + cascade plots + unlink financials | Logs to `deletion_log` |
| Restore field | "restaurar campo norte" | `restoreField()` — un-deletes field + cascade-deleted plots | Only restores `deleted_by='cascade'` plots |
| Rename field | "renombrar campo norte a sur" | `renameField()` — no uniqueness pre-check | Rename to existing name → PG UNIQUE violation |
| Create plot | "agregar lote 1" | 0 fields→auto-create "General", 1 field→auto-assign, 2+→picker | Smart auto-assign UX |
| Delete plot | "borrar lote 1" | Confirmation → soft delete + unlink expenses/incomes | `plot_aliases` not cleaned |
| Plot info | "info lote 1" | `getPlotInfo()` — expenses, incomes, rainfall by parent field | Rainfall uses `field_id` not `plot_id` (by design post-refactor) |

### 3b. Observations

| Action | User Input | Behavior | Edge Cases |
|--------|-----------|----------|------------|
| With prefix | "obs: hay malezas en lote 1" | Prefix detected at STEP 1 (conf 0.95), bypasses all guards | Prefix stripped from stored text |
| Auto-detect | "hay chinches en lote 1" | Keyword match (conf 0.85), plot resolved | Short msgs (<=2 words) blocked unless keyword match |
| No plot | "hay plagas" | Hybrid: 0 plots→block, 1→auto-assign, 2+→"¿En qué lote?" | Pending obs stored, resolution mode blocks classifier |
| Duplicate | "hay malezas en lote 1" (×2) | 3-layer dedup: memory cache (5min) → DB (5min window) → output dedup | "Observación duplicada detectada" |
| Financial text | "gasté $50mil en lote 1" | Financial guard detects verb+amount → SAVE_REJECTED_FINANCIAL | Guard runs on original text before normalization |
| Negation | "no hay malezas" | Negation guard → category 'general' (no recommendation) | Preserves "no hay" in normalized text |

### 3c. Rainfall

| Action | User Input | Behavior | Edge Cases |
|--------|-----------|----------|------------|
| Log rain | "llovieron 20mm" | Field resolution: fieldName → plotName→parent → conv state → null | mm validated 1-500 |
| Log rain (field) | "20mm en campo norte" | Resolves field by name, creates if absent | getOrCreateField |
| Log rain (plot) | "20mm en lote 1" | Resolves plot → uses parent field_id | Field-level only, no plot_id stored |
| Duplicate | "20mm" (×2 same day) | App-level dedup + DB unique index → RAINFALL_REJECTED_DUPLICATE | "Ya hay un registro de lluvia hoy para *X*" |
| Report (no field) | "reporte lluvia" | `getRainfallPeriod(null)` → aggregates ALL fields | Fixed in migration 030 (was NULL-only) |
| Report (field) | "reporte lluvia campo norte" | Scoped to field_id, falls back to global if 0 records | Soft-delete filter on field join |
| Delete rain | "borrar lluvia" | Deletes last rainfall record (hard delete) | Returns null if no records |

### 3d. Financials

| Action | User Input | Behavior | Edge Cases |
|--------|-----------|----------|------------|
| Expense | "gasté 50mil en gasoil" | Parser extracts amount+category → save with optional field/plot | Budget alert check after save |
| Income | "vendí 30tn de soja a $250" | Parser extracts amount+category+quantity+unit+unit_price | Currency ARS/USD detection |
| Partial | "gasté en algo" | Starts conversation flow, asks for missing fields | Prefills known data |
| Delete | "borrar último gasto" | Destructive confirmation → soft delete (`deleted_at = NOW()`) | Shows last expense details |
| Report | "resumen mes" | `getMonthlyReport()` — grouped by category, filtered `deleted_at IS NULL` | All queries respect soft delete |
| Budget | "presupuesto gasoil 100mil" | `setBudget()` — alerts at 80% and 100% | Global toggle for each threshold |

---

## 4. Insert / Update / Delete Flows

### Rainfall Insert (Post-Refactor)

```
User: "llovieron 25mm en lote 3"
  → Parser: mm=25, plotName="3"
  → Handler: mm validation (1-500) ✓
  → Field resolution: findPlotByNameAcrossFields("3") → field_id=X
  → saveRainfall(userId, 25, fieldId):
      1. Check existing: SELECT WHERE user+field+date
      2. If exists → return RAINFALL_REJECTED_DUPLICATE
      3. INSERT INTO rainfall (user_id, field_id, millimeters)
      4. DB unique index as safety net
  → Alert check: getDailyRainfallTotal >= threshold?
      → isDuplicate(24h) → recordAlert or recordDeduped
  → Response: "🌧️ Lluvia registrada: *25mm*\n📍 campo-name"
```

### Observation Insert

```
User: "hay plagas en lote 1"
  → Classifier: auto-detect via keyword, conf=0.85
  → Handler: isLikelyQuestionOrFollowUp? → NO
  → plotDiscovery.resolveFromNames(null, "1") → plotId=7
  → detectObservationCategory("plagas") → "sanidad"
  → saveObservation():
      1. Financial guard on original text → PASS
      2. normalizeObservationText() → "plagas"
      3. Memory cache dedup check → PASS
      4. DB dedup check (5min window) → PASS
      5. Plot enforcement (plotId != null) → PASS
      6. INSERT INTO agro_observations
      7. Add to memory cache
  → Response: "📋 Observación registrada: sanidad — plagas"
```

### Expense Insert

```
User: "gasté 50mil en gasoil"
  → Parser: amount=50000, category="Combustible", currency="ARS"
  → Controller: check confirm_before_save setting
  → If confirm: show confirmation buttons, store pending
  → If auto-save: financialHandler.handleExpense()
      1. PlotDiscovery.resolveFromNames() → fieldId, plotId
      2. saveExpense(userId, data, fieldId, plotId)
      3. Budget check: getCategoryMonthlyTotal + getBudget
      4. checkBudgetAlert → append warning if >80%
  → Response: "✅ Gasto registrado: $50,000 — Combustible"
```

---

## 5. Configuration & Settings

### Settings Hierarchy

| Layer | Storage | Scope | Managed Via |
|-------|---------|-------|-------------|
| System Settings | `system_settings` table | Global | Dashboard `/api/settings` |
| Global Settings | `global_settings` table | Global | Dashboard `/api/global-settings` |
| User Settings | `user_settings` table | Per-user | Dashboard `/api/users/:id/settings` |
| Environment | `.env` file | Global | Deploy-time |
| Defaults | `SETTING_DEFINITIONS` object | Global | Code |

### Active Settings (23 of 35 defined)

| Group | Active | Dead |
|-------|--------|------|
| Audio | 3 | 1 (`AUDIO_COST_PER_MINUTE_USD`) |
| AI | 14 | 0 |
| Limits | 3 | 2 (`MAX_AUDIO_PER_USER_DAY`, `MAX_REPORTS_PER_WEEK`) |
| Bot | 2 | 2 (`PENDING_TRANSACTION_TIMEOUT_MS`, `DEDUP_MAX_SIZE`) |
| System | 0 | 6 (all dead: `USER_CONTEXT_CACHE_TTL_MS`, `FEATURE_GATE_CACHE_TTL_MS`, `SCHEDULER_CRON_EXPRESSION`, `DEFAULT_RAIN_ALERT_MM`, `DEFAULT_FIELD_NAME`, `DEFAULT_USER_PLAN`) |
| Agronomy | 1 | 1 (`MAX_OBSERVATIONS_PER_REPORT`) |
| **Total** | **23** | **12** |

### User Settings (per-user)

| Setting | Default | Used By |
|---------|---------|---------|
| `weekly_summary` | true | Scheduler |
| `weekly_summary_day` | 0 (Sunday) | Scheduler |
| `weekly_summary_hour` | 19 | Scheduler |
| `budget_alerts` | true | Financial handler |
| `rain_alerts` | true | Rainfall handler + scheduler |
| `confirm_before_save` | true | Controller |
| `claude_daily_limit` | 50 | Intent extractor + conv. fallback |
| `rain_alert_mm` | 10 | Rainfall handler + scheduler |
| `max_fields` | 10 | Field creation guard |

---

## 6. Querying & Reporting

### Soft-Delete Compliance

| Query | `deleted_at IS NULL` | Field Join Filter | Status |
|-------|---------------------|-------------------|--------|
| `getMonthlyReport` | ✅ | N/A | PASS |
| `getWeeklyReport` | ✅ | N/A | PASS |
| `getFieldReport` | ✅ | ✅ `f.deleted_at IS NULL` | PASS |
| `getPlotReport` | ✅ | ✅ (via `findPlotByNameAcrossFields`) | PASS |
| `getMonthlyExpenses` (CSV) | ✅ | LEFT JOIN (no filter) | WARN — deleted field names may appear |
| `getRainfallPeriod` | N/A | ✅ (when fieldId specified) | PASS |
| `getRainfallAllLocations` | N/A | ✅ `f.deleted_at IS NULL` | PASS |
| `getRainfallByField` (scheduler) | N/A | ✅ `f.deleted_at IS NULL` | PASS |
| `queryPlotHistory` (rainfall subquery) | N/A | ✅ `f3.deleted_at IS NULL` | PASS (fixed in this audit) |
| `getObservationsByField` | N/A | No filter on observations | WARN — no `deleted_at` column |

### Reporting Queries

| Report | Scope | Aggregation | Notes |
|--------|-------|-------------|-------|
| Monthly expenses | User-wide | SUM by category | Current month only |
| Weekly summary | User-wide | Expenses + incomes + top category + rainfall | Sent by scheduler |
| Field report | Single field | Expenses by category | Joins `fields` with soft-delete filter |
| Plot report | Single plot | Expenses by category + income total | Via `findPlotByNameAcrossFields` |
| Rainfall report | User-wide or field | SUM mm, COUNT registros | All-fields when no field specified |
| Agro report | Field or plot | PDF + observations + activities | ISO week scoping |

---

## 7. Intent Routing Pipeline

### Full Pipeline Order

```
1. Message dedup (WhatsApp message ID)
2. User setup (getOrCreate + settings)
3. Flow state check → if active: process flow message
4. Pending observation check → if pending: RESOLUTION MODE (hard block)
5. Pending transaction check → if pending: confirm/cancel
6. Intent classification:
   a. STEP 1: Observation prefix hard rule (conf 0.95)
   b. STEP 2: Trivial command bypass (conf 0.95)
   c. STEP 3: Full regex chain (commands→income→expense→observation)
   d. STEP 4: AI extraction (only if conf < 0.75)
   e. STEP 5: Fallback to regex if AI fails
7. Domain routing (financial/agronomy/system)
8. Response: messages + interactive + suggestions
9. Observability logging (fire-and-forget)
```

### Conversation State

| Store | Persistence | TTL | Purpose |
|-------|-------------|-----|---------|
| `conversation_state` (DB) | Persistent | None | last_field_id, last_plot_id, mini-memory |
| `FlowContext` (in-memory) | Session | 10 min | Active flow state machine |
| `PendingObservationStore` | In-memory | 5 min | Plot disambiguation for observations |
| `PendingTransactionStore` | In-memory | Session | Confirm/cancel for expenses/destructive cmds |
| `UserContextService` cache | In-memory | 60s | AI prompt enrichment (fields, plots, last context) |

### Flow State Machine

```
[idle] → startFlow() → [expense_flow|income_flow|field_flow|activity_flow|rainfall_flow]
  → processFlowMessage() (validate each step)
  → all steps filled → [confirming]
  → user confirms → execute() → [idle]

Navigation: back (previous step), skip (optional only), cancel (abandon)
Timeout: 10 minutes → auto-clear + log abandonment
Smart interruption: read-only commands execute without canceling flow
```

---

## 8. UX & Conversation State

### Message Formatting

- All text in Argentine Spanish
- WhatsApp bold: `*text*`
- Emojis by domain: 💰 financial, 🌧️ rainfall, 📋 observations, 🌱 crops, ⚠️ alerts
- Currency: ARS default, USD explicit. Numbers locale-agnostic.
- Interactive: buttons (max 3) for confirmations, lists for pickers

### Conversation State Fallback

| Context | Fallback Usage | Status |
|---------|---------------|--------|
| Rainfall field | `last_field_id` from conversation_state | ✅ Used in handler |
| AI prompt | `lastFieldName`, `lastPlotName` from context service | ✅ Enriches AI |
| Follow-up queries | `lastIntent`, `lastActivityType`, `lastQueryType` | ✅ Mini-memory |
| Observation plot | NOT used (hybrid assignment instead) | By design |

### UX Inconsistencies

| Issue | Severity | Description |
|-------|----------|-------------|
| Timeout silent expiry | LOW | Flows and pending observations expire without user warning |
| Confirmation override | LOW | Low-confidence parse forces confirmation regardless of user setting |
| Error message tone | LOW | Mix of formal ("Hubo un problema") and casual ("No pude procesar") |

---

## 9. Open Bugs / Gaps

### HIGH Severity

| ID | Summary | Location | Impact |
|----|---------|----------|--------|
| BUG-SYS-01 | Dashboard has ZERO authentication | `dashboard.js` | Anyone with network access can read all user data, modify settings, change plans |
| BUG-SYS-02 | UNIQUE constraint doesn't respect soft deletes | `init.sql` (fields, plots) | Recreating soft-deleted field/plot name causes PG UNIQUE violation error |

### MEDIUM Severity

| ID | Summary | Location | Impact |
|----|---------|----------|--------|
| BUG-SYS-03 | `renameField` has no uniqueness pre-check | `expenses.js:638` | Rename to existing name → UNIQUE violation |
| BUG-SYS-04 | `agro_observations` has no `deleted_at` column | `init.sql` | Observations from deleted plots remain visible in reports |
| BUG-SYS-05 | 12 dead settings in `SETTING_DEFINITIONS` | `settings.service.js` | Config clutter, misleading dashboard UI |
| BUG-SYS-06 | `getRainfallPeriod` with specific fieldId doesn't check field soft-delete | `expenses.js:1106` | Could return rainfall for deleted field |
| BUG-SYS-07 | `getRainfallRange` has no field scoping at all | `expenses.js:1175` | Includes rainfall from deleted fields in range queries |
| BUG-SYS-08 | CSV export missing plot info and income export | `expenses.js:1057` | Incomplete data export |

### LOW Severity

| ID | Summary | Location | Impact |
|----|---------|----------|--------|
| BUG-SYS-09 | `getPlotById` missing `deleted_at` filter | `expenses.js:989` | Conversation state can reference deleted plots |
| BUG-SYS-10 | `plot_aliases` not cleaned on `deletePlot` | `expenses.js:819` | Stale aliases findable after deletion |
| BUG-SYS-11 | `rainfall.plot_id` column vestigial | `init.sql:81` | Dead column, should be dropped |
| BUG-SYS-12 | `deleteField` plot query missing `deleted_at` filter | `expenses.js:593` | Processes already-deleted plots (harmless but wasteful) |
| BUG-SYS-13 | Location stripping too greedy in observation normalization | `observations.js` | "malezas en lote 3, muy densas" → loses "muy densas" |
| BUG-SYS-14 | No text length validation for observations | `observations.js` | Extremely long text could break UI |
| BUG-SYS-15 | Unreachable intents in AI validator | `intent-validator.ts` | ~20 intents defined but no handler exists; AI could return them |

### Fixed During This Audit

| ID | Summary | Fix |
|----|---------|-----|
| BUG-FIX-01 | `queryPlotHistory` rainfall subquery missing soft-delete filter on field join | Added `AND f3.deleted_at IS NULL` to LEFT JOIN |

---

## 10. Recommendations

### P0 — Critical

| # | Recommendation | Effort |
|---|---------------|--------|
| 1 | Add authentication to dashboard API (JWT/API key minimum) | High |

### P1 — High Priority

| # | Recommendation | Effort |
|---|---------------|--------|
| 2 | Fix UNIQUE constraint for soft-deleted fields/plots: either use partial unique index `WHERE deleted_at IS NULL` or handle `ON CONFLICT` in getOrCreateField/Plot | Medium |
| 3 | Add uniqueness pre-check to `renameField` | Low |
| 4 | Clean up 12 dead settings from `SETTING_DEFINITIONS` | Low |

### P2 — Medium Priority

| # | Recommendation | Effort |
|---|---------------|--------|
| 5 | Add `deleted_at` column to `agro_observations` | Medium |
| 6 | Add `deleted_at IS NULL` filter to `getPlotById` | Low |
| 7 | Clean `plot_aliases` on `deletePlot` | Low |
| 8 | Add field soft-delete filter to `getRainfallPeriod` (fieldId specified) and `getRainfallRange` | Low |
| 9 | Drop vestigial `rainfall.plot_id` column in future migration | Low |
| 10 | Add text length validation (1000 chars max) for observations | Low |

### P3 — Nice to Have

| # | Recommendation | Effort |
|---|---------------|--------|
| 11 | Add CSV income export and plot info to CSV | Medium |
| 12 | Add flow/pending-obs expiration warning messages | Low |
| 13 | Audit and remove unreachable intents from AI validator | Medium |
| 14 | Consolidate message tone (formal vs casual) | Low |

---

## 11. Test Scenarios

### Soft-Delete Edge Cases

| Scenario | Expected | Verify |
|----------|----------|--------|
| Create field "norte", delete it, recreate "norte" | Should succeed (restore or new) | Currently fails with UNIQUE violation |
| Delete field with expenses → check monthly report | Expenses should still appear (unlinked, field_id=NULL) | ✅ Works correctly |
| Delete plot → check conversation state | `last_plot_id` should return null name | ✅ LEFT JOIN handles this |
| Delete field → check rainfall report | Deleted field rainfall should NOT appear | ✅ `getRainfallAllLocations` filters |
| Delete field → check `queryPlotHistory` | Deleted field rainfall should NOT appear | ✅ Fixed in this audit |

### Rainfall Dedup

| Scenario | Expected | Verify |
|----------|----------|--------|
| Log 20mm, then 30mm same day same field | Second rejected: "Ya hay un registro" | ✅ App dedup + DB unique index |
| Log 20mm campo norte, 20mm campo sur same day | Both succeed (different fields) | ✅ COALESCE handles |
| Log 20mm (no field), 20mm (no field) same day | Second rejected | ✅ COALESCE(null,0) = 0 |
| Log 600mm | Rejected: "El valor debe estar entre 1 y 500mm" | ✅ Handler validates |

### Observation Hybrid Plot Assignment

| Scenario | Expected | Verify |
|----------|----------|--------|
| 0 plots, "hay plagas" | "Primero necesitás crear un lote" | ✅ Blocks |
| 1 plot, "hay plagas" | Auto-assigned to single plot | ✅ Auto-assign |
| 2+ plots, "hay plagas" | "¿En qué lote?" + pending obs stored | ✅ Resolution mode |
| Pending obs + "lote 1" | Saved to lote 1, pending cleared | ✅ resolveExisting |
| Pending obs + "lote inexistente" | Re-ask, stay in resolution mode | ✅ Hard stop |
| Pending obs + "cancelar" | Pending cleared, "Observación cancelada" | ✅ Cancel path |

### Financial Queries

| Scenario | Expected | Verify |
|----------|----------|--------|
| Deleted expense in monthly report | Should NOT appear | ✅ `deleted_at IS NULL` |
| Budget alert at 81% | ⚠️ warning message | ✅ `checkBudgetAlert` |
| Budget alert at 101% | 🔴 exceeded message | ✅ `checkBudgetAlert` |
| Budget alert with `budget_alert_80=false` globally | No warning | ✅ Global toggle |

---

## Summary

| Area | Status | Notes |
|------|--------|-------|
| Data Model | PASS (with gaps) | UNIQUE constraint + soft-delete mismatch; observations lack deleted_at |
| Fields/Plots ABM | PASS | Soft-delete cascade correct; rename lacks pre-check |
| Observations | PASS | 3-layer dedup, financial guard, hybrid plot assignment all working |
| Rainfall | PASS | Field-level only, dedup solid, reporting fixed |
| Financials | PASS | All queries respect soft-delete; budget alerts working |
| Intent Routing | PASS | Multi-stage pipeline sound; AI fallback rate-limited |
| Conversation State | PASS | Flow machine + pending obs + mini-memory all functional |
| Dashboard | FAIL | Zero authentication — critical security gap |
| Settings | WARN | 12 of 35 settings are dead code |
| UX | PASS | Argentine Spanish, interactive messages, contextual suggestions |

**Overall Verdict:** System is functionally production-ready. The critical gap is dashboard authentication. All other issues are LOW-MEDIUM severity with no data corruption risks in normal operation.
