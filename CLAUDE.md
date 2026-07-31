# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

campo-bot is a WhatsApp and Telegram-based agricultural management assistant for Argentine farmers (entirely in Spanish). It uses an AI-first parsing pipeline with two modes — **AI Agent (tool_use)** and legacy **JSON extraction** — with regex fallback, storing data in PostgreSQL.

---

## Invariantes (P0 — no romper NUNCA)

Cada una de estas reglas existe porque su violación ya causó pérdida o corrupción de datos. El relato completo de cada bug está en [docs/history/2026-hardening-log.md](docs/history/2026-hardening-log.md).

1. **Nada se descarta en silencio.** Toda capa que consume, dropea, reescribe o vetea un mensaje o tool-call DEBE loguearlo (`[INTERCEPT]`, `AI_VALIDATOR DROP`, `AI_MAPPER DROP`, `ROUTER NULL`). Un veto silencioso es indistinguible de "nunca pasó" — fue la raíz común de 5 bugs de prod en una sola ronda.
2. **Comando nuevo = 3 registros**: schema en `src/ai/tool-definitions.ts` + el `*_COMMANDS` set correcto en `src/domain/router.ts` + el switch del handler. Si falta uno, `routeCommand` devuelve null y falla en silencio.
3. **Una sola normalización de nombres de entidades**: todo matching de lote/campo/corral pasa por `src/utils/entity-matcher.ts`. NUNCA otra normalización inline — la divergencia previa (8 implementaciones) perdió datos.
4. **Sinónimos conversacionales solo en `src/utils/lexicon.ts`** (correction cues, monedas incl. slang, unidades de dosis, cópulas, verbos de borrado). Nunca en regexes de handlers.
5. **Ninguna pregunta al usuario es texto suelto**: siempre pending machine-readable (`setPendingActivity` con `missing[]`) o botones. Una pregunta huérfana por `respond_text` pierde la respuesta o la corrompe (una vez editó un gasto ajeno).
6. **Nunca repetir la misma pregunta más de 2 veces** — la escalera de escalamiento (razón+desenvenenado → attempts → rescate por agente) es central y cubre todos los dominios.
7. **Compound nunca frena a mitad**: todo dentro de `withTransaction` (todo-o-nada). En bulkMode los handlers NO bloquean (no `startFlow` / no `setPending*`) — el interceptor del executor es la red de seguridad.
8. **Todo lo que valida output del agente valida contra el texto EXPANDIDO** (`agentInputText`), nunca el original — el validator una vez vetó el lote que nuestro propio pronoun-expander inyectó.
9. **Side-effects siempre via `applySideEffects(response.sideEffects, phone)`** — nunca aplicar un `setPending*` a mano en un branch. Keys nuevas se agregan AHÍ.
10. **Todo pending nuevo usa `TypedPendingStore`** (nunca un Map suelto ni clase ad-hoc) y sobrevive restarts vía `PendingMirror` + hydrate.
11. **PlotDiscoveryService es lookup-only** — jamás auto-crea campos/lotes.
12. **Plan futuro ≠ registro**: "el sábado fumigo" / "acordame de pagar X" → `create_reminder`, JAMÁS log_spraying/log_expense/sow_crop. Registrar un plan como hecho corrompe datos.
13. **Nunca inferir el cultivo** que el usuario no nombró: el agente omite el param (prohibido inferir de active_crop/siembras pasadas) y el handler pregunta con pending.
14. **Todo bug de interacción entre capas del pipeline deja su regresión en `pipeline.integration.test.ts`** (harness FakeAgent, sin API), no solo en el eval (que cuesta créditos y flakea).
15. **Todo "borrar estado de usuario" pasa por `clearAllUserPendingState`** (registro central de stores) — una lista manual de stores se desactualiza y deja estado zombie.

---

## Commands

- `npm start` — Run the app (`node src/index.js`), listens on port 3000
- `npm test` — Run all tests (`vitest run`)
- `npx vitest run src/utils/parser.test.js` — Run a single test file
- `docker compose up --build` — Start app + PostgreSQL (port 5433 for DB, 3000 for app)
- `docker compose up -d db` — Start only the database
- `cd frontend && npm run dev` — React frontend dev server (port 5173, proxies API to :3000)
- `cd frontend && npm run build` — Build frontend (output: `frontend/dist/`)
- `cd landing && npm run build` — Build landing page (output: `landing/dist/`)
- `npx tsx src/scripts/create-admin.ts --email <e> --name <n> --password <p>` — Bootstrap admin user
- `npx tsx src/scripts/seed-dummy-data.ts --user-id <id> [--reset]` — Seed dummy data
- `npx tsx src/scripts/run-migrations.ts` — Manually run pending DB migrations (auto-runs on startup)
- `npm run eval` — Conversational eval (25 scenarios against local Docker, real pipeline + DB)
- `npm run eval:verbose` — Same with step-by-step detail
- `npx tsx src/testing/run-eval.ts --scenario basic-expense` — Run a single eval scenario

## Message Processing Pipeline

Orchestrated by `src/services/intent-classifier.ts`:

