# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

campo-bot is a WhatsApp and Telegram-based agricultural management assistant for Argentine farmers (entirely in Spanish). It uses an AI-first parsing pipeline with two modes — **AI Agent (tool_use)** and legacy **JSON extraction** — with regex fallback, to understand natural language messages about farm expenses, income, agronomic activities, observations, weather, and rainfall, storing data in PostgreSQL.

## Commands

- `npm start` — Run the app (`node src/index.js`), listens on port 3000
- `npm test` — Run all tests (`vitest run`)
- `npx vitest run src/utils/parser.test.js` — Run a single test file
- `docker compose up --build` — Start app + PostgreSQL (port 5433 for DB, 3000 for app)
- `docker compose up -d db` — Start only the database
- `cd frontend && npm run dev` — Run React frontend dev server (port 5173, proxies API to :3000)
- `cd frontend && npm run build` — Build frontend for production (output: `frontend/dist/`)
- `npx tsx src/scripts/create-admin.ts --email <e> --name <n> --password <p>` — Bootstrap admin user
- `npx tsx src/scripts/seed-dummy-data.ts --user-id <id> [--reset]` — Seed realistic dummy data (4 months, 2 campos, expenses/incomes/activities/observations/rainfall)

## Architecture

### Message Processing Pipeline (3 Modes)

Messages are orchestrated by `src/services/intent-classifier.ts` through a strict fallback chain:

1. **Observation prefix** — Messages starting with "observación:" bypass AI entirely
2. **Trivial commands** — confirm, cancel, greeting, help, menu, etc. skip AI (~35 commands). Note: `generate_agro_report` is NOT trivial (needs agent for date range parsing)
3. **AI primary** — Two modes controlled by `AGENT_ENABLED` setting:
   - **Mode A: AI Agent** (`AGENT_ENABLED=true`) — `src/ai/agent.service.ts` calls Claude with `tool_use`; Claude decides which tool(s) to call or responds conversationally without tools. Supports compound actions (multiple tool calls per message).
   - **Mode B: JSON extraction** (`AGENT_ENABLED=false`, default) — `src/ai/intent-extractor.ts` calls Claude Haiku with JSON prompt + assistant prefill; returns structured JSON intent.
4. **Regex fallback** (`src/utils/parser.js`) — Commands, observations, bare references; only runs when AI is disabled/failed/low-confidence
5. **Conversational fallback** (`src/ai/conversational-fallback.service.ts`) — Lightweight Claude call for unknown intents (only active when `AGENT_ENABLED=false`; when agent is enabled, it handles conversational responses directly)

Kill switches:
- `AGENT_ENABLED=true` → tool_use agent (new)
- `AGENT_ENABLED=false` + `AI_INTENT_ENABLED=true` → JSON extraction (legacy, default)
- Both false → regex-only pipeline

### AI Intent System (`src/ai/`)

#### AI Agent (tool_use) — new primary path
- **`agent.service.ts`** — Calls Claude with `tool_use` + `tool_choice: auto`; returns `AgentResult` with tool calls array + optional conversational text. Uses plan-based rate limiting, conversation history, few-shot examples, and configurable timeout.
- **`tool-definitions.ts`** — 35 Anthropic tool definitions grouped by domain: Financial (2), Activities (6), Observations (2), Reports (5), Field/Plot Mgmt (5), Sharing (4), Stock (8), Documents (3), System (1). Each tool has typed `input_schema` with enum validation for categories. All registration tools include an optional `event_date` param (YYYY-MM-DD) for user-mentioned dates.
- **`agent-prompt-builder.ts`** — Compact system prompt (~400 tokens) with disambiguation rules, user context, and dynamic today's date for date extraction. Tool definitions carry the schema, so the prompt only needs rules. Includes explicit rules that agro activities (fumigué, sembré, coseché, etc.) are ONLY activities and NEVER expenses unless the user mentions an explicit amount. Activity synonym lines are dynamically generated from `activity_dictionary` DB table (admin-editable via dashboard).
- **`agent-response-mapper.ts`** — Converts `AgentResult` → `ParseResult[]` for backward compatibility. Maps `log_expense`/`log_income` tool calls to expense/income ParseResults (including `expenseDate`/`incomeDate` from `event_date`); everything else to command ParseResults (including `eventDate`). No-tool conversational responses become `_conversationalResponse` on ParseResult. **Smart agro filter**: when agent returns `log_expense`/`log_income` alongside an agro activity tool (sow_crop, harvest_crop, etc.), only drops them if amount=0 (Haiku hallucination). Keeps legitimate expenses with real amounts (e.g., "sembré soja y la semilla costó 100mil").
- **`few-shot.service.ts`** — `formatAsToolUseMessages()` converts training examples to tool_use triplets (user → assistant[tool_use] → user[tool_result]).

