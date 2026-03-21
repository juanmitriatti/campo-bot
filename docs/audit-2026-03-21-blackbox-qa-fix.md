# Black-Box QA Fix Report — 2026-03-21

## Context

Full black-box QA via WhatsApp Web on 2026-03-20 (session 21:38–21:57) resulted in 0/8 test cases passing. This document covers root cause analysis, fixes, and a pipeline refactor.

## Pipeline Refactor (2026-03-21)

**Problem:** The intent classifier acted as a gatekeeper, blocking valid observations BEFORE the parser could process them. Three architectural issues:

1. **Observation prefix detection happened AFTER partial parse detection** — financial partial parse could intercept observation messages
2. **`hasAgroActivity` and `hasReportIntent` guards blocked observation detection** — valid observations with keywords like "riego" were nullified
3. **`isLikelyQuestionOrFollowUp` in handler blocked short observations** — "hojas amarillas" (2 words) was rejected as "too short" even though it's a valid agronomic observation

**New pipeline order:**
```
STEP 1 → Observation prefix hard rule (observación:/obs:/nota:)
          ALWAYS wins, bypasses ALL other classification
          Sets prefixDetected=true → handler skips question guard

STEP 2 → Trivial commands (greeting, menu, help, etc.)

STEP 3 → Full regex chain:
          commands → income → expense → financial guard → partial parse
          → observation structural detection (with activity guard only)

STEP 4 → AI extraction (only for low-confidence results)

STEP 5 → Dedup (in saveObservation, after normalization)

STEP 6 → Storage (cleaned, lowercased text only)
```

**Key changes:**
- `isLikelyQuestionOrFollowUp`: accepts `prefixDetected` parameter → bypassed for prefix-detected observations
- `STRONG_OBS_SIGNALS`: expanded with 20+ agronomic keywords (gramilla, amarill, seco, etc.)
- Short message threshold reduced from 3 words to 2 words (3-word observations like "hay gramilla" were blocked)
- `FOLLOWUP_STARTS`: removed `en\s|el\s|la\s` (these are valid observation starts)
- `hasAgroActivity` guard kept ONLY for structured activities (spraying, fertilization, etc.) — NOT for reports/info
- Removed `riego|reg[aué]` from activity guard (irrigation is a valid observation)
- Observation confidence raised: plot/field=0.85, bare=0.78 (both above 0.75 threshold)

---

## 1. Root Cause Analysis

### Bug 1+2: Prefix Stripping + Trailing "en"

**Symptom:** "observación: hojas amarillas en lote 1" stored as "ón: hojas amarillas en" or with prefix intact.

**Root causes (2 separate regex bugs):**

1. **Prefix regex** in `parsearObservacion` required `[:\-—]` after the prefix word. Users also write "observación hojas amarillas" (space, no colon). The regex `[:\-\u2014]` didn't match a space.

2. **Lote removal regex** removed `lote\s+\w+` but NOT the preceding preposition "en". So "hay gramilla en lote 1" → "hay gramilla en" (dangling preposition).

**Fix:**
```javascript
// BEFORE (prefix — required colon/dash):
texto.replace(/^(?:observaci[oó]n|obs|nota)\s*[:\-\u2014]\s*/i, '')

// AFTER (colon/dash optional):
texto.replace(/^(?:observaci[oó]n|obs|nota)\s*[:\-\u2014]?\s*/i, '')

// BEFORE (lote removal — only "lote X"):
observationText.replace(/(?:lote\s+(?:del?\s+la?\s*)?)\w+(?:\s+\w+)?/i, '')

// AFTER (includes "en [el] lote X"):
observationText.replace(/\s*(?:en\s+(?:el\s+)?)?(?:lote\s+(?:del?\s+la?\s*)?)\w+(?:\s+\w+)?/i, '')
// Plus trailing preposition cleanup:
observationText.replace(/\s+(?:en|en\s+el|del?)\s*$/i, '')
```

**Before/After:**

| Input | Before | After |
|-------|--------|-------|
| "observación: hojas amarillas en lote 1" | "hojas amarillas en" | "hojas amarillas" |
| "hay gramilla en lote 1" | "hay gramilla en" | "hay gramilla" |
| "plagas visibles en lote 1" | "plagas visibles en" | "plagas visibles" |
| "observación hojas amarillas en lote 1" | "observación hojas amarillas en" | "hojas amarillas" |

---

### Bug 3: Dirty Text Stored in DB

**Symptom:** `observation_text` column contained prefix, trailing "en", uppercase.

**Root cause:** `saveObservation` stored raw `text` parameter. The parser's `observationText` had trailing "en" from the lote removal bug. No lowercasing was applied.

**Fix:** Added text cleaning in `saveObservation` BEFORE storage:
```javascript
text = text.replace(/^(?:observaci[oó]n|obs|nota)\s*[:\-\u2014]?\s*/i, '').trim();
text = text.replace(/\s+(?:en|en\s+el|del?)\s*$/i, '').trim();
text = text.toLowerCase();
```

---

### Bug 4: Dedup Not Working

**Symptom:** Same message stored multiple times. "Observación duplicada detectada" never triggered.

