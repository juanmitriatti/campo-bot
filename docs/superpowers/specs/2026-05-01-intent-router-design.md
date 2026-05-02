# Intent Router — Design Spec

**Date:** 2026-05-01
**Status:** Approved (brainstorm) — pending implementation plan
**Author:** Architecture audit follow-up

## Goal

Insert a deterministic pre-agent intent router between the trivial-command bypass and the Claude agent in `src/services/intent-classifier.ts`. The router catches a small set of high-confidence query intents and routes them straight to existing domain handlers, eliminating the corresponding Claude API calls without changing user-visible behavior.

Estimated savings: 25–35% reduction in agent calls in steady state. Risk: low, contingent on strict matcher policy and a kill switch.

## Problem

Today every non-trivial message hits the Claude agent with the full system prompt, tool definitions, and 5 few-shot examples. Several high-frequency intents do not need natural-language reasoning:

- Weather queries (`clima en X`)
- Listing fields/plots (`mis lotes`, `qué campos tengo`)
- Active crop queries (`qué cultivo tiene el lote norte`)
- Simple financial reports (`gastos del mes`, `gastos del campo X`)
- Repeated identical queries (especially weather, where multiple users in the same locality ask the same thing)

These can be matched deterministically with regex + existing services (`ParserService`, `LocalidadLookupService`) and dispatched directly via `DomainRouter`, which already routes those commands.

## Decisions made during brainstorm

| # | Decision |
|---|----------|
| 1 | **Scope of financial reports**: ultra-obvious (`gastos del mes`, `cómo vamos`) PLUS named field/plot (`gastos del campo X`). Excludes arbitrary date ranges. |
| 2 | **Cache**: only `weather_full(city, date)`. In-memory LRU, TTL 1h, max 200 entries. No per-user caches in this iteration. |
| 3 | **Risk policy**: strict matchers — must consume the full message, no leftover text with verbs. Plus new feature flag `INTENT_ROUTER_ENABLED` (default `true`) for hot kill switch. |
| 4 | **Tests**: unit tests for matchers + cache, three new eval scenarios verifying `aiUsed=false` end-to-end, plus structured `INTENT_ROUTER:` log lines. No new metrics dashboard yet. |
| 5 | **Architecture**: separate `src/services/intent-router.ts` module rather than inlining in the classifier or extending the parser. |

## Architecture

```
intent-classifier.ts  (orchestrator)
  STEP 1   observation prefix       — existing
  STEP 2   trivial commands         — existing
  STEP 2.5 IntentRouter.route()     ← NEW
            │
            └─→ src/services/intent-router.ts  (NEW)
                  ├── matchers (pure functions, no state)
                  │     ├── matchWeather()
                  │     ├── matchListFields()
                  │     ├── matchListPlots()
                  │     ├── matchActiveCrop()
                  │     └── matchFinancialReport()
                  └── (cache lives in handler, not router)

  STEP 3a  Claude agent             — existing (fallback)
  STEP 3b  JSON extractor           — existing
  STEP 4   regex chain              — existing
```

**Insertion point**: between line 157 and 162 of `intent-classifier.ts`, after `classifyTrivial`, before reading `AGENT_ENABLED`.

**Routing decision**: `IntentRouter.route()` returns `ParseResult | null`.
- `ParseResult` → classifier returns immediately, agent is skipped.
- `null` → classifier continues to STEP 3a (agent) as today.

**Kill switch**: setting `INTENT_ROUTER_ENABLED` (default `true`). When `false`, classifier skips STEP 2.5 entirely; new code stays dormant.

**No changes** to: `DomainRouter`, handlers (except for the weather cache injection), tool definitions, agent prompt, eval framework. The five target commands (`weather_full`, `list_fields`, `list_plots`, `active_crop`, `financial_report`) are already routed by `src/domain/router.ts`.

## Components

### `IntentRouter`

