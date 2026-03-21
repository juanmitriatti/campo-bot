# Dashboard Parametrization Audit — 2026-03-20

## Summary

- **Total configurable elements:** 68
- **Total hardcoded elements:** 52
- **Settings defined but never read by code:** 6
- **Dashboard pages:** 9 (+ 2 detail sub-pages)
- **API endpoints:** 50
- **Frontend:** Single monolithic HTML file (3,166 lines), no framework, no charts, no auth

### Key Observations

1. The `system_settings` table is well-designed (37 keys) but **6 settings are defined and never actually read** by the code that should use them.
2. AI token pricing (`$0.80/M input, $4.00/M output`) is **hardcoded in 8+ locations** across dashboard.js and expenses.js — not configurable.
3. The dashboard has **no authentication** — anyone with the URL can access all admin functions.
4. There are **no charts or graphs** — all analytics are stat cards and tables.
5. There is **no auto-refresh** — data loads once per page navigation.
6. **4 API endpoints** exist in the backend but have no UI in the frontend (`parser-errors`, `conversation-stats`, `deletion-log`).
7. The scheduler ignores the `SCHEDULER_CRON_EXPRESSION` setting and hardcodes `"0 * * * *"`.

---

## 1. System Settings (DB: `system_settings` — key-value store)

Managed via dashboard at `#settings`. Resolution order: DB -> env var -> hardcoded default.

### Audio Group

| Name | Type | Default | Configurable | Actually Read? | Notes |
|------|------|---------|--------------|----------------|-------|
| MAX_AUDIO_DURATION_SECONDS | number | 120 | Yes | Yes | Max audio length in seconds |
| OPENAI_WHISPER_MODEL | string | whisper-1 | Yes | Yes | STT model name |
| SPEECH_TIMEOUT_MS | number | 30000 | Yes | Yes | Transcription timeout |
| AUDIO_COST_PER_MINUTE_USD | number | 0.006 | Yes | **NO** | Controller hardcodes `0.006` at whatsapp.controller.ts:434 |
| MAX_AUDIO_PER_HOUR | number | 10 | Yes | Yes | Per-user hourly cap |
| MAX_AUDIO_PER_USER_DAY | number | 50 | Yes | Yes | Per-user daily cap |

### AI Group

| Name | Type | Default | Configurable | Actually Read? | Notes |
|------|------|---------|--------------|----------------|-------|
| CLAUDE_FALLBACK_MODEL | string | claude-haiku-4-5-20251001 | Yes | Yes | Legacy fallback model |
| CLAUDE_FALLBACK_MAX_TOKENS | number | 250 | Yes | Yes | |
| CLAUDE_FALLBACK_ENABLED | boolean | true | Yes | Yes | Kill switch |
| AI_INTENT_ENABLED | boolean | true | Yes | Yes | Kill switch for AI intent extraction |
| AI_INTENT_MODEL | string | claude-haiku-4-5-20251001 | Yes | Yes | |
| AI_INTENT_MAX_TOKENS | number | 300 | Yes | Yes | |
| AI_INTENT_TIMEOUT_MS | number | 5000 | Yes | Yes | |
| AI_INTENT_MIN_CONFIDENCE | number | 0.70 | Yes | Yes | Min confidence to accept AI intent |
| CONVERSATIONAL_FALLBACK_ENABLED | boolean | true | Yes | Yes | Kill switch |
| CONVERSATIONAL_FALLBACK_MODEL | string | claude-haiku-4-5-20251001 | Yes | Yes | |
| CONVERSATIONAL_FALLBACK_MAX_TOKENS | number | 120 | Yes | Yes | |
| CONVERSATIONAL_FALLBACK_TIMEOUT_MS | number | 5000 | Yes | Yes | |
| CONVERSATIONAL_FALLBACK_TEMPERATURE | number | 0.3 | Yes | Yes | |
| CONFIDENCE_HIGH_SKIP_AI | number | 0.75 | Yes | Yes | Above this, skip AI |
| CONFIDENCE_LOW_CONFIRM | number | 0.70 | Yes | Yes | Below this, force confirmation |
| CONFIDENCE_UNKNOWN_FALLBACK | number | 0.50 | Yes | Yes | Below this, conversational fallback |

### Limits Group

| Name | Type | Default | Configurable | Actually Read? | Notes |
|------|------|---------|--------------|----------------|-------|
| CONVERSATIONAL_FALLBACK_RATE_LIMIT_MAX | number | 5 | Yes | Yes | Max calls per window |
| CONVERSATIONAL_FALLBACK_RATE_LIMIT_WINDOW_MS | number | 600000 | Yes | Yes | 10-minute window |
| MAX_REPORTS_PER_WEEK | number | 10 | Yes | Yes | |

