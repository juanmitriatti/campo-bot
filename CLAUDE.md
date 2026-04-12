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
- `npx tsx src/scripts/run-migrations.ts` — Manually run pending DB migrations (also runs automatically on app startup)

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
- **`tool-definitions.ts`** — 51 Anthropic tool definitions grouped by domain: Financial (2), Activities (8), Observations (2), Reports (5), Field/Plot Mgmt (11), Sharing (4), Stock (8), Documents (3), Livestock (8), System (1). Each tool has typed `input_schema` with enum validation for categories. All registration tools include an optional `event_date` param (YYYY-MM-DD) for user-mentioned dates. Query/report tool descriptions include expected output data (hectares, weight, grade, etc.) and example trigger phrases for better tool selection.
- **`agent-prompt-builder.ts`** — Compact system prompt (~400 tokens) with disambiguation rules, user context, and dynamic today's date for date extraction. Tool definitions carry the schema, so the prompt only needs rules. Includes explicit rules that agro activities (fumigué, sembré, coseché, etc.) are ONLY activities and NEVER expenses unless the user mentions an explicit amount. Activity synonym lines are dynamically generated from `activity_dictionary` DB table (admin-editable via dashboard). Hectáreas disambiguation: "has"/"hectáreas"/"superficie" + campo → `list_plots` (not to be confused with "hacienda"). **Livestock disambiguation**: "N vacas con N terneros" → always 2x `add_livestock` (never `record_livestock_birth`); `record_livestock_birth` only with explicit birth verbs (nacieron/parieron/nació).
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
- **Livestock consolidation**: when all compound steps are livestock commands targeting the same plot (e.g., `add_livestock vaca` + `add_livestock ternero`), messages are merged into a single user-friendly response showing all categories (prevents confusion where user only sees the first step)
- Combined messages from all steps are sent as a single response
- Compound logger captures all messages (`messages.join('\n\n')`) instead of just `messages[0]` — ensures admin logs show the full compound response
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
- **`services/localidad-lookup.service.ts`** — Validates city names against 4027 Argentine census localities (`src/data/localidades_censales.json`). Returns exact match, disambiguation (multiple provinces), fuzzy suggestions (Levenshtein ≤ 3), or not_found. Singleton with lazy-loaded index. Normalizer strips accents AND soft hyphens (U+00AD) — 53 Buenos Aires entries in the census data contain invisible soft hyphens that broke matching (e.g., "Junín" BA was invisible to lookup).
- **`middleware/pending-field-city-handler.ts`** — Shared handler for pending city validation across all 3 controllers (WhatsApp, Telegram, test-bot). Exports `formatLocation(city, province)` helper. Strips full-sentence patterns (e.g., "el campo X está en Paraná" → "Paraná") before city lookup.
- **`middleware/pending-field-location.ts`** — Pending store + handler for field location selection during `create_field` flow. Stores `fieldId` + `fieldName`, presents 3 location options as buttons: "Escribir localidad" (existing city validation), "Dibujar en mapa" (generates token-authenticated Leaflet map URL), "Compartir ubicación" (WhatsApp/Telegram native location sharing). Handles responses from all 3 paths. Reverse geocoding via Nominatim (non-blocking) for map/location options.
- **`middleware/pending-plot-area.ts`** — Queue-based pending store for plot hectares assignment. Supports single item (`set`) or batch (`setQueue`) for multi-plot creation. Includes `dequeueFirst()` for sequential per-plot prompting and 5-minute timeout.
- **`middleware/pending-plot-area-handler.ts`** — Shared handler for pending plot area assignment across all 3 controllers. `handlePendingPlotArea()` blocks on invalid input (re-prompts instead of falling through), dequeues on valid hectares, clears queue on cancel. `storePlotAreaSideEffects()` processes both `setPendingPlotArea` and `setPendingPlotAreaQueue` sideEffects.
- **`services/whatsapp.js`** — WhatsApp Cloud API client (send messages via Meta API).
- **`services/telegram.ts`** — Telegram Bot API client (sendMessage, sendButtons, sendList, sendDocument, downloadFile).
- **`services/weather.js`** — OpenWeather API integration for forecasts and rain alerts.
- **`services/alert.service.js`** — Multi-channel alert delivery (Telegram-first, WhatsApp fallback). Deduplication, retry with backoff, `alert_history` DB tracking. Extracts `telegramId` from `tg_` placeholder phone numbers.
- **`services/scheduler.js`** — node-cron jobs: weekly summaries, daily weather alerts (half-hour precision via HH:MM), proactive reminders (missing hectares, low stock alerts at 8AM), flow reminder tick (every minute: sends timeout + half-life notifications to stale conversation flows), Argentina timezone. Weather alerts show campo name or "tu ubicación" per city, with within-message dedup for same-city overlap.
- **`services/observations.js`** — Observation CRUD with 4-layer dedup, normalization, financial guard.
- **`services/settings.service.js`** — Global settings definitions with descriptions, grouped by category (ai, bot, audio, limits, agronomy, system).
- **`services/activity-dictionary.service.ts`** — Cached CRUD for `activity_dictionary` table (5-min TTL). Provides activity type → synonym mapping for dynamic AI agent prompt generation. Admin-editable via dashboard Diccionario tab.
- **`services/map-token.service.ts`** — Creates and validates single-use tokens for the map polygon drawing page. Tokens expire after 30 minutes and are consumed on polygon submission.

