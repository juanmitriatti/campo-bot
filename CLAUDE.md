# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

campo-bot is a WhatsApp and Telegram-based agricultural management assistant for Argentine farmers (entirely in Spanish). It uses an AI-first parsing pipeline with two modes — **AI Agent (tool_use)** and legacy **JSON extraction** — with regex fallback, storing data in PostgreSQL.

## Commands

- `npm start` — Run the app (`node src/index.js`), listens on port 3000
- `npm test` — Run all tests (`vitest run`)
- `npx vitest run src/utils/parser.test.js` — Run a single test file
- `docker compose up --build` — Start app + PostgreSQL (port 5433 for DB, 3000 for app)
- `docker compose up -d db` — Start only the database
- `cd frontend && npm run dev` — Run React frontend dev server (port 5173, proxies API to :3000)
- `cd frontend && npm run build` — Build frontend for production (output: `frontend/dist/`)
- `cd landing && npm run build` — Build landing page for production (output: `landing/dist/`)
- `npx tsx src/scripts/create-admin.ts --email <e> --name <n> --password <p>` — Bootstrap admin user
- `npx tsx src/scripts/seed-dummy-data.ts --user-id <id> [--reset]` — Seed dummy data
- `npx tsx src/scripts/run-migrations.ts` — Manually run pending DB migrations (auto-runs on startup)
- `npm run eval` — Run conversational eval (25 scenarios against local Docker, real pipeline + DB)
- `npm run eval:verbose` — Same with step-by-step detail
- `npx tsx src/testing/run-eval.ts --scenario basic-expense` — Run a single eval scenario

## Message Processing Pipeline

Orchestrated by `src/services/intent-classifier.ts`:

1. **Observation prefix** — "observación:" bypasses AI entirely
2. **Trivial commands** — ~35 commands skip AI (confirm, cancel, greeting, help, menu). Note: `generate_agro_report` is NOT trivial.
3. **AI primary** — Two modes via `AGENT_ENABLED` setting:
   - `true` → `agent.service.ts` (tool_use, supports compound actions)
   - `false` → `intent-extractor.ts` (JSON extraction, legacy default)
4. **Regex fallback** (`src/utils/parser.js`) — When AI disabled/failed/low-confidence
5. **Conversational fallback** — Lightweight Claude call for unknown intents (only when AGENT_ENABLED=false)

Kill switches: `AGENT_ENABLED=true` → agent | `AGENT_ENABLED=false` + `AI_INTENT_ENABLED=true` → JSON | Both false → regex-only

**Compound actions**: when the agent fires N tool_use blocks in one response, `CompoundExecutor` (`src/domain/compound-executor.ts`) runs them sequentially inside `withTransaction`. When `actionable.length >= 2`, **bulkMode** is set → handlers MUST NOT block (no `startFlow` / no `setPendingActivity` / no `setPendingObservation`). The executor strips any blocking side-effects + suppresses the handler's own prompt + adds one short "💡 No pude completar X" advisory + keeps going. After the loop, the post-compound bulk-plot prompt asks ONCE for plot assignment for any records saved at field-level. See "Compound Actions & bulkMode" below for the full contract.

## AI Agent Disambiguation Rules

These rules are implemented in `src/ai/agent-prompt-builder.ts` and drive tool selection:

### Plot Resolution
- If user doesn't mention field/plot, agent omits params → system auto-resolves if user has exactly 1 plot
- PlotDiscoveryService `_resolveBoth()`: if field found but plot not found, auto-resolves to single plot when field has exactly 1
- Campaign close buttons ("Cerrar campaña / Mantener abierta") only appear after `harvest_crop`, NEVER after spraying/fertilization/other activities

### Activity vs Expense
- Agro verb (fumigué, sembré, coseché, fertilicé) WITHOUT explicit amount → activity tool, NEVER `log_expense`
- Agro verb WITH explicit amount → BOTH activity + `log_expense` (compound action)
- compré/gasté + insumo → `log_expense` (type=insumo)
- vendí/cobré → `log_income`
- "a X c/u" / "a X el kg" → `log_expense.unit_price` (parity with `log_income`)

### Hectáreas vs Hacienda
- "has"/"hectáreas"/"superficie" + campo → `list_plots` (NOT livestock)
- "hacienda"/"vacas"/"novillos" → livestock tools

### Crop Queries
- "soja?"/"qué cultivo tiene el lote" / "has sembradas" → `active_crop` (NOT `list_plots`)
- "cuándo se fumigó/sembró" → `query_plot_history` (NOT activity registration)

### Financial Queries
- "gastos/ingresos en/del lote X" (no amount) → `financial_report(plot=X)` — NEVER `log_observation`
- "gastos campo X" → `financial_report(field=X)`

### Livestock
- "N vacas con N terneros" → 2x `add_livestock` (NEVER `record_livestock_birth`)
- Birth verbs only (nacieron/parieron/nació) → `record_livestock_birth`
- "pasé N terneros a novillos" → `transfer_livestock` (recategorización auto-detected). Handler auto-resolves: if no destination and `dest_category` set → same-location recategorization. If no source and only one group of that category exists → auto-resolves source.
- `add_livestock` / `remove_livestock` with `unit_price_ars|usd` → auto-creates linked expense/income (category "Hacienda"). Stored in `livestock_movements.linked_expense_id` / `linked_income_id`.
- **add_livestock SIN lote (Jun 2026)**: el agente llama la tool igual omitiendo plot/corral — el handler pregunta con pending real. PROHIBIDO en prompt/tool-description que el agente pregunte el lote vía respond_text (pregunta huérfana → la respuesta "lote norte" se la robaba el bypass trivial como plot_info). Backstop determinístico: `reconstructFromOpenLocationQuestion` en intent-classifier — si la última respuesta del bot (<5 min) fue "¿en qué lote...?" sin pending y el usuario contesta "lote X" a secas, se reconstruye "<msg original> en lote X" y se re-clasifica.
- **Lote vs Feedlot determinístico (Jul 2026)**: cuando add_livestock viene SIN plot ni corral, el handler consulta `livestockLocationIntent(originalText)` (`src/utils/livestock-location-intent.ts`): `ambiguo` ("no sé si lote o feedlot") → botones **[🌾 En un lote] [🏗️ En un feedlot]** (`lv_loc_lote_*`/`lv_loc_feedlot_*`, payload en `callbackPayloadStore`); `feedlot` ("ponelas en el feedlot") → `placeLivestockInFeedlot` directo. El feedlot se resuelve/crea solo: 0 feedlots → autocrea `Feedlot <campo>` + corral `'1'` (el formatter agrega el prefijo "Corral "); 1 corral → lo usa; 2+ → botones de corral (`lv_loc_corralpick_*`). Tap "En un lote" → re-corre con `__forcePlotPath`. Reemplaza el `respond_text` huérfano que el agente usaba (resultado NO determinístico: mismas palabras → a veces lote, a veces feedlot). Regla de prompt en agent-prompt-builder: ubicación ambigua NO es dato de negocio faltante → llamar la tool omitiendo plot/corral, NUNCA preguntar por texto. Skip cuando `_bulkMode`/`__forcePlotPath`/`__resolved*Id`.
- **Precio diferido (`set_livestock_price`, Jun 2026)**: cuando add/remove pregunta "¿a cuánto fue la compra/venta?", deja `setPendingActivity({command:'set_livestock_price', data:{movementId, kind}, missing:['unit_price']})`. La respuesta la consume el pending-processor y `attachPriceToMovement` crea el gasto/ingreso vinculado a ESE movimiento. Sin esto, la respuesta iba al agente a ciegas y Haiku la mapeaba a `edit_last_expense` — corrompió un gasto ajeno en vivo. **Regla general: NINGUNA pregunta al usuario puede ser texto suelto — siempre pending machine-readable o botones.** Jun 12: además es TOOL del agente (98ª) para el precio tardío SIN pending ("los toros me salieron 2 millones por cabeza") — el handler auto-resuelve al último movimiento entrada/salida sin registro financiero (7 días, filtro categoría/kind, `findLatestUnpricedMovement`; ojo: castear enum→text en SQL). Complementos del mismo bug: (a) una consulta read-only (`isReadOnlyQuery` en conversation-guards: query word sin verbo, o interrogativo+verbo "cuánto gasté") durante un pending con missing[] se responde Y el pending se restaura + re-ask — paridad con taps; (b) `routeCommand` null (tool alucinada tipo `edit_last_livestock`) NUNCA silencia: log `ROUTER NULL` + fallback amigable.
- **Gemelas de género (`GENDER_TWIN`, Jun 2026)**: `findGroupsByCategory` matchea ternero↔ternera (el masculino genérico del campo) — "desteté 40 terneros" con "terneras" registradas resolvía 0 grupos. Cuando el lookup da 0 pero hay hacienda, el error lista el inventario real ("Tenés: 40 terneras (Sur)...") para auto-corrección.
- **Memoria conversacional**: los 9 write paths de hacienda llaman `bumpConversationContext` (alimenta `context_stack`) cuando el lote vino del grupo sin pasar por plotDiscovery — sin esto "ahí mismo" tras una operación de hacienda resolvía al lote equivocado.

### Sanidad Animal (livestock health)
- vacuné/desparasité/curé/traté + animales → `log_health_event`. health_type: vacuné=vacunacion, desparasité=desparasitacion, curé/traté=tratamiento, revisé=revision_sanitaria
- `disease_or_vaccine` captures vaccine/disease name (aftosa, brucelosis, ivermectina). `dose_quantity`/`dose_unit` for dosage
- "cuándo se vacunó"/"historial sanitario"/"última desparasitación" → `query_health_events`
- NEVER use `log_observation` for livestock health events

### Reproducción (livestock repro)
- eché el toro/entore/servicio → `log_repro_event(repro_type=servicio)`. desteté → `log_repro_event(repro_type=destete)` (NOT `remove_livestock`)
- inseminé/IA/IATF → `log_repro_event(repro_type=inseminacion)`. detecté celo → `log_repro_event(repro_type=deteccion_celo)`
- `sire_info` for bull details (name, breed, ear tag). `method` for insemination method (IA, IATF, monta natural)
- "cuándo se echó el toro"/"historial reproductivo"/"destetes del año" → `query_repro_events`

### Pesaje Hacienda (weighing)
- pesé/pesaron/peso promedio + kg → `log_weighing`. Weight is ALWAYS average per animal, not total
- `animals_weighed` for count of animals weighed
- "cuánto pesan"/"evolución de peso"/"GDPV"/"ganancia de peso"/"último pesaje" → `query_weighings`