1. **Observation prefix** — "observación:" bypasses AI entirely
2. **Trivial commands** — ~35 commands skip AI (confirm, cancel, greeting, help, menu). `generate_agro_report` is NOT trivial. `COMPOUND_ACTION_PATTERN` accepts `y`/`e`/`,`/`;` as separators so compounds don't slip into the trivial bypass.
3. **AI primary** — Two modes via `AGENT_ENABLED`: `true` → `agent.service.ts` (tool_use, compound actions) | `false` → `intent-extractor.ts` (JSON extraction, legacy)
4. **Regex fallback** (`src/utils/parser.js`) — When AI disabled/failed/low-confidence
5. **Conversational fallback** — Lightweight Claude call for unknown intents (only when AGENT_ENABLED=false). Includes recent history (1500-char budget).

Kill switches: `AGENT_ENABLED=true` → agent | `AGENT_ENABLED=false` + `AI_INTENT_ENABLED=true` → JSON | Both false → regex-only

**Compound actions**: N tool_use blocks in one response → `CompoundExecutor` runs them sequentially inside `withTransaction`, `bulkMode = actionable.length >= 2`. See "Compound Actions & bulkMode" below.

**Server-side determinism layers** (run before/after the agent so Haiku sees unambiguous input — the agent prompt alone applied these rules inconsistently):
- **Pronoun expansion** (`src/utils/pronoun-expander.ts`, STEP 2.6): "ahí mismo / ese lote / el de antes" → `"en lote <name>"` from `conversation_state.plot_name`; "el otro lote" → second-most-recent plot from `context_stack` ("el otro día" temporal excluded). Logs every expansion.
- **Relative dates** (`src/utils/relative-dates.ts`): "ayer / anteayer / hace N días / anoche / la semana pasada / el finde / el lunes" → ISO date AR-local, filled by the mapper for `TOOLS_WITH_DATE_PARAM` when the agent omits `event_date` (and OVERRIDES on weekday phrases — the agent lands them +1). `FUTURE_INTENT_RE` suppresses weekday resolution for plans ("el sábado cosecho" → reminder, not last Saturday; explicit "pasado" always wins).
- **Context stack** (`conversation_state.context_stack`, JSONB): last 3 field/plot references, LIFO deduped, updated on every `updateConversationState()` — queries update it too (`handleFinancialReport`), not just writes. Exposed to the agent as "contextos recientes:[...]".
- **Output validator** (`src/ai/agent-output-validator.ts`): strips crop/plot/field the agent inferred without backing in the (EXPANDED — invariante 8) user text. Accepts all crops in multi-crop compounds and partial plot-name tokens ("el norte" validates "Lote Norte Grande"). Every strip logs `AI_VALIDATOR DROP`.

## AI Agent Disambiguation Rules

Implemented in `src/ai/agent-prompt-builder.ts`; drive tool selection.

### Plot Resolution
- User doesn't mention field/plot → agent omits params → system auto-resolves if user has exactly 1 plot. `_resolveBoth()`: field found but plot not → auto-resolve when field has exactly 1 plot.
- Campaign close buttons only appear after `harvest_crop`, NEVER after other activities.

### Activity vs Expense
- Agro verb (fumigué, sembré, coseché, fertilicé) WITHOUT explicit amount → activity tool, NEVER `log_expense`
- Agro verb WITH explicit amount → BOTH activity + `log_expense` (compound)
- compré/gasté + insumo → `log_expense` (type=insumo) | vendí/cobré → `log_income`
- "a X c/u" / "a X el kg" → `unit_price` (both expense and income)

### Hectáreas vs Hacienda
- "has"/"hectáreas"/"superficie" + campo → `list_plots` (NOT livestock) | "hacienda"/"vacas"/"novillos" → livestock tools

### Crop / History Queries
- "soja?" / "qué cultivo tiene el lote" / "has sembradas" → `active_crop` (NOT `list_plots`)
- "cuándo se fumigó/sembró" → `query_plot_history` (NOT activity registration)

### Financial Queries
- "gastos/ingresos en/del lote X" (no amount) → `financial_report(plot=X)` — NEVER `log_observation`. "gastos campo X" → `financial_report(field=X)`.

### Livestock
- "N vacas con N terneros" → 2x `add_livestock` (NEVER `record_livestock_birth`). Birth verbs only (nacieron/parieron) → `record_livestock_birth`.
- "pasé N terneros a novillos" → `transfer_livestock` (recategorización). Handler auto-resolves source/destination when unambiguous.
- `add_livestock`/`remove_livestock` with `unit_price_ars|usd` → auto-creates linked expense/income (category "Hacienda", `linked_expense_id`/`linked_income_id`).
- **add_livestock SIN ubicación**: el agente llama la tool igual omitiendo plot/corral (ubicación ambigua NO es dato de negocio faltante — invariante 5: nunca preguntar por respond_text). El handler resuelve determinísticamente vía `livestockLocationIntent()` (`src/utils/livestock-location-intent.ts`): ambiguo → botones [🌾 En un lote]/[🏗️ En un feedlot]; feedlot explícito → directo (autocrea feedlot+corral si no hay). Backstop: `reconstructFromOpenLocationQuestion` en intent-classifier re-arma "`<msg>` en lote X" si el usuario contesta una pregunta abierta sin pending.
- **Precio diferido**: "¿a cuánto fue la compra/venta?" deja pending `set_livestock_price` (missing:['unit_price']). También es tool del agente para el precio tardío sin pending ("los toros salieron 2 palos c/u") → `findLatestUnpricedMovement` (7 días).
- Category lookup matchea gemelas de género (ternero↔ternera); con 0 matches pero hacienda existente, el error lista el inventario real para auto-corrección.
- Los 9 write paths de hacienda llaman `bumpConversationContext` cuando el lote vino del grupo — si no, "ahí mismo" resuelve al lote equivocado.