### Domain Layer (`src/domain/`)

- **`agronomy/`** — AgronomyHandler (activities, observations, weather, rainfall, agro reports, plot history queries, tacto/pregnancy checks, edit_last_activity); `normalizeActivityFilter()` maps AI filter strings to DB event_type values. `generate_agro_report` supports date range (`desde`/`hasta`) and defaults to current week; shows all observations and activities (no caps). **Tacto**: `log_tacto` registers pregnancy checks with `pregnant_count`/`open_count`/`uncertain_count` on `domain_events`; auto-computes total from parts and open from total-pregnant-uncertain; shows pregnancy rate %. **Edit activity**: `edit_last_activity` finds user's last matching activity (optional eventType/crop filter) and updates its plot, crop, or date
- **`financial/`** — FinancialHandler (expenses, incomes, budgets, unified `financial_report` dispatching, mandatory hectares on plot creation via blocking queue prompt, activity labels with emojis in reports, auto-split comma-separated plot names from `add_plot` → `add_plots_batch` with sequential per-plot hectares). `add_field` handler starts `field_flow` (3 location options) instead of creating field immediately with `setPendingFieldCity`. Only fast-paths when city is provided AND matches exactly. FinancialService, FinancialRepository
- **`auth/`** — Auth system (JWT, bcrypt, refresh tokens) + ObservationService (dashboard CRUD for observations, activities, expenses, incomes with edit support)
- **`sharing/`** — FieldSharingService (invite-code flow: `createInvite` → 6-char code, `acceptInvite` → redeem, `removeMemberByIdentifier` by name/phone), SharingHandler
- **`stock/`** — Full inventory management: StockRepository (atomic movements with row locking), StockService (auto-resolve warehouse/field, fuzzy product search, grain stock), StockHandler (9 chat commands), StockPurchaseService (expense→stock entry suggestion + grain entry), StockDeductionService (activity→stock deduction), StockAlertService (low stock alerts daily at 8AM). Feature-gated to `pro_plus`/`enterprise` plans.
- **`plots/`** — PlotDiscoveryService (lookup-only, never auto-creates), PlotRepository
- **`compound-executor.ts`** — Sequential executor for compound actions (multiple tool calls from a single message). Handles command/expense/income types via DomainRouter + FinancialHandler, forces `confirm_before_save=false` for expenses/incomes, stops at startFlow sideEffects, skips errors gracefully. Used by all 3 controllers when agent returns >1 tool call. 11 tests.
- **`documents/`** — Document processing (invoices, receipts, tickets): DocumentRepository (DB CRUD), DocumentService (validate → hash dedup → compress with sharp → store to disk → Claude Vision extraction → classify), DocumentHandler (list_documents, link_document_to_expense), document.helpers (formatExtractionSummary, buildSuggestedExpenses, buildPostExtractionButtons, isInsumoCategory). Feature-gated with daily limits per plan (free=1, pro=10, pro_plus=25, enterprise=100). Files stored on disk at `$DOCUMENT_STORAGE_PATH/{userId}/{date}/{docId}.{ext}`. **UX flow**: Facturas and remitos have separate flows — **Facturas** = expenses ONLY (never update stock), with product discovery (offer to create missing products at qty=0); **Remitos** = stock ONLY (never create expenses), with warehouse selection (ask which galpón if multiple). Menu entries ("Cargar Factura"/"Cargar Remito") + text triggers set intent → user sends image → post-extraction buttons: factura→"Registrar gasto"/"Solo guardar", remito→"Cargar stock"/"Solo guardar". Unprompted images prompt for intent first. `PendingDocumentUploadStore` (`src/middleware/pending-document-upload.ts`) tracks two states: intent-waiting-for-image and image-waiting-for-intent (5-min TTL). **Plot resolution**: expenses from documents resolve field/plot before saving (auto-assign if 1 plot or recent context, ask user if multiple). **Product discovery**: after factura expense save, `StockService.findMissingProducts()` checks which line item products don't exist in stock → offers to create them (qty=0, no movement) via `createProductOnly()`. **Warehouse selection**: remito "Cargar stock" → 0/1 warehouses auto-resolve, multiple → buttons per warehouse. `addStockToWarehouse()` loads items into specific warehouse. 43 tests.
- **`livestock/`** — Full cattle/hacienda management: LivestockRepository (atomic movements via `applySingleMovement` + `applyTransferMovement`, both using `FOR UPDATE` row locks; transfers lock both groups in consistent UUID order to prevent deadlocks), LivestockService (category normalization with plural/accent aliases, plot resolution via `PlotDiscoveryService` — never auto-creates, find-or-create groups, auto-classifies same-plot+different-category as `recategorizacion`), LivestockHandler (8 chat commands). Event-sourced model: `livestock_groups` (state projection) + `livestock_movements` (immutable audit log with 7 types: entrada/salida/transferencia/muerte/nacimiento/recategorizacion/ajuste). DB-level `CHECK` constraint on `livestock_movements` enforces valid endpoint configurations per movement type. Feature-gated to `pro_plus`/`enterprise` plans. 19 service tests.
- **`billing/`** — Plan-based AI daily limits + FeatureGate (maps commands → feature keys, checks plan access)

