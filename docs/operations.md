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
| `AGENT_MAX_TOKENS` | number | `1500` | Max output tokens |
| `AGENT_TIMEOUT_MS` | number | `12000` | Presupuesto TOTAL en ms, incluidos los 2 reintentos del SDK |
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

## WhatsApp — checklist de activación

**Estado (5 sep 2026):** el número real **+54 9 11 7819-9790** está registrado en Cloud API
(`phone_number_id` 1374438695743094, WABA "Agro bot" 1889814245322180, app `campo-bot`
1623899791990036 **publicada**, webhook `messages` suscripto). Se migró desde la app
WhatsApp Business del teléfono borrando la cuenta: **Coexistence no está disponible sin un
Solution Partner/Tech Provider con Embedded Signup**, así que el número es solo del bot. El
token es permanente (Usuario del sistema, sin vencimiento). Flows de siembra/cosecha
publicados el mismo día (ids en settings grupo `bot`). Lo que sigue son los pasos por si
hay que rehacerlo. La activación tiene **dos capas**: (A) el canal WhatsApp base (Cloud
API) y (B) los Formularios por WhatsApp Flows.

### A) Canal WhatsApp base (Cloud API) — prerequisito de todo

1. **Número dedicado**: chip prepago dedicado (recomendado); NO puede estar registrado en la
   app de WhatsApp normal.
2. **Verificar el negocio** en Business Manager (puede ir en paralelo; sin verificar el límite
   es 250 conversaciones iniciadas por el negocio/día).
3. **Alta del número** en developers.facebook.com → app → WhatsApp → API Setup (verificación
   SMS/llamada) → anotar el **Phone Number ID**.
4. **Token permanente** vía *Usuario del sistema* (rol Admin) con permisos
   `whatsapp_business_messaging` + `whatsapp_business_management`, expiración "Nunca".
5. **Webhook**: `https://campo-bot-production.up.railway.app/webhook` + `VERIFY_TOKEN`
   (ya está en Railway), suscribir el campo `messages`, app en modo Live.
6. **Variables** en Railway (y local): `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`
   (`VERIFY_TOKEN` ya existe). Redeploy y probar end-to-end un mensaje de texto ida/vuelta.

Con esto anda todo el bot conversacional por WhatsApp. Un `sow_crop`/`harvest_crop` sin
cultivo cae al flujo de pending/texto ("🌱 ¿Qué cultivo sembraste?"), que funciona en los
3 canales — **los Formularios (Flows) son un extra, no un bloqueante.**

### B) Formularios por WhatsApp Flows (código COMPLETO, falta solo config de Meta)

Estado del código (todo hecho — activar es puro config):
- ✅ `src/forms/whatsapp-flow-generator.ts` — genera el Flow JSON desde la misma
  `FormDefinition` (endpointless: las opciones dinámicas de lote/cultivo se inyectan como
  `data` del screen al enviar, screen terminal → **no** hace falta endpoint público ni
  claves RSA de Flow).
- ✅ Entrada `nfm_reply` en `whatsapp.controller.ts` — parsea la respuesta del Flow y la
  mete por el mismo `submitForm` que la Mini App (usa `flow_token` = token de sesión del form).
- ✅ Envío saliente: `appendFormOffer` (`src/forms/form-offer.ts`) hornea las opciones con
  `computeFormOptions` (`src/forms/form-options.ts`, la MISMA fuente que el form web) en
  `flow_action_payload.data` y emite un `BotResponseItem` tipo `flow`; `sendFlow` en
  `src/services/whatsapp.js` lo manda por la Cloud API. **Gateado por el `flow_id`**: sin
  setting, loguea `[FORM] skip offer (whatsapp): <KEY> vacío` y sigue dark.

Pasos de activación (Sep 2026 — un script, sin pegar JSON a mano):
1. **Token con `whatsapp_business_management`** (además de `_messaging`). El token temporal
   de "API Setup" vence a las 24 hs — el `.env` local tenía uno vencido desde el 22/08/2026.
   Usar el token permanente del *Usuario del sistema* (paso A.4). `WHATSAPP_WABA_ID` en env
   es opcional: el script lo detecta por el token y elige el WABA que contiene
   `WHATSAPP_PHONE_NUMBER_ID`.