### Sanidad Animal
- vacuné/desparasité/curé/traté → `log_health_event` (vacunacion/desparasitacion/tratamiento; revisé=revision_sanitaria). `disease_or_vaccine` + `dose_quantity`/`dose_unit`.
- "cuándo se vacunó" / "historial sanitario" → `query_health_events`. NEVER `log_observation` for livestock health.

### Reproducción
- eché el toro/entore/servicio → `log_repro_event(servicio)` | desteté → `(destete)` (NOT `remove_livestock`) | inseminé/IA/IATF → `(inseminacion)` | detecté celo → `(deteccion_celo)`. `sire_info` for bull details, `method` for insemination.
- "historial reproductivo" / "destetes del año" → `query_repro_events`

### Pesaje
- pesé/pesaron + kg → `log_weighing`. Weight is ALWAYS average per animal, not total. `animals_weighed` for count.
- "cuánto pesan" / "GDPV" / "último pesaje" → `query_weighings`

### Weather
- "clima/pronóstico/va a llover en X" → `weather_full(city=X)`. NEVER fall back to user.city if query mentions a city. `localidadLookup` disambiguates (Ameghino Bs As vs La Pampa).

### Recordatorios (migración 098)
- **Plan futuro ≠ registro (invariante 12)**: "el sábado tengo que fumigar" → `create_reminder(description, due_date)`. "mis recordatorios" → `list_reminders` (trivial regex). "listo/cancelá el recordatorio" → `complete_reminder` (pero "fumigué X" = actividad normal). `reminder.service.ts` usa `resolveFutureDate` (SIEMPRE hacia adelante, al revés de relative-dates). Los campos description/due_date/cancel necesitan mapeo explícito en agent-response-mapper.

### Grano por acopiador
- "cuánta soja tengo en Cargill" → `query_harvest_loads(destinatario, view:'aggregate')` — grano ENTREGADO, NUNCA `check_stock` (insumos propios). "cuánto entregué a cada acopio" → `group_by:'destinatario'`. Patrones en docs/ai/query-patterns.md (fuente de verdad).

### Pizarra de granos
- "pizarra" / "a cuánto está la soja" → `grain_prices(crop?)` — precio de MERCADO (Matba-Rofex), NUNCA `active_crop` ni `financial_report` ("a cuánto VENDÍ"). `src/services/grain-price.service.ts`, caché 30 min, regex trivial anclado (no roba "vendí soja a 320"). Permitido con trial vencido. Soja/maíz/trigo (el resto → mensaje honesto).

### Onboarding — primera acción diferida
- Un write que rebota por "no tenés campos/lotes" emite `sideEffects.setDeferredFirstAction={originalText}` → el wrapper de `processTextMessage` re-inyecta el texto cuando el usuario ya tiene campo+lote ("🔁 Retomo lo que me habías pedido"). Consumo antes del replay (no loopea); las recursiones internas usan `processTextMessageInner`.

### Tips contextuales (migración 099)
- Tras la primera acción exitosa de cada tipo, UN tip enseña una capacidad relacionada. Catálogo en `src/services/tips-catalog.ts` (agregar tips AHÍ), motor `tip-engine.ts`. Solo acciones exitosas, tope `TIPS_MAX_PER_DAY`, una vez por usuario, features gateadas vía FeatureGate, usuarios `testbot_*` EXCLUIDOS. Kill switch `TIPS_ENABLED`; opt-out "no más tips" → `disable_tips`.

### Pending field-city escape hatch
- `looksLikeNonCity()` aborta el loop de "¿En qué localidad?" cuando el usuario tipea algo que no es localidad (verbos agro, listas con `:`, queries con `?`, >60 chars, SQL keywords, comas múltiples CON dígitos — "Pergamino, Buenos Aires, Argentina" sí resuelve). Add new escape patterns HERE, not in the agent prompt.

### Crop synonyms (anglicismos)
- `src/utils/synonyms.js` + `normalizeCropName()`: soybean→soja, corn/maize→maíz, wheat→trigo, sunflower→girasol, sorghum→sorgo, barley→cebada, oat→avena, cotton→algodón, rye→centeno. Applied in BOTH regex parser and agent input normalization.