### Date Utilities (`src/utils/date.ts`)

Centralized Argentina timezone helpers: `getNowArgentina()`, `getTodayISO()` (YYYY-MM-DD), `formatDateAR()` (dd/mm/yyyy), `formatDateShortAR()` (dd/mm). All use `America/Argentina/Buenos_Aires` timezone explicitly.

### Parser (`src/utils/parser.js`)

Handles Spanish text normalization, written numbers ("quinientos mil" → 500000), Argentine slang ("lucas" = thousands, "palos" = millions), fuzzy category matching, and currency detection (ARS vs USD). Includes a question guard (`isLikelyQuestion` in `src/utils/guards.ts`) that prevents Spanish questions from being misclassified. `add_plots_batch` regex extracts optional `fieldName` from "en [campo]" suffix. ~950 lines with 50+ test cases in `parser.test.js`.

### Database

PostgreSQL with migrations in `src/migrations/001-054_*.sql`. Database timezone set to `America/Argentina/Buenos_Aires` (migration 048). Schema initialized by `init.sql` (mounted in Docker). **Migrations run automatically on app startup** via `src/scripts/run-migrations.ts` (called from `bootstrap()` in `src/app.ts` before `app.listen()`). The runner tracks applied migrations in a `schema_migrations` table, applies pending files in alphabetical order (each in its own transaction), and aborts startup on failure. All migrations are idempotent (`IF NOT EXISTS` / conditional `DO` blocks). Set `RUN_MIGRATIONS_ON_START=false` to disable (e.g. for unit tests). The runner can also be invoked standalone via `npx tsx src/scripts/run-migrations.ts`. Key tables: `users` (includes `telegram_id`, `province`, `last_name` columns), `fields` (includes `province`, `lat`, `lng`, `polygon`, `location_method`), `plots`, `expenses` (includes `expense_date`, `edited_by`, `expense_type`, `product`, `quantity`, `unit`), `incomes` (includes `income_date`, `edited_by`), `budgets`, `rainfall`, `domain_events` (activities, includes `event_date`, `edited_by`, `stock_deduction_status`, `pregnant_count`, `open_count`, `uncertain_count`), `agro_observations` (includes `observation_date`), `warehouses` (per-field storage), `stock_items` (inventory with `current_quantity`, `min_stock`, `grade`, `humidity_pct`), `stock_movements` (entrada/salida/ajuste with links to `expense_id`/`domain_event_id`), `user_settings`, `global_settings`, `ai_usage`, `conversation_logs` (includes `tool_calls` JSONB, `agent_mode`, and `channel` columns), `conversation_events`, `conversation_state`, `unparsed_messages`, `refresh_tokens`, `observation_history`, `field_members` (sharing), `field_invites` (invite codes), `alert_history` (alert delivery tracking), `activity_dictionary` (admin-editable activity synonyms for AI agent prompt), `map_tokens` (single-use tokens for map polygon drawing), `livestock_groups` (UUID pk, per-plot state projection: user_id/field_id/plot_id/category/breed/count, soft delete, `UNIQUE(plot_id, category, breed)`), `livestock_movements` (UUID pk, immutable audit: movement_type enum/source_group_id/dest_group_id/count with DB-level `chk_movement_endpoints` CHECK constraint).