#### Compound Action Execution
When the AI Agent returns multiple tool calls for a single message (e.g., "Sembré soja en A1 y la semilla costó 100mil"), all tool calls execute sequentially via `CompoundExecutor`:
- `IntentClassifier` attaches `_compoundResults` metadata when `parseResults.length > 1`
- All 3 controllers (WhatsApp, Telegram, test-bot) check for `_compoundResults` before normal routing
- Handles `command`, `expense`, and `income` type ParseResults (expenses/incomes via `FinancialHandler`, commands via `DomainRouter`)
- In compound context, `confirm_before_save` is forced to `false` so expenses/incomes save directly
- If any step returns `startFlow` sideEffect, execution stops there (flow needs user input)
- Errors in one step don't block subsequent steps
- Combined messages from all steps are sent as a single response
- No extra AI tokens used — agent already returned all tool calls in one API call; compound executor just processes them all

#### JSON extraction — legacy fallback (when AGENT_ENABLED=false)
- **`intent-extractor.ts`** — Calls Claude Haiku with conversation history + dynamic prompt + assistant prefill, returns ParseResult
- **`prompt-builder.ts`** — Compact system prompt with 33+ intents, agro rules, disambiguation patterns
- **`intent-validator.ts`** — Validates LLM JSON output, maps to ParseResult; propagates field/plot from AI response into expense/income data

#### Shared services
- **`conversation-history.service.ts`** — Loads recent turns from `conversation_logs` (4000 char budget)
- **`user-context.service.ts`** — Loads user fields/plots/lastContext with 60s cache
- **`conversational-fallback.service.ts`** — Rate-limited (5/10min) lightweight fallback for unknown intents (only active when AGENT_ENABLED=false)

### Key Services

- **`services/expenses.js`** — Database layer for all CRUD: expenses, incomes, budgets, fields, rainfall, user settings, AI usage tracking, plot history queries. Includes `getOrCreateUserByTelegramId()` for Telegram user provisioning. `setFieldCity` and `setUserCity` accept optional `province` param.
- **`services/localidad-lookup.service.ts`** — Validates city names against 4027 Argentine census localities (`src/data/localidades_censales.json`). Returns exact match, disambiguation (multiple provinces), fuzzy suggestions (Levenshtein ≤ 3), or not_found. Singleton with lazy-loaded index.
- **`middleware/pending-field-city-handler.ts`** — Shared handler for pending city validation across all 3 controllers (WhatsApp, Telegram, test-bot). Exports `formatLocation(city, province)` helper. Strips full-sentence patterns (e.g., "el campo X está en Paraná" → "Paraná") before city lookup.
- **`middleware/pending-plot-area.ts`** — Queue-based pending store for plot hectares assignment. Supports single item (`set`) or batch (`setQueue`) for multi-plot creation. Includes `dequeueFirst()` for sequential per-plot prompting and 5-minute timeout.
- **`middleware/pending-plot-area-handler.ts`** — Shared handler for pending plot area assignment across all 3 controllers. `handlePendingPlotArea()` blocks on invalid input (re-prompts instead of falling through), dequeues on valid hectares, clears queue on cancel. `storePlotAreaSideEffects()` processes both `setPendingPlotArea` and `setPendingPlotAreaQueue` sideEffects.
- **`services/whatsapp.js`** — WhatsApp Cloud API client (send messages via Meta API).
- **`services/telegram.ts`** — Telegram Bot API client (sendMessage, sendButtons, sendList, sendDocument, downloadFile).
- **`services/weather.js`** — OpenWeather API integration for forecasts and rain alerts.
- **`services/alert.service.js`** — Multi-channel alert delivery (Telegram-first, WhatsApp fallback). Deduplication, retry with backoff, `alert_history` DB tracking. Extracts `telegramId` from `tg_` placeholder phone numbers.
- **`services/scheduler.js`** — node-cron jobs: weekly summaries, daily weather alerts (half-hour precision via HH:MM), proactive reminders (missing hectares, low stock alerts at 8AM), Argentina timezone. Weather alerts show campo name or "tu ubicación" per city, with within-message dedup for same-city overlap.
- **`services/observations.js`** — Observation CRUD with 4-layer dedup, normalization, financial guard.
- **`services/settings.service.js`** — Global settings definitions with descriptions, grouped by category (ai, bot, audio, limits, agronomy, system).
- **`services/activity-dictionary.service.ts`** — Cached CRUD for `activity_dictionary` table (5-min TTL). Provides activity type → synonym mapping for dynamic AI agent prompt generation. Admin-editable via dashboard Diccionario tab.

