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
- `npx tsx src/scripts/create-admin.ts --email <e> --name <n> --password <p>` — Bootstrap admin user
- `npx tsx src/scripts/seed-dummy-data.ts --user-id <id> [--reset]` — Seed dummy data
- `npx tsx src/scripts/run-migrations.ts` — Manually run pending DB migrations (auto-runs on startup)

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

### Activity vs Expense
- Agro verb (fumigué, sembré, coseché, fertilicé) WITHOUT explicit amount → activity tool, NEVER `log_expense`
- Agro verb WITH explicit amount → BOTH activity + `log_expense` (compound action)
- compré/gasté + insumo → `log_expense` (type=insumo)
- vendí/cobré → `log_income`

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
- "pasé N terneros a novillos" → `transfer_livestock` (recategorización auto-detected)

### Reports
- "reporte agronómico" → `generate_agro_report` (needs agent for date range)
- "reporte financiero" / "cómo vamos" → `financial_report`
- "reportes"/"informes" (generic) → `show_reports_menu`

### Sow Crop
- `sow_crop` accepts optional `hectares` param for partial-plot sowing → `plot_crops.sowed_hectares`

### Harvest Loads
- `harvest_crop` accepts optional `loads[]` (per-truck: driver_name, weight_kg, destination, destinatario, truck_plate)
- Dedup: same plot harvested today → appends loads, no duplicate event
- `query_harvest_loads` tool queries stored loads (filters: plot, field, date, driver, destinatario)
- `campaign_stats` includes per-truck detail in yield section

## Key Conventions

- ESM modules (`"type": "module"`) — `import`/`export`, not `require`
- All user-facing text in Argentine Spanish
- Currency: ARS (default) and USD; amounts use Argentine conventions (50mil = 50,000)
- Timezone: `America/Argentina/Buenos_Aires` (UTC-3). Centralized helpers in `src/utils/date.ts`: `getNowArgentina()`, `getTodayISO()`, `formatDateAR()`. PostgreSQL timezone set via migration 048.
- Soft delete: `deleted_at` on expenses, incomes, fields, plots
- Lotes (plots) = primary productive unit; Campos (fields) = grouping container
- PlotDiscoveryService is LOOKUP-ONLY — never auto-creates fields/plots
- AI calls are plan-based rate-limited (free=20, pro=100, pro_plus=300, enterprise=1000 daily)
- Observation guard: `isLikelyQuestionOrFollowUp()` prevents non-agro text from being saved as observations

## Feature Gates

| Feature Key | Required Plan | Commands |
|-------------|---------------|----------|
| `stock` | pro_plus+ | create_warehouse, add_stock, check_stock, etc. |
| `livestock` | pro_plus+ | add_livestock, transfer_livestock, etc. |
| `sharing` | enterprise | share_field (accept_invite is ungated) |
| `documents` | all (daily limits vary) | upload_document, list_documents |

## Key File Map

### AI Pipeline
- `src/ai/agent.service.ts` — Claude tool_use agent (primary)
- `src/ai/tool-definitions.ts` — 68 tool definitions with typed schemas
- `src/ai/agent-prompt-builder.ts` — Compact system prompt with disambiguation rules
- `src/ai/agent-response-mapper.ts` — AgentResult → ParseResult[] conversion
- `src/ai/intent-extractor.ts` — JSON extraction (legacy fallback)
- `src/ai/few-shot.service.ts` — Training examples as tool_use triplets
- `src/ai/user-context.service.ts` — User fields/plots with 60s cache
- `src/ai/conversation-history.service.ts` — Multi-turn context (4000 char budget)

### Domain Handlers
- `src/domain/agronomy/` — Activities, observations, weather, reports, campaigns, tacto
- `src/domain/financial/` — Expenses, incomes, budgets, reports, plot creation
- `src/domain/livestock/` — Cattle inventory (event-sourced, 8 AI tools)
- `src/domain/stock/` — Inventory management (8 AI tools)
- `src/domain/documents/` — Invoice/receipt processing (Claude Vision)
- `src/domain/sharing/` — Invite-code field sharing
- `src/domain/feedlot/` — Feedlot/corral CRUD
- `src/domain/compound-executor.ts` — Sequential execution of multiple tool calls
- `src/domain/billing/` — Plan limits + FeatureGate

### Services & Middleware
- `src/services/intent-classifier.ts` — Pipeline orchestrator
- `src/services/expenses.js` — Main DB layer (all CRUD)
- `src/services/localidad-lookup.service.ts` — City validation (4027 census localities)
- `src/middleware/conversation-engine.ts` — Flow FSM (startFlow, processFlowMessage, clearFlow)
- `src/middleware/pending-field-location.ts` — 3-option field location (city/map/share)
- `src/middleware/pending-plot-area.ts` — Queue-based hectares assignment

### Controllers
- `src/controllers/whatsapp.controller.ts` — WhatsApp webhook
- `src/controllers/telegram.controller.ts` — Telegram webhook
- `src/controllers/test-bot.controller.ts` — Test bot (same pipeline)

### Config & Utils
- `src/utils/parser.js` — Spanish text normalization, number expansion, category matching
- `src/utils/date.ts` — Argentina timezone helpers
- `src/utils/guards.ts` — `isLikelyQuestion()` guard
- `src/types/index.ts` — ParseResult, PlanRow, ParseSource

## Extended Documentation

- **[docs/ai/tools.md](docs/ai/tools.md)** — Tool groups, disambiguation rules, compound actions
- **[docs/ai/failure-patterns.md](docs/ai/failure-patterns.md)** — Known pitfalls, hallucinations, data integrity issues
- **[docs/architecture.md](docs/architecture.md)** — Full implementation reference (AI, domain, services, DB, flows, auth, frontend)
- **[docs/operations.md](docs/operations.md)** — Deploy, env vars, migrations, Telegram setup, settings tables
- **[docs/features/stock.md](docs/features/stock.md)** — Stock/inventory system
- **[docs/features/livestock.md](docs/features/livestock.md)** — Livestock/hacienda system
- **[docs/features/documents.md](docs/features/documents.md)** — Document processing (facturas/remitos)