### Stock + Expense compound
- `add_stock` con `unit_price_ars|usd` → handler auto-crea gasto vinculado (best-effort: stock succeeds even if expense fails). Prompt rule: NO llamar `log_expense` por separado.

### Corrections (mid-flow / mid-confirmation)
- Amount: "no, eran X" / "en realidad X" / "quise decir X". Category: "no, es X" / "no, era en X" (restringido a palabras-categoría vía `looksLikeCategoryWord` para no chocar con correcciones de lote, que `correction-classifier` intercepta antes). Name: "se llama X, no Y". Extractors en `conversation-engine.ts`.
- **Pending-correction interceptor**: con pending expense/income activo, el pipeline intercepta estos patrones ANTES de clasificar — patch in-place + re-render de la confirmación, sin round-trip al agente.

### Misc agent behavior
- **Truncation**: `AgentResult.truncated` (stop_reason=max_tokens) → "⚠️ El mensaje era largo y se cortó...". Log `AI_AGENT TRUNCADO:`. Bump `AGENT_MAX_TOKENS` (default 1500) si es frecuente.
- **Stage codes** (`stage-code-validator.ts`): valida `stage_code` vs `crop` (soja V1-V8/R1-R8, maíz hasta V21/VT/R6, trigo/cebada Zadoks, girasol, sorgo). Non-blocking: guarda + warning.
- **Multi-day rainfall**: N `log_rainfall` en compound sin campo → `consolidateRainfallPrompts()` colapsa en un solo prompt con callback `rain_batch_*` → `log_rainfall_batch` persiste todo junto. El regex parser ignora lluvias compuestas a propósito.
- **Units**: kg, lt, cc, tn, qq (=100 kg), bolsas, kg/ha, lt/ha. `normalizeToKg()` en agent-response-mapper; acepta `t`/`ton` (antes defaulteaba a kg — error ÷1000).
- **Audio**: `DEFAULT_WHISPER_PROMPT` (vocabulario agro AR en contexto de frase) + capa determinística `STT_DOMAIN_CORRECTIONS` en `text-normalizer.js` — SOLO palabras sin sentido en español (cero falsos positivos; jamás palabras reales). Manglings nuevos van AHÍ. La mayoría de los "wrong tool" del path de audio son mala transcripción, no handlers.

### Harvest Loads
- ANY list of `nombre número` in cosecha context is `loads[]` (driver+weight required; destinatario/plate/humidity/quality optional). "Cosecha del lote X" WITHOUT driver/weight list → `query_harvest_loads`, NOT `harvest_crop`.
- `yield_kg_per_ha` (rate, "X kg/ha") vs `yield_kg` (total, "sacamos X tn") — mutually exclusive; handler computes total = rate × area.
- Dedup: same plot harvested today → appends loads (validates crop matches active crop). Loads with no active crop → warn user they were dropped.
- `humidity_pct` (0-50%) from "al 14%"; `quality_metrics` JSONB crop-specific (soja oil_pct, trigo protein/gluten/test_weight, girasol oil_pct) — SOLO si el usuario las mencionó, never invent.
- `query_harvest_loads` / `delete_harvest_loads` for stored loads; `campaign_stats` includes per-truck detail + `avgHumidity`.

### Reports
- "reporte agronómico" → `generate_agro_report` (needs agent for date range) | "reporte financiero"/"cómo vamos" → `financial_report` | "reportes"/"informes" genérico → `show_reports_menu`

### Crop Scouting
- Message has METRICS (stage code V3/R5/Z3, %, severity word, density) → `log_crop_scouting`. Free text without metrics → `log_observation`. Severity: ausente=1, leve=2, moderada=3, alta=4, severa=5.
- "cómo viene la sanidad" / "presión de plagas" / "monitoreos del lote X" → `query_scoutings` (NOT `query_plot_history`).

### Sow / Harvest crop
- `sow_crop` accepts `hectares` for partial-plot sowing.
- **Missing crop (invariante 13)**: `crop` is OPTIONAL in schema; agent omits it when not named. Handler sees placeholder → `setPendingActivity({missing:['crop']})` + "🌱 ¿Qué cultivo sembraste?". Next message → `extractCropFromText()` → re-run on match, re-ask on miss.

## Unified Pending Action System

One mechanism for multi-turn parameter completion (replaced 4 ad-hoc helpers):
- Handler detects missing required slots → `setPendingActivity({ command, data, missing: [...], askPrompt })`. Pipeline intercepts next message → `extractSlots(text)` (`src/middleware/slot-extractor.ts`, 12 slot types) → merge → re-route via `DomainRouter.routeCommand` when complete, or re-ask.
- Opted-in: log_spraying, log_fertilization, log_tillage, log_irrigation, log_health_event, add_stock, sow/harvest_crop (dual path with legacy `_needs:'crop'`).
- **Single-slot fallback**: one slot missing + extractor finds nothing → whole short message (≤60 chars) is the answer ("aftosa"). Guarded by `NON_ANSWER_RE` ("después te digo", "?" no son valores).
- **Escapes**: `isCancelIntent` clears; `detectsFinancialIntent` clears so the user can pivot mid-pending. Read-only queries (`isReadOnlyQuery`) get answered AND the pending is restored + re-asked.
- **Plot fallback**: `validatePlotAsync` calls `extractSlots()` as last resort ("era todo de maíz del lote B1").
- Known limitation: merge only fills NULL slots — a user contradicting an auto-resolved plot next-message won't override it.

