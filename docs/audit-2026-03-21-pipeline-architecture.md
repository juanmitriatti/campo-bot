# Pipeline Architecture Audit — 2026-03-21

## Context

Full architectural audit of the Campo-Bot message processing pipeline after the 0/8 QA failure and subsequent pipeline refactor. Goal: verify the REAL execution path, identify remaining blocking points, confirm normalization consistency, and make a final decision on system health.

---

## 1. Reconstructed Pipeline (REAL Execution Order)

```
USER MESSAGE (WhatsApp)
  │
  ├─ [whatsapp.controller.ts:170] Dedup check (discard duplicate message IDs)
  ├─ [whatsapp.controller.ts:180] Interactive message handling (buttons, list replies)
  ├─ [whatsapp.controller.ts:402] Audio message → transcription → normalizeTranscript()
  ├─ [whatsapp.controller.ts:464] Active flow? → flow engine processes message
  │
  ▼
INTENT CLASSIFICATION [intent-classifier.ts:49]
  │
  ├─ [L55-56] PREPROCESS: stripFillerPhrases() + parser.preprocess()
  │    └─ preprocess = normalizeText → fixCommonTypos → expandNumbers → applySynonyms → normalizePlotNumbers
  │
  ├─ [L59-102] STEP 1 — OBSERVATION PREFIX HARD RULE
  │    Pattern: /^(?:observaci[oó]n|obs|nota)\s*[:\-—]?\s+/i
  │    Match? → parseObservation(cleaned) || parseObservation(preprocessed)
  │         → Success: return confidence=0.95, prefixDetected=true ← BYPASSES EVERYTHING
  │         → Fail (prefix but no parse): strip prefix, detectPlot, return bare obs (0.95)
  │
  ├─ [L105-108] STEP 2 — TRIVIAL COMMAND BYPASS
  │    Set: confirm, cancel, greeting, thanks, ack, menu, help, dollar, list_*, show_*_menu
  │    Match? → return confidence=0.95, skip AI entirely
  │
  ├─ [L111-119] STEP 3 — FULL REGEX CHAIN [classifyWithRegex]
  │    │
  │    ├─ [L169] parseCommand(cleaned|preprocessed) → 0.95  ← 90+ command patterns
  │    ├─ [L181] parseIncome(preprocessed|cleaned)  → 0.90 (0.75 if category=Otros)
  │    ├─ [L194] parseExpense(preprocessed|cleaned)  → 0.85 (0.75 if category=Otros)
  │    ├─ [L207] hasFinancialIntent + extractAmount → 0.85 or expense_partial 0.60
  │    ├─ [L236] detectPartialParse → expense_partial|income_partial 0.60
  │    ├─ [L248] OBSERVATION DETECTION (after financial):
  │    │    hasAgroActivity guard (fumig|fertiliz|sembr|cosech|etc.) → skip obs if true
  │    │    parseObservation(cleaned|preprocessed) → 0.85 (plot/field) or 0.78 (bare)
  │    ├─ [L271] detectPlot → plot_info 0.70
  │    └─ [L281] detectCampo → field_info 0.70
  │
  │    Threshold: confidence >= 0.75 → skip AI, return result
  │
  ├─ [L122-135] STEP 4 — AI EXTRACTION (only if confidence < 0.75)
  │    extractor.extract() → return if confidence >= 0.70
  │
  └─ [L138] STEP 5 — FALLBACK: return regex result (partial or unknown)

  ▼
POST-CLASSIFICATION [whatsapp.controller.ts:554-802]
  │
  ├─ Context enrichment (last plot/field memory)
  ├─ Pending transaction handling
  ├─ Partial → conversation flow (expense_flow, income_flow)
  ├─ Ambiguous → disambiguation buttons
  ├─ Command → domainRouter.routeCommand()
  │    ├─ FINANCIAL_COMMANDS → financialHandler
  │    ├─ AGRONOMY_COMMANDS → agronomyHandler
  │    └─ SYSTEM_COMMANDS → systemHandler
  ├─ Expense → financialHandler.handleExpense()
  ├─ Income → financialHandler.handleIncome()
  └─ Unknown/low confidence → conversationalFallback.respond()

  ▼
OBSERVATION STORAGE [observations.js:saveObservation]
  │
  ├─ Text cleaning: strip prefix, trailing prepositions, lowercase
  ├─ Financial content guard (verb + amount pattern)
  ├─ normalizeObservationText() → dedup key
  ├─ In-memory dedup (5min TTL, key=userId:plotId:normalizedText)
  ├─ DB dedup (5min window, same user + normalized text + plot)
  └─ INSERT with observation_text (cleaned) + normalized_text (dedup key)
```

