# Operations & Deployment

## Railway Deploy

Deployed at `campo-bot-production.up.railway.app`.

**Push to `main` auto-deploys via GitHub Actions** (`.github/workflows/deploy.yml`):
1. **Tests** — `npm ci && npm test` (must pass)
2. **Railway deploy** — `railway up --detach` against the `campo-bot` service
3. **Smoke test** — polls `/api/health` for up to 10 min until `sha` matches `github.sha`. Fails the run if the new commit doesn't go live.

Required GitHub secrets:
- `RAILWAY_TOKEN` — Railway CLI auth
- `LANDING_REPO_TOKEN` — fine-grained PAT with `Contents: Read` on `juanmitriatti/campo-chat-bot`, used to clone the private `landing/` submodule during checkout

The smoke test relies on `/api/health` returning the running SHA. Resolution at boot (`src/app.ts`):
1. `process.env.RAILWAY_GIT_COMMIT_SHA` (only set with Railway's native GitHub integration — not used here)
2. Fallback: `.deploy-sha` file written by CI before `railway up`. **Do NOT add `.deploy-sha` to `.gitignore`** — `railway up` respects gitignore and would exclude the file from upload.
3. `null` otherwise

Manual deploy fallback (e.g. CI bypassed):
```bash
railway up --detach
```

The Dockerfile builds both the frontend (`frontend/dist/`) and the landing page (`landing/dist/`, git submodule). No separate build step needed.

Useful commands:
```bash
railway status --json | grep createdAt    # When did the latest deploy land?
railway logs --deployment | tail -N        # Runtime logs
railway logs --build | tail -N             # Build logs
curl https://campo-bot-production.up.railway.app/api/health   # What SHA is live?
```

## Docker Local Dev

```bash
docker compose up --build          # App + PostgreSQL (DB port 5433, app port 3000)
docker compose up -d db            # Start only DB
docker compose down && docker compose build --no-cache && docker compose up -d  # Full rebuild
```

DB credentials: user=`campo`, db=`campo_bot`, port 5433 (host) / 5432 (container).

Frontend dev server (separate from Docker):
```bash
cd frontend && npm run dev         # Port 5173, proxies API to :3000
cd frontend && npm run build       # Production build → frontend/dist/
```

## Migrations

Auto-run on app startup via `bootstrap()` in `src/app.ts` → `runMigrations()`. Tracked in `schema_migrations` table. All idempotent (`IF NOT EXISTS` / conditional `DO` blocks).

```bash
npx tsx src/scripts/run-migrations.ts   # Manual run
```

Set `RUN_MIGRATIONS_ON_START=false` to disable (e.g., unit tests).

Files: `src/migrations/001-074_*.sql`

## Environment Variables

Required in `.env`:
- `DATABASE_URL` — PostgreSQL connection string
- `ANTHROPIC_API_KEY` — Claude API key
- `OPENAI_API_KEY` — Whisper audio transcription
- `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `VERIFY_TOKEN` — WhatsApp Cloud API
- `TELEGRAM_BOT_TOKEN` — Telegram Bot API
- `OPENWEATHER_API_KEY` — Weather forecasts
- `JWT_SECRET` — Auth token signing

Optional:
- `TELEGRAM_WEBHOOK_SECRET` — Webhook verification
- `APP_URL` — Map URL generation (auto-derived from `RAILWAY_PUBLIC_DOMAIN` on Railway)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — Web push notifications (generate via `npx web-push generate-vapid-keys`)
- `VAPID_SUBJECT` — Push notification contact (default: `mailto:admin@campobot.com`)

## AI Agent Settings

Configurable via admin dashboard → `ai` group:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `AGENT_ENABLED` | bool | `false` | `true` = tool_use agent, `false` = JSON extraction |
| `AGENT_MODEL` | string | `claude-haiku-4-5-20251001` | Model for agent |
| `AGENT_MAX_TOKENS` | number | `400` | Max output tokens |
| `AGENT_TIMEOUT_MS` | number | `8000` | Timeout in ms |
| `AGENT_TEMPERATURE` | number | `0` | Temperature (0 = deterministic) |

## Flow Reminder Settings

Configurable via admin dashboard → `bot` group:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `FLOW_TIMEOUT_MS` | number | `600000` | Flow timeout (ms). 300000=5min, 600000=10min |
| `FLOW_TIMEOUT_NOTIFICATION_ENABLED` | bool | `true` | Notify user on flow expiry |
| `FLOW_HALFLIFE_WARNING_ENABLED` | bool | `true` | Send "seguís ahí?" mid-flow ping |
| `FLOW_HALFLIFE_WARNING_MS` | number | `300000` | Time before half-life reminder (ms) |
| `MONTHLY_SUMMARY_HOUR` | number | `8` | Hour (0-23 Argentina TZ) to send monthly summary |

## Scheduler Jobs

| Schedule | Job | Description |
|----------|-----|-------------|
| Mon 8AM | `weeklyTick` | Enhanced weekly summary (expenses, incomes, vs previous week, active campaigns) |
| 1st of month (configurable hour) | `monthlyTick` | Monthly summary (vs previous month, top categories, rainfall, activities) |
| Hourly (8AM gate) | `proactiveAlertsTick` | Monitoring, pest escalation, hectares reminders, low stock, phenology alerts |
| Daily 7AM | `expenseTemplateTick` | Process recurring expense templates (create expenses, advance next_run_date) |
| Daily (configurable) | `dailyAlertsTick` | Weather alerts, rain forecasts |
| Every minute | `flowReminderTick` | Expired flow notifications, half-life warnings |
| Daily 3AM | `cleanupTick` | Old conversation state cleanup |

## Telegram Webhook Setup

```bash
npx tsx src/scripts/setup-telegram-webhook.ts    # Register webhook URL
npx tsx src/scripts/delete-telegram-webhook.ts   # Remove webhook
```

User store key: `tg_${chatId}`. Users provisioned on first contact via `getOrCreateUserByTelegramId()`.

## Useful Scripts

```bash
npx tsx src/scripts/create-admin.ts --email <e> --name <n> --password <p>
npx tsx src/scripts/seed-dummy-data.ts --user-id <id> [--reset]
npx web-push generate-vapid-keys   # Generate VAPID keys for push notifications
```