2. `npx tsx src/scripts/publish-whatsapp-flows.ts` — crea (o actualiza el draft de) un Flow
   por cada `FormDefinition` en el WABA, sube el Flow JSON de `buildWhatsAppFlowJson(def)`
   y **imprime los `validation_errors` de Meta** (con path). Con `--dump <dir>` solo escribe
   los JSON (sin token), para pegarlos en WhatsApp Manager → Flows si se prefiere la UI.
3. Probar el draft: `WHATSAPP_FLOW_MODE=draft` en settings (grupo `bot`) + pegar el `flow_id`
   del draft en `WHATSAPP_FLOW_ID_SOW`/`_HARVEST`. En modo `draft` el Flow **solo llega a
   los números de prueba de la app** — con un usuario real el envío falla. Tocar "Abrir
   formulario", completar: el `nfm_reply` entra por el mismo `submitForm` que la Mini App
   (log `[FORM] flow payload re-armado`).
4. `... --publish --save-settings` — publica los que validan y guarda los `flow_id` en
   settings (`WHATSAPP_FLOW_ID_SOW`, `WHATSAPP_FLOW_ID_HARVEST`; el bot los toma en ≤5 min).
   Volver `WHATSAPP_FLOW_MODE` a `published`.
   **Gate de Meta (5 sep 2026):** publicar un Flow devuelve `Blocked by Integrity`
   (code 139000/4233020) hasta que la empresa esté **verificada** (Business Manager →
   Autorizaciones y verificaciones) **o** el número acumule "mensajes de alta calidad"
   (barra de conversaciones iniciadas / 30 días en WhatsApp Manager → Flows → Publicar).
   Los 6 drafts ya están creados y validan sin errores (6 sep 2026): siembra
   1340112071244360, cosecha 1368168561671652, gasto 1378034054484390, ingreso
   879160111794551, labor 1330233078973920, hacienda 944223028085227. Con la
   verificación aprobada, correr el paso 4 y listo.
   Mientras tanto el bot funciona por chat sin formularios (el gate por `flow_id` vacío
   loguea `[FORM] skip offer (whatsapp)`).
5. **Un Flow publicado es inmutable**: al cambiar una `FormDefinition` correr con
   `--recreate` (crea un Flow nuevo con el mismo nombre → nuevo `flow_id` → `--save-settings`).

Lo que se arregló al activar (la v1 "dark" nunca se había probado contra Meta): el
`complete` del Footer iba con payload vacío (el `nfm_reply` traía solo el `flow_token`),
la fecha se mandaba como epoch ms (Flow JSON ≥5.0 usa `YYYY-MM-DD`) y los 5 slots de
cargas nunca se re-armaban en `loads[]` (`unflattenFlowPayload`, mismo archivo que los
aplana). Limitaciones que quedan: el Dropdown de cultivo no admite "otro" (el form web sí)
y las cargas son 5 como máximo por formulario (el chat no tiene tope).

### Gotchas transversales (aplican al canal, no solo a Flows)

- **Ventana de 24 hs de Meta (CRÍTICO para alertas)**: los mensajes iniciados por el bot
  fuera de las 24 hs desde el último mensaje del usuario requieren **plantillas aprobadas**
  (template messages). Afecta directamente a: alertas proactivas (clima/monitoreo/plagas/
  stock/fenología), resúmenes semanales/mensuales, recordatorios de labores y el drip del
  trial. En Telegram nada de esto aplica — por eso los envíos hoy son Telegram-first.
  Antes de anunciar WhatsApp: crear y aprobar plantillas para cada tipo de envío proactivo,
  o restringir esos envíos a usuarios con Telegram vinculado.
- **Pricing por conversación**: Meta cobra por ventana de conversación iniciada por el
  negocio — cada alerta proactiva fuera de ventana abre una conversación paga. Presupuestar
  antes de prender `PROACTIVE_ALERTS_ENABLED` para usuarios WhatsApp-only.
- **Rate limits de Cloud API**: el tier inicial limita conversaciones iniciadas por el
  negocio por día (arranca en 250/día y escala con la calidad del número). Con el piloto en
  Telegram esto no aplica; revisar tier antes de campañas por WhatsApp.

## Useful Scripts

```bash
npx tsx src/scripts/create-admin.ts --email <e> --name <n> --password <p>
npx tsx src/scripts/seed-dummy-data.ts --user-id <id> [--reset]
npx web-push generate-vapid-keys   # Generate VAPID keys for push notifications
```