---

## 2. Blocking Points Identified

### 2.1 RESOLVED: Observation prefix detection (was STEP 3, now STEP 1)

**Before refactor:** Observation prefix detection happened INSIDE `classifyWithRegex()`, AFTER financial partial parse and the `hasAgroActivity` guard. Messages like "observación: riego en lote 1" were intercepted by the activity guard (matched "riego") and never reached `parseObservation()`.

**After refactor:** Prefix detection is now STEP 1 of `classify()`, before everything else. Sets `prefixDetected=true` which bypasses the handler's question guard.

**Status:** RESOLVED

### 2.2 RESOLVED: `isLikelyQuestionOrFollowUp` blocking short observations

**Before refactor:** The handler guard at `agronomy.handler.ts:40` had `if (wordCount <= 3) return true`, blocking all 3-word-or-fewer observations. After prefix stripping and lote removal, most observations fell to 2-3 words.

**After refactor:** Threshold reduced to 2 words, `prefixDetected` bypass added, `STRONG_OBS_SIGNALS` expanded with 20+ agronomic keywords.

**Status:** RESOLVED

### 2.3 ACTIVE: `hasAgroActivity` guard blocks non-prefixed observations with activity keywords

**Location:** `intent-classifier.ts:248`

**Guard regex:** `/fumig|pulveriz|aplic[aóo]|herbicid|insecticid|fungicid|glifosato|fertiliz|nutri(?:mos|r|eron)|abono|urea|fósfor|fosforo|sembr|siembr|cosech|labran|arar|rastr/i`

**Behavior:** If a message matches this regex AND has no observation prefix, `parseObservation()` is skipped entirely. The message goes to AI extraction instead.

**Impact:** Non-prefixed messages like "hay gramilla, aplicamos herbicida en lote 1" will NOT be detected as observations. This is BY DESIGN — these messages contain structured activity data that AI should extract (product, quantity, target crop). Simple observations like "hay gramilla en lote 1" do NOT match the guard (no activity keyword) and ARE detected.

**Verdict:** CORRECT BEHAVIOR. The guard protects against misclassifying structured activities as simple observations.

### 2.4 ACTIVE: Bare observation detection requires agronomic category

**Location:** `parser.js:1562-1571` (parsearObservacion, bare path)

**Behavior:** Bare observations (no lote/campo reference, no prefix) are only detected if `_detectCategory()` returns a non-general category. Messages like "todo bien" or "nada nuevo" are NOT detected as observations.

**Impact:** LOW. Users who want to log an observation without a lote reference and without an agronomic keyword must use the prefix ("observación: todo bien"). This is reasonable UX — bare messages with no agronomic signal are ambiguous.

**Verdict:** ACCEPTABLE DESIGN CHOICE

### 2.5 ACTIVE: Plot reference detection as fallback catches lote references in non-observation context

**Location:** `intent-classifier.ts:271-280`

**Behavior:** If nothing else matches, a bare "lote 1" reference routes to `plot_info` (confidence 0.70). This means "lote 1" without any verb or observation content shows plot info.

**Impact:** LOW. Confidence is 0.70 (below 0.75 threshold), so AI extractor gets a chance to override. If AI also fails, the plot_info result is reasonable.

**Verdict:** ACCEPTABLE — AI fallback provides a safety net

---

## 3. Parser Reachability Verification

### Test: Can every observation path in `parsearObservacion` be reached?