### Escalera de escalamiento (invariante 6)
Tres niveles, todos centrales (cubren todos los pendings `missing[]` de todos los dominios):
1. **Razón + desenvenenado**: si el handler re-pide un slot que este turno llenamos, se limpia el valor rechazado del pending (fix del envenenamiento), se antepone la razón ("🤔 No encontré el lote «5b»...") y se loguea `[INTERCEPT] pending no-progress`. `buildAskPromptForMissing` reusa el askPrompt informativo del handler cuando el missing set no cambió.
2. **Loop-breaker**: `PendingActivity.attempts` (+ `lastRejected`) cuenta re-asks sin progreso; viaja por `applySideEffects` y el `PendingMirror`.
3. **Rescate por agente** (`escalatePendingToAgent`): con `attempts >= 2` el turno va al agente con el pending completo (hint `RESCATE DE PENDING` verbatim + tag `[contexto: ...]` inline para que el output-validator acepte los tokens que nosotros aportamos). Regresiones en `pipeline.integration.test.ts`.

## Compound Actions & bulkMode

**Contract**: N tools in one response → `CompoundExecutor` runs ALL, NEVER stops mid-stream, asks ONCE at the end for missing plot assignment.

**1. CompoundExecutor (`src/domain/compound-executor.ts`)**:
- `bulkMode = actionable.length >= 2`. Todo en `withTransaction`: one throw → rollback all + "❌ No pude registrar todas las acciones...".
- Pre-execution: dedup identical steps, writes-before-reads, consolidate same-field rainfalls.
- Passes `bulkMode` per step → router sets `cmd._bulkMode`.
- **Interceptor**: handler returns `startFlow`/`setPending*` in bulkMode → strip from immediate response. Recoverable `setPendingActivity` → CAPTURE into serial pendingQueue with context-tagged askPrompt. Non-recoverable → "💡 No pude completar X" advisory.
- Post-loop: bulk-plot prompt for `savedRecordsWithoutPlot[]`; `income_partial`/`expense_partial` (amount=0, no qty×price to compute — ALL of them, one queue item each) join the queue. First queue item promoted immediately, rest → `nextInQueue`.

**2. Handler bulkMode awareness** (save at field-level instead of blocking):
- `handleExpense`/`handleIncome`: `bulkMode && !plotId && fieldId` → save `plot_id=null` + emit `savedFinanceWithoutPlot`; confirm force-disabled.
- `add_field`: city ambiguous/missing en bulk → create NOW (first lookup match or no city) — el field_flow bloqueaba las tools siguientes.
- `log_observation`: multiple plots en bulk → `allowNoPlot=true`, save field-level + emit record.
- Other handlers fall back to the interceptor (record not saved, compound continues).

**3. Post-compound bulk-plot prompt**: records collected AND field has 2+ plots → buttons "¿A qué lote los asigno?" (one per plot + "Dejar a nivel campo"). Payload `bap2_<token>_<plotId>` → `assign_bulk_plot` updates across tables by kind (expenses, incomes, domain_events, agro_observations, crop_scoutings, rainfall, livestock_groups), user_id-scoped.

**4. Serial Pending Queue**: `PendingActivity.nextInQueue[]` — items wait for the current pending to complete (sin cola, una sola respuesta se aplicaba a TODOS los ítems y conflacionaba datos). Advance via `pending-queue-advancer.ts`: re-routed cmd set its own pending → append remaining queue to it; else pop next → new pending + askPrompt. Al re-rutear: `if (!merged.command) merged.command = pendingAct.command;` (los partials guardan command en el pending, no en data). Todos los write-sites de `setPendingActivity` copian `nextInQueue`.

**Mapper guard**: el filtro que dropea `log_expense`/`log_income` espurios junto a actividad agro hermana conserva calls con `qty>0 && unit_price>0` (computables) — solo chequear `amount > 0` mató compounds enteros.

**Few-shots**: `expected_output` soporta `{tool_calls:[...]}` para demos N-tool (una assistant turn, N tool_use + N tool_result). Rotación diaria `ORDER BY md5(id::text || CURRENT_DATE::text)`. `AGENT_FEW_SHOT_LIMIT` default 5, prod 15.

## Cross-cutting plumbing

