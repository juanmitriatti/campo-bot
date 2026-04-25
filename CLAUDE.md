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
- "pasé N terneros a novillos" → `transfer_livestock` (recategorización auto-detected)
- `add_livestock` / `remove_livestock` with `unit_price_ars|usd` → auto-creates linked expense/income (category "Hacienda"). Stored in `livestock_movements.linked_expense_id` / `linked_income_id`.

### Weather
- "clima/pronóstico/va a llover en X" → `weather_full(city=X, province?)`. NEVER fall back to user.city if query mentions a city.
- Handler uses `localidadLookup` to disambiguate ambiguous names (ej: Ameghino in Bs As vs La Pampa).

### Harvest Loads (per-truck)
- ANY list of `nombre número` in a cosecha context is `loads[]` — destinatario and kg unit are optional.
- "Cosecha del lote X" WITHOUT driver/weight list → `query_harvest_loads` (query intent), NOT `harvest_crop`.

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

### Harvest Loads
- `harvest_crop` accepts optional `loads[]` (per-truck: driver_name, weight_kg, destination?, destinatario?, truck_plate?). Only driver+weight required.
- Dedup: same plot harvested today → appends loads, no duplicate event
- If `loads[]` present but no active crop → handler warns the user the loads were dropped
- If harvest called with no new loads but plot has stored loads → response includes existing-loads summary
- `query_harvest_loads` tool queries stored loads (filters: plot, field, date, driver, destinatario)
- `delete_harvest_loads` tool removes loads by criteria (plot, date, driver_names[], only_without_destination)
- `campaign_stats` includes per-truck detail in yield section

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
| `livestock` | pro_plus+ | add_livestock, transfer_livestock, feedlots, corrals, dashboard Hacienda tab + API |

## Key File Map

### AI Pipeline
- `src/ai/agent.service.ts` — Claude tool_use agent (primary)
- `src/ai/tool-definitions.ts` — 74 tool definitions with typed schemas
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

### Landing Page
- `landing/` — Git submodule (campo-chat-bot). Marketing site: hero, features, pricing, testimonial, WhatsApp demo
- Served on `/` and all non-matched routes. Frontend app served on `/login`, `/register`, `/dashboard`, `/chat` only
- Frontend assets at `/app-assets/*`, landing assets at `/assets/*` (no collision)

## Extended Documentation

- **[docs/ai/tools.md](docs/ai/tools.md)** — Tool groups, disambiguation rules, compound actions
- **[docs/ai/failure-patterns.md](docs/ai/failure-patterns.md)** — Known pitfalls, hallucinations, data integrity issues
- **[docs/architecture.md](docs/architecture.md)** — Full implementation reference (AI, domain, services, DB, flows, auth, frontend)
- **[docs/operations.md](docs/operations.md)** — Deploy, env vars, migrations, Telegram setup, settings tables
- **[docs/features/stock.md](docs/features/stock.md)** — Stock/inventory system
- **[docs/features/livestock.md](docs/features/livestock.md)** — Livestock/hacienda system
- **[docs/features/documents.md](docs/features/documents.md)** — Document processing (facturas/remitos)
