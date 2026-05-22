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
- `npm run eval` — Run conversational eval (18 scenarios against local Docker, real pipeline + DB)
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

### Pending field-city escape hatch
- `pending-field-city-handler.looksLikeNonCity()` aborts the loop when the user types something that clearly isn't a locality (agro verbs, lists with `:`, queries with `?`, messages > 60 chars, SQL keywords, multiple commas). When triggered, the bot tells the user "Dejé pendiente la ubicación de X" and clears the pending state so subsequent registrations work.
- Add new escape patterns here, NOT in the agent prompt.

### Crop name synonyms (anglicismos)
- `src/utils/synonyms.js` + `src/ai/agent-response-mapper.normalizeCropName()` translate English crop names to Spanish before the handler sees them: `soybean → soja`, `corn/maize → maíz`, `wheat → trigo`, `sunflower → girasol`, `sorghum → sorgo`, `barley → cebada`, `oat/oats → avena`, `cotton → algodón`, `rye → centeno`. Applied in BOTH the regex parser layer and the agent input normalization, so anglicisms work whether AGENT_ENABLED is on or off.

### Stock + Expense Compound
- `add_stock` accepts optional `unit_price_ars` / `unit_price_usd`. When present, the handler auto-creates a linked expense (category "Insumos", total = quantity × unit_price). Best-effort: stock succeeds even if expense fails. Bot response includes "💰 Gasto registrado: $X" line.
- Agent prompt rule: "compré X a $Y → add_stock(unit_price_ars=Y). El sistema crea el gasto automáticamente, NO llamar log_expense por separado"

### Mid-flow rename
- During any flow that has a `data.name` field set (currently `field_flow`), the user can correct the name with patterns like "se llama X, no Y" / "no Y, es X" / "el nombre es X". `extractRenameCorrection()` in `conversation-engine.ts` parses the new name, mutates `data.name`, and re-prompts the current step — no need to cancel + restart.

### Mid-flow amount/category correction
- During any flow (expense, income, etc.) that has `data.amount` or `data.category` already set, the user can correct with patterns: "no, eran X" / "en realidad X" / "perdón, X" / "quise decir X" for amounts, or "no, es X" / "no, categoría X" for categories. Works both mid-flow AND during confirmation step. `extractAmountCorrection()` and `extractCategoryCorrection()` in `conversation-engine.ts`.

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
- **Opted-in handlers**: `log_spraying`, `log_fertilization` (guard at top of case in `agronomy.handler.ts` returns pending when product/plot/quantity missing). `sow_crop` and `harvest_crop` retain the legacy `_needs:'crop'` path AND also include `missing: ['crop']` so both controller branches work.
- **Plot fallback in expense/income flow**: `validatePlotAsync` in `src/middleware/flows/field-step-helpers.ts` now calls `extractSlots()` as a LAST RESORT before failing — catches "era todo de maíz del lote B1" (gives plot=B1 + stashes `_extractedCategory='Maíz'` for later use).
- **Escape patterns**: any `isCancelIntent(text)` clears the pending. Any `detectsFinancialIntent(text)` (now also matches "cargué/registré + qty+unit" via the May 2026 widening) also clears so the user can pivot to a brand-new financial action mid-pending.
- **Wired into**: `test-bot.controller.ts`, `telegram.controller.ts`, `whatsapp.controller.ts` — same code shape in each, ~50 LOC per controller. The legacy `_needs:'crop'` branch is preserved as a fallback below the new unified branch so old code keeps working.
- **Known limitation**: when the agent auto-resolves a plot from conversation context and the user contradicts it in the next message, the existing value blocks the override (the merge only fills NULL slots). Edge case — doesn't affect normal flows.

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
- Rain: today + next 2 days, threshold `user_settings.rain_alert_mm` (default 10mm)
- Wind: days with `wind ≥ wind_alert_kmh` (default 20) — for spraying decisions
- Dry window: N consecutive days < 1mm (default 3 days via `dry_window_days`) — for application/sowing planning
- All alerts include "_Es un pronóstico, puede cambiar._" disclaimer
- Dedup: 24h per city+day per alert type. Channel: Telegram-first, WhatsApp fallback

