# Formularios estructurados

> Ago 2026: migración `105_form_sessions.sql`. Spec de diseño: `docs/superpowers/specs/2026-08-03-structured-forms-design.md`.
> Sep 2026: registro por formulario + 4 formularios nuevos.
> **Sep 2026 (28): formularios conversacionales por WhatsApp** (migración `125_form_sessions_conversation.sql`). Meta todavía no aprueba los WhatsApp Flows de la cuenta, así que WhatsApp completa el formulario **por chat**. Los Flows quedan intactos detrás de `WHATSAPP_FORM_PROVIDER`, listos para reactivarse.

Formularios para cargar datos de forma consistente, **complementando** el chat (no lo reemplazan). Hay seis, y todos salen de la **misma `FormDefinition`** y del **mismo submit**, sin importar cómo se presenten:

| Canal | Presentación | Dónde |
|---|---|---|
| Telegram / test-bot | Mini App web de pantalla única (`/form/:token`) | `frontend/src/pages/FormPage.tsx` |
| WhatsApp, **hoy** (`WHATSAPP_FORM_PROVIDER=conversation`, default) | **colector conversacional**: pregunta por chat lo que falta, con botones y listas, y muestra un resumen para confirmar | `src/forms/conversation/` |
| WhatsApp, **futuro** (`WHATSAPP_FORM_PROVIDER=meta_flow` + flow_id) | WhatsApp Flow de Meta | `src/forms/form-offer-meta-flow.ts` + `whatsapp-flow-generator.ts` |

| Acción | Se ofrece cuando… | Setting del Flow |
|---|---|---|
| `sow_crop` (siembra) | falta el cultivo | `WHATSAPP_FLOW_ID_SOW` |
| `harvest_crop` (cosecha) | falta el cultivo | `WHATSAPP_FLOW_ID_HARVEST` |
| `log_expense` (gasto) | arranca el flujo guiado (lote no encontrado / a elegir / sin categoría) | `WHATSAPP_FLOW_ID_EXPENSE` |
| `log_income` (ingreso) | ídem gasto | `WHATSAPP_FLOW_ID_INCOME` |
| `log_activity` (labor: fumigación, fertilización, labranza, riego) | el handler pide producto / lote / cantidad | `WHATSAPP_FLOW_ID_ACTIVITY` |
| `add_livestock` (alta de hacienda) | faltan cabezas o lote | `WHATSAPP_FLOW_ID_LIVESTOCK` |

A pedido: `formulario` muestra una **lista de 6**; `formulario de gasto` / `formulario siembra` / etc. van **directo** a ese formulario. En bulkMode se suprimen (invariante 7).

## Registro por formulario (Sep 2026)

Sumar un formulario es:
1. **Una entrada en `FORM_DEFINITIONS`** (`src/forms/form-definitions.ts`): `action`, `title`, `label` (para la oferta), `settingKey`, `plotFilter`, `fields`, `crossCheck`. El tipo `FormAction` vive en `src/types/index.ts`.
2. **Un builder en `src/forms/form-commands.ts`** (payload validado + referencias resueltas → comando del handler; puro) **y su entrada en `FORM_PERSISTS_TO`** (qué tablas prueban que se guardó; ver Submit).
3. **Su presentación conversacional** en `src/forms/conversation/presentation.ts`: la pregunta de cada campo, el emoji del resumen y si un opcional se ofrece.
4. **El handler que lo ofrece** emite `sideEffects.offerForm = { action, prefill }` con nombres del DOMINIO (`plotName`, `eventDate`, `amount`, `activityType`…). `form-prefill.ts` los traduce a las claves del form.
5. La setting `WHATSAPP_FLOW_ID_*` en `settings.service.js` (grupo bot), las filas del picker (`system.handler` + `CALLBACK_MAP` + `SYSTEM_COMMANDS`), el patrón de `formulario de X` en `parser.js` y el `commandToFeature` de `open_form_*`.

`form-registry.test.ts` y `conversation-form.test.ts` fallan si falta algo (invariante 2 aplicada a formularios).

