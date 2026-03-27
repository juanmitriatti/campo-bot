# Financial-Lote Traceability Audit

**Date:** 2026-03-26
**Scope:** Verify ALL production-related financial data (expenses + income) is correctly associated to plots (lotes), not only to fields (campos).
**Verdict:** **FAIL** — 6 issues found, 1 CRITICAL, 4 HIGH, 1 MEDIUM

---

## Test Environment

- Docker: campo-bot-app + campo-bot-db
- User: qa-audit@test.com (id=6, plan=pro_plus)
- Clean state: full reset before each test run
- Setup: 1 campo (Norte/Pergamino), 2 lotes (1=100ha, 2=50ha)

---

## Phase 1: Setup — PASS

All entities created correctly.

```
Fields: id=76 | name=norte | city=Pergamino
Plots:  id=63 | name=1 | area=100 | field=norte
        id=64 | name=2 | area=50  | field=norte
```

---

## Phase 2: Expense Tests — PARTIAL PASS

### Test EXP-1: "gaste 10000 en fertilizante en lote 1"

| Field | Expected | Actual | Status |
|-------|----------|--------|--------|
| amount | 10000 | 10000 | PASS |
| category | Fertilizantes | Fertilizantes | PASS |
| field_id | 76 | 76 | PASS |
| plot_id | 63 (lote 1) | 63 (lote 1) | PASS |

### Test EXP-2: "gaste 5000 en siembra en lote 2"

| Field | Expected | Actual | Status |
|-------|----------|--------|--------|
| amount | 5000 | 5000 | PASS |
| category | Semillas | Semillas | PASS |
| field_id | 76 | 76 | PASS |
| plot_id | 64 (lote 2) | 64 (lote 2) | PASS |

### Test EXP-3: "aplique herbicida por 3000 en lote 1"

| Field | Expected | Actual | Status |
|-------|----------|--------|--------|
| Routed to | expense ($3000) | agro activity (spraying 3000ml) | **FAIL** |

**Finding:** "aplique herbicida por 3000" triggers the agro domain (`log_spraying`) not the financial domain. The "3000" is interpreted as 3000ml of product, not $3000 expense. The intent classifier prioritizes agro patterns ("aplique/herbicida/fumig") over financial parsing.

**DB Evidence:**
```
domain_events: id=8 | event_type=spraying | product=herbicida | quantity=3000 | unit=ml | plot_id=63
expenses: NO record for this input
```

**Impact:** User intended a $3000 expense but got a 3000ml activity logged. Financial data is lost.

### Expense DB Truth:

```
expenses: id=15 | $10,000 | Fertilizantes | plot_id=63 (lote 1) | field_id=76
expenses: id=16 | $5,000  | Semillas      | plot_id=64 (lote 2) | field_id=76
```

**All saved expenses have correct plot_id.** The plot association works via `PlotDiscoveryService.resolve()` which calls `detectarLote()` to extract "lote X" from the raw text.

---

## Phase 3: Income Tests — PASS

### Test INC-1: "vendi 30 toneladas de soja del lote 1 a 300 usd"

| Field | Expected | Actual | Status |
|-------|----------|--------|--------|
| amount | 9000 | 9000 | PASS |
| category | Soja | Soja | PASS |
| currency | USD | USD | PASS |
| plot_id | 63 (lote 1) | 63 (lote 1) | PASS |
| field_id | 76 | 76 | PASS |

### Test INC-2: "vendi 10 toneladas de maiz del lote 2 a 200 usd"

| Field | Expected | Actual | Status |
|-------|----------|--------|--------|
| amount | 2000 | 2000 | PASS |
| category | Maiz | Maiz | PASS |
| currency | USD | USD | PASS |
| plot_id | 64 (lote 2) | 64 (lote 2) | PASS |
| field_id | 76 | 76 | PASS |

**Income IS associated with lotes when "del lote X" is explicitly stated.** The `detectarLote()` function captures "del lote 1" and "del lote 2" from the text.

### Income DB Truth:

```
incomes: id=4 | $9,000 | Soja | USD | plot_id=63 (lote 1) | field_id=76
incomes: id=5 | $2,000 | Maiz | USD | plot_id=64 (lote 2) | field_id=76
```