### AI Cost & Caching
- Agent settings live under the `ai` group in admin (`/admin/#settings`, section **"Configuración de IA"**): `AGENT_ENABLED`, `AGENT_MODEL`, `AGENT_MAX_TOKENS` (default 1500), `AGENT_TIMEOUT_MS`, `AGENT_TEMPERATURE`, `AGENT_CACHE_TTL` (`short`/`long`), `AGENT_FEW_SHOT_LIMIT` (default 5).
- Prompt caching: three cache_control breakpoints (system, tools, last few-shot). User context + today's date injected via `buildUserMessagePrefix()` so the cached prefix stays stable across users/calls.
- Few-shots rotate daily via `ORDER BY md5(id::text || CURRENT_DATE::text)` — deterministic per day, varied across days. No random reshuffles.
- `ai_usage` persists `cache_read_tokens` + `cache_write_tokens` (migration 070). Dashboard cost uses 4-term Haiku pricing: input 0.80, cache read 0.08 (10%), cache write 1.00 (125%), output 4.00 per M. Log line `AI_AGENT CACHE: Nread/Nwrite` shows real cache hits in Railway logs.

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
- `src/ai/tool-definitions.ts` — 82 tool definitions with typed schemas
- `src/ai/agent-prompt-builder.ts` — Compact system prompt with disambiguation rules
- `src/ai/agent-response-mapper.ts` — AgentResult → ParseResult[] conversion
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
- `src/domain/router.ts` — **DomainRouter**: routes commands to handlers. New commands MUST be added to the appropriate `*_COMMANDS` set here or they will silently fail (return null)
- `src/domain/compound-executor.ts` — Sequential execution of multiple tool calls inside a single `withTransaction` boundary; per-step throws → rollback all + user-facing apology message

### Services & Middleware
- `src/services/intent-classifier.ts` — Pipeline orchestrator
- `src/services/expenses.js` — Main DB layer (all CRUD)
- `src/services/localidad-lookup.service.ts` — City validation (4027 census localities)
- `src/middleware/conversation-engine.ts` — Flow FSM (startFlow, processFlowMessage, clearFlow). Includes `extractRenameCorrection()` for mid-flow name corrections
- `src/middleware/pending-field-location.ts` — 3-option field location (city/map/share)
- `src/middleware/pending-plot-area.ts` — Queue-based hectares assignment
- `src/middleware/slot-extractor.ts` — **Unified slot extractors** for 12 slot types. Single source for amount/category/plot/field/crop/quantity/unit/unit_price/product/currency/count/hectares. Reuses existing helpers. Used by `pending-action-processor` and `validatePlotAsync` fallback.
- `src/middleware/pending-action-processor.ts` — Merges extracted slots into a pending action's `data`, returns updated pending (when slots still missing) OR null (when ready to execute). Auto-generates Spanish ask-prompts for remaining slots.
- `src/middleware/pending-activities.ts` — Store + `PendingActivity` type with `missing?: string[]` + `askPrompt?: string`. 5-min TTL.

### Controllers + Routes
- `src/controllers/whatsapp.controller.ts` — WhatsApp webhook (with channel-verification gate when REQUIRE_VERIFIED_CHANNEL=true)
- `src/controllers/telegram.controller.ts` — Telegram webhook (intercepts `/start verify_<token>` deep-link redemption + same channel gate)
- `src/controllers/test-bot.controller.ts` — Test bot (same pipeline, JWT auth instead of phone lookup)
- `src/routes/auth.routes.ts` — All `/api/auth/*` endpoints incl. verify, me/export, me delete, subscription
- `src/routes/webhooks.routes.ts` — `/webhooks/mercadopago` (mounted with `express.raw` BEFORE the global JSON parser so HMAC verification has the original bytes)

### Eval Framework (Conversational Testing)
- `src/testing/run-eval.ts` — CLI entry: `npm run eval` (runs all scenarios against local Docker)
- `src/testing/test-bot-client.ts` — HTTP client wrapping test-bot API (send/tap/reset/queryDb)
- `src/testing/assertions.ts` — Deterministic assertions (responseContains, dbHasExpense, dbHasActivity, etc.)
- `src/testing/scenario-runner.ts` — Loads JSON scenarios, runs setup→steps→assertions→report
- `src/testing/scenarios/*.json` — 18 test scenarios + `_setup.json` reusable sequences
- `src/testing/qa-adversarial-30.ts` — 30 adversarial QA scenarios (run: `npx tsx src/testing/qa-adversarial-30.ts`)
- `src/testing/qa-adversarial-advanced-40.ts` — 40 advanced adversarial scenarios (run: `npx tsx src/testing/qa-adversarial-advanced-40.ts`)

### Config & Utils
- `src/config/db.js` — `pool` (with AsyncLocalStorage hijack for transactions) + `withTransaction(fn)` helper
- `src/utils/parser.js` — Spanish text normalization, number expansion, category matching
- `src/utils/date.ts` — Argentina timezone helpers
- `src/utils/guards.ts` — `isLikelyQuestion()` guard
- `src/utils/format-quantity.ts` — `formatQuantityHuman()`: renders large kg as tn (e.g. 213200kg → ≈ 213,2 tn)
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
- 1280 total, 0 failures. Baseline: 1280 passing.
- Run: `npm test`
- Single file: `npx vitest run src/utils/parser.test.js`

### Conversational Eval (end-to-end, real pipeline)
- 18 scenarios testing key intents against local Docker (real DB, real AI pipeline, no mocks)
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
