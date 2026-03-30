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
2. **Trivial commands** — confirm, cancel, greeting, help, menu, etc. skip AI (~36 commands)
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
- **`tool-definitions.ts`** — 27 Anthropic tool definitions grouped by domain: Financial (2), Activities (6), Observations (2), Reports (10), Field/Plot Mgmt (5), System (2). Each tool has typed `input_schema` with enum validation for categories.
- **`agent-prompt-builder.ts`** — Compact system prompt (~400 tokens) with disambiguation rules and user context. Tool definitions carry the schema, so the prompt only needs rules. Includes explicit rules that agro activities (fumigué, sembré, coseché, etc.) are ONLY activities and NEVER expenses unless the user mentions an explicit amount.
- **`agent-response-mapper.ts`** — Converts `AgentResult` → `ParseResult[]` for backward compatibility. Maps `log_expense`/`log_income` tool calls to expense/income ParseResults; everything else to command ParseResults. No-tool conversational responses become `_conversationalResponse` on ParseResult. **Fix**: filters spurious `log_expense`/`log_income` tool calls when the agent also returns an agro activity tool (sow_crop, harvest_crop, log_spraying, etc.), preventing Haiku from misclassifying activity messages as expenses.
- **`few-shot.service.ts`** — `formatAsToolUseMessages()` converts training examples to tool_use triplets (user → assistant[tool_use] → user[tool_result]).

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
- **`middleware/pending-field-city-handler.ts`** — Shared handler for pending city validation across all 3 controllers (WhatsApp, Telegram, test-bot). Exports `formatLocation(city, province)` helper.
- **`services/whatsapp.js`** — WhatsApp Cloud API client (send messages via Meta API).
- **`services/telegram.ts`** — Telegram Bot API client (sendMessage, sendButtons, sendList, sendDocument, downloadFile).
- **`services/weather.js`** — OpenWeather API integration for forecasts and rain alerts.
- **`services/scheduler.js`** — node-cron jobs: weekly summaries, daily weather alerts, proactive reminders (missing hectares), Argentina timezone.
- **`services/observations.js`** — Observation CRUD with 4-layer dedup, normalization, financial guard.
- **`services/settings.service.js`** — Global settings definitions with descriptions, grouped by category (ai, bot, audio, limits, agronomy, system).

### Domain Layer (`src/domain/`)

- **`agronomy/`** — AgronomyHandler (activities, observations, weather, rainfall, agro reports, plot history queries); `normalizeActivityFilter()` maps AI filter strings to DB event_type values
- **`financial/`** — FinancialHandler (expenses, incomes, budgets, financial reports, inline hectares on plot creation, activity labels with emojis in reports), FinancialService, FinancialRepository
- **`auth/`** — Auth system (JWT, bcrypt, refresh tokens) + ObservationService (dashboard CRUD for observations, activities, expenses, incomes with edit support)
- **`plots/`** — PlotDiscoveryService (lookup-only, never auto-creates), PlotRepository
- **`billing/`** — Plan-based AI daily limits

### Parser (`src/utils/parser.js`)

Handles Spanish text normalization, written numbers ("quinientos mil" → 500000), Argentine slang ("lucas" = thousands, "palos" = millions), fuzzy category matching, and currency detection (ARS vs USD). Includes a question guard (`isLikelyQuestion` in `src/utils/guards.ts`) that prevents Spanish questions from being misclassified. ~950 lines with 50+ test cases in `parser.test.js`.

### Database

PostgreSQL with migrations in `src/migrations/001-036_*.sql`. Schema initialized by `init.sql` (mounted in Docker). Key tables: `users` (includes `telegram_id`, `province` columns), `fields` (includes `province`), `plots`, `expenses`, `incomes`, `budgets`, `rainfall`, `domain_events` (activities), `agro_observations`, `user_settings`, `global_settings`, `ai_usage`, `conversation_logs` (includes `tool_calls` JSONB, `agent_mode`, and `channel` columns), `conversation_events`, `conversation_state`, `unparsed_messages`, `refresh_tokens`, `observation_history`.

### Frontend (`frontend/`)

React + Vite + TailwindCSS SPA. In production, Express serves the build from `frontend/dist/`.

- **Stack**: React 19, React Router v6, Tailwind v3, Vite 6, TypeScript
- **Auth flow**: JWT stored in localStorage, auto-refresh on 401, role-based route guards
- **Key files**: `src/api/client.ts` (fetch wrapper), `src/context/AuthContext.tsx` (auth state), `src/components/ProtectedRoute.tsx` (route guard)
- **Pages**: `/login`, `/register`, `/dashboard` (end-user with 4 tabs: Observaciones, Actividades, Gastos, Ingresos)
- **Dashboard features**: Paginated tables with filters (date, campo, lote, category/type), inline "Editar" button on each row, edit modals for all entity types
- **Edit modals**: `ObservationEditModal` (with history tracking), `ExpenseEditModal`, `IncomeEditModal`, `ActivityEditModal` (lightweight, no history)
- **Date handling**: Uses `toLocalDate()` helper for date inputs to avoid UTC timezone shift (Argentina is UTC-3)

### Auth System (`src/domain/auth/`)

JWT-based authentication with bcrypt passwords and refresh token rotation.

- **`auth.service.ts`** — register, login, refresh, logout, profile update
- **`auth.repository.ts`** — User DB queries (findByEmail, createUser, updateProfile)
- **`token.repository.ts`** — Refresh token CRUD (save, find, revoke, cleanup)
- **`observation.service.ts`** — Dashboard CRUD: observations (with edit history), expenses, incomes, activities (edit support via `editExpense`, `editIncome`, `editActivity`); `getUserFieldsWithPlots()` for filter dropdowns
- **`auth.middleware.ts`** (`src/middleware/`) — `requireAuth` + `requireRole` Express middleware

### Routes

- `GET/POST /webhook` — WhatsApp webhook (verification + message handler)
- `POST /telegram` — Telegram webhook handler (secret verified via `src/middleware/telegram-auth.ts`)
- `/api/auth/*` — Auth endpoints (register, login, refresh, logout, profile, observations, expenses, incomes, activities — including PATCH edit endpoints, GET filters)
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
- Timezone: America/Argentina/Buenos_Aires
- Expenses/incomes use soft delete (`deleted_at` column), fields/plots use soft delete (`deleted_at`, `deleted_by`)
- Lotes (plots) = primary productive unit for expenses/incomes; Campos (fields) = grouping container
- Optional confirmation workflow before saving transactions (per-user setting)
- AI calls are plan-based rate-limited per user (free=20, pro=100, pro_plus=300, enterprise=1000 daily)
- PlotDiscoveryService is lookup-only — never auto-creates fields/plots; returns `notFound` info for unresolved entities
- Observation safety guard in `agronomy.handler.ts`: `isLikelyQuestionOrFollowUp()` prevents non-agro text from being saved as observations

## Deployment

The project is deployed on **Railway** at `campo-bot-production.up.railway.app`. Deploy with `railway up` from the local directory.

The Dockerfile builds the frontend as part of the image: it installs frontend dependencies and runs `npm run build` so `frontend/dist/` is present at runtime. No separate build step is needed when deploying.

Required environment variables on Railway: `DATABASE_URL`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `VERIFY_TOKEN`, `OPENWEATHER_API_KEY`.

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
