# Architecture Reference

## AI Agent System (`src/ai/`)

### AI Agent (tool_use) — primary path
- **`agent.service.ts`** — Calls Claude with `tool_use` + `tool_choice: auto`; returns `AgentResult` with tool calls array + optional conversational text. Uses plan-based rate limiting, conversation history, few-shot examples, and configurable timeout.
- **`tool-definitions.ts`** — 74 tool definitions with typed `input_schema`. All registration tools include `event_date` (YYYY-MM-DD). Query/report tools include expected output data and example trigger phrases.
- **`agent-prompt-builder.ts`** — Compact system prompt (~400 tokens) with disambiguation rules, user context, dynamic today's date. Activity synonym lines dynamically generated from `activity_dictionary` DB table (admin-editable).
- **`agent-response-mapper.ts`** — Converts `AgentResult` → `ParseResult[]` for backward compat. Maps tool calls to expense/income/command ParseResults. No-tool responses → `_conversationalResponse`. Smart agro filter: drops `log_expense`/`log_income` alongside agro tools only when amount=0.
- **`few-shot.service.ts`** — `formatAsToolUseMessages()` converts training examples to tool_use triplets.

### Compound Action Execution
- **`src/domain/compound-executor.ts`** — Sequential executor for multiple tool calls from single message
- `IntentClassifier` attaches `_compoundResults` when `parseResults.length > 1`
- Handles `command`, `expense`, `income` types (DomainRouter + FinancialHandler)
- Forces `confirm_before_save=false`, stops at `startFlow` sideEffects
- Livestock consolidation: same-plot livestock commands merged into single response
- Combined messages sent as single response, compound logger captures all

### JSON Extraction — legacy (AGENT_ENABLED=false)
- **`intent-extractor.ts`** — Claude Haiku with JSON prompt + assistant prefill → ParseResult
- **`prompt-builder.ts`** — System prompt with 33+ intents, agro rules, disambiguation
- **`intent-validator.ts`** — Validates LLM JSON, maps to ParseResult; propagates field/plot into expense/income data

### Shared AI Services
- **`conversation-history.service.ts`** — Recent turns from `conversation_logs` (4000 char budget)
- **`user-context.service.ts`** — User fields/plots/lastContext with 60s cache
- **`conversational-fallback.service.ts`** — Rate-limited (5/10min) fallback for unknown intents (only when AGENT_ENABLED=false)

## Key Services (`src/services/`)

- **`expenses.js`** — Database layer for all CRUD: expenses, incomes, budgets, fields, rainfall, user settings, AI usage, plot history. `getOrCreateUserByTelegramId()` for Telegram provisioning. `accessibleFieldsSql()` helper for `field_members` access control.
- **`localidad-lookup.service.ts`** — Validates city names against 4027 Argentine census localities. Exact match, disambiguation, fuzzy (Levenshtein ≤ 3), or not_found. Normalizer strips accents AND soft hyphens (U+00AD).
- **`whatsapp.js`** — WhatsApp Cloud API client
- **`telegram.ts`** — Telegram Bot API client (sendMessage, sendButtons, sendList, sendDocument, downloadFile). Markdown retry on parse errors.
- **`weather.js`** — OpenWeather API for forecasts and rain alerts
- **`alert.service.js`** — Multi-channel alert delivery (Telegram-first, WhatsApp fallback, web push supplementary). Dedup, retry with backoff, `alert_history` tracking.
- **`scheduler.js`** — node-cron: weekly summaries, monthly summaries (1st of month), daily weather alerts (HH:MM precision), low stock alerts (8AM), phenology growth stage alerts (8AM), expense template processing (7AM), flow reminder tick (every minute). Argentina timezone.
- **`report-share.service.ts`** — PDF generation for campaign and financial reports via PDFKit. Returns `{ buffer, filename, mime }`.
- **`push-notification.service.ts`** — Web push notifications via VAPID/web-push. Subscribe/unsubscribe/sendToUser. Auto-cleans expired subscriptions.
- **`observations.js`** — Observation CRUD with 4-layer dedup, normalization, financial guard
- **`settings.service.js`** — Global settings with descriptions, grouped by category
- **`activity-dictionary.service.ts`** — Cached CRUD for `activity_dictionary` (5-min TTL). Feeds dynamic synonym lines into agent prompt.
- **`map-token.service.ts`** — Single-use tokens for map polygon drawing page (30-min expiry)