### Domain Layer (`src/domain/`)

- **`agronomy/`** — AgronomyHandler (activities, observations, weather, rainfall, agro reports, plot history queries); `normalizeActivityFilter()` maps AI filter strings to DB event_type values. `generate_agro_report` supports date range (`desde`/`hasta`) and defaults to current week; shows all observations and activities (no caps)
- **`financial/`** — FinancialHandler (expenses, incomes, budgets, unified `financial_report` dispatching, mandatory hectares on plot creation via blocking queue prompt, activity labels with emojis in reports, auto-split comma-separated plot names from `add_plot` → `add_plots_batch` with sequential per-plot hectares), FinancialService, FinancialRepository
- **`auth/`** — Auth system (JWT, bcrypt, refresh tokens) + ObservationService (dashboard CRUD for observations, activities, expenses, incomes with edit support)
- **`sharing/`** — FieldSharingService (invite-code flow: `createInvite` → 6-char code, `acceptInvite` → redeem, `removeMemberByIdentifier` by name/phone), SharingHandler
- **`stock/`** — Full inventory management: StockRepository (atomic movements with row locking), StockService (auto-resolve warehouse/field, fuzzy product search, grain stock), StockHandler (9 chat commands), StockPurchaseService (expense→stock entry suggestion + grain entry), StockDeductionService (activity→stock deduction), StockAlertService (low stock alerts daily at 8AM). Feature-gated to `pro_plus`/`enterprise` plans.
- **`plots/`** — PlotDiscoveryService (lookup-only, never auto-creates), PlotRepository
- **`compound-executor.ts`** — Sequential executor for compound actions (multiple tool calls from a single message). Handles command/expense/income types via DomainRouter + FinancialHandler, forces `confirm_before_save=false` for expenses/incomes, stops at startFlow sideEffects, skips errors gracefully. Used by all 3 controllers when agent returns >1 tool call. 11 tests.
- **`documents/`** — Document processing (invoices, receipts, tickets): DocumentRepository (DB CRUD), DocumentService (validate → hash dedup → compress with sharp → store to disk → Claude Vision extraction → classify), DocumentHandler (list_documents, link_document_to_expense), document.helpers (formatExtractionSummary, buildSuggestedExpenses, buildPostExtractionButtons, isInsumoCategory). Feature-gated with daily limits per plan (free=1, pro=10, pro_plus=25, enterprise=100). Files stored on disk at `$DOCUMENT_STORAGE_PATH/{userId}/{date}/{docId}.{ext}`. **UX flow**: Menu entries ("Cargar Factura"/"Cargar Remito") + text triggers ("cargar factura") set intent → user sends image → smart post-extraction buttons based on content (insumo→Gasto+Stock, non-insumo→Registrar gasto, remito→Cargar stock). Unprompted images prompt for intent first. `PendingDocumentUploadStore` (`src/middleware/pending-document-upload.ts`) tracks two states: intent-waiting-for-image and image-waiting-for-intent (5-min TTL). **Plot resolution**: expenses from documents resolve field/plot before saving (auto-assign if 1 plot or recent context, ask user if multiple). **Stock queue**: multiple insumo items chain sequentially via `pendingStockEntryQueue`. 41 tests.
- **`billing/`** — Plan-based AI daily limits + FeatureGate (maps commands → feature keys, checks plan access)

### Date Utilities (`src/utils/date.ts`)

Centralized Argentina timezone helpers: `getNowArgentina()`, `getTodayISO()` (YYYY-MM-DD), `formatDateAR()` (dd/mm/yyyy), `formatDateShortAR()` (dd/mm). All use `America/Argentina/Buenos_Aires` timezone explicitly.

### Parser (`src/utils/parser.js`)

