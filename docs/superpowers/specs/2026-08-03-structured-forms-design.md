# Formularios estructurados para siembra y cosecha (Telegram Mini App + WhatsApp Flows)

**Fecha:** 2026-08-03
**Estado:** Aprobado en brainstorming, pendiente de plan de implementación

## Objetivo

Ofrecer un formulario de pantalla única para que el usuario cargue los datos de una
siembra o una cosecha de manera consistente, como **complemento** del chat conversacional
(nunca como reemplazo): si el mensaje ya trae los datos obligatorios se registra directo
como hoy; el formulario se ofrece como botón cuando faltan datos y a pedido explícito.

**Alcance v1:** `sow_crop` y `harvest_crop`. La arquitectura queda genérica
(`FormDefinition` por acción) para sumar más acciones después.

**Canales:** Telegram completo ahora (Mini App). WhatsApp queda con el esqueleto de
Flows preparado pero sin activar, hasta que exista el número definitivo de prod.

## Decisiones tomadas (con el usuario)

1. **Alcance**: solo siembra y cosecha en v1.
2. **Gatillo**: el formulario complementa el chat — se ofrece cuando faltan datos
   (junto a la pregunta del pending) y a pedido ("formulario siembra"). Nunca es
   obligatorio.
3. **WhatsApp**: implementar Telegram end-to-end; de WhatsApp solo la abstracción +
   esqueleto del Flow + handler del webhook, dark hasta el número definitivo.
4. **Cosecha**: resumen + **cargas por camión opcionales** (grupo repetible en el form).

## Arquitectura

### Piezas nuevas

1. **Tabla `form_sessions`** (migración nueva): `token` (random 128-bit), `user_id`,
   `action` (`sow_crop` | `harvest_crop`), `prefill` (JSONB: lote/fecha/etc. ya
   conocidos), `channel` + chat id de origen (para la confirmación), `pending_ref`
   (referencia al pendingActivity asociado, si lo hay), `expires_at` (TTL 30 min),
   `used_at` (un solo uso), `created_at`. Mismo patrón token-based que `/api/map/:token`.

2. **`src/forms/form-definitions.ts`** — fuente única de verdad: un `FormDefinition`
   por acción declara campos, tipos (select / date / number / text / grupo repetible),
   obligatorios y validaciones. De acá salen: el render del form React, la validación
   server-side del submit, y a futuro el Flow JSON de WhatsApp. Nunca dos definiciones
   que puedan divergir (mismo espíritu que invariantes 3 y 4: una sola fuente).

3. **`src/services/form-session.service.ts`** — crea/valida/consume sesiones.

4. **Rutas `GET/POST /api/forms/:token`** (`src/routes/forms.routes.ts`) — sin JWT:
   el token ES la autenticación. `GET` devuelve definición + prefill + opciones del
   usuario (campos/lotes, cultivo activo por lote). `POST` valida y ejecuta.

5. **Página `/form/:token`** en el frontend React existente — ruta pública nueva,
   mobile-first, servida por Express igual que `/login` (agregar al set de rutas SPA
   en `src/app.ts`). En Telegram se abre como Mini App (botón `web_app`); detecta
   `Telegram.WebApp` para cerrarse sola tras el éxito, y fuera de Telegram muestra
   pantalla de éxito.

6. **Soporte de botones `web_app`** en `sendTelegramButtons` (`src/services/telegram.ts`)
   — hoy solo arma `callback_data`; los items de botón ganan un campo opcional de URL
   web_app.

### Flujo completo (caso típico)

```
Usuario: "sembré en el lote norte"          (falta el cultivo)
  → handler emite setPendingActivity({missing:['crop']}) + sideEffect offerForm
  → pipeline crea form_session y agrega botón "📝 Completar con formulario"
Usuario toca el botón → Mini App con lote y fecha pre-llenados
  → completa cultivo (+ hectáreas/variedad) → Enviar
POST /api/forms/:token → valida → user-lock → DomainRouter.routeCommand
  → mismo handler de siempre → confirmación en el CHAT
  → Mini App muestra ✅ y se cierra → pending relacionado consumido
```

A demanda: comando trivial `open_form` ("formulario siembra" / "formulario cosecha" /
"formulario" → menú de las dos) — regex trivial anclado, sin IA.

El submit **no pasa por el agente**: va directo al router con datos estructurados —
cero costo de IA, determinístico, reusa handler/validaciones/confirmaciones.

## Formularios campo por campo

### Siembra (`sow_crop`)

| Campo | Tipo | Oblig. | Detalle |
|---|---|---|---|
| Lote | Select agrupado por campo | Sí | Pre-seleccionado si vino del chat o si hay 1 solo lote |
| Cultivo | Select (de `src/utils/crops.ts`) + "Otro" texto libre | Sí | Nunca inferido (invariante 13) — acá lo elige explícitamente |
| Fecha | Date picker, default hoy | Sí | Sin fechas futuras (plan futuro ≠ registro, invariante 12) |
| Hectáreas | Número | No | Siembra parcial; valida contra superficie del lote si la tiene |
| Variedad | Texto | No | Va al detalle del evento |

### Cosecha (`harvest_crop`)

| Campo | Tipo | Oblig. | Detalle |
|---|---|---|---|
| Lote | Select (solo lotes con cultivo activo) | Sí | Muestra el cultivo activo read-only — no se puede cosechar otra cosa |
| Fecha | Date picker, default hoy | Sí | |
| Rinde | Toggle "kg/ha" / "total" + número | No* | Excluyentes (`yield_kg_per_ha` vs `yield_kg`); el handler computa el total |
| Humedad % | Número 0–50 | No | Mismo CHECK que `harvest_loads` |
| Cargas | Grupo repetible "+ Agregar carga" | No | Por carga: chofer (oblig.), peso kg (oblig.), destinatario (opc.), humedad % (opc.) |