---

## Phase 4: Missing Lote Test — FAIL

### Test MISS-1: "gaste 2000 en fertilizante" (no lote mentioned)

| Expected | Actual | Status |
|----------|--------|--------|
| System asks "¿En qué lote?" | Shows "Campo: General" with confirm prompt | **CRITICAL FAIL** |

**Response:**
```
💸 ¿Confirmo gasto?
Categoría: *Fertilizantes*
Monto: *$2.000*
Campo: General

Responder *SI* para confirmar o *NO* para cancelar.
```

**Root Cause:** When no lote is detected in text, `PlotDiscoveryService.resolve()` returns `plotId: null, fieldId: null`. The handler builds the confirmation with "Campo: General" and does NOT ask for lote selection.

**Code Path:**
1. `parseMensaje("gaste 2000 en fertilizante")` returns `{ amount: 2000, category: "Fertilizantes" }` — no plotName
2. `handleExpense()` calls `this.service.resolveField(userId, text)` → `PlotDiscoveryService.resolve()`
3. `detectarLote("gaste 2000 en fertilizante")` returns `null` (no "lote" keyword in text)
4. `resolveFromNames(userId, null, null)` falls to conversation state → returns `{ fieldId: null, plotId: null }`
5. Handler builds confirmation with `buildPendingMessage('expense', data, null, null)` → "Campo: General"
6. If user confirms, `saveExpense(userId, data, null, null)` stores with `plot_id = NULL`

**Impact:** Expenses saved without plot_id when user doesn't explicitly mention lote. Breaks per-lote financial reporting.

### Same behavior for income without lote:

**Input:** "vendi 5 toneladas de soja a 300 usd"
**Response:** "Campo: General" — no lote asked
**Would store:** `plot_id = NULL, field_id = NULL`

---

## Phase 5: Campo Aggregation — PARTIAL PASS

### Test AGG-1: "cuanto gaste en el campo Norte"

| Expected | Actual | Status |
|----------|--------|--------|
| Aggregated total: $15,000 (sum of both lotes) | $15,000 | PASS (value correct) |
| Filtered to campo Norte only | Shows ALL user expenses | **HIGH CONCERN** |
| No new expense created | No new expense | PASS |

