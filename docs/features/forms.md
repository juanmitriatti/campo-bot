# Formularios estructurados

> Ago 2026, migración `105_form_sessions.sql`. Spec de diseño: `docs/superpowers/specs/2026-08-03-structured-forms-design.md`. Sep 2026: registro por formulario + 4 formularios nuevos.

Formulario de **pantalla única** para cargar datos de forma consistente, **complementando** el chat (no lo reemplaza). Se abre como **Telegram Mini App** o como **WhatsApp Flow** (mismo `FormDefinition`, mismo submit). Seis formularios:

| Acción | Se ofrece cuando… | Setting del Flow |
|---|---|---|
| `sow_crop` (siembra) | falta el cultivo | `WHATSAPP_FLOW_ID_SOW` |
| `harvest_crop` (cosecha) | falta el cultivo | `WHATSAPP_FLOW_ID_HARVEST` |
| `log_expense` (gasto) | arranca el flujo guiado (lote no encontrado / a elegir / sin categoría) | `WHATSAPP_FLOW_ID_EXPENSE` |
| `log_income` (ingreso) | ídem gasto | `WHATSAPP_FLOW_ID_INCOME` |
| `log_activity` (labor: fumigación, fertilización, labranza, riego) | el handler pide producto / lote / cantidad | `WHATSAPP_FLOW_ID_ACTIVITY` |
| `add_livestock` (alta de hacienda) | faltan cabezas o lote | `WHATSAPP_FLOW_ID_LIVESTOCK` |

Siempre además del pending o flujo de chat, nunca en lugar de. Todos a pedido con `formulario` (lista de 6; `formulario gasto` también). Suprimidos en bulkMode (invariante 7).

## Registro por formulario (Sep 2026)

Sumar un formulario tocaba seis archivos. Ahora es:
1. **Una entrada en `FORM_DEFINITIONS`** (`src/forms/form-definitions.ts`): `action`, `title`, `label` (para la oferta), `settingKey`, `plotFilter`, `fields`, `crossCheck`. El tipo `FormAction` vive en `src/types/index.ts`.
2. **Un builder en `src/forms/form-commands.ts`**: payload validado + referencias resueltas → comando del handler. Puro; la DB la toca solo `form-submit`.
3. **El handler que lo ofrece** emite `sideEffects.offerForm = { action, prefill }` con nombres del DOMINIO (`plotName`, `eventDate`, `amount`, `activityType`…); `form-prefill.ts` traduce a claves del form.
4. La setting `WHATSAPP_FLOW_ID_*` en `settings.service.js` (grupo bot) y las filas del picker (`system.handler` + `CALLBACK_MAP` + `SYSTEM_COMMANDS`).

`src/forms/__tests__/form-registry.test.ts` falla si alguno falta (invariante 2 aplicada a formularios).

**Fuentes de opciones** (`FormOptionSource`, resueltas por usuario en `form-options.ts`): `plots`, `crops`, `locations` (lotes `p:<id>` + campos enteros `f:<id>`), `livestock_locations` (lotes + corrales `c:<id>`), `expense_categories` / `income_categories` (las del usuario; defaults si no tiene), `livestock_categories`, `breeds`. Opciones fijas (`options`: moneda, tipo de labor, unidad de dosis) se hornean en el Flow JSON. `allowOther` agrega un texto acompañante `<key>_other` que gana sobre la opción (web y Flow mandan la misma clave; la validación lo unifica).

El submit fuerza `confirm_before_save: false`: el formulario YA es la confirmación (con los botones de "¿confirmás?" el submit daba éxito sin guardar).

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

## WhatsApp Flows

`src/forms/whatsapp-flow-generator.ts` genera el Flow JSON v7.2 de una pantalla desde la misma `FormDefinition`, y es la fuente ÚNICA de la convención de slots: **Flows no tiene grupos repetibles** → el grupo `loads` se expande a **5 slots fijos opcionales** (`loads_1_driver_name` … `loads_5_weight_kg`) al generar, y `unflattenFlowPayload(def, payload)` los vuelve a `loads[]` al recibir (descarta slots vacíos y claves ajenas como `flow_token`).

Tres cosas que el Flow JSON tiene que cumplir y que la v1 dark no cumplía (nunca se había probado contra Meta):
- El `complete` del Footer lleva `"${form.<campo>}"` por **cada** componente — es literalmente lo que vuelve en `nfm_reply.response_json`. Con payload `{}` el submit recibía un formulario vacío.
- El DatePicker usa `YYYY-MM-DD` (Flow JSON ≥5.0) para `init-value` y para lo que devuelve. Con epoch ms el campo quedaba vacío.
- Cada `${data.x}` referenciado está declarado en el `data` del screen con `__example__`; sin eso Meta no valida.

Ida y vuelta: `appendFormOffer` (gateado por `WHATSAPP_FLOW_ID_*`) hornea opciones + prellenado en `flow_action_payload.data` → `sendFlow` → el usuario completa → `nfm_reply` en `whatsapp.controller.ts` → `submitForm(flow_token, payload, { flowResponse: true })` (re-arma grupos, log `[FORM] flow payload re-armado`) → mismo path que la Mini App.

**Si Meta rechaza el envío del Flow** (ej. `139000 Blocked by Integrity` hasta verificar la empresa — también en modo `draft`, probado el 6 sep 2026), `sendBotResponse` NO cae al texto plano como con los demás interactivos: "cargá el gasto con un formulario" sin botón es una promesa vacía. Loguea `[FORM] flow no enviado (whatsapp)` con el detalle de Meta y sigue con los demás ítems (la pregunta del chat ya salió). Regresión: `src/controllers/__tests__/whatsapp-send-flow.test.ts`.

**Activación y publicación**: `src/scripts/publish-whatsapp-flows.ts` (crea/actualiza/valida/publica contra la Graph API y guarda los `flow_id` en settings). Checklist completo en [docs/operations.md](../operations.md) § "WhatsApp — checklist de activación". Un Flow publicado es inmutable: cambiar la `FormDefinition` implica `--recreate`.

Limitaciones respecto del form web: el Dropdown de cultivo no admite "otro" (`allowOther` no tiene equivalente en Flows) y las cargas son 5 por formulario.

## Tests

- `src/forms/__tests__/form-definitions.test.ts` — validación (siembra/cosecha, fechas futuras, rinde excluyente, cargas).
- `src/forms/__tests__/form-offer.test.ts` — oferta, skip WA, skip sin PUBLIC_URL.
- `src/forms/__tests__/form-submit.service.test.ts` — 404/409/422/200, crop de cultivo activo, loads.
- `src/routes/__tests__/forms.routes.test.ts` — GET (filtra lotes sin cultivo en cosecha) + POST.
- `src/forms/__tests__/whatsapp-flow-generator.test.ts` — mapeo de componentes + 5 slots, payload del `complete` por cada componente, fecha ISO, `unflattenFlowPayload`.
- `src/forms/__tests__/form-registry.test.ts` — cada formulario registrado en settings + picker + `SYSTEM_COMMANDS`; cada Flow con todo `${data.x}` declarado; validación y builders de gasto/ingreso/labor/hacienda; opciones fijas inline y `<key>_other`.
- `pipeline.integration.test.ts` § formularios — gasto con 2 lotes ofrece el form junto al flujo guiado; submit de labor y de gasto a nivel campo entran por el handler real y persisten.
- `src/testing/integration/__tests__/pipeline.integration.test.ts` — regresiones (invariante 14): offerForm acompaña al pending, supresión en bulk, stale pending → 409.