**Fuentes de opciones** (`FormOptionSource`, resueltas por usuario en `form-options.ts`):
- `plots`;
- `crops`;
- `locations`: lotes `p:<id>` + campos enteros `f:<id>`;
- `livestock_locations`: lotes + corrales `c:<id>`;
- `expense_categories` / `income_categories`: las del usuario. Si no tiene, se **siembran** las por defecto en `user_categories` con `bootstrapDefaults`, que es el mismo catálogo contra el que matchea el handler;
- `livestock_categories`;
- `breeds`.

Las opciones fijas (`options`: moneda, tipo de labor, unidad de dosis) se hornean en el Flow JSON. `allowOther` agrega un texto acompañante `<key>_other` que gana sobre la opción (los tres renderers mandan la misma clave).

## Por qué

El chat es óptimo para lo corto y ambiguo. Pero siembra y cosecha tienen muchos campos opcionales (variedad, hectáreas parciales, cargas por camión con humedad y destinatario). Un formulario estructurado baja la fricción y evita idas y vueltas del pending, sin sacarle al usuario la opción de cargarlo por texto.

## Arquitectura

```
FormDefinition (reglas: required, tipos, min/max, opciones, crossCheck)   ← única
   ├─ Web renderer           FormPage.tsx                 (Telegram Mini App / browser)
   ├─ Conversation renderer  src/forms/conversation/*     (WhatsApp, HOY)
   └─ Meta Flow renderer     form-offer-meta-flow.ts + whatsapp-flow-generator.ts  (preservado, apagado)
   │
   └─ submitForm(token, payload)  ← ÚNICO camino de persistencia de los tres
        prepareSubmission: validar + ownership + allow-list + cultivo activo
        commit: claim atómico del token + routeCommand, en UNA transacción
```

De la `FormDefinition` salen el render web (`GET /api/forms/:token`), la validación server-side (`validateFormPayload` / `validateFieldValue`), el Flow JSON (`buildWhatsAppFlowJson`) y las preguntas del colector conversacional. **Nunca duplicar reglas de campos fuera de ahí.** `crossCheck` puede devolver `{ field, message }` (requerido condicional atribuido a un campo, ej. "producto obligatorio salvo riego"): el web y el Flow lo muestran como texto, el colector lo pregunta.

**Sesiones token-based** (`form_sessions`): el token **es** la autenticación. El submit entra por `DomainRouter.routeCommand`, que es el **mismo handler que el chat, sin IA**.

```
form_sessions(token PK, user_id, action, prefill JSONB, channel, channel_id,
              phone, had_pending, used_at, expires_at, created_at,
              mode web|flow|conversation, draft JSONB,                    -- 125
              status collecting|confirming|parked|submitted|cancelled,
              awaiting_field, updated_at)
```

- Web y Flow: token de 30 min, un solo uso.
- Conversacional: draft durable con vencimiento **deslizante** de `FORM_CONVERSATION_DRAFT_TTL_HOURS`, default 24 h desde la última respuesta.
- La purga diaria (`formSessionsCleanupTick`) borra las vencidas hace más de 7 días.

`phone` = clave interna de canal (telegram `tg_<chatId>`, testbot `testbot_<id>`, WhatsApp número). `lockKeyForSession` deriva de ahí la **misma** clave de lock que usan los controllers (`wa:` / `tg:` / `tb:`). Antes el submit lockeaba `session.phone` a secas y un POST del form web no se serializaba con el chat.

## Formulario conversacional (WhatsApp, hoy)

`src/forms/conversation/`:

| Archivo | Rol |
|---|---|
| `presentation.ts` | Cómo se pregunta: pregunta natural, emoji, `optional: 'offer' \| 'never'`, formato esperado (`hint`). Sin reglas de negocio. |
| `field-extractor.ts` | Extracción **determinística** de valores desde texto libre. No usa Claude. Reusa `normalizarMonto` / `extractAmount`, `detectarCategoria*`, `extractCropFromText`, `relative-dates`, `entity-matcher` (`mentionsEntityName`, invariante 3), `lexicon` (invariante 4) y `extractSlots`. |
| `renderer.ts` | Preguntas, resumen y menú Editar, respetando los límites de WhatsApp: hasta 3 botones con título ≤ 20, listas de hasta 10 filas con título ≤ 24. |
| `form-conversation.service.ts` | Estado: start / answer / park / resume / edit / cancel / confirm. |

**Estado.** El draft vive en `form_sessions` (`mode='conversation'`) y cada respuesta válida se persiste en el acto. El puntero de ruteo vive en `formConversationStore`: un `TypedPendingStore` de 30 min espejado en `pending_states` (invariante 10). Si el puntero se pierde (restart, TTL), el draft sigue en la DB y el usuario entra con «retomar».

**Qué se pregunta.** El orden es:
1. obligatorios que faltan;
2. requeridos condicionales del `crossCheck`;
3. opcionales con `optional:'offer'`, una sola vez y con botón "Omitir";
4. **pre-validación del submit** (`prepareSubmission`: ownership, allow-list, cultivo activo);
5. resumen.

Los demás opcionales NO se piden uno por uno: se agregan desde "✏️ Editar". "Me falta solamente X" cuando es el último. Un obligatorio no se puede omitir ("🙏 Monto es obligatorio…"). Lo que puso el sistema (fecha de hoy, moneda ARS, lote único) va en `draft.autoFilled`: se muestra en el resumen, lo pisa lo que diga el usuario ("…, ayer") y la fecha se recalcula si se retoma otro día.

**Varios datos en un mensaje.** Cada mensaje se prueba contra todos los campos vacíos: "Cargá $250.000 de combustible en el lote A1 de La Esperanza de hoy" llena cuatro de una.

Reglas anti-ruido:
- un número pelado solo responde la pregunta abierta;
- un importe sin pista de dinero no se toma si no se preguntó;
- un comando de consulta ("mis campos") solo matchea opciones exactas (`strict`).

**Consistencia campo ↔ lote.** "el A1 de San Martín", cuando el A1 es de La Esperanza, NO se toma: se explica y se re-pregunta. Dos lotes homónimos → se pregunta cuál, nunca se elige el primero.

**Convivencia con el pipeline** (rama en `processTextMessageInner`, antes del flow activo). Con puntero activo:
- `cancelar` → descarta;
- consulta (read-only) → se responde y se re-pregunta lo mismo;
- verbo de acción de OTRO dominio ("llovieron 20 mm") → **estaciona** con aviso ("💡 Dejé el gasto a medio cargar… *retomar*") y el mensaje sigue su curso;
- verbo del MISMO dominio ("gasté 200 lucas de gasoil") → es respuesta.

**Resumen, edición y confirmación.** Los botones son [✅ Confirmar] [✏️ Editar] [❌ Cancelar]:
- **Editar** abre una lista de campos con su valor y pregunta solo ese.
- En el resumen, el texto libre corrige ("no, el monto era 300 mil" → "✏️ Actualicé: Monto").
- **Confirmar** llama a `submitForm(token, draft, { deliver:'return', userId, alreadyLocked:true })`. `withUserLock` no es reentrante y el controller ya tiene el lock.

**Retomar / vencido.**
- `retomar` / `volvamos al gasto` / `seguir con el formulario` → comando regex `resume_form` → `sideEffects.resumeForm` → último draft vivo, con un recap corto.
- Iniciar un formulario con otro del mismo tipo a medio cargar → [↩️ Retomar] [🆕 Empezar de nuevo].
- Un draft vencido nunca se lee ni se confirma: "⌛ El formulario de gasto que empezaste venció y no guardé nada. ¿Empezamos uno nuevo?" con el botón [📝 Nuevo formulario]. No hay mensaje proactivo: fuera de la ventana de 24 h WhatsApp no lo permite.

