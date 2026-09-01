# Planes, prueba y cobro

Cómo se vende Campo Bot hoy, dónde vive cada decisión y qué tocar para cambiarla.
El relato de los bugs que llevaron a esto está en
[docs/history/2026-hardening-log.md](../history/2026-hardening-log.md).

## El modelo

1. **Prueba de 14 días con todo desbloqueado**, sin tarjeta. Se otorga en el
   registro (`AuthService.register` → `SubscriptionService.createTrialIfMissing`)
   y solo si `PAYMENTS_ENABLED`. El plan de la prueba lo define
   `TRIAL_PLAN_NAME` (default `pro_plus`, el único que incluye compartir campo).
2. **Al vencer no queda un plan gratis usable**: el usuario baja a `free` y el
   access-gate lo pasa a `trial_expired_readonly` (bot cortado salvo triviales,
   dashboard detrás del paywall). `free` es el destino del downgrade, no un
   producto — por eso `is_public = false` y no aparece en la landing.
3. **La escalera es por COMPARTIR CAMPO, no por registrar datos**:

   | Plan | Precio | Qué incluye |
   |---|---|---|
   | Pro | $5.000/mes | Todo el producto EXCEPTO compartir campo |
   | Pro+ | $12.000/mes · $100.000/año | Todo, incluido compartir campo (`sharing`) |
   | Dedicado (`enterprise`) | a medida | Todo + multi-usuario, integraciones, onboarding |

   Los precios son los sembrados; la fuente de verdad es la tabla `plans`,
   editable desde **/admin → Planes**.

   > Pro y Pro+ se separan por una sola feature. Lo que además los distingue son
   > los límites diarios (`daily_ai_limit` 100 vs 300, `daily_document_limit`
   > 10 vs 25), que por eso se muestran en las cards. Si mañana la diferencia
   > deja de justificar 2,4× de precio, el corte se cambia desde el admin — no
   > hay nada hardcodeado.

## Una sola fuente para "qué se vende y a cuánto"

`src/domain/billing/plan-catalog.service.ts` (`getPlanCatalog`) es la ÚNICA
lista comercial. La consumen:

- `GET /api/plans/public` → la sección Planes de la landing
  (`landing/src/components/Pricing.tsx`, con fallback propio si el fetch falla).
- `GET /api/auth/subscription` → el paywall del dashboard y la tarjeta de
  Mi cuenta.

**No agregar una segunda lista de planes en ningún lado.** Si la landing y el
checkout sacaran los precios de fuentes distintas, la página prometería un
número y el cobro haría otro.

Qué expone cada plan lo decide el admin (migración 108):

| Columna | Efecto |
|---|---|
| `is_public` | aparece como card en la landing y en el paywall |
| `is_featured` | badge "MÁS ELEGIDO" — índice único parcial: **uno solo** |
| `custom_pricing` | precio "A medida" + CTA de contacto en vez de checkout |

El catálogo se cachea 60s en memoria; el `PUT /admin/api/plans/:id` invalida el
caché (sin eso, el admin cambia un precio, no lo ve, y lo vuelve a cambiar).

## Qué pasa cuando vence

`src/services/access-gate.service.ts` resuelve el modo en runtime leyendo
`subscriptions` — no depende del cron, así que una prueba que vence a las 02:00
queda cortada a las 02:00:01 y no a las 03:15. Usuarios sin fila de
`subscriptions` son grandfathered a `full`.

- **Bot**: solo los comandos de `EXPIRED_ALLOWED_COMMANDS` (costo cero y
  read-only, incluido `show_plan`). Todo lo demás responde `trialExpiredCopy()`.
- **Dashboard**: `PaywallModal` sobre el board borroso. Se exceptúa **Mi
  cuenta**: ahí viven el checkout, exportar datos y eliminar la cuenta —
  bloquearla dejaría al usuario encerrado sin poder pagar ni llevarse lo suyo.
  Si `payments_enabled` está en false no se levanta el paywall: no habría nada
  que ofrecerle.
- **Cron** (`sweepExpired`, 03:15 AR): marca `expired` y baja el plan a `free`.

## Trampas conocidas (no repetirlas)

- **`getActiveForUser` filtra estados vivos.** `getStatus` cae a
  `getLatestForUser` justamente para devolver la fila vencida: sin eso, el
  frontend recibía `subscription: null` + `plan: null` y escondía el botón de
  pago **en el único momento en que el usuario entra a pagar**. Los estados
  `expired`/`cancelled` del banner del Resumen eran código muerto por lo mismo.
- **La condición del CTA se escribe por exclusión, no por enumeración**: se
  ofrecen planes salvo que la suscripción esté `active`. Enumerar los estados
  "que pueden pagar" ya dejó afuera a `expired` y `cancelled` una vez.
- **El `name` del plan es la clave, el `display_name` es copy.** "Dedicado" es
  el `display_name` de `enterprise`; renombrar el `name` rompería el
  feature-gate, el checkout y el admin.
- **El plan de la prueba no es "tu plan" una vez vencida**: el paywall no marca
  ninguna card como actual.

## Settings (grupo `payments`, salvo aclaración)

| Setting | Qué hace |
|---|---|
| `PAYMENTS_ENABLED` | kill switch: sin esto no se crean pruebas ni se ofrece checkout ni paywall |
| `TRIAL_DAYS` | duración de la prueba (0 = sin prueba). Solo afecta registros nuevos |
| `TRIAL_PLAN_NAME` | plan que se otorga durante la prueba |
| `PAST_DUE_GRACE_DAYS` | días de gracia antes de cancelar un pago rebotado |
| `MP_ACCESS_TOKEN` / `MP_WEBHOOK_SECRET` | credenciales de MercadoPago |
| `SUPPORT_CONTACT` (grupo `system`) | contacto que muestran el bot y el CTA del plan a medida |
| `TRIAL_DRIP_*` (grupo `bot`) | mensajes proactivos durante la prueba (días 2/5/8/11) |

## Cambiar un precio

1. **/admin → Planes** → editar mensual/anual del plan.
2. Listo: la landing y el paywall lo toman en ≤60s. **No** se toca código, ni
   el repo de la landing, ni hace falta deploy.

Para cambiar qué planes se muestran o cuál va destacado, los toggles
"Landing" de esa misma pantalla.
