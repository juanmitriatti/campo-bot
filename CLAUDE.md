# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

campo-bot is a WhatsApp-based agricultural management assistant for Argentine farmers (entirely in Spanish). It parses natural language messages about farm expenses, income, weather, and rainfall using a multi-stage parsing pipeline, and stores data in PostgreSQL.

## Commands

- `npm start` — Run the app (`node src/index.js`), listens on port 3000
- `npm test` — Run all tests (`vitest run`)
- `npx vitest run src/utils/parser.test.js` — Run a single test file
- `docker compose up --build` — Start app + PostgreSQL (port 5433 for DB, 3000 for app)
- `docker compose up -d db` — Start only the database
- `cd frontend && npm run dev` — Run React frontend dev server (port 5173, proxies API to :3000)
- `cd frontend && npm run build` — Build frontend for production (output: `frontend/dist/`)
- `npx tsx src/scripts/create-admin.ts --email <e> --name <n> --password <p>` — Bootstrap admin user

## Architecture

### Message Processing Pipeline

The core flow lives in `src/routes/webhook.js` (the largest file). Messages go through a strict fallback chain:

1. **Command detection** (`parser.js:detectarComando`) — 90+ Spanish command patterns (ayuda, clima, resumen, presupuesto, etc.)
2. **Local income parser** (`parser.js:parsearIngreso`) — Regex-based detection of sales ("vendí 30 tn de soja a $250")
3. **Local expense parser** (`parser.js:parsearGasto`) — Regex-based detection of expenses ("gasté 50mil en gasoil")
4. **Claude AI fallback** (`services/claude.js`) — Only called when local parsers fail; uses Claude Haiku with temperature=0 and a strict JSON-only system prompt
5. **Unparsed storage** — Failed messages saved to `unparsed_messages` table for debugging

### Key Services

- **`services/claude.js`** — Anthropic SDK integration. Model: `claude-haiku-4-5-20251001`, max_tokens: 200. Returns structured JSON for expense/income extraction.
- **`services/expenses.js`** — Database layer for all CRUD: expenses, incomes, budgets, fields, rainfall, user settings, AI usage tracking.
- **`services/whatsapp.js`** — WhatsApp Cloud API client (send messages via Meta API).
- **`services/weather.js`** — OpenWeather API integration for forecasts and rain alerts.
- **`services/scheduler.js`** — node-cron jobs: weekly summaries and daily weather alerts, Argentina timezone.

### Parser (`src/utils/parser.js`)

Handles Spanish text normalization, written numbers ("quinientos mil" → 500000), Argentine slang ("lucas" = thousands, "palos" = millions), fuzzy category matching, and currency detection (ARS vs USD). Includes a question guard (`isLikelyQuestion`) that prevents Spanish questions ("que es...?", "como...?") from being misclassified as expenses. This is the most complex utility and has 50+ test cases in `parser.test.js`.

### Database

PostgreSQL with migrations in `src/migrations/001-031_*.sql`. Schema initialized by `init.sql` (mounted in Docker). Key tables: `users`, `fields`, `expenses`, `incomes`, `budgets`, `rainfall`, `user_settings`, `global_settings`, `ai_usage`, `unparsed_messages`, `refresh_tokens`, `observation_history`.

### Frontend (`frontend/`)

React + Vite + TailwindCSS SPA. In production, Express serves the build from `frontend/dist/`.

- **Stack**: React 19, React Router v6, Tailwind v3, Vite 6, TypeScript
- **Auth flow**: JWT stored in localStorage, auto-refresh on 401, role-based route guards
- **Key files**: `src/api/client.ts` (fetch wrapper), `src/context/AuthContext.tsx` (auth state), `src/components/ProtectedRoute.tsx` (route guard)
- **Pages**: `/login`, `/register`, `/dashboard` (end-user)

### Auth System (`src/domain/auth/`)

JWT-based authentication with bcrypt passwords and refresh token rotation.

- **`auth.service.ts`** — register, login, refresh, logout, profile update
- **`auth.repository.ts`** — User DB queries (findByEmail, createUser, updateProfile)
- **`token.repository.ts`** — Refresh token CRUD (save, find, revoke, cleanup)
- **`observation.service.ts`** — End-user observation CRUD with edit history
- **`auth.middleware.ts`** (`src/middleware/`) — `requireAuth` + `requireRole` Express middleware

### Routes

- `GET/POST /webhook` — WhatsApp webhook (verification + message handler)
- `/api/auth/*` — Auth endpoints (register, login, refresh, logout, profile, observations)
- `/admin/api/*` — Admin dashboard API endpoints (stats, users, settings, AI usage, parse metrics) — requires admin JWT
- `/admin` — Admin dashboard static files (legacy HTML/JS from `src/public/`)

## Key Conventions

- ESM modules (`"type": "module"` in package.json) — use `import`/`export`, not `require`
- All user-facing text is in Spanish (Argentine dialect)
- Currency: ARS (default) and USD; amounts use Argentine conventions (50mil = 50,000)
- Timezone: America/Argentina/Buenos_Aires
- Expenses/incomes use soft delete (`deleted_at` column)
- Optional confirmation workflow before saving transactions (per-user setting)
- Claude AI calls are rate-limited per user (`claude_daily_limit` in user_settings)
- PlotDiscoveryService is lookup-only — never auto-creates fields/plots; returns `notFound` info for unresolved entities

## Environment Variables

Required in `.env`: `DATABASE_URL`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `ANTHROPIC_API_KEY`, `VERIFY_TOKEN`, `OPENWEATHER_API_KEY`, `JWT_SECRET`. See `docker-compose.yml` for defaults.