**Taps `cform_<token8>_<verbo>`** (≤ 64 bytes).
- La sesión se busca solo entre las del usuario que tapeó (anti-IDOR).
- Un tap de opción solo responde la pregunta que lo mostró.
- Un botón viejo / ajeno / de un formulario ya confirmado responde "ya no está vigente" / "ya quedó registrado". Nunca silencio.

### Formulario vs flow de chat

Hay dos caminos para, por ejemplo, un gasto: el chat libre ("quiero registrar un gasto" → `expense_flow`, o el agente) y el formulario («formulario de gasto» → colector). Reglas:
- **Un solo colector activo por usuario.** Prioridad: **formulario > flow > pending > tarjeta de confirmación > agente**.
  - Si después de abrir el formulario arranca otro colector (p. ej. un tap viejo abre un flow), gana el más nuevo y el formulario se estaciona con aviso.
  - Pedir un formulario con un pending abierto aplica la política de pivot (`open_form_*` / `resume_form` están en `NEW_ACTION_WRITE_COMMANDS`).
- **Una oferta implícita** (`offerForm` sin `explicit`, el handler ya está preguntando) **no** abre el colector en WhatsApp: serían dos preguntas a la vez. Log `[FORM] offer implícita omitida (conversation)`.
- **Mismo resultado persistido**: los dos caminos terminan en el mismo handler. Hay un test de paridad (`pipeline.integration.test.ts`: el mismo gasto por formulario y por el agente deja la misma fila).
- Unificar `expense_flow` / `income_flow` con el colector queda como **deuda explícita**.

## Flujo de oferta (`offerForm`)

`appendFormOffer` (`src/forms/form-offer.ts`) según el canal:
- **Telegram / test-bot**: crea la sesión (`mode='web'`) y pushea un botón `web_app` a `${PUBLIC_URL}/form/<token>`. Sin `PUBLIC_URL` no se ofrece; si el usuario lo pidió, se le dice.
- **WhatsApp**: `resolveWhatsAppFormProvider(def)` (`form-provider.ts`):
  - `conversation` (default) → `startConversationForm`, solo si la oferta es explícita;
  - `meta_flow` + flow_id → `appendMetaFlowOffer`;
  - `meta_flow` sin flow_id → cae a `conversation` con log `[FORM] provider fallback`.
- **bulkMode (compound)**: `offerForm` se **suprime** en el `CompoundExecutor` (invariante 7). Log `[INTERCEPT] offerForm suprimido en bulkMode`.

## Submit (`submitForm`)

`src/forms/form-submit.service.ts`, el único camino de persistencia.

| status | caso |
|--------|------|
| **404** | token inválido / vencido / de otro usuario (`opts.userId`) |
| **409** | token ya usado → "✅ Eso ya quedó registrado. No lo dupliqué." · o había un pending al ofrecer el form y ya no está (se resolvió por chat) |
| **422** | validación, lote/campo/corral no accesible, opción fuera de la lista, cosecha sin cultivo activo, o el handler **no guardó** (trae `field` cuando se sabe qué dato pedir) — token **NO** consumido |
| **200** | registrado; `deliver:'chat'` (web/Flow) lo empuja al chat, `deliver:'return'` (colector) lo devuelve |

Detalles:
- **Idempotencia**: `formSessionService.claim(token)`, un UPDATE atómico `used_at IS NULL → NOW()`, corre **dentro de la misma transacción** (`withTransaction`) que `routeCommand`.
  - Doble tap, webhook reintentado, doble POST o `nfm_reply` duplicado: el segundo no reclama nada y NO escribe.
  - Si el handler rechaza, el ROLLBACK libera el token.
  - Antes se validaba fuera del lock y se marcaba usado al final, así que dos submits concurrentes escribían dos veces.
- **¿Se guardó de verdad?** Después de `routeCommand` se mira, en la misma transacción, qué tablas se escribieron (`pg_stat_xact_user_tables`) contra `FORM_PERSISTS_TO[action]`.
  - Un handler que contesta con una pregunta (picker de categoría, "¿en qué lote?") no es éxito aunque traiga texto.
  - Antes un tip pegado a la pregunta alcanzaba para quemar el token sin registro.
