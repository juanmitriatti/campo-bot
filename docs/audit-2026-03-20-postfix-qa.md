# Post-Fix QA Report — 2026-03-20

## Summary

Follow-up fixes addressing observation storage, dedup, prefix stripping, auto-detection, and UX consistency issues found in post-fix QA testing (session 21:38–21:57).

---

## 1. Bug Assessment vs Current State

### BUG C — Text Cleaning / Prefix Stripping

**Previous state:** `observation_text` stored with "observación:" prefix intact. `normalizeObservationText` only stripped it for dedup (via punctuation removal), but raw stored text still contained the prefix.

**Root cause:** Three layers failed to strip the prefix:
1. `parsearObservacion()` in `parser.js` — extracted `observationText` without removing "observación:" prefix
2. `saveObservation()` in `observations.js` — stored raw `text` parameter as-is
3. `normalizeObservationText()` — removed colons via punctuation regex but left the word "observacion" in normalized text

**Fix applied:**
- `parser.js:1514` — Strip prefix with `/^(?:observaci[oó]n|obs|nota)\s*[:\-\u2014]\s*/i` at the start of `parsearObservacion`
- `observations.js:92` — Strip same prefix in `saveObservation` before any processing (defense-in-depth)
- `observations.js:60` — Strip "observacion/obs/nota" word in `normalizeObservationText` after accent removal

**Verification:**

| Input | Before Fix (observation_text) | After Fix (observation_text) |
|-------|-------------------------------|------------------------------|
| "observación: hay rama negra en lote 1" | "observación: hay rama negra en lote 1" | "hay rama negra en lote 1" |
| "obs: hojas amarillas en lote 3" | "obs: hojas amarillas en lote 3" | "hojas amarillas en lote 3" |
| "nota: plaga detectada" | "nota: plaga detectada" | "plaga detectada" |
| "hay malezas en lote 1" | "hay malezas en lote 1" | "hay malezas en lote 1" (unchanged) |

---

### BUG B — Deduplication / Cross-Variant Normalization

**Previous state:** Dedup worked for exact and case-insensitive matches. However, "observación: hojas amarillas" and "hojas amarillas" would normalize differently because the word "observacion" remained in the normalized form.

**Root cause:** `normalizeObservationText` removed the colon via punctuation regex but left the word "observacion" in the normalized output.

**Fix applied:** Added explicit prefix stripping step in normalization pipeline (before punctuation removal):
```
.replace(/^(?:observacion|obs|nota)\s*[:\-\u2014]?\s*/i, '')
```

**Verification:**

| Text A | Text B | Normalized A | Normalized B | Dedup? |
|--------|--------|-------------|-------------|--------|
| "observación: hojas amarillas" | "hojas amarillas" | "hojas amarillas" | "hojas amarillas" | YES |
| "Hojas Amarillas en lote 1" | "hojas amarillas" | "hojas amarillas" | "hojas amarillas" | YES |
| "obs: hay rama negra" | "hay rama negra" | "hay rama negra" | "hay rama negra" | YES |
| "HOJAS AMARILLAS" | "hojas amarillas" | "hojas amarillas" | "hojas amarillas" | YES |
| "hojas amarillas" (plot 1) | "hojas amarillas" (plot 2) | — | — | NO (different plot) |

---

### BUG D — Lote-Scoped Report Filtering

**Status: Already fixed in previous round.**

- `getWeekObservationsByPlot`: `WHERE o.plot_id = $1 AND EXTRACT(ISOYEAR...) AND EXTRACT(WEEK...)`
- `generate_agro_report` handler uses `filterPlotId` to scope all queries
- No session_id column exists on `agro_observations` — scoping is by plot + ISO week (no historical leak within current week)
- No financial data in `agro_observations` table (separate from `expenses`/`incomes`)

**Note on session_id:** The QA report requested `WHERE session_id = current_session`. This is not applicable because:
1. `agro_observations` has no `session_id` column
2. Domain separation is achieved via separate tables (not a `record_type` column)
3. Report scoping by ISO week + plot_id provides correct temporal and spatial isolation

---

### BUG E — Report Title

**Status: Already fixed in previous round.**

- WhatsApp text: `🌱 *Reporte agronómico — ${fieldName} > ${plotName}*`
- PDF header: `Campo: ${fieldName} > Lote: ${plotName}`
- Caption: `Reporte Agronómico — ${fieldName} > ${plotName} — Semana ${weekNumber}`

---

### BUG F — UX Consistency

**Previous state:** Dedup rejection message was "⚠️ Observación duplicada — ya registraste esta misma observación hace unos minutos." which didn't match the spec.

**Fix applied:** Changed to exact spec message: "Observación duplicada detectada"

---

### BUG G — Financial Data Isolation

**Status: Already fixed. No changes needed.**

Protection layers:
1. **Table separation:** `agro_observations` vs `expenses`/`incomes` — never queried together
2. **Financial content guard:** `hasFinancialContent()` blocks financial text from becoming observations
3. **No cross-domain JOINs:** agro report queries only touch `agro_observations`, `domain_events`, `plots`, `fields`
4. **Financial intent guard:** In intent classifier, financial messages are intercepted before observation detection

---

## 2. New Feature: Auto-Detect Observations Without Prefix

**Previous behavior:** `parsearObservacion` required a plot/field reference (e.g., "lote 1", "campo norte") to detect observations. Messages without location context (e.g., "hay rama negra") returned `null`.

**New behavior:** Added a third detection path in `parsearObservacion`:

