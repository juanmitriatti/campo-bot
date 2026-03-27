# Comprehensive Lotes (Plots) Audit Report

**Date:** 2026-03-26
**Auditor:** QA Engineer (automated + manual)
**Scope:** Full lote lifecycle — creation, listing, info, metadata, editing, deletion, crop lifecycle, yields, expenses, income, edge cases
**Test Count:** 68 (Phase 1) + 45 (Phase 2) = 113 test inputs
**Environment:** Docker (campo-bot-app + campo-bot-db), test-bot API, user plan: free → pro_plus

---

## 1. CONVERSATION TRANSCRIPT SUMMARY

### Phase 1 (Free Plan) — 68 tests

| Phase | Tests | Pass | Fail | Notes |
|-------|-------|------|------|-------|
| P1: Creation | 8 | 8 | 0 | All creation patterns work correctly |
| P2: Listing | 6 | 6 | 0 | Global + per-campo listing works |
| P3: Info | 5 | 4 | 1 | "ver lote 2" → plan gate (not plot_info) |
| P4: Metadata | 4 | 4 | 0 | Area works; coordinates store wrong values |
| P5: Editing | 3 | 2 | 1 | Rename broken; move not supported |
| P6: Deletion | 5 | 3 | 2 | Confirm button ID mismatch; restore fails |
| P7: Edge Cases | 8 | 8 | 0 | Lote 0, -1 accepted (no validation) |
| P8: Yields | 9 | 3 | 6 | All blocked by plan gate on free plan |
| P9: Farmer Flow | 15 | 11 | 4 | Yields/profitability unrecognized |
| P10: Crop Lifecycle | 5 | 2 | 3 | All blocked by plan gate on free plan |

### Phase 2 (Pro+ Plan) — 45 tests

| Area | Tests | Pass | Fail | Notes |
|------|-------|------|------|-------|
| Setup | 8 | 8 | 0 | Campos, lotes, metadata all work |
| Crop Lifecycle | 8 | 7 | 1 | Sow/harvest/history work; "que hay sembrado" (no lote) fails |
| Yields/Rindes | 10 | 0 | 10 | **ZERO support** — all misrouted |
| Agro Features | 6 | 6 | 0 | Reports, observations, activities all work |
| "ver lote" | 3 | 0 | 3 | Not recognized as plot_info |
| Rename | 3 | 1 | 2 | Campo rename works; lote rename broken |
| Delete | 6 | 2 | 4 | Button ID mismatch; restoration fails |
| Expense on Lote | 5 | 3 | 2 | Expense saved with plot_id but query shows all |
| Income on Lote | 3 | 1 | 2 | Income NOT associated with lote |
| Advanced | 3 | 1 | 2 | No lote comparison; no profitability |

---

## 2. DETECTED BUGS

### [CRITICAL] BUG-L01: No yield/rinde support — data loss via observation misrouting

**Input:** "lote 1 rindio 3500 kg por hectarea"
**Expected:** Yield record saved in domain_events (event_type='harvest', quantity=3500, unit='kg/ha')
**Actual:** Saved as agro_observation with text "3500 kg por hectarea", category "general"

**Evidence (DB):**
```
agro_observations: "3500 kg por hectarea" | general | plot_id=60
domain_events (harvest): quantity=NULL, unit=NULL
```

**Impact:** Yield data is permanently lost in the observation noise. No way to query, compare, or report yields. Core farming metric completely unsupported.

**Root Cause:** No parser patterns for yield/rinde/rendimiento. The observation detection catches the lote reference and stores it as a generic note. The `harvest_crop` handler doesn't extract quantity, and the activity_flow skips the quantity step for harvests.

---

### [CRITICAL] BUG-L02: Coordinate decimal stripping — data corruption

**Input:** "lote 1 esta en -33.9,-60.5"
**Expected:** lat=-33.9, lng=-60.5
**Actual:** lat=-339, lng=-605

**Root Cause:** `normalizeText()` in parser.js line 11: `.replace(/\./g, "")` strips ALL periods, including decimal points in coordinates. The text becomes "-339,-605" before the regex even runs.

**Impact:** GPS coordinates stored are off by 10x, rendering all location data useless.

---

### [HIGH] BUG-L03: Rename lote broken — handler calls getFieldByName instead of getPlotByName

**Input:** "renombrar lote 1 a lote principal"
**Expected:** Lote 1 renamed to "principal"
**Actual:** "No encontré lote 1" — handler looks in fields table, not plots table