- **Ownership**: lote, campo y corral se validan con `accessibleFieldsSql`, la fuente única. Vale para el dueño y para los miembros de campos compartidos, igual que el chat. Antes era solo dueño mientras las opciones ofrecían también los compartidos.
- **Allow-list**: un select dinámico sin "otro" (categoría de hacienda, raza) tiene que estar en la lista de `computeFormOptions` de ESE usuario.
- Validación contra la `FormDefinition`:
  - obligatorios;
  - fecha **no futura** (invariante 12);
  - rangos;
  - `yield_kg` / `yield_kg_per_ha` excluyentes;
  - chofer y peso por carga.
- **Cosecha**: el crop es el **cultivo activo** del lote (nunca del form).
- Categoría escrita a mano ("Otro…") → `category_match:'new'`; elegida de la lista → `'exact'`.
- `confirm_before_save:false`: el formulario YA es la confirmación.
- Side-effects de éxito por `applySideEffects` (invariante 9). El pending puntual se limpia con `pendingActStore.clear` (invariante 15: NO `clearAllUserPendingState`).

Todo path loguea `[FORM]` (invariante 1).

## Frontend

`frontend/src/pages/FormPage.tsx`, ruta pública `/form/:token` (sin `ProtectedRoute`).
- Render 100% genérico desde la `FormDefinition` del GET, con `fetch` pelado.
- Mobile-first y Mini App-aware: `ready()/expand()`, y `close()` a los 1,8 s tras el éxito.
- `src/app.ts` sirve `/form/:token` antes del catch-all de la landing.

## WhatsApp Flows (preservado, apagado)

> **TODO / FUTURE: Meta Flow implementation retained for future activation.** Nada de esto se borró. Hoy no se usa porque `WHATSAPP_FORM_PROVIDER=conversation`.

`src/forms/whatsapp-flow-generator.ts` genera el Flow JSON v7.2 de una pantalla desde la misma `FormDefinition`. **Flows no tiene grupos repetibles**, así que el grupo `loads` se expande a **5 slots fijos opcionales** y `unflattenFlowPayload` los vuelve a `loads[]`. `allowOther` se rinde como un `TextInput` acompañante `<key>_other`.

Reglas del Flow JSON:
- El `complete` del Footer lleva `"${form.<campo>}"` por **cada** componente.
- El DatePicker usa `YYYY-MM-DD`.
- Cada `${data.x}` está declarado en el `data` del screen con `__example__`.

**Ida y vuelta**:
1. `appendMetaFlowOffer` (`form-offer-meta-flow.ts`) hornea opciones y prellenado en `flow_action_payload.data`.
2. `sendFlow` lo manda y el usuario lo completa.
3. Vuelve como `nfm_reply` en `whatsapp.controller.ts`.
4. `submitForm(flow_token, payload, { flowResponse: true, alreadyLocked: true })`: mismo path que los otros renderers.

Si Meta rechaza el envío (`139000 Blocked by Integrity`), no se cae a texto plano (`[FORM] flow no enviado (whatsapp)`). Regresión en `whatsapp-send-flow.test.ts`.

**Contrato de `mode` (setting `WHATSAPP_FLOW_MODE`, grupo bot, default `draft`)**: el envío incluye la clave `mode` **solo** cuando vale `draft` (Flow sin publicar → llega únicamente a los números de prueba de la app de Meta). Con `published` (o cualquier otro valor) la clave `mode` se **omite** del payload — Meta rechaza `mode: "published"`, no alcanza con mandarla vacía. `form-offer-meta-flow.ts` resuelve `mode` a `'draft' | undefined` y `sendFlow` la agrega con spread condicional. Al publicar el Flow en Meta, poner la setting en `published`. Regresiones: `whatsapp-send-flow-mode.test.ts` (la clave presente/ausente) + `form-offer.test.ts`.