```
1. Plot-level: text has "lote X" → type='plot', confidence=0.80
2. Field-level: text has "campo X" → type='field', confidence=0.80
3. Bare: text has agronomic keyword (non-'general' category) → type='bare', confidence=0.72
```

**Category keywords that trigger auto-detection:**

| Category | Keywords |
|----------|----------|
| malezas | maleza, rama negra, yuyo, sorgo de alepo, cardo, gramón, gramilla |
| sanidad | oruga, plaga, chinche, isoca, trips, arañuela, mosca, pulgón, bolillera, cogollero, bicho, enfermedad, hongo, roya, mancha |
| nutricion | nutrición, deficiencia, clorosis, amarill*, carencia |
| fenologia | estado fen*, V1-V12, R1-R8, fenolog, floración, llenado, emergencia, macollaje, espigazón, panojamiento |
| clima | helada, granizo, sequía, encharcamiento, estrés, viento, inundación |

**Safety:** Bare observations get lower confidence (0.72) than plot/field-scoped ones (0.80). The `'general'` category does NOT trigger auto-detection — prevents casual messages from being stored as observations.

**Guard chain preserved:**
1. Financial intent guard → blocks financial messages
2. Agro activity guard → forwards to AI for structured extraction (fumig, fertiliz, etc.)
3. Report intent guard → forwards to report commands
4. Only then: auto-detect observation

---

## 3. Files Modified

| File | Lines Changed | Change |
|------|--------------|--------|
| `src/utils/parser.js` | 1514, 1555-1565, 1591 | Strip prefix in parsearObservacion. Add bare observation path. Expand nutricion category. |
| `src/services/observations.js` | 60, 92 | Strip prefix in normalizeObservationText and saveObservation. |
| `src/domain/agronomy/agronomy.handler.ts` | 739-741 | Dedup message → "Observación duplicada detectada". |
| `src/services/intent-classifier.ts` | 208 | Bare observations confidence 0.72. |
| `src/utils/parser.test.js` | +14 tests | Prefix stripping, cross-variant dedup, bare auto-detect. |

---

## 4. Test Plan

### New Tests Added (14)

| Test Block | Count | Assertions |
|-----------|-------|------------|
| QA: observation prefix stripping | 4 | Prefix removed from observationText, plotName preserved |
| QA: normalizeObservationText cross-variant dedup | 4 | Prefixed and non-prefixed normalize identically |
| QA: bare observation auto-detection | 6 | Agro keywords → type='bare', casual messages → null |

### Verification Matrix

| Test Case | Input | Expected Result | Status |
|-----------|-------|----------------|--------|
| Prefix stripping | "observación: hay rama negra en lote 1" | observationText="hay rama negra", plotName="1" | PASS |
| Prefix stripping | "obs: hojas amarillas en lote 3" | observationText starts with "hojas", plotName="3" | PASS |
| Cross-variant dedup | "observación: hojas amarillas" vs "hojas amarillas" | Same normalized text | PASS |
| Cross-variant dedup | "Hojas Amarillas en lote 1" vs "hojas amarillas" | Same normalized text | PASS |
| Bare auto-detect | "hay rama negra" | type='bare', category='malezas' | PASS |
| Bare auto-detect | "hojas amarillas" | type='bare', category='nutricion' | PASS |
| Bare auto-detect | "presencia de roya" | type='bare', category='sanidad' | PASS |
| Bare auto-detect | "helada fuerte" | type='bare', category='clima' | PASS |
| Bare auto-detect (negative) | "hola como estas" | null (no agro keywords) | PASS |
| Bare auto-detect (negative) | "buen dia" | null (no agro keywords) | PASS |
| Lote-scoped report | "reporte agronómico lote 1" | generate_agro_report, plotName="1" | PASS |
| Report title | lote-scoped report | "Campo > Lote" format | PASS |
| Financial isolation | "gasté 5000 en gasoil" | hasFinancialIntent=true, NOT observation | PASS |
| Dedup message | duplicate observation | "Observación duplicada detectada" | PASS |

### Tests: 1099 passing (+14 new)

---

## 5. Data Processing Pipeline (Updated)

```
User message
  │
  ├─ stripFillerPhrases() — audio cleanup
  ├─ preprocess() — normalize, fixTypos, expandNumbers, applySynonyms
  │
  ├─ detectDomainIntent("observación:...") → bypass all guards
  │   └─ parsearObservacion() → strips prefix → extracts plot/field → returns observationText
  │
  ├─ Financial intent guard → blocks financial messages
  ├─ Agro activity guard → forwards to AI (fumig, fertiliz, etc.)
  ├─ Report intent guard → forwards to report commands
  │
  ├─ parsearObservacion() (auto-detect path)
  │   ├─ Plot detected → type='plot', confidence=0.80
  │   ├─ Field detected → type='field', confidence=0.80
  │   └─ Agro keyword only → type='bare', confidence=0.72
  │
  └─ saveObservation()
      ├─ Strip prefix (defense-in-depth)
      ├─ hasFinancialContent guard
      ├─ normalizeObservationText() — strips prefix, accents, punctuation, location
      ├─ In-memory dedup (5min cache)
      ├─ DB dedup (5min window, normalized_text + plot_id + user_id)
      └─ INSERT INTO agro_observations (clean text stored)
```

---

## 6. No DB Migration Required

All fixes are application-level. No schema changes needed:
- `agro_observations` table unchanged
- No new columns or indexes required
- Existing data is not modified (constraint: "do not touch historical data")