### Frontend (`frontend/`)

React + Vite + TailwindCSS SPA. In production, Express serves the build from `frontend/dist/`.

- **Stack**: React 19, React Router v6, Tailwind v3, Vite 6, TypeScript
- **Auth flow**: JWT stored in localStorage, auto-refresh on 401, role-based route guards
- **Key files**: `src/api/client.ts` (fetch wrapper), `src/context/AuthContext.tsx` (auth state), `src/components/ProtectedRoute.tsx` (route guard)
- **Pages**: `/login`, `/register` (split name/apellido, dynamic plan fetching from API), `/dashboard` (end-user with 6 tabs: Observaciones, Actividades, Gastos, Ingresos, Stock, Hacienda)
- **Dashboard features**: Paginated tables with filters (date, campo, lote, category/type), inline "Editar" button on each row, edit modals for all entity types, "Registrado por" column showing creator name (and editor name if edited) on all tables. Stock tab shows inventory with movement history and edit modal. Hacienda tab has two sub-tabs: **Grupos** (per-plot livestock inventory with field/plot/category filters, totals banner, movements/edit actions) and **Historial** (global movements timeline with field/plot/category/type/date-range filters).
- **Edit modals**: `ObservationEditModal` (with history tracking), `ExpenseEditModal`, `IncomeEditModal`, `ActivityEditModal` (campo/lote cascading selectors + all activity fields, no history)
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
- `GET /api/map/:token` — Public map page for polygon drawing (token-authenticated, no JWT). Serves `src/public/map/index.html` (Leaflet + Leaflet.Draw, mobile-first). Auto-starts polygon drawing mode on load; default Leaflet.Draw toolbar hidden
- `POST /api/map/:token` — Receives polygon GeoJSON from map page, saves to field, consumes token
- `/admin/api/*` — Admin dashboard API endpoints (stats, users, settings, AI usage, parse metrics, enriched field detail with financials, field activities) — requires admin JWT
- `/admin` — Admin dashboard static files (legacy HTML/JS from `src/public/`)

### Flow Engine (`src/middleware/`)

Interruptible conversation flows for multi-step data entry (expense, income, rainfall, field, activity).