### Bot/Flow Group

| Name | Type | Default | Configurable | Actually Read? | Notes |
|------|------|---------|--------------|----------------|-------|
| FLOW_TIMEOUT_MS | number | 600000 | Yes | Yes | Conversation flow timeout |
| FLOW_MAX_STEP_FAILURES | number | 3 | Yes | Yes | |
| PENDING_TRANSACTION_TIMEOUT_MS | number | 300000 | Yes | **NO** | pending-transactions.ts hardcodes `5 * 60 * 1000` |
| DEDUP_MAX_SIZE | number | 1000 | Yes | **NO** | dedup.ts hardcodes `MAX_SIZE = 1000` |

### System Group

| Name | Type | Default | Configurable | Actually Read? | Notes |
|------|------|---------|--------------|----------------|-------|
| USER_CONTEXT_CACHE_TTL_MS | number | 60000 | Yes | **NO** | user-context.service.ts hardcodes `60_000` |
| FEATURE_GATE_CACHE_TTL_MS | number | 300000 | Yes | **NO** | feature-gate.ts hardcodes `5 * 60 * 1000` |
| SCHEDULER_CRON_EXPRESSION | string | 0 * * * * | Yes | **NO** | scheduler.js hardcodes `"0 * * * *"` |
| WEATHER_FORECAST_DAYS | number | 3 | Yes | Yes | But scheduler hardcodes `2` for rain alerts |
| DEFAULT_RAIN_ALERT_MM | number | 10 | Yes | Yes | |
| DEFAULT_FIELD_NAME | string | General | Yes | Yes | Auto-created field name |
| DEFAULT_USER_PLAN | string | free | Yes | Yes | |

### Agronomy Group

| Name | Type | Default | Configurable | Actually Read? | Notes |
|------|------|---------|--------------|----------------|-------|
| MAX_OBSERVATIONS_PER_REPORT | number | 200 | Yes | Yes | |
| REPORTS_STORAGE_PATH | string | data/reports | Yes | Yes | |

---

## 2. Global Settings (DB: `global_settings` — single-row table)

Editable via dashboard at `#alerts` page.

| Name | Type | Default | Configurable | Notes |
|------|------|---------|--------------|-------|
| daily_weather_enabled | boolean | true | Yes | Global weather alerts toggle |
| daily_weather_hour | int (0-23) | 6 | Yes | Hour to send weather alerts (Argentina TZ) |
| default_rain_alert_mm | int | 10 | Yes | System-wide rain threshold |
| budget_alert_80 | boolean | true | Yes | Alert at 80% budget |
| budget_alert_100 | boolean | true | Yes | Alert at 100% budget |

---

## 3. User Settings (DB: `user_settings` — per-user)

Editable via dashboard at `#user/{id}` detail page.

| Name | Type | Default | Configurable | Notes |
|------|------|---------|--------------|-------|
| weekly_summary | boolean | true | Yes | |
| weekly_summary_day | int (0-6) | 0 (Sunday) | Yes | |
| weekly_summary_hour | int (0-23) | 19 | Yes | |
| budget_alerts | boolean | true | Yes | |
| rain_alerts | boolean | true | Yes | |
| confirm_before_save | boolean | true | Yes | |
| claude_daily_limit | int | 50 | Yes (admin) | Also hardcoded as fallback in 2 files |
| rain_alert_mm | int | 10 | Yes | Per-user rain threshold |
| max_fields | int | 10 | Yes (admin) | Max fields per user |

---

## 4. Environment Variables

| Name | Required | Default | Configurable | Notes |
|------|----------|---------|--------------|-------|
| DATABASE_URL | Yes | — | .env only | PostgreSQL connection |
| WHATSAPP_TOKEN | Yes | — | .env only | Protected secret |
| WHATSAPP_PHONE_NUMBER_ID | Yes | — | .env only | Protected secret |
| ANTHROPIC_API_KEY | Yes | — | .env only | Protected secret |
| VERIFY_TOKEN | Yes | — | .env only | Webhook verification |
| OPENWEATHER_API_KEY | Yes | — | .env only | Protected secret |
| OPENAI_API_KEY | Yes | — | .env only | Protected secret |
| PORT | No | 3000 | .env | Server port |
| SPEECH_PROVIDER | No | openai | .env | openai, local_whisper, google |
| SPEECH_LANGUAGE | No | es | .env | Audio language |
| WEATHER_CITY | No | Buenos Aires | .env | Default weather city |