**Dos guardas antes de enviar** (el Flow no abre en el celular si están mal): (1) un `<campo>_options` de un select **requerido** vacío (ej. alta de hacienda sin lotes ni corrales) → no se manda el Flow, se loguea `[FORM] skip offer... opciones vacías` y, si fue pedido explícito, se avisa por texto (un formulario que no se puede enviar es peor que ninguno); (2) `validateFlowData(def, data)` verifica que estén **todas** las claves del esquema del screen y que ningún valor sea `null`/numérico (deben ser string, o array `{id,title}` para los `*_options`) — falla ruidoso fuera de prod (`throw`), en prod loguea y no manda un Flow roto. Regresión: `whatsapp-flow-generator.test.ts` (`validateFlowData`).

### Reactivar WhatsApp Flows

1. Publicar: `npx tsx src/scripts/publish-whatsapp-flows.ts --publish --save-settings`. Guarda los `WHATSAPP_FLOW_ID_*`. Checklist en [docs/operations.md](../operations.md) § "WhatsApp — checklist de activación"; un Flow publicado es inmutable (`--recreate`).
2. En /admin (grupo bot): `WHATSAPP_FORM_PROVIDER = meta_flow` y `WHATSAPP_FLOW_MODE = published` (con `draft` solo llega a los números de prueba). Sin deploy; el caché de settings tarda ≤ 5 min.
3. Un formulario sin flow_id sigue por `conversation` automáticamente.

Limitaciones respecto del form web: hasta 5 cargas por formulario.

## Tests

- `form-definitions.test.ts`: validación (siembra/cosecha, fechas futuras, rinde excluyente, cargas).
- `conversation-form.test.ts`:
  - presentación completa por campo;
  - reglas compartidas;
  - extractor (varios datos, "200 lucas", números pelados, fechas, hacienda, labor, rinde, cargas, "otro");
  - consistencia campo↔lote y homónimos;
  - no pisar lo cargado;
  - lexicon (omitir / cancelar / dominio);
  - renderer (límites de WhatsApp, resumen, Editar).
- `form-offer.test.ts`:
  - Telegram web_app, sin PUBLIC_URL;
  - WhatsApp `meta_flow` + flow_id → Flow (preservado);
  - oferta implícita omitida;
  - `conversation` explícito → colector;
  - `meta_flow` sin flow_id → fallback;
  - `resumeForm`.
- `form-submit.service.test.ts`:
  - 404/409/422/200, cultivo activo, loads;
  - `nfm_reply` (y duplicado);
  - **claim concurrente** (una sola escritura);
  - token de otro usuario, id manipulado, ubicación ajena;
  - opción fuera de la lista;
  - handler que contesta con pregunta → 422 + `field`;
  - `category_match`;
  - ownership por `field_members`;
  - `lockKeyForSession`.
- `form-registry.test.ts`:
  - settings + picker + `SYSTEM_COMMANDS`;
  - `WHATSAPP_FORM_PROVIDER` / TTL;
  - gate de los 6 `open_form_*`;
  - `resume_form`;
  - `FORM_PERSISTS_TO`;
  - Flow JSON válido.
- `whatsapp-flow-generator.test.ts`, `whatsapp-send-flow.test.ts`, `forms.routes.test.ts`, `form-prefill.test.ts`, `form-session.service.test.ts`: sin cambios de semántica.
- `pipeline.integration.test.ts`:
  - § "formularios estructurados": offerForm con el flujo guiado, submits reales.
  - § "formulario conversacional por WhatsApp (sin Meta Flows)":
    - paso a paso → 1 gasto sin agente;
    - varios datos en un mensaje;
    - doble Confirmar → 1 gasto;
    - obligatorio no omitible, opcional sí;
    - consulta en el medio;
    - cambio de tema + «volvamos al gasto»;
    - draft durable sin puntero;
    - lote de otro campo;
    - Editar y corrección libre;
    - Cancelar;
    - vencido;
    - fecha auto recalculada;
    - tap ajeno;
    - siembra;
    - retomar vs empezar de nuevo;
    - **paridad con el chat**.