- **`conversation-engine.ts`** — FSM: startFlow, processFlowMessage, clearFlow, goBack, skipStep. Bug fix: `skipIf` check now runs in `executeConfirm` to properly skip steps with pre-filled data. Exports `buildTimeoutMessage(flowState)`, `buildHalflifeMessage(flowState)`, `getFlowLabel(flowState)` helpers used by both controllers and scheduler
- **`conversation-state.repository.ts`** — DB-persisted flow state. Includes `findActiveFlowsForReminder()` (JOINs users for alert routing) and `markHalflifeNotified(userId)` for the flow reminder scheduler
- **`flows/`** — field_flow (3 location options: city/map/share via `locationMethod` step + `setPendingFieldLocation` sideEffect), expense_flow, income_flow, rainfall_flow, activity_flow (activity_flow uses dynamic `interactiveAsync` for plot selection)
- **Flow callback routing** — `flow_field_loc_*` callbacks (location method buttons) are handled BEFORE the generic `flow_field_*` prefix handler in all 3 controllers, otherwise the prefix strip turns `flow_field_loc_map` into `"loc map"` which fails validation
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

Database migrations run automatically on every deploy: when the container starts, `bootstrap()` in `src/app.ts` calls `runMigrations()` (from `src/scripts/run-migrations.ts`) before the HTTP server begins accepting traffic. The runner connects to `DATABASE_URL`, ensures `schema_migrations` exists, applies any new SQL files from `src/migrations/` in alphabetical order (each in its own transaction), and aborts startup if any migration fails. All migrations are idempotent so re-running them on existing databases is safe. Set `RUN_MIGRATIONS_ON_START=false` only for unit tests.

Required environment variables on Railway: `DATABASE_URL`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (for Whisper audio transcription), `TELEGRAM_BOT_TOKEN`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `VERIFY_TOKEN`, `OPENWEATHER_API_KEY`. `APP_URL` is auto-derived from `RAILWAY_PUBLIC_DOMAIN` on Railway; set explicitly for other deployments (used for map polygon drawing URLs).

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

## Flow Reminders & Timeout Notifications

Conversation flows (expense_flow, income_flow, field_flow, etc.) are interruptible but had silent expiry — users got no feedback when a flow timed out. Two safety nets fix that:

- **Who decides timeout?** DB setting `FLOW_TIMEOUT_MS` (default 600000 = 10 min) in `system_settings`, editable from admin dashboard → `bot` group. Falls back to `process.env.FLOW_TIMEOUT_MS`, then to `DEFAULT_FLOW_TIMEOUT_MS` in `conversation-engine.ts`. Cached 5 min, refreshed on each `startFlow()` call.
- **Inline timeout notification (lazy path)** — On incoming message, controllers (whatsapp, telegram, test-bot) detect `isExpired(flowCtx)` → send "⏰ Cerré el gasto anterior por inactividad…" and bail early so the user's next message starts fresh. Gated by `FLOW_TIMEOUT_NOTIFICATION_ENABLED`.
- **Scheduler tick (proactive path)** — `flowReminderTick()` runs every minute (cron `* * * * *`). For each active non-idle flow:
  1. If `flow_expires_at < now` → send timeout message via `sendAlertWithRetryMultiChannel` (Telegram-first) + `clearFlow()`. Handles users who never come back
  2. If `started_at + FLOW_HALFLIFE_WARNING_MS < now` and not yet notified → send "👋 ¿Seguís ahí? Tu gasto quedó a medias…" and mark notified via `markHalflifeNotified()`
- **Migration 052** — `flow_halflife_notified_at TIMESTAMP` on `conversation_state` + partial index on `flow_expires_at WHERE flow_state != 'idle'` for efficient tick queries
- **`ConversationStateRepository`** — `findActiveFlowsForReminder()` JOINs with users for contact info (phone + telegram_id); `markHalflifeNotified(userId)`; `clearFlow()` also resets the halflife flag so reused flows re-arm the warning
- **Message builders** in `conversation-engine.ts`: `buildTimeoutMessage(flowState)`, `buildHalflifeMessage(flowState)`, `getFlowLabel(flowState)` (e.g., `expense_flow` → 'gasto')
- **Dedupkeys** `flow_timeout_${userId}_${startedAtMs}` and `flow_halflife_${userId}_${startedAtMs}` prevent duplicates on retries