Handles Spanish text normalization, written numbers ("quinientos mil" → 500000), Argentine slang ("lucas" = thousands, "palos" = millions), fuzzy category matching, and currency detection (ARS vs USD). Includes a question guard (`isLikelyQuestion` in `src/utils/guards.ts`) that prevents Spanish questions from being misclassified. `add_plots_batch` regex extracts optional `fieldName` from "en [campo]" suffix. ~950 lines with 50+ test cases in `parser.test.js`.

### Database

PostgreSQL with migrations in `src/migrations/001-048_*.sql`. Database timezone set to `America/Argentina/Buenos_Aires` (migration 048). Schema initialized by `init.sql` (mounted in Docker). Key tables: `users` (includes `telegram_id`, `province`, `last_name` columns), `fields` (includes `province`), `plots`, `expenses` (includes `expense_date`, `edited_by`, `expense_type`, `product`, `quantity`, `unit`), `incomes` (includes `income_date`, `edited_by`), `budgets`, `rainfall`, `domain_events` (activities, includes `event_date`, `edited_by`, `stock_deduction_status`), `agro_observations` (includes `observation_date`), `warehouses` (per-field storage), `stock_items` (inventory with `current_quantity`, `min_stock`, `grade`, `humidity_pct`), `stock_movements` (entrada/salida/ajuste with links to `expense_id`/`domain_event_id`), `user_settings`, `global_settings`, `ai_usage`, `conversation_logs` (includes `tool_calls` JSONB, `agent_mode`, and `channel` columns), `conversation_events`, `conversation_state`, `unparsed_messages`, `refresh_tokens`, `observation_history`, `field_members` (sharing), `field_invites` (invite codes), `alert_history` (alert delivery tracking), `activity_dictionary` (admin-editable activity synonyms for AI agent prompt).

### Frontend (`frontend/`)

React + Vite + TailwindCSS SPA. In production, Express serves the build from `frontend/dist/`.

- **Stack**: React 19, React Router v6, Tailwind v3, Vite 6, TypeScript
- **Auth flow**: JWT stored in localStorage, auto-refresh on 401, role-based route guards
- **Key files**: `src/api/client.ts` (fetch wrapper), `src/context/AuthContext.tsx` (auth state), `src/components/ProtectedRoute.tsx` (route guard)
- **Pages**: `/login`, `/register` (split name/apellido, dynamic plan fetching from API), `/dashboard` (end-user with 5 tabs: Observaciones, Actividades, Gastos, Ingresos, Stock)
- **Dashboard features**: Paginated tables with filters (date, campo, lote, category/type), inline "Editar" button on each row, edit modals for all entity types, "Registrado por" column showing creator name (and editor name if edited) on all tables. Stock tab shows inventory with movement history and edit modal.
- **Edit modals**: `ObservationEditModal` (with history tracking), `ExpenseEditModal`, `IncomeEditModal`, `ActivityEditModal` (lightweight, no history)
- **Edit audit**: `edited_by` column on `expenses`, `incomes`, `domain_events` tracks who last edited each record. Dashboard queries JOIN `users` to show `user_name` (creator) and `edited_by_name` (last editor) on all 4 tables
- **Date handling**: Uses `toLocalDate()` helper for date inputs to avoid UTC timezone shift (Argentina is UTC-3)

### Auth System (`src/domain/auth/`)

JWT-based authentication with bcrypt passwords and refresh token rotation.

- **`auth.service.ts`** — register (with duplicate-email race condition handling), login, refresh, logout, profile update
- **`auth.repository.ts`** — User DB queries (findByEmail, createUser, updateProfile)
- **`token.repository.ts`** — Refresh token CRUD (save, find, revoke, cleanup)
- **`observation.service.ts`** — Dashboard CRUD: observations (with edit history), expenses, incomes, activities (edit support via `editExpense`, `editIncome`, `editActivity`); `getUserFieldsWithPlots()` for filter dropdowns
- **`auth.middleware.ts`** (`src/middleware/`) — `requireAuth` + `requireRole` Express middleware

### Routes

- `GET/POST /webhook` — WhatsApp webhook (verification + message handler)
- `POST /telegram` — Telegram webhook handler (secret verified via `src/middleware/telegram-auth.ts`)
- `/api/auth/*` — Auth endpoints (register, login, refresh, logout, profile, plans, observations, expenses, incomes, activities — including PATCH edit endpoints, GET filters)
- `/admin/api/*` — Admin dashboard API endpoints (stats, users, settings, AI usage, parse metrics, enriched field detail with financials, field activities) — requires admin JWT
- `/admin` — Admin dashboard static files (legacy HTML/JS from `src/public/`)