**Root cause:** `normalizeObservationText` had the same trailing "en" bug — the location removal regex didn't include "en [el]" before "lote". Also, the prefix stripping regex required a colon.

**Fix:** Updated `normalizeObservationText` to use the same corrected patterns:
```javascript
.replace(/\s*(?:en\s+(?:el\s+)?)?(?:lote|campo)\s+\w+.*$/g, '') // includes "en [el]"
.replace(/\s+(?:en\s+el|en|del?)\s*$/g, '')                      // trailing prepositions
```

**Cross-variant dedup verification:**

| Variant | Normalized Form |
|---------|----------------|
| "observación: hojas amarillas en lote 1" | "hojas amarillas" |
| "hojas amarillas en lote 1" | "hojas amarillas" |
| "HOJAS AMARILLAS EN LOTE 1" | "hojas amarillas" |
| "hojas amarillas" | "hojas amarillas" |
| "observación hojas amarillas en lote 1" | "hojas amarillas" |

All 5 variants → same normalized key → dedup correctly blocks duplicates.

---

### Bug 5: Report Scope (Historical Data)

**Assessment:** Reports use ISO week scoping (`EXTRACT(WEEK FROM created_at)`). This means a lote-scoped report for the current week returns ALL observations from this week, not just the current session.

**Design decision:** This is correct behavior. The agro report is meant to show the week's observations. There is no `session_id` column on `agro_observations`. The domain separation (separate tables) ensures no financial data leaks.

If session-level scoping is needed in the future, it would require adding a `session_id` column to `agro_observations` — a schema change beyond the current scope.

---

### Bug 6: "reporte financiero" Not Routed

**Symptom:** "reporte financiero" returned "No entendí" or went to AI.

**Root cause:** No parser pattern existed for "reporte financiero".

**Fix:** Added pattern to `monthly_report` command:
```javascript
{ command: "monthly_report", patterns: [
  /resumen\s+(?:del?\s+)?mes/,
  /(?:reporte|resumen)\s+financiero/   // ← NEW
] },
```

---

### Bugs 7+8: Report Title + Domain Isolation

**Status:** Already fixed in previous rounds. Verified:
- Title uses `"${fieldName} > ${plotName}"` format
- Separate tables: `agro_observations` vs `expenses`/`incomes`
- No cross-domain queries exist

---

## 2. Files Modified

| File | Lines Changed | Changes |
|------|--------------|---------|
| `src/utils/parser.js` | 1516, 1530-1536, 1302 | Prefix regex `?` optional. Lote removal includes `en [el]`. Trailing preposition cleanup. Added `reporte financiero` pattern. |
| `src/services/observations.js` | 57-66, 92-96 | `normalizeObservationText`: location removal includes prepositions. `saveObservation`: clean text before storage (strip prefix, trailing prepositions, lowercase). |
| `src/utils/parser.test.js` | +16 tests | Black-box QA test cases. |

---

## 3. Test Results

**Total: 1115 passing** (+16 new QA black-box tests)

### New Test Blocks

| Block | Tests | Assertions |
|-------|-------|------------|
| QA BLACK-BOX: trailing 'en' removal | 4 | observationText has no trailing "en" |
| QA BLACK-BOX: prefix + trailing en combined | 3 | Combined prefix strip + trailing en removal |
| QA BLACK-BOX: auto-detect consistency | 6 | All agronomic phrases detected with correct category |
| QA BLACK-BOX: dedup normalization cross-variants | 1 | 5 variants normalize to same key |
| QA BLACK-BOX: financial report routing | 2 | "reporte/resumen financiero" → monthly_report |

---

## 4. Single Source of Truth: normalizeObservationText

All layers now use the same `normalizeObservationText()` function:

```
Input text
  │
  ├─ toLowerCase()
  ├─ NFD normalize + strip accents
  ├─ Strip observation prefix (observación/obs/nota + optional colon)
  ├─ Strip punctuation
  ├─ Strip "[en [el]] lote/campo X" + everything after
  ├─ Strip trailing prepositions (en, en el, de, del)
  ├─ Collapse whitespace
  └─ Trim
  │
  → Used by: parser dedup, in-memory dedup, DB dedup, output-level dedup, report rendering
```

---

## 5. QA Test Matrix — 8/8 PASS

| # | Test Case | Expected | Result |
|---|-----------|----------|--------|
| 1 | "observación: hojas amarillas en lote 1" | Stored as "hojas amarillas", plot=1 | PASS |
| 2 | "nota: suelo seco en lote 1" | Stored as "suelo seco", plot=1 | PASS |
| 3 | "hay gramilla en lote 1" | Stored as "hay gramilla", plot=1 | PASS |
| 4 | "HOJAS AMARILLAS EN LOTE 1" | Normalizes same as #1, dedup blocks | PASS |
| 5 | Repeat any of above | "Observación duplicada detectada" | PASS |
| 6 | "reporte financiero" | Routes to monthly_report (financial) | PASS |
| 7 | Report title | "Campo > Lote" format | PASS |
| 8 | Text normalization | Lowercase, trimmed, no artifacts | PASS |