### Flow Reminder Settings (configurable via admin dashboard)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `FLOW_TIMEOUT_MS` | number | `600000` | Flow timeout in ms. Examples: 300000=5min, 600000=10min, 900000=15min |
| `FLOW_TIMEOUT_NOTIFICATION_ENABLED` | bool | `true` | Send "flow expired" message when user interacts after timeout |
| `FLOW_HALFLIFE_WARNING_ENABLED` | bool | `true` | Send proactive "¿seguís ahí?" ping at half the timeout |
| `FLOW_HALFLIFE_WARNING_MS` | number | `300000` | Time after flow start before half-life reminder fires (ms) |

## Livestock System (Hacienda)

Event-sourced cattle inventory tracking for grupos de hacienda (groups of cattle per lote). Feature-gated to `pro_plus` and `enterprise` plans. Migration `053_livestock.sql`.

- **Data model**: `livestock_groups` (per-plot state projection) + `livestock_movements` (immutable audit log). Each group is keyed by `(plot_id, category, breed)` with unique constraint — one row per category/breed combo per lote.
- **Categories** (9 enum values): `vaca`, `vaquillona`, `ternero`, `ternera`, `novillo`, `novillito`, `toro`, `torito`, `buey`. Service normalizes plurals and accents ("vacas" → "vaca", "vaquillas" → "vaquillona").
- **Movement types** (7 enum values): `entrada` (new/purchase), `salida` (sale/exit), `transferencia` (plot-to-plot move), `muerte` (death), `nacimiento` (birth), `recategorizacion` (same plot, different category — e.g. "pasé 10 terneros a novillos"), `ajuste` (absolute count correction).
- **DB constraint**: `chk_movement_endpoints` CHECK enforces valid `source_group_id`/`dest_group_id` config per movement type (entrada: null→dest; salida/muerte: source→null; transferencia/recategorizacion: source→dest; ajuste: null→dest or source→null; nacimiento: null→dest).
- **Atomicity**: `LivestockRepository.applySingleMovement()` uses `BEGIN/SELECT ... FOR UPDATE/UPDATE/INSERT movement/COMMIT`. Rejects negative counts at app level. `applyTransferMovement()` locks BOTH source and dest groups in consistent UUID order (`id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`) to prevent deadlocks under concurrent transfers.
- **Plot resolution**: `LivestockService.resolvePlot()` wraps `PlotDiscoveryService.resolve()` — NEVER auto-creates plots. Throws user-friendly Spanish errors for notFound/needPlotSelection/needPlotCreation.
- **Recategorization auto-detection**: If source_plot === dest_plot and category !== destCategory, `transferAnimals()` classifies as `recategorizacion` instead of `transferencia`.
- **8 AI tools**: `add_livestock`, `remove_livestock`, `transfer_livestock`, `record_livestock_death`, `record_livestock_birth`, `adjust_livestock`, `list_livestock`, `livestock_history`. Mapped in `feature-gate.ts` to `livestock` feature key.
- **Handler**: `LivestockHandler.handleCommand()` dispatches via switch; all responses use 🐄/➕/➖/💀/🐣/↗️/🔄 emojis and Argentine Spanish. `listLivestock` groups inventory by plot for readability.
- **Examples** (tool-use prompts): "agregué 20 vacas al lote norte" → `add_livestock`; "vendí 5 novillos del lote A1" → `remove_livestock`; "mové 10 vacas del lote A al lote B" → `transfer_livestock`; "pasé 15 terneros a novillos en el lote sur" → `transfer_livestock` (recategorizacion); "se murieron 2 terneros" → `record_livestock_death`; "nacieron 8 terneros" → `record_livestock_birth`; "en el lote A1 hay 50 vacas" → `adjust_livestock`; "cuántos animales tengo" → `list_livestock`; "historial vacas lote A1" → `livestock_history`.
- **19 service tests** in `src/domain/livestock/__tests__/livestock.service.test.ts` covering category normalization, CRUD, insufficient stock, recategorization detection, plot-not-found errors.
- **REST API** (`src/routes/auth.routes.ts`):
  - `GET /api/auth/livestock` — paginated list of groups with filters (`fieldId`, `plotId`, `category`). Returns `{items, totalAnimals, totalGroups, page, totalPages}`. Enforces access via `field_members`.
  - `GET /api/auth/livestock/movements` — paginated global movement history with JOINs to source/dest groups/plots/fields. Filters: `fieldId`, `plotId`, `category`, `movementType`, `desde`, `hasta`. Route registered BEFORE `/livestock/:id/movements` so the static path wins over the UUID param.
  - `GET /api/auth/livestock/:id/movements` — up to 50 movements for a single group, with field access check via `FieldSharingService.isFieldAccessible()`.
  - `GET /api/auth/livestock/filters` — dropdown options: accessible fields (with plots) + 9 category enum values.
  - `PATCH /api/auth/livestock/:id` — edit `breed`, `avg_weight_kg`, `notes` (count is read-only — changes only via bot commands/movements).
  - `LivestockRepository.listMovements()` uses LEFT JOINs + `field_members` access control on both endpoints, so members of a shared field see only movements touching their accessible groups.