- **Entity matching (invariante 3)**: `entity-matcher.ts` — `sqlNormalizedName()` (SQL) + `normalizeEntityName()`/`compactEntityName()` (espejo JS con test de paridad), `stripLeadingArticle()` (solo fallback), `entityNameCandidates()`.
- **Explicit plot intent** (`utils/plot-intent.ts`): `userExplicitlyReferencedPlot(text)` — la regla `FIELD_LEVEL_CATEGORIES` de `handleExpense` (strip del plot auto-resuelto para categorías corporativas) solo aplica cuando el usuario NO dio señal de lote (ni pronombre ni nombre).
- **Pending persistence**: los 4 stores clásicos + los 11 `TypedPendingStore` se espejan a `pending_states` (migración 097) vía `PendingMirror`; `hydratePendingStores(phone)` al entrar cada mensaje; tombstones 60s; sweep horario. TTL 30 min.
- **Per-user serialization** (`user-lock.ts`): mensajes del mismo usuario en orden, usuarios distintos en paralelo. In-process (single-replica).
- **Message idempotency** (`dedup.ts`): TTL 10 min sobre update_id/callback ids — un webhook retry de un audio lento duplicaba writes.
- **Button payloads**: Telegram limita `callback_data` a 64 bytes (excederlo = HTTP 400 silencioso, sin botones) → `bap2_*`/`rain_batch_*` usan token de `callbackPayloadStore` con fallback inline-base64. `assign_bulk_plot` reporta taps parcialmente stale ("⚠️ N registros ya no existían").
- **Pending hint**: mensaje que llega al agente con pending activo → `[Hay una pregunta pendiente...]` en el user prefix (zona no cacheada).

## AI Cost & Caching

- Settings grupo `ai` en admin: `AGENT_ENABLED`, `AGENT_MODEL`, `AGENT_MAX_TOKENS` (1500), `AGENT_TIMEOUT_MS` (12000, presupuesto TOTAL incl. retries), `AGENT_TEMPERATURE`, `AGENT_CACHE_TTL`, `AGENT_FEW_SHOT_LIMIT`.
- Prompt caching: 3 breakpoints (system, tools, last few-shot). Contexto de usuario + fecha via `buildUserMessagePrefix()` — NUNCA datos dinámicos en `coreRules()` (invalida el caché).
- `ai_usage` persiste 4 tipos de token; pricing Haiku 4.5: input 1.00 / cache read 0.10 / cache write 1.25 / output 5.00 por M. Log `AI_AGENT CACHE: Nread/Nwrite`.
- `ConversationHistoryService.getRecentTurns` agrega `[acciones ejecutadas: tool1, tool2]` a los turnos del bot (el agente sabe QUÉ se registró, no solo qué se dijo). LIMIT 40.
- **Admin AI Training** (`/admin → AI Training → Logs`): filtro "⚠️ Sospechosas" (respuesta vacía / "no entendí" / >8s / confidence <0.5) + bulk "Marcar OK/Mal" + "Promover" a training example. Workflow semanal recomendado con usuarios reales.

## Account Lifecycle & Billing

Gated by admin settings (ship dark, flip when ready):
- **Atomicity (always on)**: `src/config/db.js` hijacks `pool.query`/`pool.connect` via AsyncLocalStorage — inside `withTransaction(fn)` every query (47 files importing pool) runs on the same client; nested BEGIN/COMMIT become savepoints. Zero caller changes.
- **Channel verification (`REQUIRE_VERIFIED_CHANNEL`, migración 076)**: WA OTP + TG deep-link `t.me/<bot>?start=verify_<token>`. `ChannelVerificationService`; endpoints `/api/auth/verify/*`; controllers gate BEFORE user auto-create; Telegram intercepts `/start verify_*` before lookup. Grandfathers existing users.
- **GDPR (always on, migración 077)**: `DataExportService.streamUserExport` (ZIP, 23 CSVs, per-table failures isolated) + `AccountDeletionService.deleteAccount` (password gate, soft-delete + PII nulled in `withTransaction`; same email re-registrable). `GET /me/export`, `DELETE /me`.
- **MercadoPago (`PAYMENTS_ENABLED`, migración 078)**: `subscriptions` state machine (trial→active→past_due→cancelled/expired, partial unique = ONE non-terminal sub per user) + `payment_events` (idempotent via unique `(provider, provider_event_id)`). `SubscriptionService`: trial 14d on register, checkout, idempotent webhook, cancel (immediate trial / deferred paid), `sweepExpired` daily 03:15 AR. Webhook `/webhooks/mercadopago` mounted with `express.raw` BEFORE the JSON parser (HMAC needs original bytes). Settings grupo `payments`.

## Key Conventions

- ESM modules (`"type": "module"`) — `import`/`export`, not `require`
- All user-facing text in Argentine Spanish
- Currency: ARS (default) + USD; Argentine conventions (50mil = 50.000, medio palo = 500.000, palo = 1.000.000)
- Timezone: `America/Argentina/Buenos_Aires`. Helpers in `src/utils/date.ts`: `getNowArgentina()`, `getTodayISO()`, `formatDateAR()`.
- Soft delete: `deleted_at` on expenses, incomes, fields, plots
- Lotes (plots) = primary productive unit; Campos (fields) = grouping container
- AI calls plan-rate-limited (free=20, pro=100, pro_plus=300, enterprise=1000 daily)
- Observation guard: `isLikelyQuestionOrFollowUp()` prevents non-agro text from being saved as observations
- **Alertas proactivas (Jul 2026)**: reactivadas en cron, gateadas por `PROACTIVE_ALERTS_ENABLED` (admin grupo bot, default false — flip al arrancar el piloto) + opt-out por usuario (`user_settings.alerts_enabled`, migración 103, comandos triviales "no más alertas"/"dame alertas"). Gate central en `alert.service.js` (`isProactiveAlertType`): los 6 tipos proactivos (weather, monitoring_reminder, pest_escalation, missing_hectares, low_stock, phenology) chequean opt-out + llevan footer de baja; resúmenes/recordatorios NO se gatean. Skip loguea `[INTERCEPT]`.
- **Resumen mensual con tendencias (Jul 2026)**: bloque "📈 Tendencias" (movers por categoría vs mes anterior) — `src/services/monthly-insights.js` (puro, testeado) cableado en `buildMonthlyReport`. Config admin: `MONTHLY_INSIGHTS_ENABLED` + `MONTHLY_INSIGHTS_MIN_PCT`.