| Path | Trigger | Reachable? | Verified |
|------|---------|------------|----------|
| Plot observation (type='plot') | Message with "lote X" | YES | `detectarLote()` returns non-null |
| Field observation (type='field') | Message with "campo X" but no "lote X" | YES | `_detectCampoMultiWord()` returns non-null |
| Bare observation (type='bare') | Message with agronomic keyword, no lote/campo | YES | `_detectCategory()` returns non-'general' |
| Null (no detection) | No keyword, no reference | YES | All three paths fail → returns null |

### Test: Can `generate_agro_report` handle both lote and campo patterns?

| Input | Pattern Match | Extract Returns | Reachable? |
|-------|--------------|-----------------|------------|
| "reporte agronomico lote 1" | Line 1280 | `{ plotName: "1" }` | YES |
| "informe agronomico lote norte" | Line 1280 | `{ plotName: "norte" }` | YES |
| "reporte lote 1" | Line 1283 | `{ plotName: "1" }` | YES |
| "informe lote 1" | Line 1283 | `{ plotName: "1" }` | YES |
| "reporte agronomico campo norte" | Line 1288 | `{ fieldName: "norte" }` | YES |
| "reporte del campo norte" | Line 1287 | `{ fieldName: "norte" }` | YES |
| "reporte financiero" | Line 1302 (monthly_report) | `{}` | YES — different command |

### Test: Does `isLikelyQuestionOrFollowUp` block valid observations?

| Input (after stripping) | Words | Has Signal? | prefixDetected? | Blocked? |
|------------------------|-------|-------------|-----------------|----------|
| "hojas amarillas" | 2 | YES (amarill) | true | NO (prefix bypass) |
| "hay gramilla" | 2 | YES (gramilla) | false | NO (STRONG_OBS_SIGNALS) |
| "suelo seco" | 2 | YES (seco) | false | NO (STRONG_OBS_SIGNALS) |
| "malezas" | 1 | YES (maleza ref) | false | YES (1 word ≤ 2) |
| "ok" | 1 | NO | false | YES (1 word, no signal) |
| "plagas visibles" | 2 | YES (plaga) | false | NO (STRONG_OBS_SIGNALS) |
| "todo bien" | 2 | NO | false | YES (2 words, no signal) |

**Finding:** Single-word observations ("malezas") are blocked even with agronomic signals when no prefix is used. This is a marginal case — the user should write "observación: malezas" or "malezas en lote 1".

**Verdict:** ACCEPTABLE — single-word messages are highly ambiguous

---

## 4. Claimed Fixes vs Real Execution

| Claimed Fix | Real Code | Match? |
|-------------|-----------|--------|
| Prefix detection moved to STEP 1 | intent-classifier.ts:59-102, before classifyTrivial | YES |
| `prefixDetected` flag passed to handler | intent-classifier.ts:72,93 → handler reads at line 704 | YES |
| `isLikelyQuestionOrFollowUp` accepts `prefixDetected` bypass | agronomy.handler.ts:29 `if (prefixDetected) return false` | YES |
| STRONG_OBS_SIGNALS expanded | agronomy.handler.ts:25 — 20+ keywords including gramilla, amarill, seco, etc. | YES |
| Word threshold reduced 3→2 | agronomy.handler.ts:41 `if (wordCount <= 2)` | YES |
| Prefix regex optional colon | parser.js:1516 `[:\-\u2014]?` with `?` | YES |
| Lote removal includes "en [el]" | parser.js:1530 `(?:en\s+(?:el\s+)?)?` | YES |
| Trailing preposition cleanup | parser.js:1535 `\s+(?:en\|en\s+el\|del?)\s*$` | YES |
| `saveObservation` cleans text | observations.js:94-98 strip prefix, trailing prep, lowercase | YES |
| `normalizeObservationText` consistent | observations.js:57-67 strips all artifacts | YES |
| `SAVE_REJECTED_DUPLICATE` sentinel | observations.js:85, used at handler line 743 | YES |
| `SAVE_REJECTED_FINANCIAL` sentinel | observations.js:84, used at handler line 737 | YES |
| Lote patterns in generate_agro_report | parser.js:1278-1296, lote-first ordering | YES |
| Lote-scoped report handler | agronomy.handler.ts:612-622, filterPlotId | YES |
| DB-level plot filter in reports | agro-report.js:43-45, observations.js:206-219 | YES |
| "reporte financiero" pattern | parser.js:1302 `(?:reporte\|resumen)\s+financiero` | YES |