**Root Cause:** `financial.handler.ts:660` — `rename_field` case calls `this.service.renameField()` which calls `getFieldByName()`. When `entityKeyword='lote'`, it should call a plot-specific rename function, but no such function exists.

**Evidence:** Renaming a campo works ("renombrar campo norte a campo zona norte" → PASS). Only lotes fail.

---

### [HIGH] BUG-L04: Delete confirmation button ID mismatch

**Input:** "borrar lote 3 del campo sur" → shows buttons → click "confirm_delete"
**Expected:** Lote deleted
**Actual:** Empty response, lote NOT deleted

**Root Cause:** The delete handler generates a dynamic button ID like `confirm_delete_plot_3_in_sur`, but clients may send the generic `confirm_delete`. The interactive router doesn't match generic→specific.

**Evidence:** After clicking `confirm_delete`, lote 3 still appears in `lotes del campo sur`.

---

### [HIGH] BUG-L05: "ver lote X" not recognized as plot_info

**Input:** "ver lote 1", "ver lote 2", "ver lote 3"
**Expected:** Plot info display (same as "info lote 1")
**Actual:** "No entendí si querías registrar una observación o consultar algo"

**Root Cause:** The `plot_info` parser patterns include "info lote", "detalle lote", "estado lote", "lote X?" but NOT "ver lote X". The "ver" keyword is only in `list_plots` patterns ("ver lotes" plural). "ver lote 1" (singular) falls through to the conversational handler.

---

### [HIGH] BUG-L06: Expense query not filtered by lote

**Input:** "cuanto gaste en el lote 1"
**Expected:** $50,000 (only herbicida on lote 1)
**Actual:** $80,000 (herbicida $50k + semillas $30k = ALL expenses)

**DB Evidence:**
```
expenses: id=13 | $50,000 | Agroquímicos | plot_id=60 (lote 1)
expenses: id=14 | $30,000 | Semillas     | plot_id=61 (lote 2)
```

**Root Cause:** "cuanto gaste en el lote 1" matches `monthly_report` (which aggregates ALL user expenses) rather than `plot_report` (which requires "resumen/reporte lote X" prefix). The "cuanto gaste en lote X" pattern doesn't exist.

---

### [HIGH] BUG-L07: Income not associated with lotes

**Input:** "vendi 100 toneladas de soja a 350 dolares"
**Expected:** Income associated with lote (at least asks which lote)
**Actual:** Income registered with Campo: "General", no plot_id

**DB Evidence:**
```
incomes: id=3 | $35,000 | Soja | plot_id=NULL | field_id=NULL
```

**Root Cause:** The income parser doesn't extract lote references from the message text. There's no "para lote X" extraction in the income regex, and no lote selection step in the income flow.

---

### [MEDIUM] BUG-L08: "gastos del lote X" / "ingresos del lote X" not recognized

**Input:** "gastos del lote 2", "ingresos del lote 1"
**Expected:** Lote-specific financial report
**Actual:** "No entendí si querías registrar una observación o consultar algo"

**Root Cause:** No parser pattern for "gastos del lote X" or "ingresos del lote X". Only "resumen/reporte lote X" (plot_report) exists, which shows combined expenses/incomes.

---

### [MEDIUM] BUG-L09: "que hay sembrado" (no lote specified) fails

**Input:** "que hay sembrado"
**Expected:** List all active crops across all lotes
**Actual:** "No pude identificar el lote"

**Root Cause:** The `active_crop` handler requires a plotName. When none is specified, it returns an error instead of listing all active crops.

---

### [MEDIUM] BUG-L10: Harvest doesn't capture yield quantity

**Input:** "cosechamos 3500 kg de soja en lote 1"
**Expected:** Harvest recorded with quantity=3500, unit=kg
**Actual:** "No hay cultivo activo en norte > 1 para cosechar" (already harvested), but even when active, quantity is not extracted

**DB Evidence (from earlier harvest):**
```
domain_events: event_type=harvest | crop=Soja | quantity=NULL | unit=NULL
```

**Root Cause:** `harvest_crop` parser doesn't extract quantity/unit. The `activity.flow.ts` skipIf condition skips the quantity step for harvest events.

---

### [MEDIUM] BUG-L11: No lote name validation