### Flow Engine (`src/middleware/`)

Interruptible conversation flows for multi-step data entry (expense, income, rainfall, field, activity).

- **`conversation-engine.ts`** — FSM: startFlow, processFlowMessage, clearFlow, goBack, skipStep
- **`conversation-state.repository.ts`** — DB-persisted flow state
- **`flows/`** — field_flow (city step validates via localidadLookup, saves province), expense_flow, income_flow, rainfall_flow, activity_flow (activity_flow uses dynamic `interactiveAsync` for plot selection)
- Safe interruption commands execute mid-flow without canceling; financial intents cancel the active flow

## Key Conventions

- ESM modules (`"type": "module"` in package.json) — use `import`/`export`, not `require`
- All user-facing text is in Spanish (Argentine dialect)
- Currency: ARS (default) and USD; amounts use Argentine conventions (50mil = 50,000)
- Timezone: America/Argentina/Buenos_Aires (UTC-3). All `new Date()` for "today" must use `toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })`. All user-facing dates use `toLocaleDateString('es-AR', { timeZone: ... })` for dd/mm/yyyy format. PostgreSQL timezone set via migration 048. Centralized helpers in `src/utils/date.ts`
- Expenses/incomes use soft delete (`deleted_at` column), fields/plots use soft delete (`deleted_at`, `deleted_by`)
- Lotes (plots) = primary productive unit for expenses/incomes; Campos (fields) = grouping container
- Optional confirmation workflow before saving transactions (per-user setting)
- AI calls are plan-based rate-limited per user (free=20, pro=100, pro_plus=300, enterprise=1000 daily)
- PlotDiscoveryService is lookup-only — never auto-creates fields/plots; returns `notFound` info for unresolved entities
- Observation safety guard in `agronomy.handler.ts`: `isLikelyQuestionOrFollowUp()` prevents non-agro text from being saved as observations

## Deployment

The project is deployed on **Railway** at `campo-bot-production.up.railway.app`. Deploy with `railway up` from the local directory.

The Dockerfile builds the frontend as part of the image: it installs frontend dependencies and runs `npm run build` so `frontend/dist/` is present at runtime. No separate build step is needed when deploying.

Required environment variables on Railway: `DATABASE_URL`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (for Whisper audio transcription), `TELEGRAM_BOT_TOKEN`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `VERIFY_TOKEN`, `OPENWEATHER_API_KEY`.

## Telegram Integration

Telegram support was added as a second messaging channel alongside WhatsApp. All message processing (AI pipeline, flows, domain handlers) is shared.

- **`src/services/telegram.ts`** — Telegram Bot API client: `sendMessage`, `sendButtons`, `sendList`, `sendDocument`, `downloadFile`
- **`src/controllers/telegram.controller.ts`** — Webhook handler at `POST /telegram`; follows the same pattern as `test-bot.controller.ts`
- **`src/middleware/telegram-auth.ts`** — Webhook secret verification middleware
- **`src/scripts/setup-telegram-webhook.ts`** — Registers the Telegram webhook URL with the Bot API
- **`src/scripts/delete-telegram-webhook.ts`** — Removes the registered Telegram webhook
- **Migration 035** — Adds `telegram_id` column to `users`; adds `channel` column to `conversation_logs`
- User store key: `tg_${chatId}`; users are provisioned on first contact via `getOrCreateUserByTelegramId()` in `expenses.js`
- Env vars: `TELEGRAM_BOT_TOKEN` (required), `TELEGRAM_WEBHOOK_SECRET` (optional, for webhook verification)

## Field Sharing (Campos Compartidos)

Invite-code based field sharing that works across WhatsApp and Telegram.

- **Flow**: Owner says "compartir campo X" → bot generates 6-char code (7-day expiry) → owner shares code externally → invitee says "unirme ABC123" → gets access
- **`src/domain/sharing/field-sharing.service.ts`** — Core: `createInvite()` (owner check, generates code), `acceptInvite()` (validates code/expiry/usage, adds membership in transaction), `removeMemberByIdentifier()` (by name or phone), `getAccessibleFieldIds()`, `listMembers()`, `isOwner()`
- **`src/domain/sharing/sharing.handler.ts`** — Handles `share_field`, `accept_invite`, `list_field_members`, `remove_field_member`
- **Migration 037** — `field_members` table (field_id, user_id, role, invited_by); backfills existing fields as 'owner'
- **Migration 038** — `field_invites` table (code VARCHAR(6) UNIQUE, created_by, used_by, used_at, expires_at)
- All field/plot queries use `field_members` for access control (`accessibleFieldsSql()` helper in `expenses.js`)
- Enterprise plan required to generate invite codes (gated via `sharing` feature in FeatureGate); `accept_invite` is ungated (anyone can redeem)
- 4 AI tools: `share_field` (generates code), `accept_invite` (code), `list_field_members`, `remove_field_member` (member name or phone)