---

## 5. Dashboard UI Components — Configurable vs Hardcoded

### Filters & Controls (User-Changeable)

| Page | Element | Type | Current Value | Notes |
|------|---------|------|---------------|-------|
| Usuarios | Search | Text input | — | Filters by name, phone, email, city, plan (client-side) |
| Usuarios | Status filter | Dropdown | Todos | Options: Todos, Activos, Suspendidos, Deshabilitados |
| Alertas | Type filter | Dropdown | Todos | Options: Clima, Pres. 80%, Pres. 100%, Monitoreo, Plaga |
| Alertas | Status filter | Dropdown | Todos | Options: Enviada, Fallida, Deduplicada |
| Alertas | History pagination | Prev/Next buttons | Page 1 | Page size: 50 (hardcoded) |
| Analiticas | Days range | Dropdown | 30 dias | Options: 7, 14, 30, 60 |
| Errores | Service filter | Dropdown | Todos | Options: whatsapp, claude, audio, webhook, agro-report |
| Errores | Severity filter | Dropdown | Todas | Options: error, warning, info |
| Errores | Pagination | Prev/Next buttons | Page 1 | Page size: 50 (hardcoded) |
| Parser | Fallback pagination | Prev/Next buttons | Page 1 | Page size: 50 (hardcoded) |
| Parser | Unparsed pagination | Prev/Next buttons | Page 1 | Page size: 50 (hardcoded) |
| Configuracion | All system settings | Dynamic inputs | Per-key defaults | Grouped by audio/ai/agronomy/limits |
| User Detail | User profile fields | Form inputs | Per-user | 7 editable fields |
| User Detail | User settings | Toggles + inputs | Per-user | 9 editable settings |
| User Detail | Plan selector | Dropdown | Current plan | All active plans |
| Agro Detail | Generate Report | Button | — | Triggers PDF generation |

### Hardcoded UI Elements (Not Configurable)