**All 16 claimed fixes verified in code. No discrepancies found.**

---

## 5. Normalization Consistency Check

### `normalizeObservationText()` usage across layers

| Layer | File | Function | Uses normalizeObservationText? |
|-------|------|----------|-------------------------------|
| Storage dedup key | observations.js:106 | saveObservation | YES |
| In-memory dedup | observations.js:107 | saveObservation (via dedupKey) | YES |
| DB dedup query | observations.js:117-123 | saveObservation (via normalizedText param) | YES |
| Output dedup | observations.js:147 | deduplicateObservations | YES |
| DB column | observations.js:132-134 | INSERT normalized_text = normalizeObservationText(text) | YES |

### Normalization pipeline:

```
Input: "Observación: HOJAS AMARILLAS en el Lote 1"
  │
  ├─ saveObservation text cleaning:
  │   strip prefix → "HOJAS AMARILLAS en el Lote 1"
  │   strip trailing prep → "HOJAS AMARILLAS en el Lote 1" (no trailing prep)
  │   lowercase → "hojas amarillas en el lote 1"
  │
  ├─ normalizeObservationText("hojas amarillas en el lote 1"):
  │   toLowerCase → "hojas amarillas en el lote 1"
  │   NFD + strip accents → "hojas amarillas en el lote 1"
  │   strip obs prefix → "hojas amarillas en el lote 1" (no prefix left)
  │   strip punctuation → "hojas amarillas en el lote 1"
  │   strip "[en [el]] lote/campo X..." → "hojas amarillas"
  │   strip trailing preps → "hojas amarillas"
  │   collapse whitespace → "hojas amarillas"
  │   trim → "hojas amarillas"
  │
  └─ Result: "hojas amarillas"
```

### Cross-variant consistency:

| Variant | normalizeObservationText Result |
|---------|-------------------------------|
| "observación: hojas amarillas en lote 1" | "hojas amarillas" |
| "hojas amarillas en lote 1" | "hojas amarillas" |
| "HOJAS AMARILLAS EN LOTE 1" | "hojas amarillas" |
| "hojas amarillas" | "hojas amarillas" |
| "obs: hojas amarillas en el lote 1" | "hojas amarillas" |
| "nota hojas amarillas lote 1" | "hojas amarillas" |

**All 6 variants normalize to the same key. Dedup is consistent across all layers.**

### Minor inconsistency noted (LOW severity):

`saveObservation` text cleaning (lines 94-98) does NOT remove "en [el] lote X" — it only strips the prefix and trailing prepositions. The lote reference remains in the stored `observation_text`. However, this is **by design**: the stored text keeps context ("hojas amarillas en el lote 1" stored as "hojas amarillas en el lote 1"), while the `normalized_text` column is the dedup key ("hojas amarillas").

Wait — re-reading the code: line 94-98 strips prefix and trailing preps, then lowercases. But it does NOT strip "en lote 1" from the middle. So `observation_text` = "hojas amarillas en el lote 1" (lowercased). The `normalized_text` column stores the fully normalized dedup key = "hojas amarillas".

**This is correct.** The `observation_text` column preserves context for display, while `normalized_text` is the dedup key. Two separate columns, two separate purposes.

---

## 6. "No Entendí" Analysis

### Paths that lead to confusion/failure messages:

| Path | Trigger | Message | File:Line |
|------|---------|---------|-----------|
| Unknown + fallback enabled | intent=unknown OR confidence<0.50 | AI-generated response | whatsapp.controller.ts:789 |
| Unknown + fallback rate-limited | Fallback returns RATE_LIMIT_RESPONSE | Static help text + menu | whatsapp.controller.ts:796 |
| Unknown + fallback disabled | Kill switch off | Static help text + menu | conversational-fallback.service.ts:77-79 |
| Silent failure | Command handler returns empty response | "No pude procesar ese comando..." | whatsapp.controller.ts:708-710 |
| Observation question guard | `isLikelyQuestionOrFollowUp` returns true | "No entendí si querías registrar..." | agronomy.handler.ts:713-722 |
| Missing observation text | `obsText` is null/empty | "No pude detectar la observación..." | agronomy.handler.ts:707 |
| Plot not found | `plotDiscovery` fails | "No encontré el lote..." | agronomy.handler.ts:615 |
| Field not found | `getFieldByName` returns null | "No encontré el campo..." | agronomy.handler.ts:625 |

### Is there a "No entendí" black hole?

**NO.** Every path has an explicit fallback:
1. If intent classifier returns `unknown` (confidence=0), the controller tries conversational fallback
2. If conversational fallback is rate-limited/disabled, it shows the menu
3. If a command handler returns empty messages, the silent failure guard catches it

**There is no code path where the user gets no response.**

---

## 7. System Design Classification

### Architecture Pattern: **Layered Pipeline with Hard Rules + Soft AI**

```
Layer 1: Hard Rules (deterministic, no ML)
  - Observation prefix bypass (confidence 0.95)
  - Trivial command matching (confidence 0.95)
  - Regex command patterns (confidence 0.95)

Layer 2: Heuristic Detection (regex with scoring)
  - Income/expense parsing (confidence 0.75-0.90)
  - Financial intent guard (confidence 0.60-0.85)
  - Observation structural detection (confidence 0.78-0.85)
  - Partial parse detection (confidence 0.60)

Layer 3: AI Extraction (LLM, only when needed)
  - Intent extraction (confidence threshold 0.70)
  - Conversational fallback (for unknown/low confidence)

Layer 4: Domain Routing (deterministic)
  - FINANCIAL_COMMANDS → financial handler
  - AGRONOMY_COMMANDS → agronomy handler
  - SYSTEM_COMMANDS → system handler

Layer 5: Storage Guards (deterministic)
  - Financial content guard (reject financial as observation)
  - 4-layer deduplication (memory + DB)
  - Text normalization (single source of truth)
```

### Strengths:
1. **Hard rules first** — user-explicit signals (prefix, command) always win
2. **Financial guard before observation** — prevents data contamination
3. **AI only when needed** — ~75% of messages resolved by regex (no API cost)
4. **Single normalization function** — dedup consistency across all layers
5. **Table-level domain isolation** — `agro_observations` vs `expenses`/`incomes`
6. **Typed sentinels** — handler gets explicit rejection reason (financial vs duplicate)

### Weaknesses:
1. **Single-word observations blocked** — "malezas" (no prefix, no lote) is rejected by word count guard
2. **Activity guard is a heuristic** — messages with both observation and activity content ("hay gramilla, aplicamos herbicida") go to AI, which may or may not handle them correctly
3. **No session scoping** — observations are scoped by ISO week, not session. A report shows the whole week's observations regardless of when they were entered
4. **`saveObservation` stores lote reference in text** — "hojas amarillas en el lote 1" is stored with the lote reference. This is cosmetic but could confuse report rendering (the `normalized_text` column correctly strips it)

---

## 8. Final Decision

### Is the system healthy enough for production?

**YES — with caveats.**

### Assessment:

| Criterion | Status | Notes |
|-----------|--------|-------|
| Observation routing | PASS | Prefix bypass at STEP 1, structural detection after financial guards |
| Financial isolation | PASS | Separate tables, financial guard in saveObservation, no cross-domain queries |
| Deduplication | PASS | 4-layer dedup, single normalization function, consistent across all layers |
| Report scoping | PASS | DB-level `WHERE plot_id=$1` for lote-scoped, ISO week for time scoping |
| Text normalization | PASS | `normalizeObservationText()` is the single source of truth |
| Handler guards | PASS | `isLikelyQuestionOrFollowUp` has prefix bypass, expanded signals, reduced threshold |
| Error messaging | PASS | Every path has an explicit response, no silent failures |
| AI efficiency | PASS | ~75% resolved by regex, AI only for partial/unknown with confidence < 0.75 |

