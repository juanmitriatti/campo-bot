# Formularios estructurados (siembra / cosecha)

> Ago 2026, migración `105_form_sessions.sql`. Spec de diseño: `docs/superpowers/specs/2026-08-03-structured-forms-design.md`.

Formulario de **pantalla única** para cargar siembras y cosechas de forma consistente, **complementando** el chat (no lo reemplaza). Hoy se abre como **Telegram Mini App**; el camino de **WhatsApp Flows** está implementado pero **dark** (esperando número de WhatsApp en prod).

## Por qué

El chat es óptimo para lo corto y ambiguo, pero siembra/cosecha tienen muchos campos opcionales (variedad, hectáreas parciales, cargas por camión con humedad/destinatario). Un form estructurado baja la fricción y evita idas y vueltas del pending sin sacarle al usuario la opción de cargarlo por texto.

## Arquitectura

**Fuente única de verdad**: `src/forms/form-definitions.ts` (`FORM_DEFINITIONS`). De la misma `FormDefinition` salen:
1. el render del form React (`GET /api/forms/:token`),
2. la validación server-side del submit (`validateFormPayload`),
3. el Flow JSON de WhatsApp (`buildWhatsAppFlowJson`).

Nunca duplicar reglas de campos fuera de ahí.

**Sesiones token-based** (`form_sessions`, patrón `map_tokens`): el token de la URL **es** la autenticación (corta vida = 30 min, un solo uso, atado al usuario). Sin sesión de dashboard. El submit entra por `DomainRouter.routeCommand` con `withUserLock` — **mismo handler que el chat, cero IA**. El token de un solo uso da idempotencia.

```
form_sessions(token PK, user_id, action, prefill JSONB, channel, channel_id,
              phone, had_pending, used_at, expires_at, created_at)
```
`plot_crops.variety` (TEXT) se agregó en la misma migración: la variedad la carga el form.

`phone` = clave interna de canal (telegram `tg_<chatId>`, testbot `testbot_<id>`, WhatsApp número) — se usa para el lock por usuario y los pending stores al momento del submit. `channel_id` telegram = chatId pelado.

## Flujo de oferta (`offerForm`)

Cuando un handler de `sow_crop`/`harvest_crop` no tiene cultivo, además del pending `missing:['crop']` emite el sideEffect `offerForm: { action, prefill }` (invariante 9 — via `applySideEffects`). `appendFormOffer` (`src/forms/form-offer.ts`) crea la sesión y pushea un item interactivo con un botón `web_app` (Telegram Mini App) apuntando a `${PUBLIC_URL}/form/<token>`.

- **WhatsApp**: el botón `web_app` se omite con log `[FORM] skip web_app button (whatsapp v1)` (v1 no ofrece form por WA).
- **Sin `PUBLIC_URL`**: no se ofrece, se loguea el skip.
- **bulkMode (compound)**: `offerForm` se **suprime** en el interceptor del `CompoundExecutor` (invariante 7 — en compound nunca se ofrecen formularios). Log `[INTERCEPT] offerForm suprimido en bulkMode`.

También hay un **comando trivial** `formulario` / `formulario siembra` / `formulario de cosecha` (regex anclado en `parser.js`) que muestra un picker de 2 botones (🌱 Siembra / 🌾 Cosecha). v1: un tap extra aunque nombre la acción (simplificación deliberada para no depender de extracción de args en el parser trivial).

## Submit (`submitForm`)

`src/forms/form-submit.service.ts`. Reglas de resultado:

| status | caso |
|--------|------|
| **404** | token inválido / vencido / usado |
| **409** | había un pending al ofrecer el form y ya no está → se resolvió por chat. **No se duplica**; se cierra el token. |
| **422** | validación falló, lote ajeno/inexistente, cosecha sin cultivo activo, o el handler no confirmó (pending / mensaje `❌`) — token **NO** consumido |
| **200** | registrado; la confirmación se envía al chat (Telegram/WhatsApp) y el token se marca usado |

Detalles:
- La validación server-side (`validateFormPayload`) corre contra la `FormDefinition`: obligatorios, fecha **no futura** (invariante 12), rangos numéricos, humedad 0-50%, `yield_kg` y `yield_kg_per_ha` excluyentes, chofer+peso por carga.
- El lote se re-valida por dueño (`loadUserPlot`, scoped a `user_id`).
- **Cosecha**: el crop se toma del **cultivo activo** del lote (nunca del form) — sin cultivo activo → 422.
- Éxito con side effects legítimos (ej. botones de cierre de campaña tras cosecha) se aplican por la vía canónica (`applySideEffects`); v1 no reenvía esos botones al chat.
- El pending puntual se limpia con `pendingActStore.clear` (invariante 15: NO se toca `clearAllUserPendingState` — es UN pending, no "borrar todo el estado").

Todo path loguea con prefijo `[FORM]` (invariante 1).

## Frontend

`frontend/src/pages/FormPage.tsx`, ruta pública `/form/:token` (sin `ProtectedRoute`). Render 100% genérico desde la `FormDefinition` del GET — con `fetch` pelado (no `apiRequest`, que metería el JWT del dashboard). Mobile-first, Mini App-aware: `window.Telegram.WebApp.ready()/expand()`, y tras el éxito `close()` a los 1.8s. El SDK de Telegram se carga global en `frontend/index.html`.

`src/app.ts` sirve `/form/:token` con el `index.html` del build de React **antes** del catch-all de la landing.

## WhatsApp Flows (dark)

`src/forms/whatsapp-flow-generator.ts` genera el Flow JSON v7.2 de una pantalla desde la misma `FormDefinition`. **Limitación conocida**: Flows no tiene grupos repetibles → el grupo `loads` se expande a **5 slots fijos opcionales** (`loads_1_driver_name` … `loads_5_weight_kg`).

El branch `nfm_reply` en `src/controllers/whatsapp.controller.ts` extrae `flow_token` del `response_json` y lo trata como token de `form_sessions` → `submitForm` (mismo path que la Mini App). Hoy **nunca se envían Flows**; el branch solo loguea si llega algo.

### Checklist de activación de WhatsApp Flows (cuando llegue el número)

1. Publicar el Flow en Meta Business Manager (usar el JSON de `buildWhatsAppFlowJson`).
2. Guardar el `flow_id` en settings (grupo `bot`).
3. Enviar el Flow (interactive `flow`) con `flow_token` = token de `form_sessions` y las opciones dinámicas (lotes/cultivos) como data del screen.
4. Verificar el ida y vuelta con `nfm_reply` → `submitForm`.
5. Quitar el skip de `offerForm`/botón `web_app` para WhatsApp.

## Tests

- `src/forms/__tests__/form-definitions.test.ts` — validación (siembra/cosecha, fechas futuras, rinde excluyente, cargas).
- `src/forms/__tests__/form-offer.test.ts` — oferta, skip WA, skip sin PUBLIC_URL.
- `src/forms/__tests__/form-submit.service.test.ts` — 404/409/422/200, crop de cultivo activo, loads.
- `src/routes/__tests__/forms.routes.test.ts` — GET (filtra lotes sin cultivo en cosecha) + POST.
- `src/forms/__tests__/whatsapp-flow-generator.test.ts` — mapeo de componentes + 5 slots.
- `src/testing/integration/__tests__/pipeline.integration.test.ts` — regresiones (invariante 14): offerForm acompaña al pending, supresión en bulk, stale pending → 409.