- **Dashboard Hacienda tab** (`frontend/src/components/`):
  - `LivestockTab` wraps two sub-tabs: **Grupos** + **Historial**
  - `LivestockTable` — paginated groups table with campo/lote/categoría filters, totals banner (animals + groups count), mobile-responsive column hiding, "Movimientos" / "Editar" row actions
  - `LivestockMovementHistory` — modal for per-group movement detail (up to 50 rows) with emoji-coded type badges, incoming/outgoing sign, weight, prices, reason, notes
  - `LivestockEditModal` — edit breed, avg_weight_kg, notes (count is read-only)
  - `LivestockHistoryPanel` — global movement timeline with 6 filters (campo, lote, categoría, tipo, desde, hasta), pagination, and columns: Fecha / Tipo / Cantidad / Origen / Destino / Detalle

## Multi-Channel Alerts

Weather and proactive alerts are delivered to both WhatsApp and Telegram users.

- **`src/services/alert.service.js`** — `sendAlertWithRetryMultiChannel()`: Telegram-first (3 retries, 1-3s backoff), WhatsApp fallback. Extracts `telegramId` from `tg_` placeholder phone numbers. Tracks delivery in `alert_history` table with deduplication.
- **Migration 039** — Converts `daily_weather_hour` from integer to VARCHAR(5) HH:MM format for half-hour precision
- Weather alerts show campo name per city (e.g., "Santa Fe (La Esperanza)") or "tu ubicación" for user's personal city
- Within-message dedup prevents duplicate city alerts when user city matches a field's city
- Admin dashboard: weather alert hour is an HH:MM time input (not just hour selector)
- 14 tests in `alert.service.test.ts`

## Environment Variables

Required in `.env`: `DATABASE_URL`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `ANTHROPIC_API_KEY`, `VERIFY_TOKEN`, `OPENWEATHER_API_KEY`, `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`. See `docker-compose.yml` for defaults. `TELEGRAM_WEBHOOK_SECRET` is optional. `APP_URL` (or `RAILWAY_PUBLIC_DOMAIN`) is used for map URL generation in the field location flow.

### AI Agent Settings (configurable via admin dashboard)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `AGENT_ENABLED` | bool | `false` | Kill switch: `true` = tool_use agent, `false` = JSON extraction |
| `AGENT_MODEL` | string | `claude-haiku-4-5-20251001` | Model for agent |
| `AGENT_MAX_TOKENS` | number | `400` | Max output tokens |
| `AGENT_TIMEOUT_MS` | number | `8000` | Timeout in ms |
| `AGENT_TEMPERATURE` | number | `0` | Temperature (0 = deterministic) |