### Weather
- "clima/pronóstico/va a llover en X" → `weather_full(city=X, province?)`. NEVER fall back to user.city if query mentions a city.
- Handler uses `localidadLookup` to disambiguate ambiguous names (ej: Ameghino in Bs As vs La Pampa).

### Recordatorios de labores (Jul 2026, migración 098)
- **Plan futuro ≠ registro**: "el sábado tengo que fumigar" / "acordame mañana de pagar X" / "la semana que viene siembro" → `create_reminder(description, due_date)` — JAMÁS log_spraying/log_expense/sow_crop (regla CRÍTICA en agent-prompt-builder; registrar un plan como hecho corrompe datos). "mis recordatorios" → `list_reminders` (trivial regex, costo cero). "listo/cancelá el recordatorio" → `complete_reminder` (pero "fumigué X" = actividad normal). Tabla `task_reminders`; `src/services/reminder.service.ts` (con `resolveFutureDate`: SIEMPRE hacia adelante, a diferencia de relative-dates que resuelve al pasado); tick horario a los :10 (franja 07-21 AR, Telegram-first) en scheduler. Los campos description/due_date/cancel necesitan mapeo explícito en agent-response-mapper (el genérico no los copia).

### Grano por acopiador
- "cuánta soja tengo en Cargill" / "qué tengo en el acopio" → `query_harvest_loads(destinatario, view:'aggregate')` — grano ENTREGADO, NUNCA `check_stock` (insumos propios). "cuánto entregué a cada acopio" → `group_by:'destinatario'`. Patrones en docs/ai/query-patterns.md (fuente de verdad).

### Primera acción diferida (onboarding, Jul 2026)
- Un write que rebota por "no tenés campos/lotes" (gasto/ingreso en financial.handler, actividades en agronomy `buildNoPlotsResponse`) emite `sideEffects.setDeferredFirstAction={originalText}` → `deferredFirstActionStore` (TypedPendingStore). El **wrapper de `processTextMessage`** re-inyecta el texto original automáticamente cuando el usuario ya tiene campo+lote ("🔁 Retomo lo que me habías pedido"). Antes el primer gasto de un usuario nuevo se descartaba y había que re-tipearlo tras crear campo y lote. Consumo antes del replay (no loopea); las llamadas recursivas internas del pipeline usan `processTextMessageInner` (no re-disparan el replay).

### Tips contextuales de primera vez (Jul 2026, migración 099)
- Descubrimiento por goteo: tras la primera acción exitosa de cada tipo, UN tip enseña una capacidad relacionada ("💡 También podés mandarme un audio..."). Catálogo en `src/services/tips-catalog.ts` (agregar tips AHÍ, keys estables); motor en `tip-engine.ts` (singleton `tipEngine`). Hook principal: `DomainRouter.routeCommand` (wrapper sobre `dispatchCommand`) + los 2 sitios de confirmación del pipeline que bypasean el router (`appendTipAfterConfirm`). Reglas: solo acciones EXITOSAS (`looksSuccessful`: sin pendings/flows, sin ❌/⚠️/¿), tope `TIPS_MAX_PER_DAY` (default 1), cada tip UNA vez por usuario (`user_settings.tips_shown`), features gateadas se verifican con FeatureGate, **usuarios `testbot_*` EXCLUIDOS** (no contaminar eval/QA — testear el motor directo, no vía pipeline). Config admin (grupo bot): `TIPS_ENABLED` (kill switch) + `TIPS_MAX_PER_DAY`. Opt-out usuario: "no más tips" → `disable_tips` (regex trivial); "dame tips de nuevo" → `enable_tips`. El primer tip lleva el pie de opt-out.

### Pizarra de granos (Jul 2026)
- "pizarra" / "a cuánto está la soja" / "precio del maíz hoy" → `grain_prices(crop?)` — precio de MERCADO (Matba-Rofex Rosario), NUNCA `active_crop` (qué hay sembrado) ni `financial_report` ("a cuánto VENDÍ"). Fuente: API pública `apicem.matbarofex.com.ar/api/v2/closing-prices` — Disponible (contado ≈ pizarra) + 2 futuros más cercanos, USD/tn, caché 30 min (`src/services/grain-price.service.ts`, singleton en SystemHandler). Regex trivial anclado en parser.js (no roba "vendí soja a 320"). Permitido para usuarios con trial vencido (costo cero). Granos: soja/maíz/trigo (girasol/sorgo/cebada no tienen disponible en la fuente → mensaje honesto).

### Pending field-city escape hatch
- `pending-field-city-handler.looksLikeNonCity()` aborts the loop when the user types something that clearly isn't a locality (agro verbs, lists with `:`, queries with `?`, messages > 60 chars, SQL keywords, multiple commas **WITH digits** — "Pergamino, Buenos Aires, Argentina" is a valid locality answer and resolves; only data-lists escape, Jun 2026). When triggered, the bot tells the user "Dejé pendiente la ubicación de X" and clears the pending state so subsequent registrations work.
- Add new escape patterns here, NOT in the agent prompt.

### Crop name synonyms (anglicismos)
- `src/utils/synonyms.js` + `src/ai/agent-response-mapper.normalizeCropName()` translate English crop names to Spanish before the handler sees them: `soybean → soja`, `corn/maize → maíz`, `wheat → trigo`, `sunflower → girasol`, `sorghum → sorgo`, `barley → cebada`, `oat/oats → avena`, `cotton → algodón`, `rye → centeno`. Applied in BOTH the regex parser layer and the agent input normalization, so anglicisms work whether AGENT_ENABLED is on or off.

### Stock + Expense Compound
- `add_stock` accepts optional `unit_price_ars` / `unit_price_usd`. When present, the handler auto-creates a linked expense (category "Insumos", total = quantity × unit_price). Best-effort: stock succeeds even if expense fails. Bot response includes "💰 Gasto registrado: $X" line.
- Agent prompt rule: "compré X a $Y → add_stock(unit_price_ars=Y). El sistema crea el gasto automáticamente, NO llamar log_expense por separado"

### Mid-flow rename
- During any flow that has a `data.name` field set (currently `field_flow`), the user can correct the name with patterns like "se llama X, no Y" / "no Y, es X" / "el nombre es X". `extractRenameCorrection()` in `conversation-engine.ts` parses the new name, mutates `data.name`, and re-prompts the current step — no need to cancel + restart.

### Mid-flow amount/category correction
- During any flow (expense, income, etc.) that has `data.amount` or `data.category` already set, the user can correct with patterns: "no, eran X" / "en realidad X" / "perdón, X" / "quise decir X" for amounts, or "no, es X" / "no, categoría X" / **"no, era en X"** / "no, fue en X" for categories. Works both mid-flow AND during confirmation step. `extractAmountCorrection()` and `extractCategoryCorrection()` in `conversation-engine.ts`. The "no, era en X" pattern is restricted to candidates that look like CATEGORY words (sueldos / gasoil / semillas / fertilizante / etc.) via a shared stoplist from `correction-classifier.looksLikeCategoryWord` — without that guard it'd conflict with plot corrections ("no, era en lote Norte"), which `correction-classifier` intercepts earlier in the pipeline.

### Pending-correction interceptor (May 27)
- The shared pipeline (`message-pipeline.processTextMessage`, **one implementation for the 3 channels since Jun 2026**) intercepts correction patterns BEFORE classification when a pending expense/income exists. If `extractAmountCorrection` or `extractCategoryCorrection` matches the incoming text, the pending is patched in-place (amount or `detectarCategoria(...)`-canonicalized category) and a fresh confirmation is re-rendered — no round-trip to the agent. Without this, "no, era en sueldos" mid-confirmation was hitting the agent which produced an unhelpful "what plot to correct?" prompt (CR02 in regression QA).

### Pronoun expansion (May 27, comprehensive memory fix)
- `src/utils/pronoun-expander.ts` swaps Spanish plot pronouns ("ahí mismo", "ese (mismo) lote", "el mismo", "el de antes", "en ahí", etc.) for the explicit `"en lote <name>"` BEFORE the agent sees the message, using `conversation_state.plot_name` from the most-recent context. Since Jun 2026 also "el otro lote / en el otro" → SECOND-most-recent plot from `context_stack` (prevPlotName, lazy lookup only when text says "el otro"; temporal "el otro día" excluded). Wired into `intent-classifier.ts` as STEP 2.6 (between correction pre-classifier and agent call). Passes through unchanged when no pronoun OR no recent plot. Logs every expansion as `[intent-classifier] Pronoun expansion: "<in>" → "<out>" (N swap)`.
- **CRITICAL coupling**: everything downstream that validates agent output against "what the user said" MUST use the EXPANDED text (`agentInputText`), not the original — `agent-output-validator` once vetoed the plot our own expander injected (live bug).
- Why server-side: the agent prompt already had this rule but Haiku applied it inconsistently — sometimes emitting `plot="ahi mismo"` (which never resolves) or text-only "¿qué lote?". Doing it deterministically makes the agent see unambiguous text and removes the variance.
- Why this is bedrock: it's the root cause of the memory-corto / memoria-largo / context-switch / contradiction categories all simultaneously regressing in the senior QA run before the fix. Pronoun-expander + `plotDiscovery.resolveFromNamesWithContext` (context_stack fallback) + `relative-dates` normalizer form the conversational-memory triad.