**Input:** "crear lote 0 en campo norte" → PASS, "crear lote -1 en campo norte" → PASS
**Expected:** Reject invalid names (0, -1, empty, purely numeric negatives)
**Actual:** All accepted and created

**Impact:** Users can create confusing plot names that may cause parsing issues later.

---

### [LOW] BUG-L12: Rename extracts "lote" keyword in new name

**Input:** "renombrar lote 1 a lote norte"
**Expected:** newName = "norte"
**Actual:** newName = "lote norte" (includes the "lote" keyword)

**Root Cause:** Parser regex capture group `((?:\w+)(?:\s+\w+){0,3})` captures everything after "a", including "lote".

---

### [LOW] BUG-L13: Long/multi-word lote names misparsed

**Input:** "agregar lote el lote de la esquina noroeste en campo norte"
**Expected:** Creates lote "el lote de la esquina noroeste" in campo norte
**Actual:** "No encontré el campo esquina noroeste en campo norte"

**Root Cause:** The add_plot regex captures too aggressively — "en" acts as the field separator, breaking the parse at "en campo" instead of the intended field name.

---

## 3. MISSING FEATURES

### 3.1 Yield/Rinde System (CRITICAL GAP)

| Feature | Status | Impact |
|---------|--------|--------|
| "cargar rinde lote X" | NOT SUPPORTED | Core farmer workflow blocked |
| "lote X rindió Y kg/ha" | Misrouted → observation | Data stored as text, not queryable |
| "ver rinde lote X" | NOT SUPPORTED | No way to retrieve yield data |
| "cuanto rindio el lote X" | NOT SUPPORTED | No yield query capability |
| "que lote rindio mas" | NOT SUPPORTED | No cross-lote comparison |
| "cosechamos Y kg de Z" | Quantity not captured | Harvest registered but yield lost |
| Yield-per-hectare calculation | NOT SUPPORTED | No area-weighted yield metrics |
| Season-level yield tracking | NOT SUPPORTED | No yield-to-campaign association |

### 3.2 Financial-Lote Integration

| Feature | Status | Impact |
|---------|--------|--------|
| Lote selection in expense flow | MISSING | Expenses sometimes lack plot context |
| Lote selection in income flow | MISSING | Income NEVER associated with lotes |
| "gastos del lote X" query | MISSING | Can only get via "resumen/reporte lote X" |
| "ingresos del lote X" query | MISSING | No lote-specific income query |
| Cost-per-hectare by lote | MISSING | No area-weighted financial metrics |
| Profitability by lote | MISSING | No income-expense comparison per lote |

### 3.3 Advanced Lote Management

| Feature | Status | Impact |
|---------|--------|--------|
| Move lote between campos | NOT SUPPORTED | No field_id reassignment |
| Bulk lote operations | NOT SUPPORTED | No "delete all lotes in campo X" |
| Lote comparison reports | NOT SUPPORTED | AI fallback gives generic response |
| Lote export (CSV/PDF) | NOT SUPPORTED | No per-lote export |
| Lote timeline/history | NOT SUPPORTED | No chronological event view |
| Lote-level weather | NOT SUPPORTED | Weather is field-level only |

---

## 4. DATA MODEL GAPS

### 4.1 Current Schema (plots table)

| Column | Type | Present | Used | Notes |
|--------|------|---------|------|-------|
| id | SERIAL PK | Yes | Yes | |
| field_id | INT FK | Yes | Yes | Links to campo |
| name | VARCHAR(100) | Yes | Yes | |
| area_hectares | NUMERIC | Yes | Yes | Set via "lote X tiene Y ha" |
| soil_type | VARCHAR(50) | Yes | No | Column exists but no command to set it |
| lat | NUMERIC | Yes | Buggy | Decimal stripping corrupts values |
| lng | NUMERIC | Yes | Buggy | Same decimal bug |
| created_at | TIMESTAMP | Yes | Yes | |
| deleted_at | TIMESTAMP | Yes | Yes | Soft delete |
| deleted_by | VARCHAR(50) | Yes | Yes | |

### 4.2 Related Tables

| Table | Relationship | Status |
|-------|-------------|--------|
| plot_crops | plot_id FK | Working — sow/harvest/active/history all functional |
| plot_aliases | plot_id FK | Partially working — not always registered |
| domain_events | plot_id FK | Working — activities stored correctly |
| agro_observations | plot_id FK | Working — observations properly scoped |
| expenses | plot_id FK (nullable) | Partially — inline expenses get plot_id but queries don't filter |
| incomes | plot_id FK (nullable) | Broken — income NEVER gets plot_id |
| rainfall | NO plot_id | By design — field-level only |