## Middleware (`src/middleware/`)

- **`pending-field-city-handler.ts`** — Shared city validation across all 3 controllers. `formatLocation()` helper. Strips full-sentence patterns before city lookup.
- **`pending-field-location.ts`** — Store + handler for 3-option field location (city/map/share). Map token URLs, polygon/location callbacks, reverse geocoding via Nominatim.
- **`pending-plot-area.ts`** — Queue-based store for plot hectares. Single (`set`) or batch (`setQueue`), `dequeueFirst()`, 5-min timeout.
- **`pending-plot-area-handler.ts`** — Shared blocking handler: re-prompts invalid, dequeues valid, clears on cancel. `storePlotAreaSideEffects()` handles both sideEffect types.
- **`auth.middleware.ts`** — `requireAuth` (Bearer JWT) + `requireRole` Express middleware
- **`telegram-auth.ts`** — Webhook secret verification

## Domain Layer (`src/domain/`)

### Agronomy (`agronomy/`)
- AgronomyHandler: activities, observations, weather, rainfall, agro reports (date range via desde/hasta), plot history queries (detail ≤15 rows, summary above), tacto/pregnancy checks, tacto summary, edit_last_activity, campaign lifecycle, campaign comparison, PDF report sharing
- `normalizeActivityFilter()` maps AI filter strings to DB event_type values
- Campaign lifecycle: ACTIVE → HARVESTED (`harvested_at`) → CLOSED (`end_date`). `CropService.startCrop()` auto-closes harvested campaigns when re-sowing.
- `active_crop`: with plot → single crop; without → ALL active crops (filterable by crop name)
- Sowed hectares: `sow_crop` accepts optional `hectares` → `plot_crops.sowed_hectares`
- Harvest loads: `harvest_crop` accepts optional `loads[]` (per-truck: driver, kg, destination). Dedup: same plot+today → append. `updateYieldFromLoads()` auto-sums into `plot_crops.yield_kg`. Query via `query_harvest_loads` tool. Delete duplicates via `delete_harvest_loads` tool.
- Campaign stats: cost/ha, cost/tn (ARS+USD), income/ha, income/tn metrics
- Campaign comparison: `compare_campaigns` tool compares 2 seasons (auto-detects or explicit) with % deltas on yield, expenses, incomes, net result/ha
- Phenology alerts: `phenology.service.ts` queries active crops against `crop_stages` table (soja/maiz/trigo growth stages), sends alerts at key milestones with 7-day dedup

### Financial (`financial/`)
- FinancialHandler: expenses, incomes, budgets, unified `financial_report`, mandatory hectares on plot creation, auto-split comma-separated plot names → `add_plots_batch`
- Recurring expense templates: `expense-template.service.ts` — create/list/delete templates with weekly/biweekly/monthly recurrence. Scheduler processes due templates daily at 7AM.
- `add_field` starts `field_flow` (3 location options) instead of immediate creation
- FinancialService, FinancialRepository

### Auth (`auth/`)
- JWT (bcrypt 12 rounds, 15min access, 7d refresh with DB-backed rotation)
- `auth.service.ts` — register (duplicate-email race handling), login, refresh, logout, profile
- `observation.service.ts` — Dashboard CRUD: observations (edit history), expenses, incomes, activities (with edit)

### Sharing (`sharing/`)
- Invite-code flow: owner → 6-char code (7-day expiry) → invitee redeems → `field_members` access
- `field_members` table used for all access control (`accessibleFieldsSql()`)
- Enterprise plan required to generate codes; `accept_invite` ungated

### Feedlot (`feedlot/`)
- CRUD for feedlots + corrals, access via `field_members`
- Max 1 feedlot per campo (UNIQUE field_id). Corrals unique by name within feedlot
- Cross-type transfers (lote ↔ corral) supported. Feature-gated to `livestock`

### Plots (`plots/`)
- PlotDiscoveryService (lookup-only, NEVER auto-creates), PlotRepository

### Billing (`billing/`)
- Plan-based AI daily limits + FeatureGate (maps commands → feature keys, checks plan access)

## Flow Engine (`src/middleware/`)