## Feature Gates

13 features toggleable per plan via admin UI. Bot commands, dashboard API (`requireFeature()`) and frontend all enforce gating.

| Feature Key | Required Plan | Scope |
|-------------|---------------|-------|
| `expenses` | all | log_expense, financial_report, templates, dashboard Gastos |
| `incomes` | all | log_income, income edits, dashboard Ingresos |
| `fields` | all | add_field, add_plot, add_plots_batch, etc. |
| `budgets` | all | set_budget |
| `rainfall` | all | log_rainfall(+batch), rainfall reports |
| `agronomy` | all | sow/harvest/spray/fertilize, observations, agro reports, campaign_stats |
| `csv_export` | pro+ | export_csv |
| `weather` | all | weather_full/forecast/field |
| `audio` | all | voice transcription |
| `sharing` | enterprise | share_field (accept_invite ungated) |
| `stock` | pro_plus+ | warehouses, add/check_stock, dashboard Stock |
| `documents` | all (daily limits vary) | upload/list_documents |
| `livestock` | pro_plus+ | inventory + health/repro/weighing, feedlots, dashboard Hacienda |

## Key File Map

### AI Pipeline
- `src/ai/agent.service.ts` — Claude tool_use agent (primary)
- `src/ai/tool-definitions.ts` — 98 tool definitions with typed schemas
- `src/ai/agent-prompt-builder.ts` — Compact system prompt with disambiguation rules
- `src/ai/agent-response-mapper.ts` — AgentResult → ParseResult[]; every drop/override logs (invariante 1)
- `src/ai/agent-output-validator.ts` — anti-hallucination layer (flags ON in prod), 15-test suite
- `src/ai/intent-extractor.ts` — JSON extraction (legacy fallback)
- `src/ai/few-shot.service.ts` — Training examples as tool_use triplets
- `src/ai/user-context.service.ts` — User fields/plots, 60s cache
- `src/ai/conversation-history.service.ts` — Multi-turn context (4000 char budget)

### Domain
- `src/domain/router.ts` — DomainRouter + `*_COMMANDS` sets (invariante 2)
- `src/domain/compound-executor.ts` — compound contract (see § Compound)
- `src/domain/interactive/interactive.router.ts` — button callbacks → commands
- `src/domain/agronomy/` | `financial/` | `livestock/` | `stock/` | `documents/` | `sharing/` | `feedlot/` — domain handlers
- `src/domain/auth/` — Auth + ChannelVerificationService + AccountDeletionService
- `src/domain/billing/` — Plans + FeatureGate + PaymentProvider/MercadoPago + SubscriptionService

### Pipeline & Middleware
- `src/services/message-pipeline.ts` — **THE pipeline** for the 3 channels (`ChannelContext`): `processTextMessage` + `handleInteractiveReply` + `applySideEffects` (invariante 9) + pending-store singletons. Controllers are thin channel adapters (~400 LOC each: whatsapp/telegram/test-bot).
- `src/services/document-pipeline.ts` — shared document processing (facturas/remitos, `doc_*` buttons)
- `src/services/intent-classifier.ts` — pipeline orchestrator
- `src/services/expenses.js` — main DB layer (all CRUD)
- `src/services/localidad-lookup.service.ts` — 4027 census localities
- `src/middleware/slot-extractor.ts` — unified extractors, 12 slot types
- `src/middleware/pending-action-processor.ts` — slot merge + re-prompt
- `src/middleware/pending-activities.ts` — PendingActivity store (`missing[]`, `askPrompt`, `nextInQueue`, `attempts`)
- `src/middleware/pending-persistence.ts` — PendingMirror → `pending_states`
- `src/middleware/typed-pending-store.ts` — TypedPendingStore<T> (invariante 10)
- `src/middleware/pending-queue-advancer.ts` — serial queue advance
- `src/middleware/user-lock.ts` — per-user serialization
- `src/middleware/conversation-engine.ts` — flow FSM + correction extractors
- `src/middleware/pending-field-location.ts` / `pending-plot-area.ts` / `pending-field-city-handler.ts` — location flows
- `src/middleware/dedup.ts` — webhook idempotency