| Element | Current Value | Location | Should Be Configurable? |
|---------|---------------|----------|------------------------|
| Theme colors | Green agriculture theme (#2d5a27) | CSS custom properties | Low priority |
| Sidebar width | 250px | CSS `--sidebar-width` | No |
| Border radius | 8px / 12px | CSS `--radius` | No |
| Toast duration | 3000ms | index.html:1619 | No |
| Page animation | fadeIn 0.25s, translateY(8px) | CSS keyframes | No |
| Responsive breakpoint | 768px | CSS media query | No |
| Font family | system-ui stack | CSS body | No |
| USD decimal places | 4 | JS formatters | No |
| Date format | dd/mm/yyyy (es-AR) | JS formatters | No |
| Analytics day options | [7, 14, 30, 60] | Hardcoded dropdown | Yes — missing custom range |
| Pagination page size | 50 | Multiple pages | Yes — should be user-selectable |
| Auto-refresh | None (loads once) | — | Yes — dashboard should auto-refresh |
| Dashboard auth | None | dashboard.js routing | **Critical** — should have auth |
| Chart visualization | None (stat cards only) | — | Yes — charts would add value |
| Max plots in report text | 5 | response-formatter.ts:99 | Low priority |
| Max activities in report text | 5 | response-formatter.ts:100 | Low priority |
| Observation category colors | Fixed map | index.html | No |
| Status badge colors | Fixed map | index.html | No |

---

## 6. Hardcoded Values That SHOULD Be Configurable

### Critical — Should Be System Settings

| Value | Where Used | Impact |
|-------|-----------|--------|
| AI pricing: $0.80/M input, $4.00/M output | 8+ locations in dashboard.js, expenses.js | If model pricing changes, 8 files need manual updates |
| Proactive alerts hour: 8 AM | scheduler.js:473 | Cannot schedule proactive alerts at different times |
| Weather forecast days for rain alerts: 2 | scheduler.js:277 | Mismatches WEATHER_FORECAST_DAYS default of 3 |
| Monitoring reminder window: 7 days | scheduler.js:371 | Cannot adjust observation monitoring window |
| Pest escalation window: 14 days | scheduler.js:431,437 | Cannot adjust pest alert sensitivity |
| Pest escalation threshold: >= 3 observations | scheduler.js:440 | Cannot adjust pest alert sensitivity |
| Dedup alert window: 168 hours (7 days) | scheduler.js:389,445 | Cannot adjust alert dedup window |

### Medium — Settings Exist But Not Wired

| Setting | File That Ignores It | Hardcoded Value |
|---------|---------------------|-----------------|
| AUDIO_COST_PER_MINUTE_USD | whatsapp.controller.ts:434 | `0.006` |
| PENDING_TRANSACTION_TIMEOUT_MS | pending-transactions.ts:3 | `5 * 60 * 1000` |
| DEDUP_MAX_SIZE | dedup.ts | `MAX_SIZE = 1000` |
| USER_CONTEXT_CACHE_TTL_MS | user-context.service.ts:17 | `60_000` |
| FEATURE_GATE_CACHE_TTL_MS | feature-gate.ts:16 | `5 * 60 * 1000` |
| SCHEDULER_CRON_EXPRESSION | scheduler.js:489,494,499 | `"0 * * * *"` |

### Low — Display Constants

| Value | Location | Description |
|-------|----------|-------------|
| MAX_PLOTS = 5 | response-formatter.ts:99 | Max plots in WhatsApp agro report |
| MAX_ACTIVITIES = 5 | response-formatter.ts:100 | Max activities in WhatsApp agro report |
| RECENT_LIMIT = 5 | plot-query.service.ts:17 | Max recent history items |
| SUMMARY_THRESHOLD = 7 | plot-query.service.ts:18 | List-to-summary threshold |
| MAX_INTERACTIVE_ROWS = 9 | field-step-helpers.ts:7 | WhatsApp interactive list max |
| Recent expenses LIMIT 10 | dashboard.js:108 | User detail page |
| Top commands LIMIT 20 | dashboard.js:1228 | Conversation stats |
| Graph API version v22.0 | whatsapp.js:16, audio-download.service.js:4 | Facebook API version |
| WhatsApp retry delays [1s, 5s, 15s] | whatsapp.js:156 | Message send retries |

---

## 7. API Endpoints Without UI

These endpoints exist in the backend but have no corresponding dashboard page:

| Endpoint | Description | UI Status |
|----------|-------------|-----------|
| GET /api/parser-errors | Parser error log with pagination | No UI |
| GET /api/parser-errors/stats | Parser error breakdown | No UI |
| GET /api/conversation-stats | Rich conversation analytics | No UI |
| GET /api/conversation-stats/unknown-phrases | Unknown phrase ranking | No UI |
| GET /api/conversation-stats/user-journey/:userId | Per-user event timeline | No UI |
| GET /api/deletion-log | Entity deletion history | No UI |

---

## 8. Subscription Plans (DB: `plans`)

| Plan | Display Name | Price ARS | Features | Editable |
|------|-------------|-----------|----------|----------|
| free | Gratis | 0 | expenses, incomes, fields | Features only (via dashboard) |
| pro | Pro | 5000 | + budgets, rainfall, weather, csv_export | Features only |
| pro_plus | Pro+ | 12000 | + agronomy, ai_fallback, audio | Features only |
| enterprise | Enterprise | 0 | All features | Features only |

Note: Plan creation/deletion is not available in the dashboard UI. Only feature toggling per plan.

---

## 9. Scheduled Jobs

| Job | Cron Expression | Configurable? | Parameters Used |
|-----|----------------|---------------|-----------------|
| Weekly Summary | `0 * * * *` (hourly check) | No (ignores SCHEDULER_CRON_EXPRESSION) | Per-user weekly_summary_day/hour |
| Weather Alerts | `0 * * * *` (hourly check) | No | global daily_weather_enabled/hour, per-user rain_alert_mm |
| Proactive Alerts | `0 * * * *` (hourly check) | No | Runs only at hour=8 (hardcoded) |

---

## 10. Security Observations

| Issue | Severity | Notes |
|-------|----------|-------|
| No dashboard authentication | **CRITICAL** | Anyone with the URL can access all admin functions, delete users, change settings |
| No rate limiting on dashboard API | MEDIUM | All endpoints are unprotected |
| User deletion is hard-delete | MEDIUM | Cascades across 18 tables, irreversible |
| Secret keys blocked from API | OK | 10 secret keys correctly blocked in SECRET_KEYS list |
| Admin audit log exists | OK | Tracks settings changes, user status changes, user creation/deletion |

---

## Appendix: Protected Secret Keys (blocked from dashboard API)

`OPENAI_API_KEY`, `WHISPER_API_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `VERIFY_TOKEN`, `OPENWEATHER_API_KEY`, `OPENAI_BASE_URL`, `WHISPER_API_BASE_URL`