\* Si manda rinde Y cargas, las cargas mandan (igual que por chat). Un submit sin rinde
ni cargas registra la cosecha igual; el form lo avisa con texto suave, no bloquea.

Decisiones de detalle validadas:
- Lotes sin cultivo activo **no aparecen** en el select de cosecha (prevenir el error
  en el origen).
- El select de cultivo es cerrado + "Otro" con texto libre.

## Integración con el pipeline e invariantes

### Oferta del botón (lado bot)

- El handler de sow/harvest **no cambia su lógica**: sigue emitiendo
  `setPendingActivity({missing[]})`. Lo nuevo es un side effect adicional
  `offerForm: {action, prefill}` que viaja por `applySideEffects` (invariante 9).
  El pipeline, al renderizar, crea la `form_session` y agrega el botón web_app.
- Comando trivial nuevo `open_form`: regex trivial en intent-classifier +
  `*_COMMANDS` en router + switch del handler (invariante 2; no necesita tool del
  agente por ser trivial pre-IA, como "menú").
- **En bulkMode nunca se ofrece formulario** — `offerForm` se suprime igual que los
  `setPending*` (contrato compound: nunca frenar a mitad, invariante 7).

### Submit (lado form)

1. `POST /api/forms/:token` valida token (vivo, no usado, del usuario) y payload
   contra el `FormDefinition` — la validación del cliente es solo UX.
2. Adquiere el **lock por usuario** (`user-lock.ts`): el submit serializa con los
   mensajes de chat del mismo usuario.
3. Construye el comando estructurado y lo rutea por `DomainRouter.routeCommand` con
   un `ChannelContext` sintetizado (mismo patrón que el test-bot controller).
4. La confirmación del handler se manda **al chat de origen** vía el sender del canal
   guardado en la sesión. La Mini App muestra "✅ Registrado" y se cierra.
5. **El token se marca usado solo si el handler tuvo éxito** — si falla, el form
   muestra el error y permite reintentar. Un solo uso = idempotencia ante double-submit.
6. **Limpieza del pending relacionado**: el submit consume el `pendingActivity`
   asociado (el formulario ES la respuesta a esa pregunta). Se limpia ese pending
   puntual vía su store — NO `clearAllUserPendingState` (eso es para resets totales,
   invariante 15).

### Caso borde: resolución por chat con el form abierto

Al crear la sesión se guarda el `pending_ref`. Si al submit ese pending ya no existe
(se resolvió por otra vía), el submit rebota con "⚠️ Esto ya se registró por el chat"
— salvo que el form se haya pedido explícitamente sin pending previo ("formulario
siembra"), en cuyo caso registra normal.

## Errores

- Token vencido/usado → página amigable: "Este formulario venció. Pedime otro en el
  chat con «formulario siembra»." Nunca JSON crudo ni 500 pelado.
- Handler falla en el submit (ej. lote borrado entre medio) → el form muestra el
  mensaje de error del handler (ya es texto humano en español) y permite corregir;
  el token sigue vivo.
- Toda sesión creada, usada, vencida o rebotada **loguea su path**
  (`[FORM] created/submitted/expired/rejected`) — invariante 1.

## Seguridad

- Token 128-bit random, TTL 30 min, un solo uso, atado a `user_id`; el GET solo
  devuelve lotes/cultivos de ESE usuario. Sin JWT a propósito: la Mini App no
  comparte sesión con el dashboard.
- Validación server-side completa contra el `FormDefinition` (tipos, rangos, que el
  lote sea del usuario). Rate limit con el middleware de `limits` existente.
- Feature gate `agronomy` (el mismo de sow/harvest): si el plan no lo tiene, el
  botón no se ofrece.
- Validación de `initData` de Telegram: **diferida** (se puede sumar después sin
  romper nada; el token alcanza).

## Testing

- **Unit**: `form-definitions` (payloads buenos/malos, cargas repetibles, rinde
  excluyente) + `form-session.service` (TTL, un uso, scoping por usuario).
- **Integración** en `pipeline.integration.test.ts` (invariante 14): `offerForm`
  aparece con missing[], se suprime en bulkMode, y el caso borde "se resolvió por
  chat antes del submit".
- **HTTP**: GET/POST con token válido/vencido/ajeno, siguiendo el patrón de tests
  de rutas existente.
- **Eval**: sin escenario nuevo (el submit no toca IA). Verificar que el regex
  trivial `formulario` no robe mensajes como "el formulario de AFIP…" — regex
  anclado, como `pizarra`.

## Esqueleto de WhatsApp (dark)

- Interfaz `FormChannelAdapter` con dos implementaciones:
  - `telegram-mini-app` — completa.
  - `whatsapp-flow` — esqueleto: generador de Flow JSON desde el mismo
    `FormDefinition` (limitación conocida: cargas = hasta 5 slots fijos, Flows no
    tiene grupos repetibles) + branch `nfm_reply` en el webhook de WhatsApp que
    mapea la respuesta del Flow al MISMO path de submit.
- Sin activar hasta el número definitivo. Pendiente para ese momento: publicar el
  Flow en Meta Business Manager, configurar el `flow_id` en settings, y firmar
  `data_exchange` si se usa endpoint dinámico.
- Mientras tanto, el mismo form web puede ofrecerse en WhatsApp vía botón CTA-URL
  si se quisiera (fuera de alcance de la v1).

## Fuera de alcance (explícito)

- Formularios para otras acciones (fumigación, gastos, hacienda, etc.) — la
  arquitectura lo permite, pero no se shippean en v1.
- Validación de `initData` de Telegram (enfoque C).
- Flow de WhatsApp activo end-to-end.
- Edición de registros existentes vía formulario.