- **`conversation-engine.ts`** — FSM: startFlow, processFlowMessage, clearFlow, goBack, skipStep. Exports timeout/halflife message builders.
- **`conversation-state.repository.ts`** — DB-persisted flow state. `findActiveFlowsForReminder()`, `markHalflifeNotified()`.
- **`flows/`** — field_flow (3 location options), expense_flow, income_flow, rainfall_flow, activity_flow (dynamic `interactiveAsync` for plot selection)
- **Callback routing**: `flow_field_loc_*` handled BEFORE generic `flow_field_*` prefix
- Safe interruption commands execute mid-flow; financial intents cancel active flow
- **Flow reminders**: scheduler tick every minute checks for expired flows (send timeout + clear) and half-life reached (send "seguís ahí?" warning). Configurable via `FLOW_TIMEOUT_MS`, `FLOW_HALFLIFE_WARNING_MS` settings.

## Database

PostgreSQL with migrations in `src/migrations/001-066_*.sql`. Timezone: `America/Argentina/Buenos_Aires` (migration 048). Migrations auto-run on app startup via `bootstrap()` → `runMigrations()`.

### Key Tables
- `users` (telegram_id, province, last_name), `fields` (province, lat, lng, polygon, location_method), `plots`
- `expenses` (expense_date, edited_by, expense_type, product, quantity, unit), `incomes` (income_date, edited_by)
- `domain_events` (event_date, edited_by, stock_deduction_status, pregnant_count/open_count/uncertain_count)
- `agro_observations` (observation_date), `budgets`, `rainfall`
- `plot_crops` (crop, season_year, start_date, end_date, harvested_at, yield_kg, sowed_hectares)
- `harvest_loads` (domain_event_id, plot_crop_id, driver_name, weight_kg, destination, destinatario, truck_plate)
- `expense_templates` (name, amount, recurrence_type, recurrence_day, next_run_date, active)
- `crop_stages` (crop, stage_name, stage_code, typical_days_from_sowing, alert_message)
- `warehouses`, `stock_items` (current_quantity, min_stock, grade, humidity_pct), `stock_movements`
- `livestock_groups` (plot_id OR corral_id, category, breed, count), `livestock_movements` (movement_type, source/dest)
- `feedlots` (UNIQUE field_id), `corrals` (UNIQUE feedlot_id+name)
- `field_members` (sharing access control), `field_invites` (6-char codes)
- `push_subscriptions` (user_id, endpoint, p256dh, auth)
- `conversation_logs` (tool_calls JSONB, agent_mode, channel), `conversation_state`, `ai_usage`
- `activity_dictionary` (admin-editable synonyms), `map_tokens`, `alert_history`

## Routes

- `GET/POST /webhook` — WhatsApp webhook
- `POST /telegram` — Telegram webhook (secret verified)
- `/api/auth/*` — Auth + dashboard (register, login, refresh, plans, observations, expenses, incomes, activities, stock, livestock — including PATCH edits, GET filters, analytics, map-data, push notifications)
- `GET/POST /api/map/:token` — Public map page for polygon drawing (token-authenticated)
- `/admin/api/*` — Admin dashboard API (stats, users, settings, AI usage, parse metrics)

## Frontend (`frontend/`)

React 19 + Vite 6 + Tailwind v3 + React Router v6 SPA. Express serves `frontend/dist/` in production.

- Auth: JWT in localStorage, auto-refresh on 401, role-based route guards
- Dashboard: Sidebar (desktop) + BottomNav (mobile), `view` state. Default: Overview (KPIs, charts, map, quick actions, feed, alerts)
- Overview charts: `MonthlyTrendChart` (recharts AreaChart, 6-month expense/income trend), `ExpensePieChart` (recharts PieChart, category breakdown)
- Overview map: `FieldMap` (react-leaflet, collapsible, field markers + polygons colored by crop status)
- Detail views: Gastos, Ingresos, Actividades, Observaciones, Stock (feature-gated), Hacienda (feature-gated)
- Paginated tables with filters + inline edit buttons + edit modals. Mobile: card components instead of tables
- Edit audit: `edited_by` on all entities, shown as "Registrado por" / "editado por" in tables
- Date handling: `toLocalDate()` helper avoids UTC timezone shift
- Push notifications: `usePushNotifications` hook + bell icon in sidebar. Service worker at `frontend/public/sw.js`.