```ts
// src/services/intent-router.ts
class IntentRouter {
  constructor(
    private parser: ParserService,
    private localidadLookup: LocalidadLookupService,
  ) {}

  async route(text: string, userId: UserId, settings: UserSettings): Promise<ParseResult | null> {
    if (!(await getSettingBool('INTENT_ROUTER_ENABLED'))) return null;

    const cleaned = stripFillerPhrases(text);

    if (COMPOUND_ACTION_PATTERN.test(cleaned)) {
      console.log(`INTENT_ROUTER: skipped reason=compound user=${userId}`);
      return null;
    }

    try {
      return this.matchWeather(cleaned, userId)
          ?? this.matchActiveCrop(cleaned)
          ?? this.matchFinancialReport(cleaned)
          ?? this.matchListPlots(cleaned)
          ?? this.matchListFields(cleaned);
    } catch (err) {
      logError('intent-router', 'MATCH_FAILED', err as Error, { userId, text });
      return null;
    }
  }

  // private matchers...
}
```

Each matcher returns `ParseResult` with `confidence: 0.95`, `aiUsed: false`, `source: 'command'` — same shape as trivial commands.

### Matchers — regex policy

All matchers use anchored regex (`^…$`) and reject leftover text. If a matcher would extract args but the rest of the message contains agro verbs, amounts, or `y + verb`, it returns `null`.