## Stock System (Inventario)

Full inventory management for agricultural inputs (insumos) and grain (granos). Feature-gated to `pro_plus` and `enterprise` plans.

- **Data model**: `warehouses` (per-field) → `stock_items` (product, quantity, unit, min_stock, grade, humidity) → `stock_movements` (entrada/salida/ajuste with links to expenses and activities)
- **Expense types**: `expenses.expense_type` differentiates `'varios'` (services/labranzas) from `'insumo'` (storable products like agroquimicos, fertilizantes, semillas, combustible). Agent auto-detects type from product name/category.
- **Migrations**: 044 (expense types), 045 (warehouses/stock_items/stock_movements + feature), 046 (stock_deduction_status on domain_events), 047 (grain: grade/humidity_pct on stock_items)
- **`src/domain/stock/`** — Repository (atomic movements with `FOR UPDATE` row lock), Service (auto-resolve warehouse, fuzzy search, unit validation, grain stock), Handler (9 commands), PurchaseService (expense→stock suggestion + grain entry), DeductionService (activity→stock deduction), AlertService (low stock alerts)
- **AI tools** (8): `create_warehouse`, `list_warehouses`, `add_stock`, `remove_stock`, `adjust_stock`, `check_stock`, `stock_history`, `set_min_stock`
- **Interactive flows** (all via buttons on both WhatsApp + Telegram):
  - Expense (insumo) → "cargar al stock?" (`stock_entry_yes/no`)
  - Activity (spraying/fertilization) → "descontar del stock?" (`stock_deduct_yes/no`)
  - Harvest → "cargar grano al silo?" (`stock_grain_yes/no`)
  - Grain sale → "descontar del stock?" (`stock_grain_sale_yes/no`)
- **Alerts**: Daily 8AM low stock check via `lowStockAlertTick()` in scheduler, multi-channel delivery with 24h dedup
- **Dashboard**: Stock tab with `StockTable`, `StockMovementHistory` modal, `StockEditModal`. Expense table shows type badge + product column + type filter.
- **API endpoints**: `GET /api/auth/stock`, `GET /api/auth/stock/:id/movements`, `GET /api/auth/stock/filters`, `PATCH /api/auth/stock/:id`

## Multi-Channel Alerts

Weather and proactive alerts are delivered to both WhatsApp and Telegram users.

- **`src/services/alert.service.js`** — `sendAlertWithRetryMultiChannel()`: Telegram-first (3 retries, 1-3s backoff), WhatsApp fallback. Extracts `telegramId` from `tg_` placeholder phone numbers. Tracks delivery in `alert_history` table with deduplication.
- **Migration 039** — Converts `daily_weather_hour` from integer to VARCHAR(5) HH:MM format for half-hour precision
- Weather alerts show campo name per city (e.g., "Santa Fe (La Esperanza)") or "tu ubicación" for user's personal city
- Within-message dedup prevents duplicate city alerts when user city matches a field's city
- Admin dashboard: weather alert hour is an HH:MM time input (not just hour selector)
- 14 tests in `alert.service.test.ts`

## Environment Variables

Required in `.env`: `DATABASE_URL`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `ANTHROPIC_API_KEY`, `VERIFY_TOKEN`, `OPENWEATHER_API_KEY`, `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`. See `docker-compose.yml` for defaults. `TELEGRAM_WEBHOOK_SECRET` is optional.

### AI Agent Settings (configurable via admin dashboard)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `AGENT_ENABLED` | bool | `false` | Kill switch: `true` = tool_use agent, `false` = JSON extraction |
| `AGENT_MODEL` | string | `claude-haiku-4-5-20251001` | Model for agent |
| `AGENT_MAX_TOKENS` | number | `400` | Max output tokens |
| `AGENT_TIMEOUT_MS` | number | `8000` | Timeout in ms |
| `AGENT_TEMPERATURE` | number | `0` | Temperature (0 = deterministic) |