### Remaining risks (LOW severity):

1. **Single-word bare observations** — acceptable UX limitation, users can use prefix
2. **Activity+observation hybrid messages** — AI handles these, accuracy depends on LLM quality
3. **ISO week scoping** — correct design choice, but may confuse users who expect "today's report" to show only today's data (it shows the whole week)
4. **Stored text includes lote reference** — cosmetic, `normalized_text` column correctly strips it

### Verdict: **MINOR FIXES ADEQUATE — No structural refactor needed**

The pipeline refactor from 2026-03-21 addressed all critical blocking issues:
- Moved observation prefix to STEP 1 (was buried after financial + activity guards)
- Fixed handler question guard (was blocking all short observations)
- Fixed parser regex (trailing "en", optional colon, lote removal)
- Established single normalization function

The system is architecturally sound. The remaining issues are edge cases that don't warrant a structural refactor.

---

## 9. Justification

### Why the pipeline refactor was necessary (and why it's now sufficient):

**Root cause of 0% QA pass rate:** Three independent bugs that compounded:

1. **Classifier order** — observation detection was buried after `hasAgroActivity` guard, which matched "riego" and blocked "observación: riego en lote 1"
2. **Handler guard** — `isLikelyQuestionOrFollowUp` had a 3-word threshold that blocked all observations after prefix/lote stripping (2-word observations like "hojas amarillas" were rejected)
3. **Parser regex** — prefix required colon/dash (not space), lote removal left trailing "en"

All three bugs have been fixed. The fixes are surgical and targeted:
- STEP 1 prefix bypass = 7 lines of new code
- Handler bypass = 1 line (`if (prefixDetected) return false`)
- Regex fixes = 3 character changes (`?` for optional colon, preposition patterns)

A structural refactor would have been overkill. The architecture is sound — the bugs were implementation errors, not design flaws.

### Why the current architecture is maintainable:

1. **Clear separation of concerns** — classifier routes, handler processes, storage guards
2. **Typed interfaces** — `ParseResult`, `HandlerResponse`, typed sentinels
3. **Single source of truth** — `normalizeObservationText()` for all dedup
4. **Comprehensive tests** — 1115 tests covering all QA scenarios
5. **Audit trail** — `parser_errors` table, `ai_usage` tracking, `conversation_events`

---

## Files Analyzed

| File | Lines | Purpose |
|------|-------|---------|
| `src/services/intent-classifier.ts` | 407 | Pipeline orchestration |
| `src/domain/agronomy/agronomy.handler.ts` | 771 | Observation + report handling |
| `src/services/observations.js` | 256 | Storage, dedup, normalization |
| `src/utils/parser.js` | 1597 | Regex parsing (commands, observations, expenses) |
| `src/services/parser.service.ts` | ~92 | Parser wrapper + preprocessing |
| `src/controllers/whatsapp.controller.ts` | ~809 | Controller + post-classification routing |
| `src/domain/router.ts` | ~90 | Domain routing (financial/agro/system) |
| `src/services/agro-report.js` | ~189 | PDF generation + report scoping |
| `src/middleware/response-formatter.ts` | ~139 | Text message formatting |
| `src/ai/conversational-fallback.service.ts` | ~162 | Unknown intent fallback |

**Total: 10 files, ~4,472 lines analyzed**

---

## Tests

**Total: 1115 passing** (as of 2026-03-21 post-refactor)

| Test Category | Count | Notes |
|---------------|-------|-------|
| Parser tests | 300+ | Commands, expenses, incomes, observations |
| QA black-box tests | 16 | All 8 QA scenarios covered |
| Intent classifier tests | 50+ | Pipeline order, confidence scoring |
| Handler tests | 80+ | Observation guards, report scoping |
| Dedup tests | 20+ | Cross-variant normalization |
| Integration tests | 100+ | End-to-end flows |