### Utils
- `src/utils/parser.js` — Spanish normalization, number expansion, regex fallback
- `src/utils/entity-matcher.ts` (invariante 3) | `lexicon.ts` (invariante 4) | `pronoun-expander.ts` | `plot-intent.ts` | `relative-dates.ts` | `date.ts` | `guards.ts` | `format-quantity.ts` | `synonyms.js` | `crops.ts` | `livestock-location-intent.ts`
- `src/config/db.js` — pool + `withTransaction(fn)`
- `src/types/index.ts` — ParseResult, PlanRow, ParseSource

### Testing
- `src/testing/run-eval.ts` + `scenarios/*.json` — conversational eval (25 scenarios)
- `src/testing/integration/` — FakeAgent harness (invariante 14): full pipeline sin API Anthropic, ~1s, determinístico. Seam: `intentClassifier.setAgentServiceForTests()`.
- `src/testing/qa-*.ts` — QA suites (see § Tests)

### Frontend / Landing
- `frontend/` — React dashboard (in-repo). `landing/` — git submodule (Lovable — no editar a mano). Landing on `/`, app on `/login|/register|/dashboard|/chat`, assets split `/app-assets/*` vs `/assets/*`.
- `src/routes/auth.routes.ts` — `/api/auth/*` (verify, export, delete, subscription)
- `src/routes/webhooks.routes.ts` — `/webhooks/mercadopago`

## Extended Documentation

- **[docs/ai/query-patterns.md](docs/ai/query-patterns.md)** — **SOURCE OF TRUTH** for the 8 unified query tools. Read before modifying ANY query handler.
- **[docs/ai/tools.md](docs/ai/tools.md)** — Tool groups, disambiguation, compound actions
- **[docs/ai/failure-patterns.md](docs/ai/failure-patterns.md)** — Known pitfalls, hallucinations, data integrity
- **[docs/history/2026-hardening-log.md](docs/history/2026-hardening-log.md)** — full bug narratives behind the invariants (what happened, how it was found, what changed)
- **[docs/architecture.md](docs/architecture.md)** — full implementation reference
- **[docs/operations.md](docs/operations.md)** — deploy, env vars, migrations, settings
- **[docs/features/stock.md](docs/features/stock.md)** / **[livestock.md](docs/features/livestock.md)** / **[documents.md](docs/features/documents.md)** — feature deep-dives

## Tests

- **Unit (vitest)**: 1769 total. Local baseline: **1753 pass + 16 env-dependent fails** (need seeded DB; PASS in CI, which is the deploy gate). Compare against this baseline, don't chase the 16. `npm test`.
- **Conversational eval**: 25 end-to-end scenarios vs local Docker (real pipeline + DB). Baseline **25/25** (occasional 1 fail = LLM non-determinism on price proximity). `npm run eval` (requires `docker compose up -d`; consume créditos API — masivo fail con menú/regex → chequear "credit balance is too low" antes de debuggear). **Run after any change to AI pipeline, agent prompt, tool definitions, handlers, or flows.**
- **Integration harness**: `npx vitest run src/testing/integration/pipeline.integration.test.ts` — full pipeline, no API, requires DB. Regressions for cross-layer bugs go HERE (invariante 14).
- **QA suites** (`npx tsx src/testing/<file>`; requieren Docker + plan enterprise en el test user, salvo las `-prod-`):
  | Suite | Focus | Last |
  |---|---|---|
  | qa-adversarial-30 | informal language, ambiguity, context | 90% |
  | qa-adversarial-advanced-40 | silent corruption, drift, collisions (DB-verified) | 73% |
  | qa-compound-mixed-25 | 4+ domain compounds | 56% (assert-strict; DB-real higher) |
  | qa-bulk-extended-20 | bulkMode interceptor, never stop mid-compound | 80% |
  | qa-onboarding-25 | zero-state, whole setup in ONE message | 88% |
  | qa-serial-conversations-20 | serial queue, no data conflation | green post-58ae007 |
  | qa-repeated-combos-20 | N verbs → N tools, DB deltas | — |
  | qa-prod-senior / qa-prod-regression-v2 | PROD: memoria/contexto/consistencia | 96% stable |

## Checklist antes de commitear

1. ¿Rompe algún **invariante** (sección P0 de arriba)?
2. ¿Comando/tool nuevo? → registrado en los **3 lugares** (invariante 2) + mapeo explícito en `agent-response-mapper` si tiene campos que el genérico no copia.
3. ¿Normalización, sinónimo o regex nuevo? → ¿vive en `entity-matcher` / `lexicon` / `slot-extractor`, o acabás de crear una segunda fuente de verdad?
4. ¿Interceptor/veto/drop nuevo? → ¿loguea su path desde el día uno?
5. ¿Pregunta nueva al usuario? → ¿pending machine-readable o botones (nunca texto suelto)?
6. ¿Bug de interacción entre capas? → regresión en `pipeline.integration.test.ts`, no solo eval.
7. `npm test` contra el baseline local; `npm run eval` si tocaste pipeline AI / prompt / tools / handlers / flows.
8. ¿Cambió un contrato? → actualizar este archivo (regla + porqué en una línea); el relato completo va a `docs/history/`.