**Note:** The response shows the monthly report for ALL user expenses, which happens to equal the campo Norte total (since there's only 1 campo). This query does NOT actually filter by campo — it routes to `monthly_report` which shows all expenses regardless of field.

---

## Phase 6: Plot-Level Queries — MIXED

### Test Q-1: "cuanto gaste en lote 1"

| Expected | Actual | Status |
|----------|--------|--------|
| $10,000 (Fertilizantes only) | $15,000 (ALL expenses) | **FAIL** |

**Root Cause:** "cuanto gaste en lote 1" routes to `monthly_report` (generic, no lote filter), not to `plot_report` (lote-specific).

### Test Q-2: "resultado lote 1" (plot_result command)

| Expected | Actual | Status |
|----------|--------|--------|
| Gastos: $10,000 | Gastos: $10,000 | PASS |
| Ingresos: $9,000 | Ingresos: $9,000 | PASS |
| Resultado: -$1,000 | Resultado: -$1,000 | PASS |
| Margen: -11% | Margen: -11% | PASS |

### Test Q-3: "resultado lote 2" (plot_result command)

| Expected | Actual | Status |
|----------|--------|--------|
| Gastos: $5,000 | Gastos: $5,000 | PASS |
| Ingresos: $2,000 | Ingresos: $2,000 | PASS |
| Resultado: -$3,000 | Resultado: -$3,000 | PASS |
| Margen: -150% | Margen: -150% | PASS |

### Test Q-4: "resumen lote 1" (plot_report command)

| Expected | Actual | Status |
|----------|--------|--------|
| Fertilizantes: $10,000 | Fertilizantes: $10,000 | PASS |
| Total gastos: $10,000 | $10,000 | PASS |
| Ingresos: $9,000 | $9,000 | PASS |

**Conclusion:** Plot-level financial data IS correctly scoped when using `plot_report` or `plot_result` commands ("resumen lote X", "resultado lote X"). But the natural language "cuanto gaste en lote X" does NOT filter by lote.

---

## Phase 7: Campo-Wide Expense — PASS

### Test MIX-1: "fumigue todo el campo por 10000"

**Response:** "No pude identificar el lote. Escribí algo como: Pulverización en el *lote 3*"

The agro domain correctly requires lote specification. However, this routes to agro (spraying), not financial. A pure financial campo-wide expense like "gaste 10000 en todo el campo" would face the missing-lote issue from Phase 4.

---

## Phase 8: Final DB Truth Check

```
=== ALL EXPENSES ===
id=15 | $10,000 | Fertilizantes | plot=1 | field=norte | plot_status=✅
id=16 | $5,000  | Semillas      | plot=2 | field=norte | plot_status=✅

=== ALL INCOMES ===
id=4 | $9,000 | Soja | USD | plot=1 | field=norte | plot_status=✅
id=5 | $2,000 | Maiz | USD | plot=2 | field=norte | plot_status=✅

Expenses without plot_id: 0
Incomes without plot_id: 0
Total financial records without plot_id: 0
```

**All SAVED records have correct plot_id.** The traceability is 100% for records that were saved. The issue is that the system ALLOWS saving without plot_id when lote is not mentioned.

---

## Issues Summary

### [CRITICAL] ISS-FT-01: No lote prompt when financial data lacks plot reference

**Failing step:** Phase 4 — "gaste 2000 en fertilizante" (no lote)
**Expected:** System asks "¿En qué lote?" (similar to observation hybrid guard)
**Actual:** Confirms with "Campo: General", would save with plot_id=NULL
**Impact:** Silent data loss — expenses/incomes saved without lote association, invisible in per-lote reports
**Root cause:** `handleExpense()`/`handleIncome()` do not check for null plotId and prompt user. Unlike observation handler which has hybrid guard (0 plots→block, 1 plot→auto-assign, 2+→ask), financial handlers have no equivalent guard.
**Fix:** Add hybrid plot guard to `handleExpense()` and `handleIncome()` — mirror the observation handler's logic: 0 plots→save without, 1 plot→auto-assign, 2+ plots→ask "¿En qué lote?"

### [HIGH] ISS-FT-02: "cuanto gaste en lote X" shows ALL expenses, not filtered

**Failing step:** Phase 6 — "cuanto gaste en lote 1" shows $15,000 (all) instead of $10,000 (lote 1)
**Expected:** Filtered to lote 1 expenses only
**Actual:** Routes to `monthly_report` (all expenses), ignores "lote 1" in text
**Root cause:** No parser pattern for "cuanto gaste en lote X". The "cuanto gaste" patterns match `_cuanto_gaste` or `monthly_report`, neither of which accepts lote filtering.
**Fix:** Add parser pattern: `/cuanto\s+(?:gaste|llevo)\s+(?:en\s+)?(?:el\s+)?lote\s+(\w+)/` → `plot_report`

### [HIGH] ISS-FT-03: "aplique herbicida por 3000" routes to agro, not expense

**Failing step:** Phase 2 — "aplique herbicida por 3000 en lote 1" saved as spraying activity (3000ml), not $3000 expense
**Expected:** $3000 expense in Agroquímicos category
**Actual:** domain_event with event_type=spraying, quantity=3000, unit=ml
**Root cause:** Intent classifier prioritizes agro patterns. "aplique" + "herbicida" triggers `log_spraying` before financial parsing. The "3000" is captured as product quantity, not monetary amount.
**Impact:** Financial data lost — user intended expense, got activity log
**Fix:** Ambiguous — requires either: (a) explicit "$" or "pesos" to distinguish financial from agro, or (b) confirmation: "¿Querés registrar un gasto de $3000 o una aplicación de 3000ml?"

### [HIGH] ISS-FT-04: Income without "del lote X" gets no plot association

**Failing step:** Phase 4 follow-up — "vendi 5 toneladas de soja a 300 usd" → "Campo: General"
**Expected:** System asks "¿En qué lote?"
**Actual:** Confirms with plot_id=NULL
**Note:** Income WITH "del lote X" DOES work correctly (Phase 3 proved this). The gap is only when lote is omitted.
**Root cause:** Same as ISS-FT-01 — no hybrid plot guard in `handleIncome()`

### [HIGH] ISS-FT-05: "cuanto gaste en campo Norte" does not filter by campo

**Failing step:** Phase 5 — shows monthly_report for ALL user expenses, not filtered to campo Norte
**Expected:** Aggregated expenses WHERE field_id = campo Norte's ID
**Actual:** Shows all expenses regardless of field
**Root cause:** "cuanto gaste en campo Norte" matches generic `monthly_report`, which aggregates all user expenses. No campo-filtered expense query exists.
**Fix:** Add campo-filtered expense query: `/cuanto\s+gaste\s+(?:en\s+)?(?:el\s+)?campo\s+(\w+)/` → new `field_report` command

### [MEDIUM] ISS-FT-06: No campo-wide expense distribution across lotes

**Failing step:** Phase 7 context — no mechanism to split a campo-level cost across lotes by hectares
**Expected:** "gaste 10000 en arrendamiento del campo" → distribute $6,666 to lote 1 (100ha) + $3,333 to lote 2 (50ha)
**Actual:** Would save with plot_id=NULL (not tested because of ISS-FT-01)
**Fix:** Future feature — add `distribute_expense` command or auto-distribute option in expense flow

---

## Architecture Analysis

### How Plot Association Works (Current)

```
User message → IntentClassifier → ParseResult
                                    ↓
                              handleExpense(userId, data, text)
                                    ↓
                              resolveField(userId, text)
                                    ↓
                              PlotDiscoveryService.resolve(userId, text)
                                    ↓
                              detectarLote(text) → "lote X" or null
                                    ↓
                              resolveFromNames(userId, campoName, plotName)
                                    ↓
                              Returns { fieldId, plotId } or { null, null }
                                    ↓
                              saveExpense(userId, data, fieldId, plotId)
```

**Key insight:** The parsers (`parseMensaje`, `parseMensajeIngreso`) do NOT extract plot references. Plot association happens AFTER parsing, in the handler layer via `PlotDiscoveryService.resolve()`. This means:
- If `detectarLote()` finds "lote X" in the text → plot_id is set correctly
- If no "lote" keyword → plotId=null → saved without plot association
- There is NO guard to catch the null case and ask the user

### Comparison with Observation System

The observation system has a mature hybrid guard:
```
log_observation handler:
  1. resolveFromNames() → plotId
  2. IF plotId is null:
     a. findAllUserPlots(userId)
     b. 0 plots → block ("Primero necesitás crear un lote")
     c. 1 plot → auto-assign
     d. 2+ plots → ask "¿En qué lote?" + setPendingObservation
  3. Save with guaranteed plotId
```

The financial handlers lack this guard entirely.

---

## Verdict

### FAIL — Financial-lote traceability is NOT guaranteed

**What works:**
- Expenses with explicit "en lote X" → plot_id correctly saved
- Incomes with explicit "del lote X" → plot_id correctly saved
- `plot_report` and `plot_result` commands → correctly filter by plot_id
- 100% of SAVED records in this test have correct plot_id

**What fails:**
- Expenses/incomes without explicit lote reference → saved with plot_id=NULL
- System NEVER asks "¿En qué lote?" for financial data (unlike observations)
- "cuanto gaste en lote X" natural language query ignores lote filter
- "cuanto gaste en campo X" query ignores campo filter
- Ambiguous agro/financial inputs misrouted (herbicida expense → spraying activity)

### The Rule Violations

| Rule | Status |
|------|--------|
| IF it affects production → MUST belong to lote | **VIOLATED** — financial data can be saved without lote |
| System MUST ask "¿En qué lote?" when missing | **VIOLATED** — silently defaults to "General" |
| No income without plot_id | **VIOLATED** — income without "del lote X" gets null |
| No expense without plot_id | **VIOLATED** — expense without "en lote X" gets null |
| Aggregations correct | **PARTIAL** — plot-level commands work, but natural queries don't filter |
| Campo = grouping entity only | **VIOLATED** — campo used as primary when lote omitted |