### Explicit plot intent (May 27, `utils/plot-intent.ts`)
- `userExplicitlyReferencedPlot(text)` returns true when the user wrote a plot pronoun OR an explicit "lote <name>" / "potrero <name>" reference. Used in `handleExpense` to decide whether the `FIELD_LEVEL_CATEGORIES` rule should strip an auto-resolved `plotId`.
- **Bug it fixes**: `handleExpense` had a rule "if category is sueldos/arrendamiento/etc. AND the agent didn't pass `plotName`, drop the auto-resolved plot" (defense against silent assignment of corporate-overhead to the user's only lote). But it was too aggressive — when the user explicitly referenced a plot via pronoun (resolved through `context_stack`) or by name in text, the plot still got stripped, silently saving at field-level. P01/P02 in regression QA caught this. Now the rule honors explicit intent and only strips when the user gave NO plot signal.

### Query updates conversation_state (May 27)
- `handleFinancialReport` now calls `updateConversationState(userId, fieldId, plotId)` whenever the query resolves a specific plot/field. Without this, "cuánto gasté en lote Amarillo este mes" left no trace in `context_stack`, and the next pronoun-bearing message resolved to whichever plot the LAST WRITE used — conflating contexts. P02 was a regression caused by exactly this.

### Relative date normalizer (May 27, `utils/relative-dates.ts`)
- `resolveRelativeDate(text)` detects Spanish relative phrases ("ayer", "anteayer", "antes de ayer", "hace N días/semanas/meses", and since Jun 2026 also "anoche", "la noche pasada", "esta mañana/madrugada/tarde/noche", "hoy temprano", "la semana pasada" ≈ −7d, "el mes pasado" ≈ −30d, "el finde / fin de semana (pasado)" → most recent past Saturday) and resolves to ISO date in Argentina TZ.
- **Future-intent suppression (Jun 2026)**: `FUTURE_INTENT_RE` ("voy a", "que viene", "mañana", present-tense plan verbs like "cosecho/pago/siembro") suprime la resolución de día-de-semana/finde — "el sábado cosecho" es un plan, NO se registra el sábado pasado. "pasado" explícito ("el sábado pasado coseché") siempre gana. "ayer/anteayer/hace N" no se suprimen (inequívocamente pasado). Tests en `relative-dates.test.ts`. Used by `agent-response-mapper` as a server-side safety net when the agent omits `event_date` — covers tools in `TOOLS_WITH_DATE_PARAM` (log_expense, log_income, sow/harvest, spray/fertil, livestock health/repro/weighing, rainfall, etc.). The agent prompt teaches Haiku to set the date, but it forgets often on casual phrasings ("ayer pagué..."). Date never overwrites an explicitly-set agent value — only fills the gap.

### Multi-slot context tracking
- `conversation_state.context_stack` (JSONB, migration 075) stores last 3 field/plot references as `[{field_id, plot_id, ts}]`. Updated on every `updateConversationState()` call (LIFO, deduped). Exposed in agent prompt as "contextos recientes:[1)Lote Norte (La Esperanza), 2)Lote Sur...]" when stack has >1 entry. Enables resolution of "el otro campo" / "el de antes".

### Agent truncation handling
- `AgentResult.truncated` is true when Anthropic stops with `stop_reason=max_tokens`. Surfaced to controllers via `ParseResult._truncated` and rendered as "⚠️ El mensaje era largo y se cortó. Si te quedaron acciones sin registrar, repetilas en un mensaje aparte." Console logs `AI_AGENT TRUNCATED:` for monitoring. Bump `AGENT_MAX_TOKENS` (default 1500) if you see this often in production.

### Stage code validation (log_crop_scouting)
- `src/domain/agronomy/stage-code-validator.ts` validates `stage_code` against `crop`: soja (VE, V1..V8, R1..R8), maíz (VE, V1..V21, VT, R1..R6), trigo/cebada (Zadoks Z21..Z99), girasol (VE, V1..V20, R1..R9), sorgo (VE, V1..V12, R1..R6). Non-blocking: the monitoreo still saves and the bot adds a warning line "⚠️ El estadio X no es típico de Y" + valid range hint. Useful for typos like "soja R12" (R12 doesn't exist for soja).

### Multi-day rainfall (log_rainfall_batch)
- When the agent fires multiple `log_rainfall` calls in compound (e.g. "20mm el lunes, 35mm el martes y 12mm el miércoles") and none provide a field, `compound-executor.consolidateRainfallPrompts()` collapses the per-rain "¿En qué campo?" prompts into a single batched prompt with callback `rain_batch_<fieldName>_<base64payload>`. The interactive router decodes and dispatches `log_rainfall_batch` which persists all entries in one shot. Callback payload is JSON-then-base64url of `[{mm, date}]`.
- `log_rainfall` schema includes `event_date` so each call carries its own date; the regex parser deliberately ignores compound rainfall messages so the agent handles them.

### Harvest Loads (per-truck)
- ANY list of `nombre número` in a cosecha context is `loads[]` — destinatario and kg unit are optional.
- "Cosecha del lote X" WITHOUT driver/weight list → `query_harvest_loads` (query intent), NOT `harvest_crop`.
- `yield_kg_per_ha` (rate) vs `yield_kg` (total): "X kg/ha" or "X por hectárea" → `yield_kg_per_ha`. "sacamos X tn/kg" (no "por hectárea") → `yield_kg`. Handler computes total = rate × area when rate provided.

### Reports
- "reporte agronómico" → `generate_agro_report` (needs agent for date range)
- "reporte financiero" / "cómo vamos" → `financial_report`
- "reportes"/"informes" (generic) → `show_reports_menu`

### Crop Scouting (structured monitoring)
- Message has METRICS (V3/R5/Z3 stage code, %, severity word, density, pl/m²) → `log_crop_scouting`. Free text without metrics → `log_observation`.
- Severity mapping: ausente=1, leve=2, moderada=3, alta=4, severa=5.
- Ex: "soja V3 con 15% rama negra y presencia leve de chinche" → `log_crop_scouting(stage_code=V3, weed_coverage_pct=15, weed_species=["rama negra"], pest_species="chinche", pest_severity_1_5=2)`.
- Queries: "cómo viene la sanidad", "presión de plagas", "evolución del cultivo", "monitoreos del lote X" → `query_scoutings` (NOT `query_plot_history`).

### Sow Crop
- `sow_crop` accepts optional `hectares` param for partial-plot sowing → `plot_crops.sowed_hectares`
- **Missing-crop pending state** (structural): `crop` is OPTIONAL in `sow_crop`/`harvest_crop` schema. Prompt orders agent to OMIT the param when the user didn't name a crop and explicitly bans inferring from active_crop / past sowings. When the handler sees `isPlaceholder(cmd.crop)`, it returns `setPendingActivity({ ...cmd, _needs: 'crop', missing: ['crop'], askPrompt: '...' })` + asks "🌱 ¿Qué cultivo sembraste?". The 3 controllers (whatsapp/telegram/test-bot) intercept the next message: `extractCropFromText()` (in `src/utils/crops.ts`) tries to map it to a canonical crop. On match → re-runs `handleCommand` with merged data. On miss → re-asks. The new unified `missing[]` array (added May 2026) also routes through `processPendingAction` — see "Unified Pending Action System" below.

### Unified Pending Action System (May 2026)
- **Goal**: replace 4 ad-hoc multi-turn helpers (`_needs:'crop'`, `expense_flow`, `extractAmountCorrection`, agent `respond_text`) with one mechanism that absorbs all of them.
- **Architecture**: handler detects required-missing slots → returns `setPendingActivity({ command, data, missing: ['product','plot','quantity'], askPrompt })`. Controller intercepts the next user message, runs `extractSlots(text)` from `src/middleware/slot-extractor.ts` (12 slot types: amount, category, plot, field, crop, quantity, unit, unit_price, product, currency, count, hectares — reuses `normalizarMonto`, `detectarCategoria`, `extractCropFromText`, `stripPlotCorrectionPrefix`), merges into `pending.data`, and either (a) re-routes the command when all required slots are filled or (b) re-asks for what's still missing via the auto-generated Spanish prompt.
- **Files**: `src/middleware/slot-extractor.ts` (extractors, ~170 LOC), `src/middleware/pending-action-processor.ts` (merge + re-prompt logic, ~110 LOC), `src/middleware/pending-activities.ts` (storage shape with `missing?: string[]` + `askPrompt?: string`).
- **Opted-in handlers** (May 22 update):
  - `log_spraying`: product + plot + quantity
  - `log_fertilization`: product + plot + quantity
  - `log_tillage`: plot + (implement OR product)
  - `log_irrigation`: plot + quantity (mm)
  - `log_health_event` (vacunación/desparasitación): nombre vacuna/antiparasitario required
  - `add_stock`: product + quantity + unit
  - `sow_crop` / `harvest_crop` (dual path): legacy `_needs:'crop'` + new `missing: ['crop']`
- **Plot fallback in expense/income flow**: `validatePlotAsync` in `src/middleware/flows/field-step-helpers.ts` now calls `extractSlots()` as a LAST RESORT before failing — catches "era todo de maíz del lote B1" (gives plot=B1 + stashes `_extractedCategory='Maíz'` for later use).
- **Single-slot fallback**: in `pending-action-processor.ts`, when only ONE slot is missing and the SlotExtractor finds nothing, the whole short message (≤ 60 chars, no special punctuation) is taken as the answer. Catches bare-word replies like "aftosa" to "¿qué vacuna?".
- **Cross-domain routing**: re-execution after merge goes through `DomainRouter.routeCommand`, not `agronomyHandler` directly — so `add_stock`, livestock, and future tools all work through the same code path.
- **Escape patterns**: any `isCancelIntent(text)` clears the pending. Any `detectsFinancialIntent(text)` (now also matches "cargué/registré + qty+unit" via the May 2026 widening) also clears so the user can pivot to a brand-new financial action mid-pending.
- **Wired into**: `src/services/message-pipeline.ts` (single implementation for the 3 channels since the Jun 2026 controller unification). The legacy `_needs:'crop'` branch is preserved as a fallback below the new unified branch so old code keeps working.
- **Known limitation**: when the agent auto-resolves a plot from conversation context and the user contradicts it in the next message, the existing value blocks the override (the merge only fills NULL slots). Edge case — doesn't affect normal flows.

### Compound Actions & bulkMode (May 23)

**Contract**: when the agent fires N tools in one response, `CompoundExecutor` runs them all, NEVER stops mid-stream, and asks ONCE at the end for any missing plot assignment. Three layers:

**1. CompoundExecutor (`src/domain/compound-executor.ts`)**:
- `bulkMode = actionable.length >= 2` (any 2+ compound — NOT just 2+ financial; lowered May 23).
- Wraps every step in `withTransaction`. One throw → rollback all + "❌ No pude registrar todas las acciones..." message.
- Pre-execution: dedup identical steps, reorder writes-before-reads, consolidate same-field rainfalls into `log_rainfall_batch`.
- Per step, passes `bulkMode` to handlers: `routeCommand(cmd, ..., bulkMode)` → router sets `cmd._bulkMode = true` so any downstream handler can read it.
- **Interceptor (safety net + queue capture)**: if any handler returns `startFlow`/`setPendingActivity`/`setPendingObservation` in bulkMode → strip those side-effects from the immediate response. When the blocked side-effect was `setPendingActivity` (recoverable — has command + missing slots), **CAPTURE it into the serial pendingQueue** with a context-tagged askPrompt (e.g. `👇 Baja de hacienda (2 vacas): ¿en qué lote?`) so it gets asked AFTER the current pending completes. For `startFlow`/`setPendingObservation` (non-recoverable, different mechanism) inject a `💡 No pude completar *<command>*` advisory.
- Post-loop: build the bulk-plot prompt if any `savedRecordsWithoutPlot[]` were collected (see §3 below). Also collects `income_partial`/`expense_partial` into the queue (one item each, context-tagged). Promote queue: first item → `setPendingActivity` + askPrompt added to finalMessages so the user sees it immediately. Rest → `nextInQueue`. Lead announcement `💡 Tengo *N acciones pendientes* — te las pregunto una por una.` when queue > 1.

**2. Handler-level bulkMode awareness (when present, saves at field-level)**:
- `handleExpense` + `handleIncome` (`financial.handler.ts`): when `bulkMode && !plotId && fieldId`, save with `plot_id=null` + emit `savedFinanceWithoutPlot`. Confirm flow is force-disabled (`noConfirmSettings`).
- `add_field` (`financial.handler.ts:2025+`): when `_bulkMode && city is ambiguous/missing`, create the field NOW (take first lookup match for city or skip city) instead of starting `field_flow`. Without this, onboarding compounds like "Tengo el campo X en Y..." were stuck — the field flow blocked subsequent plot/sow/etc. tools that depended on the field existing.
- `log_observation` (`agronomy.handler.ts:3380+`): when `_bulkMode && multiple plots`, pass `allowNoPlot=true` to `saveObservation`, save at field-level + emit `savedRecordsWithoutPlot[{kind:'observation', id, fieldId}]`. The legacy "Indicá el lote" guard is bypassed only in this context.
- Other agronomy/livestock/stock handlers don't yet have explicit bulkMode awareness — they fall back to the interceptor (record not saved, but compound continues).

**3. Post-compound bulk-plot prompt (`HandlerResponse.savedRecordsWithoutPlot[]`)**:
- Shape: `Array<{ kind: 'expense'|'income'|'activity'|'observation'|'scouting'|'livestock'|'rainfall'|'stock_movement'; id: number; fieldId: number }>`.
- Legacy single-record `savedFinanceWithoutPlot` is kept for back-compat but new code emits the array.
- When the loop ends with records collected AND the field has 2+ plots, the executor builds an interactive list/buttons message: `💡 Guardé N gastos + M ingresos + ... a nivel campo *X*. ¿A qué lote los asigno?` with one button per plot + "Dejar a nivel campo".
- Button payload **V2** (`bap2_<base64url(byKindMap)>_<plotId>`) carries the record IDs grouped by kind. Decoded by `InteractiveRouter` → command `assign_bulk_plot` with `{plotId, records: {kind: number[]}}`.
- `FinancialHandler.handleAssignBulkPlot`: dispatches across tables by kind: `expenses`, `incomes`, `domain_events`, `agro_observations`, `crop_scoutings`, `rainfall`, `livestock_groups`. user_id-scoped UPDATEs. Returns "✅ Asigné 2 ingresos + 1 gasto al *Lote A1*."
- Legacy `bap_*` parser stays for in-flight buttons.

**4. Partial financial in compound (`income_partial` / `expense_partial`)**:
- `agent-response-mapper.mapIncome`/`mapExpense` returns `income_partial`/`expense_partial` when amount=0 AND no `quantity*unit_price` to compute from.
- CompoundExecutor collects ALL partials into the serial pendingQueue (one item per partial) — not just the first. Each gets a context-tagged askPrompt like `👇 Venta de *Soja* (10 tn): ¿cuánto fue el precio?`.
- `log_income` + `log_expense` are in `FINANCIAL_COMMANDS` in DomainRouter so the pending re-execution path works.

**4b. Serial Pending Queue (May 23, hotfix `58ae007`)**:
- **Why**: when a compound left 2+ items needing follow-up, the prior design only wired the FIRST partial and the user's single reply would apply to ALL items — conflating data (e.g. "vendí 2 vacas y compré glifosato" → "Lote A2 y precio 100mil" → both vacas AND glifosato got 100k each).
- **Type**: `PendingActivity.nextInQueue?: Array<Omit<PendingActivity, 'timestamp'|'nextInQueue'>>` (see `src/middleware/pending-activities.ts`).
- **Build**: CompoundExecutor populates `pendingQueue` from (a) interceptor-captured setPendingActivity items + (b) income_partial/expense_partial items. Each item gets a `describeQueueItem()` label so the user knows WHICH action is being asked about.
- **Promote**: first item → `setPendingActivity.askPrompt` + appended to finalMessages immediately. Rest → `setPendingActivity.nextInQueue`. Lead announcement `💡 Tengo N acciones pendientes — te las pregunto una por una.` when queue > 1.
- **Advance**: shared helper `src/middleware/pending-queue-advancer.ts` used by all 3 controllers. After pending re-routes successfully, decides: (a) if the re-routed cmd set its OWN new pending, append our remaining queue to it (don't lose items); (b) else pop next from queue → set as new pending → send its askPrompt.
- **Critical fixes in `58ae007`**:
  - `pending-action-processor.ts:69` had a duplicate `const missing = pending.missing ?? []` (line 55 already declared it) that silently broke tsx/esbuild transform → EVERY multi-turn pending answer returned 500. Pre-existing bug.
  - When a queue item for `log_income`/`log_expense` got its slots filled and was re-routed, the merged ParsedCommand did NOT carry the `command` field (partials store command on the pending, not in `data`) → `routeCommand(undefined)` → null → "No pude completar el registro" + silent data drop. Fix: `if (!merged.command) merged.command = pendingAct.command;` in all 3 controllers BEFORE calling routeCommand.
- **All 9 setPendingActivity write-sites** across 3 controllers now copy `nextInQueue` too (otherwise queue items would be lost when re-set).

**5. Critical mapper bugfix (May 23)**:
- `agent-response-mapper.ts:246-253` filter that drops spurious `log_expense`/`log_income` when there's a sibling agro activity was too aggressive: it only checked `input.amount > 0` and dropped calls with `quantity+unit_price` (mapper would auto-compute later). Result: a 4-tool compound like "gasté + vendí 20tn maíz a 200 USD + fumigué + agregué ganado" lost the maíz income → `bulkMode=false` → expense triggered single-action plot flow → 0 writes. **Fix**: also keep when `qty>0 && unit_price>0` (computable). This was the silent killer for many tests.

**Agent prompt rules wired to this (in `agent-prompt-builder.ts`)**:
- **COMPLETITUD EN MENSAJES LARGOS** — counts verbs, demands one tool per verb, lists verbs to count, includes 4-tool + 5-tool CRÍTICO examples.
- **COMPOUND CON UN ÍTEM SIN PRECIO** — proximity rule: a single price applies ONLY to the item immediately preceding it (not all items).
- **EXCEPCIÓN COMPOUND** in ANTI-HALLUCINACIÓN — in compound, NEVER consolidate missing-data asks into a single respond_text. Emit one tool per verb (partials allowed).
- **ONBOARDING DECLARATIVO** — "Tengo el campo X" / "Doy de alta" / "Arranco con" / "Cargá el campo" treated same as "agregar campo X". Forces add_field + add_plots_batch + activity in one turn. PROHIBIDO emitir solo add_field y abandonar las plots/actividades.
- **HECTÁREAS POR LOTE** — heterogeneous list → hectares as aligned array; homogeneous → number.
- **MAÍZ vs MANÍ** — explicit disambig because Haiku was mapping "maiz" (sin tilde) to "Maní".

**Multi-tool few-shots** (see `seed-training-examples.ts`):
- `expected_output` now supports `{tool_calls: [{tool, input}, ...]}` for N-tool demos.
- `FewShotService.formatAsToolUseMessages` emits ONE assistant turn with N `tool_use` blocks + N matching `tool_result` blocks (canonical Anthropic multi-tool shape).
- Seeded compound demos covering ranges from 2 to 5 tool calls across all domains (incomes, expenses, sow/harvest, spray/fertil, livestock, observation, scouting, rainfall, onboarding).
- Daily rotation `ORDER BY md5(id::text || CURRENT_DATE::text)` — bump `AGENT_FEW_SHOT_LIMIT` (code default 5; **prod is at 15**, verified Jun 2026) so more compound demos enter the daily rotation.

### Admin AI Training — auto-flag + bulk feedback (May 22)
- `/admin → AI Training → Logs` adds the **"⚠️ Sospechosas (auto-flag)"** filter alongside Todos/Sin revisar/Revisados. Server-side query in `GET /admin/api/ai-training/logs?suspicious=true` matches: empty response, "no entendí" / "no encontré" / "me faltan" / "no pude" / "fallback" / "sin reconocer" in response_text, processing_time_ms > 8000, or confidence < 0.5.
- Each row has a checkbox. Header checkbox toggles all. **"Marcar OK" / "Marcar Mal"** bulk buttons hit `PATCH /admin/api/ai-training/logs/bulk-feedback` (body `{ ids: number[], was_correct: boolean }`) and update many rows in one query. Live counter "(N seleccionados)" between the buttons.
- Each row that matches the suspicious heuristic shows a **⚠️** chip next to the date column, regardless of which filter is active — so you can spot bad rows even in the "Todos" view.
- Suggested workflow: weekly, filter "Sospechosas" → bulk-mark obvious mistakes → click "Promover" on edge cases that need a training example.

### Harvest Loads
- `harvest_crop` accepts optional `loads[]` (per-truck: driver_name, weight_kg, destination?, destinatario?, truck_plate?, humidity_pct?, quality_metrics?). Only driver+weight required.
- Dedup: same plot harvested today → appends loads, no duplicate event. Dedup path validates crop matches active crop before reusing event
- Yield rate: `yield_kg_per_ha` param for "X kg/ha" inputs. Handler computes total = rate × area. Mutually exclusive with `yield_kg` (total)
- If `loads[]` present but no active crop → handler warns the user the loads were dropped
- If harvest called with no new loads but plot has stored loads → response includes existing-loads summary
- `query_harvest_loads` tool queries stored loads (filters: plot, field, date, driver, destinatario)
- `delete_harvest_loads` tool removes loads by criteria (plot, date, driver_names[], only_without_destination)
- `campaign_stats` includes per-truck detail (with humidity + quality) in yield section + `avgHumidity` aggregate
- `humidity_pct` (0-50%, migration 073) — capture from "al 14%" / "13.5 de humedad". AR base: soja 13.5%, trigo 14%, maíz 14.5%
- `quality_metrics` JSONB (migration 073) — crop-specific: soja `{oil_pct}`, trigo `{protein_pct, gluten_pct, test_weight_kg_hl}`, girasol `{oil_pct}`. Pasarlas SOLO si el usuario las mencionó

### Units (kg / tn / qq)
- `UNIT_PROP` accepts kg, lt, cc, tn, qq, bolsas, kg/ha, lt/ha. qq=quintal=100 kg, tn=tonelada=1000 kg.
- Conversion happens in `normalizeToKg(quantity, unit)` (agent-response-mapper.ts) + ad-hoc in agro-report.js + the regex fallback. Examples: "rindió 42 qq" → 4200 kg, "200 qq de soja" → 20000 kg.

### Weather Alerts (scheduled 06:00 AR)
- ⚠️ **DISABLED (Jun 2026, user request)**: the `weatherAlertTick` (rain/wind/dry) and `proactiveAlertsTick` (monitoring/pest/hectares/low-stock/phenology) cron registrations are commented out in `startScheduler()` (`src/services/scheduler.js`). Summaries, flow reminders, cleanup, expense templates and subscription sweep still run. To re-enable, uncomment the two blocks.
- Rain: today + next 2 days, threshold `user_settings.rain_alert_mm` (default 10mm)
- Wind: days with `wind ≥ wind_alert_kmh` (default 20) — for spraying decisions
- Dry window: N consecutive days < 1mm (default 3 days via `dry_window_days`) — for application/sowing planning
- All alerts include "_Es un pronóstico, puede cambiar._" disclaimer
- Dedup: 24h per city+day per alert type. Channel: Telegram-first, WhatsApp fallback

### Audio (Whisper) domain glossary
- `src/services/audio/audio.types.ts` exports `DEFAULT_WHISPER_PROMPT` — Argentine agro/livestock vocabulary IN PHRASE CONTEXT (Jun 12: rewritten from word-list to example sentences; biases better) passed as the OpenAI Whisper `prompt` param to bias transcription (otherwise it mangles "desteté"→"de este", "vaquillonas"→"vacuiciones"). Overridable via `WHISPER_PROMPT` env. **Capa 2 determinística**: `STT_DOMAIN_CORRECTIONS` in `src/utils/text-normalizer.js` (`correctSttDomainWords`, step 4.5 of `normalizeTranscript`) fixes KNOWN manglings word-by-word — entry rule: ONLY nonsense words that can't mean anything else in Spanish (zero false positives; never add real words like "valieron"). Add new manglings THERE when reported. Most audio-path "wrong tool" errors trace back to bad transcription, not handlers.

### Entity name matching (single source of truth, Jul 2026)
- `src/utils/entity-matcher.ts` es la ÚNICA normalización válida para matchear nombres de lote/campo/corral: `sqlNormalizedName()` (fragmento SQL), `normalizeEntityName()`/`compactEntityName()` (JS espejo, con test de paridad JS↔SQL), `stripLeadingArticle()` (SOLO como fallback — literal primero), `entityNameCandidates()`. Consumido por `getPlotByName`/`findPlotByNameAcrossFields`/`getOrCreatePlot`/`getFieldByName`/`findPlotByAlias` (expenses.js), plot-discovery, agent-output-validator y financial.handler. **NO escribir otra normalización inline** — la divergencia previa (8 implementaciones) causó pérdida de datos ("El Bajo"→"Bajo") y aliases rotos ("Ñandú" con acento al escribir, sin acento al leer).

### Integration harness (FakeAgent, Jul 2026)
- `src/testing/integration/` — `FakeAgentService` (tool_calls prefijados, graba invocaciones) + `pipeline-harness.ts` (`createPipelineHarness()`: usuario efímero + send/tap/q/cleanup) + `pipeline.integration.test.ts`. Testea `processTextMessage`/`handleInteractiveReply` COMPLETOS (interceptores→mapper→validator→handlers→DB) **sin API de Anthropic** (~1s, determinístico). Seam: `intentClassifier.setAgentServiceForTests()`. **Todo bug de interacción entre capas del pipeline debe dejar su regresión ACÁ**, no solo en el eval (que cuesta créditos y flakea). Requiere DB; se saltea si no hay.

### Conversational lexicon (synonym source of truth)
- `src/utils/lexicon.ts` is the SINGLE source of truth for the correction/pivot/guard synonym sets (correction cues, currency incl. slang "verdes"/"mangos", dose units, copulas, delete verbs). **Add a new synonym THERE, not in scattered handler regexes.** Consumed by the `extract*Correction` family in `conversation-engine.ts`, `pending-correction-interceptor`, `pending-action-processor`. All matchers accent-insensitive.

### Message idempotency
- `src/middleware/dedup.ts` `MessageDedup` is time-windowed (10-min TTL, age-based eviction) — dedups Telegram `update_id` / callback ids so a webhook RETRY of a slow audio doesn't double-write (one "320 madres" audio once created the herd twice). Still per-process; multi-replica would need a shared store.

### Pending persistence + per-user serialization (Jun 2026; contrato único Jul 2026)
- **Pending stores persist to DB** (`pending_states` table, migration 097): the 4 stores (`PendingActivityStore`, `PendingTransactionStore`, `PendingObservationStore`, `PendingFieldCityStore`) keep their synchronous Map API but write-through to DB via `src/middleware/pending-persistence.ts` (`PendingMirror`). Controllers call `hydratePendingStores(phone)` at message entry (fill-if-missing) so a Railway restart no longer wipes in-flight pendings. Tombstones (60s) prevent a hydrate from resurrecting a just-cleared pending whose DELETE is in flight. Hourly sweep at :30 in scheduler.
- **Contrato único (Jul 2026)**: `src/middleware/typed-pending-store.ts` (`TypedPendingStore<T>`: TTL 30 min default + mirror + hydrate + `delete` alias de `clear`). Migrados: los 3 Maps pelados (stock_entry, stock_deduction — causa del "📤 Stock descontado." falso —, campaign_close) + field-location + documents + doc-upload (delegan al genérico) + plot-area (mirror manual, cola entera como payload). `hydratePendingStores` cubre los 11. **Todo pending simple nuevo usa TypedPendingStore — NUNCA un Map suelto ni otra clase ad-hoc.** TTL de pending-activities también 30 min (antes 5: la respuesta a los 6 min iba al agente a ciegas).
- **Per-user message serialization** (`src/middleware/user-lock.ts` `withUserLock`): the 3 controllers chain message processing per phone/chat-id so two rapid messages from the same user can't interleave and overwrite each other's pending. Different users still run in parallel. In-process only (single-replica deploy).
- **Pending hint to agent**: when a pending is active and a message still reaches the agent, `classify(..., { pendingHint })` injects a `[Hay una pregunta pendiente...]` line into the user prefix (uncached zone) so the agent knows there's an open slot question.

### Button payload tokens (Telegram 64-byte limit)
- `bap2_*` (bulk plot assign) and `rain_batch_*` callbacks now embed a short token from `callbackPayloadStore` instead of inline base64 — inline payloads with 3+ records exceeded Telegram's 64-byte `callback_data` cap (silent HTTP 400, user saw no buttons). `InteractiveRouter` resolves token→payload with inline-base64 fallback for in-flight buttons.
- `assign_bulk_plot` reports partially-stale taps: when some record IDs no longer exist (deleted after the buttons rendered), the confirmation appends "⚠️ N registros ya no existían" instead of confirming as if everything was assigned.

### Interceptor observability (Jun 2026 — PRINCIPLE)
**Any layer that consumes, drops, rewrites or vetoes a message/tool-call MUST log it** (`[INTERCEPT]`, `AI_VALIDATOR DROP`, `AI_MAPPER DROP`). The Jun 2026 live-testing round found 5 production bugs whose common root was silent interception — a vetoed plot, a dropped expense, a swallowed answer were indistinguishable from "never happened". Current logged interceptors: output-validator strips, mapper sibling-expense drops, mapper conversational-text drops alongside tools, single-slot fallback consumption, unknown units in `normalizeToKg`, pronoun expansions, open-question rejoins. When adding a new interceptor, log its interception path from day one.
- `COMPOUND_ACTION_PATTERN` (intent-classifier) accepts `y` / `e` / `,` / `;` as separators (an action verb must follow) — "fumigué lote norte, después registrá 50mil" no longer slips past into the trivial bypass.
- Single-slot fallback (pending-action-processor) has a `NON_ANSWER_RE` guard: short doubt/delay phrases ("después te digo", questions with "?") are NOT taken as slot values.
- `normalizeToKg` accepts `t`/`ton` as tonelada (used to default to kg, ÷1000 silent error).

### AI Cost & Caching
- Agent settings live under the `ai` group in admin (`/admin/#settings`, section **"Configuración de IA"**): `AGENT_ENABLED`, `AGENT_MODEL`, `AGENT_MAX_TOKENS` (default 1500), `AGENT_TIMEOUT_MS`, `AGENT_TEMPERATURE`, `AGENT_CACHE_TTL` (`short`/`long`), `AGENT_FEW_SHOT_LIMIT` (default 5).
- Prompt caching: three cache_control breakpoints (system, tools, last few-shot). User context + today's date injected via `buildUserMessagePrefix()` so the cached prefix stays stable across users/calls.
- Few-shots rotate daily via `ORDER BY md5(id::text || CURRENT_DATE::text)` — deterministic per day, varied across days. No random reshuffles.
- `ai_usage` persists `cache_read_tokens` + `cache_write_tokens` (migration 070). Dashboard cost uses 4-term Haiku 4.5 pricing (corrected Jun 2026): input 1.00, cache read 0.10 (10%), cache write 1.25 (125%), output 5.00 per M. Log line `AI_AGENT CACHE: Nread/Nwrite` shows real cache hits in Railway logs.
- Anthropic client uses explicit `maxRetries: 2` (SDK exponential backoff on 429/529/5xx). `AGENT_TIMEOUT_MS` default is 12000 — it's the TOTAL budget including retries (8000 was cutting them off). `AGENT_MAX_TOKENS` code default is 1500 (was 400, which truncated 4-5 tool compounds).
- Conversational fallback (`conversational-fallback.service.ts`) now includes recent history (1500-char budget via `ConversationHistoryService`) — it was single-turn and follow-up questions lost all context.
- `ConversationHistoryService.getRecentTurns` appends `[acciones ejecutadas: tool1, tool2]` to assistant turns (from `conversation_logs.tool_calls`) so the next agent turn knows WHAT was registered, not just what the bot said. Query is bounded with LIMIT 40.

## Account Lifecycle & Billing (P0 hardening — Mayo 2026)

Four production-readiness features added on top of the agent pipeline. All four are gated by admin settings so they ship dark and you flip them on when ready.

### Compound action atomicity (always on)
- `src/config/db.js` hijacks `pool.query` and `pool.connect` via `AsyncLocalStorage`. When inside a `withTransaction(fn)` block every query — including from the 47 files that import `pool` — runs on the same client. Inner `pool.connect()` calls (livestock/stock repos with their own BEGIN/COMMIT) get a savepoint-aware shadow client, so nested `BEGIN` becomes `SAVEPOINT sp_<rand>`, `COMMIT` becomes `RELEASE`, `ROLLBACK` becomes `ROLLBACK TO`. Zero changes to caller code.
- `CompoundExecutor.execute()` wraps the steps in `withTransaction`. If any step throws → rollback all + a single user-facing message: "❌ No pude registrar todas las acciones del mensaje. Ningún dato quedó guardado. Probá de nuevo o registralo en mensajes separados."
- `src/config/db.js` also exports `withTransaction(fn)` for any new code that needs an atomic boundary (used by `AccountDeletionService` and `SubscriptionService.handleWebhook`).

### Channel verification — WhatsApp OTP + Telegram deep-link (`REQUIRE_VERIFIED_CHANNEL`)
- Migration 076 adds `users.whatsapp_verified_at`, `users.telegram_verified_at`, table `channel_verifications` (code, target, attempts, expires_at, verified_at) with partial indexes for pending lookups. **Grandfathers existing users**: any user with a real phone (not the `tg_<id>` placeholder) or `telegram_id` is auto-marked verified at NOW() so this is non-breaking.
- `src/domain/auth/channel-verification.service.ts` — `ChannelVerificationService`. Methods: `startWhatsApp` (normalizes AR phones, generates 6-digit OTP, sends via Cloud API, race-safe phone-collision check), `confirmWhatsApp` (TTL + max-attempts), `startTelegramLink` (deep-link via `t.me/<bot>?start=verify_<token>`), `redeemTelegramToken` (idempotent linking from the bot side; safe if Telegram already linked elsewhere), `unlinkWhatsApp/Telegram`, `getStatus`.
- Endpoints (under `/api/auth`, all require auth): `GET /verify/status`, `POST /verify/whatsapp/start|confirm`, `DELETE /verify/whatsapp`, `POST /verify/telegram/start`, `DELETE /verify/telegram`.
- Bot gating: WhatsApp + Telegram controllers add a top-level gate using `userRepository.findVerifiedByPhone` / `findVerifiedByTelegramId`. When `REQUIRE_VERIFIED_CHANNEL=true` and no verified user owns this channel, replies with onboarding hint pointing at `PUBLIC_URL/register` and stops (no anonymous auto-create). Telegram also intercepts `/start verify_<token>` BEFORE user lookup to redeem deep-link tokens.
- Settings (group `system`): `PUBLIC_URL`, `TELEGRAM_BOT_USERNAME` (without @), `OTP_TTL_MINUTES` (10), `OTP_MAX_ATTEMPTS` (5), `TELEGRAM_LINK_TTL_MINUTES` (1440), `REQUIRE_VERIFIED_CHANNEL` (kill switch, default false).
- Frontend: "Mi cuenta" tab in dashboard (`frontend/src/components/ChannelLinking.tsx`) drives both flows.

### Data export + account deletion (always on, GDPR)
- Migration 077 adds `users.deleted_at` for soft-delete with 30-day grace.
- `src/services/data-export.service.ts` — `DataExportService.streamUserExport(userId, res)` streams a ZIP via `archiver`. One CSV per domain (23 in total: fields, plots, plot_crops, expenses, incomes, budgets, expense_templates, activities, observations, scoutings, harvest_loads, rainfall, agronomic_reports, livestock_groups, livestock_movements, feedlots, corrals, warehouses, stock_items, stock_movements, documents [metadata only — binaries excluded], field_invites, field_members) plus README.txt + metadata.json. Per-table failures are isolated (replaced with an error stub instead of aborting the entire export).
- `src/domain/auth/account-deletion.service.ts` — `AccountDeletionService.deleteAccount(userId, password)`: requires current password, marks `status='deleted'` + `deleted_at`, nulls out PII (email, phone_number, telegram_id, password_hash, *_verified_at), revokes all refresh tokens — all wrapped in `withTransaction`. The same email can be re-registered immediately because PII is released.
- Endpoints (under `/api/auth`): `GET /me/export` (streams ZIP), `DELETE /me` (requires password in body).

### Payments — MercadoPago Subscriptions (`PAYMENTS_ENABLED`)
- Migration 078 creates `subscriptions` (state machine: trial → active → past_due → cancelled/expired; partial unique index `idx_subscriptions_user_active` enforces ONE non-terminal sub per user) and `payment_events` (idempotent webhook log, unique `(provider, provider_event_id)`). Plus `plans.price_ars_yearly` for optional annual pricing.
- `src/domain/billing/payment-provider.ts` — abstract `PaymentProvider` interface. Implementations plug in via the same shape (Stripe etc. can be added later).
- `src/domain/billing/mercadopago.provider.ts` — MP Preapproval API integration. Creates recurring charges (monthly = 1 month frequency; yearly = 1 year), validates HMAC `x-signature` (skipped only when `MP_WEBHOOK_SECRET` is empty for sandbox), maps MP statuses (`authorized`→active, `paused`→past_due, `cancelled`→cancelled, `finished`→expired).
- `src/domain/billing/subscription.service.ts` — `SubscriptionService`. Methods: `createTrialIfMissing` (called from `AuthService.register`; creates a 14-day pro trial when `PAYMENTS_ENABLED`), `getStatus`, `startCheckout` (gated by enabled + provider configured + plan has price > 0), `cancel` (immediate downgrade for pure trials, deferred to `current_period_end` for paid subs — provider is told to stop billing, local sub keeps `status='cancelled'` until cron sweep downgrades plan), `handleWebhook` (idempotent — duplicate events become no-ops via the unique constraint; on `status='active'` event also calls `setUserPlan` + invalidates feature gate cache), `sweepExpired` (daily cron at 03:15 AR via `subscriptionSweepTick` in scheduler.js — handles trial expiry, past_due grace window, cancelled subs whose period_end has passed).
- Endpoints: `GET /api/auth/subscription`, `POST /api/auth/subscription/checkout` (body: `{plan, period}`), `POST /api/auth/subscription/cancel`. Webhook lives outside the API tree at `POST /webhooks/mercadopago` and is mounted with `express.raw` BEFORE the global JSON parser so signature verification has access to original bytes.
- Settings (group `payments`): `PAYMENTS_ENABLED` (kill switch), `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `TRIAL_DAYS` (14), `TRIAL_PLAN_NAME` (pro), `PAST_DUE_GRACE_DAYS` (3).
- Frontend: "Suscripción" card in Mi cuenta — current plan + status (trial/active/past_due/cancelled), trial expiry countdown, monthly/yearly toggle, MP checkout button, cancel button. Hidden when `PAYMENTS_ENABLED=false`.
- **Production rollout**: get production credentials at https://www.mercadopago.com.ar/developers/panel/credentials → set `MP_ACCESS_TOKEN` + `MP_WEBHOOK_SECRET` in admin → register webhook URL `<PUBLIC_URL>/webhooks/mercadopago` in MP > Notificaciones → flip `PAYMENTS_ENABLED=true`. Test flow with sandbox card before announcing.

## Key Conventions

- ESM modules (`"type": "module"`) — `import`/`export`, not `require`
- All user-facing text in Argentine Spanish
- Currency: ARS (default) and USD; amounts use Argentine conventions (50mil = 50,000, medio palo = 500,000, palo = 1,000,000)
- Timezone: `America/Argentina/Buenos_Aires` (UTC-3). Centralized helpers in `src/utils/date.ts`: `getNowArgentina()`, `getTodayISO()`, `formatDateAR()`. PostgreSQL timezone set via migration 048.
- Soft delete: `deleted_at` on expenses, incomes, fields, plots
- Lotes (plots) = primary productive unit; Campos (fields) = grouping container
- PlotDiscoveryService is LOOKUP-ONLY — never auto-creates fields/plots
- AI calls are plan-based rate-limited (free=20, pro=100, pro_plus=300, enterprise=1000 daily)
- Observation guard: `isLikelyQuestionOrFollowUp()` prevents non-agro text from being saved as observations

## Feature Gates

All 13 features are independently toggleable per plan via admin UI (`PUT /dashboard/api/plans/:id/features`). Bot commands, dashboard API endpoints (`requireFeature()` middleware), and frontend (Sidebar + BottomNav + view guard) all enforce gating.

| Feature Key | Required Plan | Scope |
|-------------|---------------|-------|
| `expenses` | all | log_expense, financial_report, expense templates, dashboard Gastos tab + API |
| `incomes` | all | log_income, income edits, dashboard Ingresos tab + API |
| `fields` | all | add_field, add_plot, add_plots_batch, set_plot_grupo, etc. |
| `budgets` | all | set_budget |
| `rainfall` | all | log_rainfall, rainfall reports |
| `agronomy` | all | sow/harvest/spray/fertilize, observations, agro reports, campaign_stats, dashboard Activities + Observations tabs + API |
| `csv_export` | pro+ | export_csv |
| `weather` | all | weather_full, weather_forecast, weather_field |
| `audio` | all | voice message transcription |
| `sharing` | enterprise | share_field (accept_invite is ungated) |
| `stock` | pro_plus+ | create_warehouse, add_stock, check_stock, etc., dashboard Stock tab + API |
| `documents` | all (daily limits vary) | upload_document, list_documents, dashboard Documents tab + API |
| `livestock` | pro_plus+ | add_livestock, transfer_livestock, health/repro/weighing events, feedlots, corrals, dashboard Hacienda tab + API |

## Key File Map

### AI Pipeline
- `src/ai/agent.service.ts` — Claude tool_use agent (primary). `AgentResult.truncated` exposed when stop_reason=max_tokens
- `src/ai/tool-definitions.ts` — 98 tool definitions with typed schemas
- `src/ai/agent-prompt-builder.ts` — Compact system prompt with disambiguation rules
- `src/ai/agent-response-mapper.ts` — AgentResult → ParseResult[] conversion. Mutating layers here LOG every drop/override (`AI_MAPPER DROP`, `[INTERCEPT]`) — keep it that way; silent vetoes were the worst bug class of Jun 2026
- `src/ai/agent-output-validator.ts` — **anti-hallucination layer** (flags `AGENT_OUTPUT_VALIDATION_ENABLED` + `AGENT_VALIDATE_CROP`/`AGENT_VALIDATE_PLOT_FIELD`, all ON in prod): strips crop/plot/field the agent inferred without backing in the user text. Invariants (Jun 2026 hardening, own 15-test suite): validates against the pronoun-EXPANDED text (agentInputText — our expander's injections are trusted), accepts ALL crops in the text (multi-crop compounds), accepts partial plot-name tokens ("el norte" validates "Lote Norte Grande"; generic tokens like "lote"/"campo" don't count), every strip logs `AI_VALIDATOR DROP`
- `src/ai/intent-extractor.ts` — JSON extraction (legacy fallback)
- `src/ai/few-shot.service.ts` — Training examples as tool_use triplets
- `src/ai/user-context.service.ts` — User fields/plots with 60s cache
- `src/ai/conversation-history.service.ts` — Multi-turn context (4000 char budget)

### Domain Handlers
- `src/domain/agronomy/` — Activities, observations, weather, reports, campaigns, tacto
- `src/domain/financial/` — Expenses, incomes, budgets, reports, plot creation
- `src/domain/livestock/` — Cattle inventory (event-sourced, 14 AI tools: 8 inventory + 6 health/repro/weighing)
- `src/domain/stock/` — Inventory management (8 AI tools)
- `src/domain/documents/` — Invoice/receipt processing (Claude Vision)
- `src/domain/sharing/` — Invite-code field sharing
- `src/domain/feedlot/` — Feedlot/corral CRUD
- `src/domain/auth/` — Auth + `ChannelVerificationService` (OTP/deep-link) + `AccountDeletionService` (soft-delete + PII release)
- `src/domain/billing/` — Plans + `FeatureGate` + `PaymentProvider` interface + `MercadoPagoProvider` + `SubscriptionService`
- `src/domain/router.ts` — **DomainRouter**: routes commands to handlers. New commands MUST be added to the appropriate `*_COMMANDS` set here or they will silently fail (return null). Also accepts optional `bulkMode` flag and writes it to `cmd._bulkMode` so any handler can read it.
- `src/domain/compound-executor.ts` — Sequential execution inside `withTransaction`. Sets `bulkMode = actionable.length >= 2`. Has the bulkMode interceptor (strips blocking side-effects + suppresses prompts), collects `savedRecordsWithoutPlot[]` across kinds, surfaces partials, and builds the post-compound bulk-plot prompt with base64 `bap2_*` button payload.
- `src/domain/interactive/interactive.router.ts` — Dispatches button callbacks to commands. `bap2_<base64>_<plotId>` → `assign_bulk_plot` with kind-grouped record ids. Legacy `bap_*` parser kept.

### Services & Middleware
- `src/services/intent-classifier.ts` — Pipeline orchestrator
- `src/services/expenses.js` — Main DB layer (all CRUD)
- `src/services/localidad-lookup.service.ts` — City validation (4027 census localities)
- `src/middleware/conversation-engine.ts` — Flow FSM (startFlow, processFlowMessage, clearFlow). Includes `extractRenameCorrection()` for mid-flow name corrections
- `src/middleware/pending-field-location.ts` — 3-option field location (city/map/share)
- `src/middleware/pending-plot-area.ts` — Queue-based hectares assignment
- `src/middleware/slot-extractor.ts` — **Unified slot extractors** for 12 slot types. Single source for amount/category/plot/field/crop/quantity/unit/unit_price/product/currency/count/hectares. Reuses existing helpers. Used by `pending-action-processor` and `validatePlotAsync` fallback.
- `src/middleware/pending-action-processor.ts` — Merges extracted slots into a pending action's `data`, returns updated pending (when slots still missing) OR null (when ready to execute). Auto-generates Spanish ask-prompts for remaining slots. **CAUTION**: pre-existing duplicate `const missing` declaration was silently breaking tsx transform → 500 on every pending answer. Fixed `58ae007`.
- `src/middleware/pending-activities.ts` — Store + `PendingActivity` type with `missing?: string[]` + `askPrompt?: string` + `nextInQueue?: Array<...>`. 5-min TTL. The `nextInQueue` is the serial pending queue — items wait for the current pending to complete before being asked. **DB-persisted since Jun 2026** via `PendingMirror` (write-through; controllers hydrate at message entry).
- `src/middleware/pending-persistence.ts` — `PendingMirror` (write-through mirror of the 4 pending stores to the `pending_states` table, migration 097) + `sweepExpiredPendingStates` (hourly cron). Fill-if-missing hydration + 60s tombstones. Survives restarts/deploys.
- `src/middleware/user-lock.ts` — `withUserLock(key, fn)`: per-user promise-chain serialization in the 3 webhook controllers. Rapid messages from the same user process in order; different users stay parallel.
- `src/middleware/pending-queue-advancer.ts` — Shared helper used by all 3 controllers. After a pending completes + re-routes, decides whether to (a) merge remaining queue into a new pending the re-route set, (b) pop next queue item as new pending + return its askPrompt, or (c) clear (queue empty).

### Message Pipeline + Controllers (refactor Jun 2026 — controllers are thin channel adapters now)
- `src/services/message-pipeline.ts` — **THE message pipeline**: canonical `processTextMessage` + `handleInteractiveReply` + `applySideEffects` + single service graph + single set of pending-store singletons, shared by the 3 channels via `ChannelContext { channel, phone, userId, user, settings, startTime, handleDocCallback? }`. Before this, each controller duplicated ~900 LOC of text pipeline + ~400 of button handling and fixes landed on one channel but not the others (telegram had campaign-close handling test-bot lacked; test-bot had try/catch over processPendingAction telegram lacked; only whatsapp injected follow-up memory — all unified now). **Rule: NEVER apply a `setPending*` side-effect by hand in a branch — always call `applySideEffects(response.sideEffects, phone)`.** New side-effect keys get added THERE only. Attachments travel as `_attachment` on the item (binary preserved); test-bot strips it before res.json.
- `src/services/document-pipeline.ts` — shared document processing (facturas/remitos): `processDocumentWithIntent`, `saveDocExpenses`, `loadRemitoStock`, `resolveDocPlot`, `makeDocCallbackHandler(downloadFile)` (the 7 `doc_*` button branches). Controllers provide only their media-download function.
- `src/controllers/whatsapp.controller.ts` (~380 LOC, was ~2455) — webhook verify/parse, channel gate (OTP), audio rate-limit + transcription, image/PDF receive, location, render items via Cloud API. Converted from push (sendMessage inline per branch) to collect (items → render at end).
- `src/controllers/telegram.controller.ts` (~410 LOC, was ~2232) — update parse, `/start verify_<token>` deep-link, channel gate, audio download + transcription, photo/PDF receive, location, render items (with the never-silent send-failure fallback)
- `src/controllers/test-bot.controller.ts` (~400 LOC, was ~1935) — JWT auth, JSON transport, direct audio transcription, `/reset` + `/query-db` behind `testEndpointGate`
- `src/routes/auth.routes.ts` — All `/api/auth/*` endpoints incl. verify, me/export, me delete, subscription
- `src/routes/webhooks.routes.ts` — `/webhooks/mercadopago` (mounted with `express.raw` BEFORE the global JSON parser so HMAC verification has the original bytes)

### Eval Framework (Conversational Testing)
- `src/testing/run-eval.ts` — CLI entry: `npm run eval` (runs all scenarios against local Docker)
- `src/testing/test-bot-client.ts` — HTTP client wrapping test-bot API (send/tap/reset/queryDb)
- `src/testing/assertions.ts` — Deterministic assertions (responseContains, dbHasExpense, dbHasActivity, etc.)
- `src/testing/scenario-runner.ts` — Loads JSON scenarios, runs setup→steps→assertions→report
- `src/testing/scenarios/*.json` — 25 test scenarios + `_setup.json` reusable sequences
- `src/testing/qa-adversarial-30.ts` — 30 adversarial QA scenarios (run: `npx tsx src/testing/qa-adversarial-30.ts`)
- `src/testing/qa-adversarial-advanced-40.ts` — 40 advanced adversarial scenarios (run: `npx tsx src/testing/qa-adversarial-advanced-40.ts`)
- `src/testing/qa-compound-mixed-25.ts` — 25 multi-domain compound conversations (May 23)
- `src/testing/qa-bulk-extended-20.ts` — 20 conversations verifying bulkMode interceptor across handlers (May 23)
- `src/testing/qa-onboarding-25.ts` — 25 first-impression cases (resets to ZERO state between tests; verifies new-user onboarding works in ONE message)
- `src/testing/qa-serial-conversations-20.ts` — 20 multi-turn scenarios verifying the serial pending queue (NEW May 23)
- `src/testing/qa-repeated-combos-20.ts` — 20 repetition-focused scenarios (NEW May 23)
- `src/testing/qa-prod-senior.ts` — 24 senior-engineer-style scenarios run against PROD (memoria, contexto, consistencia, recovery). Categorical scoring + severity-grouped bugs + verdict line. (NEW May 27)
- `src/testing/qa-prod-regression-v2.ts` — 25 fresh scenarios that retarget the categories that were weak in `qa-prod-senior` after each fix lands. Auto-cancels pendings between tests, retries `dbq` on 5xx. Used to verify pronoun-expander + plot-intent + extractCategoryCorrection extensions stay green. (NEW May 27)

### Config & Utils
- `src/config/db.js` — `pool` (with AsyncLocalStorage hijack for transactions) + `withTransaction(fn)` helper
- `src/utils/parser.js` — Spanish text normalization, number expansion, category matching
- `src/utils/date.ts` — Argentina timezone helpers
- `src/utils/guards.ts` — `isLikelyQuestion()` guard
- `src/utils/format-quantity.ts` — `formatQuantityHuman()`: renders large kg as tn (e.g. 213200kg → ≈ 213,2 tn)
- `src/utils/pronoun-expander.ts` — `expandPronouns(text, lastPlotName, prevPlotName?)` — server-side rewrite of "ahí mismo / ese (mismo) lote / el de antes" → "en lote X", plus "el otro lote / en el otro" → second-most-recent plot from `context_stack` (prevPlotName, lazy lookup in intent-classifier only when text says "el otro"; "el otro día" temporal is excluded). Wired into `intent-classifier.ts` STEP 2.6.
- `src/utils/plot-intent.ts` — `userExplicitlyReferencedPlot(text)` — does the user's text contain a plot pronoun or explicit "lote X" mention? Used by `financial.handler` to decide whether `FIELD_LEVEL_CATEGORIES` should strip the auto-resolved plot.
- `src/utils/relative-dates.ts` — `resolveRelativeDate(text)` (incl. named weekdays "el lunes", AR-local) + `resolveAllRelativeDates(text)` (ordered, for multi-day messages so each entry keeps its own date) + `TOOLS_WITH_DATE_PARAM` + `dateKeyForTool()`. The mapper OVERRIDES the agent's date when a relative/weekday phrase is present (agent landed weekdays +1).
- `src/utils/lexicon.ts` — **single source of truth** for conversational synonym sets: `CORRECTION_CUES`/`CORRECTION_ALT`, `COPULA_ALT`, `detectCurrencyTerm` (USD/ARS incl. slang verdes/mangos), `UNIT_TERMS`/`QUANTITY_UNIT_RE`, `MONEY_HINT_RE`, `hasDeleteVerb`, `stripAnswerPrefix`, `normLex`. Add synonyms here, not in handler regexes.
- `src/middleware/dedup.ts` — `MessageDedup` time-windowed (10-min TTL) idempotency for webhook update_id/callback ids.
- `src/services/data-export.service.ts` — `DataExportService.streamUserExport()` — full GDPR ZIP per user
- `src/types/index.ts` — ParseResult, PlanRow, ParseSource

### Landing Page
- `landing/` — Git submodule (campo-chat-bot). Marketing site: hero, features, pricing, testimonial, WhatsApp demo
- Served on `/` and all non-matched routes. Frontend app served on `/login`, `/register`, `/dashboard`, `/chat` only
- Frontend assets at `/app-assets/*`, landing assets at `/assets/*` (no collision)

## Extended Documentation

- **[docs/ai/query-patterns.md](docs/ai/query-patterns.md)** — **SOURCE OF TRUTH** for the 8 unified query tools (financial / scouting / harvest / stock / livestock-inv / activities / rainfall). Every supported natural-language pattern → expected view/filters. Read this before modifying ANY query handler.
- **[docs/ai/tools.md](docs/ai/tools.md)** — Tool groups, disambiguation rules, compound actions
- **[docs/ai/failure-patterns.md](docs/ai/failure-patterns.md)** — Known pitfalls, hallucinations, data integrity issues
- **[docs/architecture.md](docs/architecture.md)** — Full implementation reference (AI, domain, services, DB, flows, auth, frontend)
- **[docs/operations.md](docs/operations.md)** — Deploy, env vars, migrations, Telegram setup, settings tables
- **[docs/features/stock.md](docs/features/stock.md)** — Stock/inventory system
- **[docs/features/livestock.md](docs/features/livestock.md)** — Livestock/hacienda system
- **[docs/features/documents.md](docs/features/documents.md)** — Document processing (facturas/remitos)

## Tests

### Unit Tests (vitest)
- 1769 total. **Local baseline: 1753 passing + 16 env-dependent fails** (intent-classifier/stt tests that need seeded DB state — they return `trial_expired` without it; they PASS in CI, which is the deploy gate). Don't chase those 16 locally; compare against this baseline after changes.
- Run: `npm test`
- Single file: `npx vitest run src/utils/parser.test.js`

### Conversational Eval (end-to-end, real pipeline)
- 25 scenarios testing key intents against local Docker (real DB, real AI pipeline, no mocks)
- **Last run (Jun 2026): 24/25 (96%)** — the 1 fail is LLM non-determinism on the price-proximity rule ("vendí A y B a $X" → Haiku sometimes prices both items instead of only the adjacent one). Jun 2026: 10 scenarios had drifted assertions (eventType "sow"/"spray" vs DB "planting"/"spraying", category picker is now a list not buttons, confirm cards show category not description, "Junín" became ambiguous in the localidad census) — fixed, the eval is a useful signal again.
- Requires: `docker compose up -d` (app on :3000 + DB on :5433)
- Run: `npm run eval` — auto-registers test user, resets between scenarios, exits 1 on failure
- Single: `npx tsx src/testing/run-eval.ts --scenario basic-expense`
- Verbose: `npm run eval:verbose`
- Scenarios cover: expenses, incomes, fields/plots, sowing, spraying, observations, weather, reports, greetings, rainfall, compound actions, conversational fallback
- Add new scenarios: create `src/testing/scenarios/NN-name.json`, reusable setup in `_setup.json`
- **Run eval after any change to the AI pipeline, agent prompt, tool definitions, handlers, or flows**

### QA Adversarial Testing (30 scenarios)
- `npx tsx src/testing/qa-adversarial-30.ts` — 30 adversarial scenarios testing informal language, ambiguity, stock, hacienda, scouting, complex queries
- Requires: `docker compose up -d` + enterprise plan on test user
- Tests: implicit references, typos, compound actions, recategorización, multi-day rainfall, crop scouting severity, harvest loads, financial queries vs registrations, unit conversions (qq/tn), weather, context memory
- Last run: **90% pass rate** (27 PASS, 0 FAIL, 3 WARN) — MVP READY

### QA Adversarial Advanced Testing (40 scenarios)
- `npx tsx src/testing/qa-adversarial-advanced-40.ts` — 40 advanced adversarial scenarios targeting silent data corruption, memory drift, temporal contradictions, entity collisions, cross-domain confusion, and edge cases
- Requires: `docker compose up -d` + enterprise plan on test user
- Uses DB verification via `/api/test-bot/query-db` endpoint (SELECT/UPDATE only)
- Setup: 2 fields (La Esperanza + San Martin), 6 plots, 4 crops, livestock, stock warehouse
- Categories: silent corruption (01-08), memory drift (09-16), temporal contradictions (17-22), entity collisions (23-30), cross-domain confusion (31-36), edge cases (37-40)
- Last run: **73% pass rate** (29 PASS, 0 FAIL, 11 WARN)

### QA Compound Mixed Testing (25 multi-domain conversations, May 23)
- `npx tsx src/testing/qa-compound-mixed-25.ts` — 25 compounds each mixing 4+ different action domains (gastos, ingresos, actividades, hacienda, cosecha, monitoreos, stock).
- 10 with complete data, 15 with partial. Verifies the compound executor + post-compound bulk-plot prompt + partial-pending wire end-to-end.
- Last run: **14/25 (56%) PASS** — many fails are assertion-strict on substrings (bot says "Combustible" when test expected "gasoil"). Real pass-by-DB-writes is higher.

### QA Bulk-Mode Extended Testing (20 conversations, May 23)
- `npx tsx src/testing/qa-bulk-extended-20.ts` — 20 NEW compounds focused on verifying the bulkMode interceptor works for non-financial handlers (agronomy, livestock, stock).
- 8 complete + 12 partial. Tests that the bot NEVER stops mid-compound (no flow, no pending in bulk).
- Last run: **16/20 (80%) PASS** — 12/15 partials pass. Remaining fails are handler-level conflicts (crop mismatch, repro-no-bull) orthogonal to bulkMode.
- Asserts a "graceful ask" response as PASS for partial cases (the agent asking for missing data IS acceptable UX).

### QA Onboarding Testing (25 first-impression cases, May 23)
- `npx tsx src/testing/qa-onboarding-25.ts` — 25 brand-new-user scenarios. **Each test resets to ZERO state** then sends ONE compound message creating field + plots + activities + livestock + stock from nothing.
- Targets the most common onboarding patterns: "Tengo el campo X en Y con lotes A, B, C. Sembré soja en A".
- Last run: **22/25 (88%) PASS** — best suite result. Average 0.8 fields + 1.5 plots + 1.7 records per single onboarding message.
- Critical for first-impression UX: a new user can dump their entire setup in one message and the bot persists it cleanly.

### QA Serial Conversations (20 multi-turn scenarios, May 23)
- `npx tsx src/testing/qa-serial-conversations-20.ts` — 20 compound messages where some items have missing data; the test answers the bot's follow-up questions one-at-a-time and verifies each item ends up with the right data (no conflation).
- **Discovered TWO production-blocking bugs** later fixed in `58ae007`:
  1. `pending-action-processor.ts` had a duplicate `const missing` that crashed tsx transform → every multi-turn pending answer returned 500
  2. Re-routing `log_income`/`log_expense` pendings lost the `command` field → silent data drop
- After the fixes the serial queue mechanism works end-to-end across 2-6 item compounds.

### QA Repeated Combos (20 repetition-focused scenarios, May 23)
- `npx tsx src/testing/qa-repeated-combos-20.ts` — 20 NEW scenarios focused on REPEATED action types (2x compra + 2x venta, 3x fumigación, 3x hacienda, etc.) — verifies the agent emits N tools when the user repeats a verb N times, plus diverse real-farmer-style combinations.
- Setup shared across tests (does NOT reset between cases); each test measures DB deltas to verify correct attribution.

### QA Prod Senior + Regression V2 (24 + 25 scenarios, May 27)
- `npx tsx src/testing/qa-prod-senior.ts` — 24 senior-engineer-style scenarios run against PROD on a fresh user. Categories: memoria_corto / memoria_largo / context_switch / math_consist / fin_consist / temporal / entities / colloquial / multi_intent / ambiguity / contradiction / recovery. Produces a categorical scorecard + severity-grouped bug list + verdict line.
- `npx tsx src/testing/qa-prod-regression-v2.ts` — 25 fresh scenarios that re-target the same categories with NEW conversations + better assertions (uses DB writes, not response substrings). Auto-cancels pending state between tests. Retries `dbq` on 5xx (Railway flake).
- Drove the May 27 fix sequence: pronoun-expander (memoria categories from failing to 100%), relative-date normalizer (temporal 100%), `userExplicitlyReferencedPlot` (P01/P02), `handleFinancialReport` updating `conversation_state` (P02), `extractCategoryCorrection` extended to "no, era en X" + pending-correction interceptor (CR02).
- **Stable score: 24/25 (96%)** — the 1 outlier is LLM non-determinism on "flete" categorization (Haiku sometimes maps to "Otros", sometimes asks for clarification). Real categories all green.
