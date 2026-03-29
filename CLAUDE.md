# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

campo-bot is a WhatsApp-based agricultural management assistant for Argentine farmers (entirely in Spanish). It uses an AI-first parsing pipeline (Claude Haiku) with regex fallback to understand natural language messages about farm expenses, income, agronomic activities, observations, weather, and rainfall, storing data in PostgreSQL.

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

### Message Processing Pipeline (AI-First)

Messages are orchestrated by `src/services/intent-classifier.ts` through a strict fallback chain:

1. **Observation prefix** — Messages starting with "observación:" bypass AI entirely
2. **Trivial commands** — confirm, cancel, greeting, help, menu, etc. skip AI
3. **AI primary** (`src/ai/intent-extractor.ts`) — Claude Haiku with multi-turn history + dynamic prompt; returns structured JSON intent with confidence score
4. **Regex fallback** (`src/utils/parser.js`) — Commands, observations, bare references; only runs when AI is disabled/failed/low-confidence
5. **Conversational fallback** (`src/ai/conversational-fallback.service.ts`) — Lightweight Claude call for unknown/low-confidence intents

Kill switch: `AI_INTENT_ENABLED=false` skips step 3, running full regex chain.

### AI Intent System (`src/ai/`)

- **`intent-extractor.ts`** — Calls Claude Haiku with conversation history + dynamic prompt, returns ParseResult
- **`prompt-builder.ts`** — Compact system prompt with 33+ intents (including plot mgmt: add_plot, add_plots_batch, set_plot_area), agro rules, disambiguation patterns
- **`intent-validator.ts`** — Validates LLM JSON output, maps to ParseResult; propagates field/plot from AI response into expense/income data
- **`conversation-history.service.ts`** — Loads recent turns from `conversation_logs` (800 char budget, 3 turns)
- **`user-context.service.ts`** — Loads user fields/plots/lastContext with 60s cache
- **`conversational-fallback.service.ts`** — Rate-limited (5/10min) lightweight fallback for unknown intents

### Key Services

- **`services/expenses.js`** — Database layer for all CRUD: expenses, incomes, budgets, fields, rainfall, user settings, AI usage tracking, plot history queries.
- **`services/whatsapp.js`** — WhatsApp Cloud API client (send messages via Meta API).
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

PostgreSQL with migrations in `src/migrations/001-032_*.sql`. Schema initialized by `init.sql` (mounted in Docker). Key tables: `users`, `fields`, `plots`, `expenses`, `incomes`, `budgets`, `rainfall`, `domain_events` (activities), `agro_observations`, `user_settings`, `global_settings`, `ai_usage`, `conversation_logs`, `conversation_events`, `conversation_state`, `unparsed_messages`, `refresh_tokens`, `observation_history`.

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
- `/api/auth/*` — Auth endpoints (register, login, refresh, logout, profile, observations, expenses, incomes, activities — including PATCH edit endpoints, GET filters)
- `/admin/api/*` — Admin dashboard API endpoints (stats, users, settings, AI usage, parse metrics, enriched field detail with financials, field activities) — requires admin JWT
- `/admin` — Admin dashboard static files (legacy HTML/JS from `src/public/`)

### Flow Engine (`src/middleware/`)

Interruptible conversation flows for multi-step data entry (expense, income, rainfall, field, activity).

- **`conversation-engine.ts`** — FSM: startFlow, processFlowMessage, clearFlow, goBack, skipStep
- **`conversation-state.repository.ts`** — DB-persisted flow state
- **`flows/`** — field_flow, expense_flow, income_flow, rainfall_flow, activity_flow (activity_flow uses dynamic `interactiveAsync` for plot selection)
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

## Environment Variables

Required in `.env`: `DATABASE_URL`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `ANTHROPIC_API_KEY`, `VERIFY_TOKEN`, `OPENWEATHER_API_KEY`, `JWT_SECRET`. See `docker-compose.yml` for defaults.