| Intent | Pattern (sketch) | Args | Strict guards |
|---|---|---|---|
| **weather** | `^\s*(?:qué\s+)?(?:clima\|tiempo\|pronóstico\|va\s+a\s+llover\|lluvia\|temperatura)\s+(?:en\|de)\s+([\w\s\-]+?)\s*\??$` | `city` | Validate against `localidadLookup`; if not found → null. Reject if rest contains agro verbs or > 60 chars. |
| **list_fields** | `^\s*(?:cuáles\|qué)?\s*(?:son\s+)?(?:mis\|los)?\s*campos\s*\??$` and variants (`listar campos`, `mostrar campos`, `qué campos tengo`) | — | Whole message. |
| **list_plots** | Same with `lotes`. Optional `en <field>` capture. | `field?` | Whole message. |
| **active_crop** | `^\s*qué\s+(?:cultivo\|sembré\|tengo\s+sembrado).*?(?:lote\|campo)\s+([^?]+?)\s*\??$` | `plot` or `field` | Reject if message contains registration verbs (sembré, coseché, fumigué). |
| **financial_report (month)** | `^\s*(?:gastos\|ingresos\|cómo\s+vamos\|resumen\|reporte\s+financiero)\s+(?:de\|del)\s+(este\s+mes\|el\s+mes\|<month_name>)\s*\??$` | `dateRange` | No field/plot name; no number. |
| **financial_report (field/plot)** | `^\s*(?:gastos\|ingresos\|reporte)\s+(?:de\|del\|en)?\s+(campo\|lote)\s+(.+?)\s*\??$` | `field` or `plot` | No number (a number means it's a registration). |

**Cases that must continue to reach the agent** (verified by negative tests):
- `fumigué soja en lote norte` — agro verb
- `gasté 50mil en gasoil` — amount
- `clima en pergamino y agregar lote` — `COMPOUND_ACTION_PATTERN`
- `gastos del lote norte la semana pasada` — out-of-scope range

### `WeatherCache`

```ts
// src/services/weather-cache.ts
class WeatherCache {
  private map = new Map<string, { result: any; expiresAt: number }>();
  private maxSize = 200;
  private ttlMs = 60 * 60 * 1000;

  get(city: string, dateAR: string): any | null;
  set(city: string, dateAR: string, result: any): void;
}
```

Key: `${cityNormalized}|${dateAR}` (date in Argentina timezone).

**Important**: cache is consulted by the **weather handler** at execution time, not by the router. This way `weather_full` benefits from caching whether the call originates from the router or from the agent. Lives in process memory; cleared on redeploy (acceptable).

## Data flow

### Happy path (weather)
```
"clima en pergamino"
  → IntentClassifier.classify()
      STEP 1 obs prefix         → no
      STEP 2 trivial commands   → no
      STEP 2.5 IntentRouter.route()
        - COMPOUND check        → no
        - matchWeather()
          - regex match → city="pergamino"
          - localidadLookup.find("pergamino") → ✓
          - return ParseResult{ command: "weather_full", city, confidence: 0.95 }
      → return immediately (no Claude call)

  → DomainRouter → AgronomyHandler.weather_full()
      WeatherCache.get("pergamino", "2026-05-01")
        HIT  → return cached, log "WEATHER_CACHE: hit"
        MISS → fetch API → cache.set → log "WEATHER_CACHE: miss"
```

### Defer-to-agent paths
- Compound message → `COMPOUND_ACTION_PATTERN` matches → `null`.
- Unknown city → `localidadLookup` returns nothing → matcher returns `null`. Agent can ask for clarification or use `user.city`.
- Out-of-scope range → matcher returns `null`. Agent handles.
- Matcher throws → caught, logged via `logError`, returns `null`.

### Error handling

`IntentRouter.route()` wraps the matcher chain in try/catch. Any failure logs and returns `null`, so the pipeline degrades to the existing agent path. **The router never breaks the pipeline.**

`WeatherCache` is in-memory only; if the `Map` operation somehow failed the handler would skip the cache and call the API directly. Cache failures are not user-visible.

### Observability

Structured stdout logs (read via `railway logs`):

```
INTENT_ROUTER: matched=weather user=42 ms=2
INTENT_ROUTER: matched=list_plots user=42 ms=1
INTENT_ROUTER: skipped reason=compound user=42
INTENT_ROUTER: skipped reason=invalid_city city=saraza user=42
WEATHER_CACHE: hit city=pergamino date=2026-05-01
WEATHER_CACHE: miss city=pergamino date=2026-05-01
```

Initial hit-rate measurement: `railway logs --deployment | grep "INTENT_ROUTER:" | sort | uniq -c`.

## Testing

### Unit — `src/services/intent-router.test.ts` (~60 cases)

**Block 1 — positive matches**: weather variants, field/plot listings, active crop queries, financial report variants. Verify args extracted correctly.

**Block 2 — must NOT match**: compound, agro verbs, amounts, invalid cities (mocked `localidadLookup`), questions without city, out-of-scope ranges, very long messages, empty/punctuation-only input.

**Block 3 — kill switch + error handling**: `INTENT_ROUTER_ENABLED=false`, matcher throws, `localidadLookup` throws.

### Unit — `src/services/weather-cache.test.ts` (~10 cases)
Hit, miss, post-TTL expiry, LRU eviction at capacity, key normalization (case, accents).

### Eval — three new scenarios in `src/testing/scenarios/`

| File | Inputs | Key assertions |
|---|---|---|
| `19-router-weather.json` | `clima en pergamino` (×2, second should be cache hit) | bot responds correctly; both calls `aiUsed=false` |
| `20-router-list.json` | `mis lotes`, `qué campos tengo` | bot lists correctly; both `aiUsed=false` |
| `21-router-financial.json` | `gastos del mes`, `gastos del campo La Esperanza` | bot responds with totals; both `aiUsed=false` |

New assertion: `aiNotInvoked()` — reads last `conversation_logs.ai_used` for the test user, fails if `true`.

### Regression coverage
- `npm test` (1240 unit tests) — must stay green.
- `npm run eval` (18 existing scenarios) — must stay green.

## Acceptance criteria

1. New unit tests pass (~70 cases).
2. Full `npm test` suite at 0 failures.
3. `npm run eval` at 18/18 green.
4. Three new router eval scenarios pass.
5. Smoke test: with `INTENT_ROUTER_ENABLED=false`, the pipeline behaves identically to the current main branch.
6. Structured `INTENT_ROUTER:` log lines visible in Docker and Railway logs.

## Out of scope (deferred to future iterations)

- Per-user caches for `list_fields` / `list_plots` / `active_crop` (need invalidation on writes).
- Redis-backed shared cache.
- Arbitrary date-range financial reports.
- Mixed queries (`gastos del campo X de marzo`) — agent handles these.
- In-memory hit-rate counter or admin dashboard panel.
- Embedding-based fallback for the conversational `unknown` intent.
- Rules for `query_plot_history` shortcut (already partially handled by trivial set).