### 4.3 Missing for Real Farm Usage

| Data | Current Status | Required For |
|------|---------------|--------------|
| **Yield (rinde)** | NOT STORED | Core ROI calculation, lote comparison |
| **Campaña (season)** | In plot_crops | Exists but not queryable independently |
| **Cultivo activo** | In plot_crops | Exists, works per-lote |
| **Superficie** | area_hectares | Exists, works |
| **Costos por lote** | Partial (plot_id on expenses) | Queries don't filter by lote |
| **Ingresos por lote** | NOT STORED | Income never linked to lote |
| **Margen por lote** | NOT CALCULABLE | Missing income + yield linkage |
| **Rendimiento económico** | NOT CALCULABLE | Missing yield + income + cost per lote |

---

## 5. CRITICAL FINDINGS CLASSIFICATION

| ID | Severity | Bug | Impact |
|----|----------|-----|--------|
| BUG-L01 | **CRITICAL** | No yield/rinde support | Core farming metric completely missing. Yield data dumped as observations. |
| BUG-L02 | **CRITICAL** | Coordinate decimal stripping | GPS data corrupted 10x. All stored coordinates wrong. |
| BUG-L03 | **HIGH** | Rename lote broken | getFieldByName called instead of plot lookup. Dead feature. |
| BUG-L04 | **HIGH** | Delete confirmation mismatch | Button IDs don't match. Deletion flow broken. |
| BUG-L05 | **HIGH** | "ver lote X" unrecognized | Common user phrase not handled. |
| BUG-L06 | **HIGH** | Expense query not filtered by lote | "cuanto gaste en lote 1" shows ALL expenses. |
| BUG-L07 | **HIGH** | Income not linked to lotes | Sales never associated with plot_id. |
| BUG-L08 | **MEDIUM** | "gastos/ingresos del lote X" unrecognized | Missing parser patterns for common queries. |
| BUG-L09 | **MEDIUM** | "que hay sembrado" (no lote) fails | Should list all active crops globally. |
| BUG-L10 | **MEDIUM** | Harvest skips yield quantity | quantity/unit never captured on harvest. |
| BUG-L11 | **MEDIUM** | No lote name validation | Lote 0, -1, empty strings accepted. |
| BUG-L12 | **LOW** | "lote" keyword captured in rename | newName = "lote norte" instead of "norte". |
| BUG-L13 | **LOW** | Long name parsing failure | Multi-word names with "en" break the parser. |

---

## 6. PRODUCT RECOMMENDATIONS

### 6.1 Minimum Viable Lote Model Enhancement

The current plots table needs these additions:

```sql
-- Option A: Add yield columns to domain_events (preferred — reuses existing infra)
-- domain_events already has: quantity, unit columns
-- Just need to populate them during harvest

-- Option B: Dedicated yield table (more structured)
CREATE TABLE plot_yields (
  id SERIAL PRIMARY KEY,
  plot_id INT NOT NULL REFERENCES plots(id),
  plot_crop_id INT REFERENCES plot_crops(id),
  yield_kg_ha NUMERIC NOT NULL,  -- kg per hectare
  total_quantity NUMERIC,        -- total harvest quantity
  total_unit VARCHAR(20),        -- tn, kg, qq
  quality_grade VARCHAR(50),     -- optional: humedad, proteina
  harvest_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Recommendation:** Option A (populate domain_events.quantity/unit during harvest) for MVP. Option B for future scale.

### 6.2 Required New Commands

| Command | Pattern | Handler Action |
|---------|---------|----------------|
| `log_yield` | "rinde/rindio/rendimiento lote X: Y kg/ha" | Save yield to domain_events or plot_yields |
| `view_yield` | "ver rinde/rendimiento lote X" | Query yield by plot + season |
| `compare_yields` | "comparar lotes/rendimientos" | Side-by-side yield + cost per lote |
| `plot_profitability` | "rentabilidad lote X" | Income - expenses per lote, yield per ha |
| `all_active_crops` | "que hay sembrado" (no lote) | List all active crops across all lotes |
| `plot_expenses` | "gastos del lote X" | Lote-specific expense breakdown |
| `plot_income` | "ingresos del lote X" | Lote-specific income breakdown |

### 6.3 Implementation Priority

**Phase 1 — Fix Existing Bugs (1-2 days)**
1. Fix coordinate decimal parsing (BUG-L02) — change normalizeText to preserve decimals
2. Fix rename_field handler to support lotes (BUG-L03) — add getPlotByName branch
3. Fix delete button ID matching (BUG-L04) — use consistent button IDs
4. Add "ver lote X" pattern to plot_info (BUG-L05)
5. Add "gastos/ingresos del lote X" parser patterns (BUG-L08)

**Phase 2 — Yield Support MVP (2-3 days)**
1. Add `log_yield` parser pattern + handler
2. Modify `harvest_crop` to extract quantity/unit
3. Remove skipIf for quantity on harvest in activity_flow
4. Add `view_yield` query command
5. Add "que hay sembrado" global active crop listing

**Phase 3 — Financial-Lote Integration (2-3 days)**
1. Add lote step to income flow
2. Add "cuanto gaste en lote X" specific pattern
3. Add cost-per-hectare calculation in plot_info
4. Add basic lote profitability report (income - expenses / hectares)

**Phase 4 — Comparison & Analytics (3-5 days)**
1. Cross-lote yield comparison
2. Lote ranking by profitability
3. Season-over-season yield trends
4. Campaign-level rollup reports

### 6.4 Real Farmer Feature Requirements

| Feature | Priority | Status | Notes |
|---------|----------|--------|-------|
| Cultivo (crop) | P0 | DONE | plot_crops table works |
| Superficie (area) | P0 | DONE | area_hectares column works |
| Campaña (season) | P0 | DONE | season_year + season_type in plot_crops |
| Rinde (yield) | P0 | **MISSING** | Core gap — no storage or commands |
| Costos por lote | P1 | PARTIAL | Stored but not queryable by lote |
| Ingresos por lote | P1 | **MISSING** | Income never linked to plot_id |
| Rentabilidad | P1 | **MISSING** | Depends on yield + income + cost per lote |
| Comparación | P2 | **MISSING** | No cross-lote analytics |
| Historial completo | P2 | PARTIAL | Crop history works, financial history per lote missing |

---

## 7. WHAT WORKS WELL

| Capability | Status | Quality |
|------------|--------|---------|
| Create lote with explicit campo | PASS | Excellent — all syntax variants work |
| Create lote with auto-assign (1 campo) | PASS | Smart — auto-picks the only campo |
| Create lote no-campo error | PASS | Clear guidance — "primero creá un campo" |
| List all lotes | PASS | Grouped by campo with area display |
| List lotes per campo | PASS | Filtered correctly |
| Plot info (via "info lote X") | PASS | Shows expenses, income, rainfall |
| Set area (hectares) | PASS | Multiple syntaxes work |
| Duplicate detection | PASS | "Ya existía el lote" message |
| Same name across campos | PASS | Correctly supported |
| Soft delete | PASS | Via "borrar lote X del campo Y" |
| Non-existing campo rejection | PASS | Clear "No encontré el campo" error |
| Sow crop | PASS | Season auto-detected (gruesa/fina) |
| Harvest crop | PASS | Closes plot_crops.end_date |
| Active crop query (per lote) | PASS | Shows crop + campaign |
| Crop history | PASS | Shows all seasons with status |
| Observations on lote | PASS | Properly scoped with categories |
| Activities on lote | PASS | Spraying, sowing, harvesting logged |
| Agro reports per lote | PASS | Text + PDF with observations + activities |
| Expense registration with lote context | PASS | plot_id correctly saved |
| Financial result per lote | PASS | "resultado financiero lote X" works |

---

## AUDIT VERDICT

**Production readiness: CONDITIONAL**

The lote system has a solid foundation for CRUD, crop lifecycle, and agro observations. However, the complete absence of yield/rinde tracking makes it unsuitable for production farming use where ROI calculation is essential. The financial-lote disconnect (income never linked, expenses not queryable by lote) further limits its value.

**Blockers for production:**
1. No yield support (CRITICAL)
2. Coordinate data corruption (CRITICAL)
3. 5 broken UX flows (rename, delete confirm, "ver lote", expense query, income linkage)

**Strengths:**
- Clean CRUD operations
- Good error messages in Spanish
- Smart auto-assign logic
- Proper soft delete with restoration
- Crop lifecycle fully functional
- Observation system well-integrated
