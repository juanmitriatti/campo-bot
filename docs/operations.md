# Operations & Deployment

## Railway Deploy

Deployed at `campo-bot-production.up.railway.app`.

**Railway does NOT auto-deploy on `git push`.** After pushing to main, run manually:
```bash
railway up --detach
```

The Dockerfile builds the frontend (`npm run build` → `frontend/dist/`). No separate build step needed.

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

Files: `src/migrations/001-060_*.sql`

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
```
