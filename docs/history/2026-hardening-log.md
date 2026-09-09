# Historial de hardening 2026

Relatos completos de los bugs de producción/QA que motivaron las reglas del CLAUDE.md. El CLAUDE.md conserva la regla + una línea de porqué; acá vive el contexto completo (qué pasó, cómo se detectó, qué se cambió). Ordenado por subsistema.

---

## Hacienda (livestock)

### add_livestock sin lote (Jun 2026)
El agente preguntaba el lote vía `respond_text` → pregunta huérfana: la respuesta "lote norte" se la robaba el bypass trivial como `plot_info` y se perdía. Fix: el agente llama la tool igual omitiendo plot/corral y el handler pregunta con pending real. Backstop determinístico: `reconstructFromOpenLocationQuestion` en intent-classifier — si la última respuesta del bot (<5 min) fue "¿en qué lote...?" sin pending y el usuario contesta "lote X" a secas, se reconstruye "`<msg original>` en lote X" y se re-clasifica.

### Lote vs Feedlot determinístico (Jul 2026)
El `respond_text` huérfano que el agente usaba para la ubicación era NO determinístico: mismas palabras → a veces lote, a veces feedlot. Fix: cuando `add_livestock` viene sin plot ni corral, el handler consulta `livestockLocationIntent(originalText)` (`src/utils/livestock-location-intent.ts`): `ambiguo` → botones **[🌾 En un lote] [🏗️ En un feedlot]** (`lv_loc_lote_*`/`lv_loc_feedlot_*`, payload en `callbackPayloadStore`); `feedlot` explícito → `placeLivestockInFeedlot` directo. El feedlot se resuelve/crea solo: 0 feedlots → autocrea `Feedlot <campo>` + corral `'1'` (el formatter agrega el prefijo "Corral "); 1 corral → lo usa; 2+ → botones de corral (`lv_loc_corralpick_*`). Tap "En un lote" → re-corre con `__forcePlotPath`. Skip cuando `_bulkMode`/`__forcePlotPath`/`__resolved*Id`. Regla de prompt: ubicación ambigua NO es dato de negocio faltante → llamar la tool omitiendo plot/corral, NUNCA preguntar por texto.

### Precio diferido — set_livestock_price (Jun 2026)
Cuando add/remove preguntaba "¿a cuánto fue la compra/venta?" como texto suelto, la respuesta iba al agente a ciegas y Haiku la mapeaba a `edit_last_expense` — **corrompió un gasto ajeno en vivo**. Este bug parió la regla general "ninguna pregunta puede ser texto suelto". Fix: pending machine-readable `{command:'set_livestock_price', data:{movementId, kind}, missing:['unit_price']}`; `attachPriceToMovement` crea el gasto/ingreso vinculado a ESE movimiento. Jun 12: además es TOOL del agente (98ª) para el precio tardío SIN pending ("los toros me salieron 2 millones por cabeza") — auto-resuelve al último movimiento entrada/salida sin registro financiero (7 días, filtro categoría/kind, `findLatestUnpricedMovement`; ojo: castear enum→text en SQL). Complementos del mismo bug: (a) una consulta read-only (`isReadOnlyQuery` en conversation-guards) durante un pending con `missing[]` se responde Y el pending se restaura + re-ask — paridad con taps; (b) `routeCommand` null (tool alucinada tipo `edit_last_livestock`) NUNCA silencia: log `ROUTER NULL` + fallback amigable.

### Gemelas de género — GENDER_TWIN (Jun 2026)
"Desteté 40 terneros" con "terneras" registradas resolvía 0 grupos (el masculino genérico del campo). Fix: `findGroupsByCategory` matchea ternero↔ternera. Cuando el lookup da 0 pero hay hacienda, el error lista el inventario real ("Tenés: 40 terneras (Sur)...") para auto-corrección.

### Memoria conversacional de hacienda
"Ahí mismo" tras una operación de hacienda resolvía al lote equivocado porque el lote venía del grupo sin pasar por plotDiscovery. Fix: los 9 write paths de hacienda llaman `bumpConversationContext` (alimenta `context_stack`).

---

## Pendings

### Escalera de escalamiento (Jul 2026) — historia de origen
Loop de prod: "Me falta el lote. ¿Me lo decís?" × 3. El usuario contestó "En otro lote" → se consumió como nombre → el handler re-seteó el pending CON el valor no resuelto en `data` → el cálculo de slots vacíos lo veía lleno → ni una respuesta válida podía llenarlo. De ahí los 3 niveles centrales (ver CLAUDE.md § Escalera). Regresiones en `pipeline.integration.test.ts` ("escalera de escalamiento").

### Serial pending queue — hotfix 58ae007 (May 23)
Cuando un compound dejaba 2+ ítems con follow-up, el diseño anterior solo cableaba el PRIMER partial y la única respuesta del usuario se aplicaba a TODOS ("vendí 2 vacas y compré glifosato" → "Lote A2 y precio 100mil" → vacas Y glifosato con 100k cada uno). Dos fixes críticos en `58ae007`:
1. `pending-action-processor.ts:69` tenía un `const missing` duplicado (línea 55 ya lo declaraba) que rompía en silencio el transform de tsx/esbuild → TODA respuesta multi-turn devolvía 500. Bug pre-existente.
2. Al re-rutear un queue item de `log_income`/`log_expense`, el ParsedCommand mergeado NO llevaba `command` (los partials lo guardan en el pending, no en `data`) → `routeCommand(undefined)` → null → drop silencioso de datos. Fix: `if (!merged.command) merged.command = pendingAct.command;` antes de routeCommand.
Además: los 9 write-sites de `setPendingActivity` copian `nextInQueue` (si no, la cola se perdía al re-setear).

### TTL de pendings (Jul 2026)
TTL de pending-activities subido de 5 a 30 min: la respuesta a los 6 minutos iba al agente a ciegas.

### Stock deduction falso (Jul 2026)
Los 3 Maps pelados (stock_entry, stock_deduction, campaign_close) no sobrevivían restarts — causa del "📤 Stock descontado." falso. Migrados a `TypedPendingStore` (contrato único).

---

## Compound / bulkMode

### Mapper bugfix crítico (May 23)
El filtro de `agent-response-mapper.ts` que dropea `log_expense`/`log_income` espurios cuando hay actividad agro hermana era demasiado agresivo: solo chequeaba `input.amount > 0` y dropeaba calls con `quantity+unit_price` (que el mapper auto-computa después). Un compound de 4 tools perdía el income → `bulkMode=false` → el gasto disparaba el flow de lote single-action → **0 writes**. Fix: conservar también cuando `qty>0 && unit_price>0`. Fue el killer silencioso de muchos tests.

### add_field en bulk
Onboarding compounds ("Tengo el campo X en Y, lotes A,B...") se trababan: el `field_flow` bloqueaba las tools siguientes que dependían del campo. Fix: en `_bulkMode` con ciudad ambigua/faltante, crear el campo YA (primer match del lookup o sin ciudad).

### Reglas de prompt wired al compound (agent-prompt-builder)
COMPLETITUD EN MENSAJES LARGOS (contar verbos, una tool por verbo, ejemplos de 4 y 5 tools), COMPOUND CON UN ÍTEM SIN PRECIO (regla de proximidad: un precio aplica SOLO al ítem inmediatamente anterior), EXCEPCIÓN COMPOUND en ANTI-HALLUCINACIÓN (nunca consolidar asks en un respond_text), ONBOARDING DECLARATIVO ("Tengo el campo X" fuerza add_field + add_plots_batch + actividad en un turno), HECTÁREAS POR LOTE (lista heterogénea → array alineado), MAÍZ vs MANÍ (Haiku mapeaba "maiz" sin tilde a "Maní").

---

## Memoria conversacional (May 27 — la tríada)

Antes del fix, las categorías memoria_corto / memoria_largo / context_switch / contradiction del QA senior regresionaron TODAS a la vez. Causa raíz común: resolución de pronombres dejada al agente. La tríada que lo arregló:

1. **Pronoun-expander** (`src/utils/pronoun-expander.ts`): reescritura server-side de "ahí mismo / ese lote / el de antes" → "en lote X" ANTES de que el agente vea el mensaje. El prompt ya tenía la regla pero Haiku la aplicaba inconsistentemente (a veces emitía `plot="ahi mismo"` que nunca resuelve). Hacerlo determinístico eliminó la varianza. Jun 2026: + "el otro lote" → segundo lote del `context_stack` (lazy lookup; "el otro día" temporal excluido).
2. **`userExplicitlyReferencedPlot`** (`utils/plot-intent.ts`): `handleExpense` tenía la regla "categoría corporativa sin plotName del agente → strip del plot auto-resuelto", pero era demasiado agresiva — cuando el usuario referenció el lote vía pronombre o por nombre, el plot igual se stripeaba y se guardaba a nivel campo en silencio (P01/P02 en QA). Ahora la regla honra el intent explícito.
3. **Query actualiza conversation_state**: "cuánto gasté en lote Amarillo" no dejaba rastro en `context_stack`, y el siguiente pronombre resolvía al lote del ÚLTIMO WRITE — conflación de contextos (P02).

**Acoplamiento crítico descubierto acá**: el `agent-output-validator` una vez vetó el lote que nuestro propio expander inyectó — de ahí el invariante "validar contra el texto EXPANDIDO (`agentInputText`), no el original".

### Relative dates (May 27 + Jun 2026)
`resolveRelativeDate` nació porque el agente olvidaba `event_date` en frases casuales ("ayer pagué..."). Jun 2026: `FUTURE_INTENT_RE` suprime la resolución de día-de-semana/finde — "el sábado cosecho" es un plan, NO se registra el sábado pasado; "pasado" explícito siempre gana. El mapper OVERRIDE la fecha del agente cuando hay frase relativa/día nombrado (el agente aterrizaba weekdays +1).

### Pending-correction interceptor (May 27)
"No, era en sueldos" a mitad de confirmación llegaba al agente, que respondía un inútil "¿qué lote corrijo?" (CR02 en QA de regresión). Fix: el pipeline intercepta patrones de corrección ANTES de clasificar cuando hay pending expense/income — patch in-place + re-render de la confirmación, sin round-trip al agente.

---

## Interceptores y observabilidad (Jun 2026)

La ronda de live-testing de Jun 2026 encontró **5 bugs de producción cuya raíz común era intercepción silenciosa** — un plot vetado, un gasto dropeado, una respuesta tragada eran indistinguibles de "nunca pasó". De ahí el invariante "toda capa que intercepta loguea". Fixes de la misma ronda:
- `COMPOUND_ACTION_PATTERN` acepta `y`/`e`/`,`/`;` como separadores — "fumigué lote norte, después registrá 50mil" ya no se cuela al bypass trivial.
- `NON_ANSWER_RE` en single-slot fallback: "después te digo" / preguntas con "?" no se toman como valor de slot.
- `normalizeToKg` acepta `t`/`ton` como tonelada (antes defaulteaba a kg — error silencioso ÷1000).
- Audio: un webhook retry de un audio lento duplicó una tropa ("320 madres" creó el rodeo dos veces) → `MessageDedup` time-windowed (10-min TTL).

---

## Flow taps fuera de paso — "Producto: norte" (Ago 2026)

Primer test desde cero del usuario real: tras registrar una siembra, tocó las sugerencias post-acción y arrancó el flow de actividad. El tap [Norte] del paso lote se procesó **dos veces** (los logs de Railway muestran `INTERACTIVE: flow_plot_norte` duplicado; timestamp = minuto exacto de un deploy → overlap de contenedores; el `MessageDedup` y el `user-lock` son in-process y no cubren duplicados con ids distintos — misma limitación single-replica documentada). La primera entrega consumió "norte" como lote y avanzó el flow (estado en DB, compartido); la segunda cayó en el paso *producto*, cuyo `validate` acepta cualquier texto → confirmación "Tipo: Fumigación, Lote: Norte, **Producto: norte**".

Raíz: el callback lleva la intención de slot en el prefijo (`flow_plot_*` = "esto responde LOTE") pero el pipeline lo reducía a texto plano y lo alimentaba al paso activo, cualquiera fuera. Fix: `FLOW_TAP_EXPECTED_FIELDS` (prefijo → fields válidos) + `getCurrentStepField()` en conversation-engine; tap fuera de paso se ignora con log `[INTERCEPT]` (invariante 1). La defensa cubre las 3 fuentes de duplicados de una (doble tap, retry, deploy). Regresión TDD en `pipeline.integration.test.ts` reproduciendo la secuencia exacta. Detalle de diagnóstico: la cascada no estaba en `conversation_logs` (los callbacks no se loguean ahí) — la evidencia salió de los logs de Railway.

Había **8 implementaciones divergentes** de normalización de nombres. Consecuencias reales: pérdida de datos ("El Bajo"→"Bajo") y aliases rotos ("Ñandú" con acento al escribir, sin acento al leer). Fix: `src/utils/entity-matcher.ts` como única fuente (`sqlNormalizedName` + espejo JS con test de paridad JS↔SQL), consumido por getPlotByName/findPlotByNameAcrossFields/getOrCreatePlot/getFieldByName/findPlotByAlias/plot-discovery/agent-output-validator/financial.handler.

---

## Corrección de lote tras hacienda — "deberían ir al norte" movió una siembra (Ago 2026)

Test desde cero del usuario real: cargó 30 vacas ("Tengo 30 vacas" → adjust_livestock, al lote Sur por contexto) y corrigió: "En realidad, deberían ir al lote norte". El agente mapeó la corrección a `edit_last_activity(new_plot)` — la última ACTIVIDAD agrícola era la siembra de maíz de una campaña YA CERRADA en Sur. El handler la movió a Norte y `syncPlotCropFromEdit` arrastró la campaña cerrada entera; la cosecha quedó en Sur. Historial inconsistente en 2 tablas y las vacas nunca se movieron.

Fix en tres capas: (1) guard determinístico en el handler — corrección de SOLO ubicación sin nombrar actividad + hacienda más reciente que la actividad → redirige a "pasá las vacas al lote X" con log `[INTERCEPT]`, no edita; (2) guard de campaña cerrada — cambio de lote sobre actividad con `plot_crop_id` de campaña cerrada se bloquea con explicación (mover historial archivado = corrupción); (3) regla de prompt (CORRECCIÓN DE UBICACIÓN TRAS HACIENDA → transfer_livestock). El control de regresión verifica que la corrección legítima (usuario nombra "la siembra", campaña activa) sigue moviendo campaña+evento coherentemente. Datos del usuario reparados a mano. Lección: `[acciones ejecutadas]` en el historial no alcanzó para que Haiku eligiera bien — otra confirmación de que las reglas de intención van respaldadas por guard server-side.

## Ronda de agentes QA (Ago 2026) — 2 P0 + 9 P1 en un día

Dos agentes LLM ("Raúl" agricultor / "Marta" ganadera) corrieron primeros días completos contra prod vía el canal test-bot (cuentas reales, rol admin temporal). Hallazgos → fixes → re-verificación por los mismos agentes (10/13 FIXED en la primera pasada; los 3 restantes cerrados con su raíz real en la segunda). Los que dejaron cicatriz:

- **Distributivo "en cada lote" (P0)**: cadena de 3 capas — el agente expandía BIEN a 2 tools, el output-validator stripeaba ambos lotes (no literales en el texto), las tools quedaban idénticas y el dedup del compound las colapsaba a UNA → mitad de las bajas perdidas en silencio. Fix: `hasCollectiveReference` en el validator (referencia colectiva legítima) + expansión determinística en recordDeath para el caso single-tool. Lección: una pérdida silenciosa puede ser la COMPOSICIÓN de tres capas cada una razonable por sí sola.
- **Filtro fantasma en sanidad (P0)**: query_health/repro/weighings heredaban lote del contexto y NEGABAN registros existentes — port del patrón 11e54b9.
- **Escape numérico del pending (raíz de 2 "parciales")**: "las 95" contestando "¿A cuántos animales?" escapaba por detectsFinancialIntent al agente, que INVENTÓ el conteo (13, sacado del historial). El guard anti-escape solo cubría slots financieros → generalizado a todo slot numérico.
- **Escala de montos**: "no, eran 350" tras $200.000 → $350 literal. `inheritAmountScale` (interceptor + edits).
- **5 copias de fmtDay** con `new Date()` pelado → DATE de medianoche UTC retrocedía un día en ART → centralizadas en `formatDayShortAR`.
- **Weekday futuro**: el agente aterriza "el sábado" +1 también en recordatorios → la resolución server pisa el due_date del agente (mismo patrón que relative-dates pasado).

## Test de fuego secuencial + batch estado-en-vuelo (Ago 2026)

Tras el batch del barrido, 3 agentes secuenciales (harness endurecido: token inline por request — la ronda paralela anterior colisionó tokens en archivos temporales compartidos e inventó un falso "split-brain") dieron **GO-CON-RESERVAS unánime**: libro mayor de hacienda 118/118, agro 100% consistente, finanzas al centavo. Las reservas eran todas de "estado en vuelo" y se cerraron con raíz real:

- **Card consolidada mentirosa (P0)**: `consolidateLivestockMessages` fabricaba la card desde los INTENTS — un compound nacimiento+muerte con la baja fallida mostraba "➖ 2 Vaca" sin baja real. Ahora ante cualquier marca de error se muestran los mensajes reales.
- **"y era en el Oeste" mid-confirmación** editaba un registro guardado ajeno → corrección de lote patcheada en el pending.
- **"sí, confirmo" destructivo por texto** → "Listo" sin borrar → ahora rutea el comando igual que el botón.
- **Writes parseables escapan SIEMPRE del pending** ("llovieron 15mm" durante el pending de precio se perdía).
- **Botón vencido con pending vivo** → red de rescate que re-ofrece el registro.
- **"metí" no disparaba la oferta mover-vs-alta**: `\b` final tras vocal acentuada — SEGUNDA vez que muerde este pitfall (primera: "ahí"). Regla: verbos conjugados con tilde SIEMPRE con lookahead.
- Extras: getBudget case-insensitive (la alerta de presupuesto nunca disparaba), stripAnswerPrefix pela "del", fechas de confirmación via formatDateAR, duración mínima "1 día".

**Incidente créditos (Ago 2026)**: dos días de QA intensivo agotaron el saldo de Anthropic — y prod comparte la key con local → bot degradado a regex en prod hasta la recarga. El síntoma en eval: fallos masivos con el MENÚ como respuesta (la firma documentada). Pendiente: key separada QA/prod + alerta de saldo. Flaky conocido nuevo: `19-category-ambiguous` oscila con la rotación diaria de few-shots (Haiku a veces asigna "Otros" directo sin picker — sin pérdida de datos).

## Eval y QA

### Eval degradado (Jul 26)
Eval cayó 13/25: el `conversation_lock` sobrevivía al `/reset` (lista manual de stores desactualizada). Fix: registro central de stores + `clearAllUserPendingState` (`76b3cd3`). Regla: todo "borrar estado de usuario" pasa por ese helper. Eval volvió a 25/25.

### Drift de asserts (Jun 10)
10 escenarios tenían asserts drifteados (eventType "sow"/"spray" vs DB "planting"/"spraying", el category picker pasó a lista, las confirm cards muestran categoría, "Junín" se volvió ambiguo en el censo de localidades). Corregidos — el eval volvió a ser señal útil.

### El 1 fail estable
Tanto el eval como qa-prod-regression-v2 quedan en 24-25/25 con 1 outlier de no-determinismo LLM: regla de proximidad de precios ("vendí A y B a $X") y categorización de "flete" (a veces "Otros", a veces pregunta).

### Bugs históricos que encontraron las suites
- qa-serial-conversations-20 descubrió los 2 bugs production-blocking del hotfix `58ae007` (ver § Pendings).
- qa-prod-senior (May 27) motivó toda la tríada de memoria conversacional.

---

## AI cost / plataforma

- `AGENT_TIMEOUT_MS` default 12000 — presupuesto TOTAL incluyendo retries (8000 los cortaba). `maxRetries: 2` explícito.
- `AGENT_MAX_TOKENS` default 1500 (era 400 → truncaba compounds de 4-5 tools).
- Pricing Haiku 4.5 corregido Jun 2026: input 1.00 / cache read 0.10 / cache write 1.25 / output 5.00 por M.
- `AGENT_FEW_SHOT_LIMIT`: code default 5, **prod está en 15** (verificado Jun 2026).
- Conversational fallback era single-turn → ahora incluye historia reciente (1500 chars).
- Whisper prompt reescrito Jun 12 de word-list a oraciones de ejemplo (biasea mejor). Manglings conocidos ("desteté"→"de este", "vaquillonas"→"vacuiciones") se fixean determinísticamente en `STT_DOMAIN_CORRECTIONS`.

## Scheduler

- Weather alerts + proactive alerts **deshabilitados Jun 2026 a pedido del usuario** (bloques comentados en `startScheduler()`). Summaries, flow reminders, cleanup, expense templates y subscription sweep siguen corriendo.

## Cuenta web: login, verificación de email y reset (Sep 9, 2026)

Revisión desde cero del flujo de cuenta (registro → verificación → login → olvidé mi contraseña → reset), con un test de integración que lo recorre entero con el mailer mockeado (`auth-lifecycle.integration.test.ts`) y un E2E HTTP contra el backend local. Lo que apareció:

- **Tres criterios de email en tres lugares.** Registro guardaba verbatim, login buscaba con igualdad exacta, forgot-password lowercaseaba antes de buscar. Consecuencia: un usuario registrado como "Juan@Gmail.com" podía loguearse solo con esa capitalización y su "olvidé mi contraseña" respondía 200 sin mandar nada (por diseño, para no revelar cuentas). En la copia de prod había 2 cuentas así. Fix: `email-normalizer.ts` única, `findByEmail` con `LOWER()`, migración 119 (índice funcional + normalización de las cuentas viejas sin colisión).
- **Tokens bcrypt sin selector.** Reset y verificación guardaban bcrypt del token y, como no se puede comparar en SQL, traían los 50 tokens pendientes más recientes de TODO el sistema y los comparaban uno a uno (~250 ms cada uno). Con verificación a 24 h de TTL, 50 registros en un día bastaban para que un link válido quedara fuera de la ventana ("Token inválido o vencido") y cada click tardaba varios segundos. Fix: sha256 con lookup exacto (`one-time-token.ts`), fallback bcrypt solo para los tokens emitidos antes del deploy.
- **Link de verificación no idempotente.** El comentario decía "si ya está verificado devolvemos ok", el código tiraba "Token inválido". Con StrictMode en dev el `useEffect` mandaba dos POST y el segundo pisaba el ✅ con un error. Fix en el servicio (`alreadyVerified`) y guard en la página.
- **Refresh en paralelo cerraba la sesión.** Al volver a la pestaña con el access vencido, el dashboard lanza N requests → N 401 → N `/refresh` con el MISMO refresh token; el primero rotaba (revoca el viejo) y los demás fallaban → `window.location = /login`. Fix: single-flight en `api/client.ts`.
- **"Sesión expirada" por contraseña equivocada.** Un 401 de `/login` con un access token viejo en localStorage disparaba el refresh; si fallaba, borraba tokens y recargaba /login con "Sesión expirada". Fix: los endpoints públicos de auth nunca refrescan ni redirigen.
- **Cuentas deshabilitadas por admin entraban al dashboard.** El bot filtraba `status <> 'disabled'`, el login web no. Fix: 403 en login y refresh (después de validar la contraseña), sin link de reset.
- **Sin límite de intentos.** Login y forgot-password no tenían ningún throttling. Fix: `auth-rate-limit.ts` por email (la IP detrás de Railway es la misma para todos). Un reset exitoso libera el bloqueo de login: el propio 429 manda a ese camino.
- **Reenviar verificación decía "reenviado" aunque el envío hubiera fallado** (`sendEmail` devuelve `ok:false`, no tira). Fix: se propaga `ok:false` y el banner lo muestra.
- **Ninguna tabla de tokens tenía purga**: 486 refresh tokens (rotación cada 15 min por usuario activo) y 227 tokens de verificación en la copia local. Fix: `authTokensCleanupTick` en el cleanup diario.

## Cosecha como proceso comercial (Sep 9, 2026, migración 120)

Análisis de la feature entera contra cómo se cosecha y se comercializa grano en la Argentina (informe en el artifact "Cosecha en Campo Bot"). El registro por camión estaba bien; faltaba todo lo que pasa después de que el camión sale del lote.

- **Bug P0 — la cosecha de varios días pisaba el rinde.** `setPlotCropHarvested` hacía `yield_kg = $3` sin condición y se llamaba una vez por día: "rindió 42 qq/ha" el lunes, "seguimos con el Norte, Pérez 30 tn" el martes → yield_kg NULL → el recálculo por cargas lo dejaba en 30.000. También la fecha se corría al último día. Ahora `harvested_at` es el primer día, `harvest_ended_at` el último y rinde/notas solo se pisan con valor nuevo.
- **Peso neto comercial.** Se guardaban los kilos brutos del camión y la humedad, pero nadie aplicaba la merma: rinde, costo/tn y "cuánto tengo en Cargill" salían inflados (maíz al 18 % → +5 %). `grain-merma.ts` (fuente única, bases por cultivo configurables, fórmula que aproxima las tablas de la Cámara Arbitral: soja al 16 % → 3,2 %) calcula `net_weight_kg` al guardar y al editar; todas las lecturas usan `COALESCE(net, bruto)`.
- **Avance de cosecha en hectáreas y rinde esperado.** Había `sowed_hectares` pero no cosechadas: el bot no podía decir cuánto faltaba de un lote ni comparar contra lo esperado. Ahora `harvested_hectares` acumula y `expected_yield_kg_per_ha` alimenta el desvío en la confirmación, en `campaign_stats` y en "Para revisar".
- **Saldo real por acopio.** "Cuánta soja tengo en Cargill" sumaba entregas y nunca restaba ventas ni retiros. Ahora la venta lleva comprador y estado del precio (fijado / a fijar), el retiro es un evento propio, y `view:'balance'` responde entregado neto − vendido − retirado. Con comprador, la venta no ofrece descontar del stock propio (el grano ya estaba en el acopio).
- **Costo de cosechar.** Contratista y flete eran gastos sueltos si alguien se acordaba. Tras una cosecha con producción el bot ofrece cargarlos con un botón (pending machine-readable, invariante 5); "8%" se valúa a pizarra en USD, "45.000 por ha" y "flete 18.000 por tn" se multiplican por ha cosechadas y tn netas.
- **Silo bolsa como stock, documentación por camión, edición puntual, conciliación.** Una carga al silo propio entra al stock en neto; carta de porte, CTG, bruto/tara y peso en destino por camión; el dashboard edita y borra cargas y concilia el romaneo pegado (coincide / difiere / falta), guardando el peso del acopio para que "Para revisar" marque diferencias > 1,5 %.
- **Fuera de alcance en esta ronda**: publicar el Flow de WhatsApp del formulario de cosecha (necesita el token de Meta vigente; el código está).

## QA E2E de siembra → cosecha → comercialización (Sep 9, 2026, migración 121)

Tercer plan del runner de QA contra prod (`qa-prod-siembra-cosecha.plan.json`, 45 mensajes, 3 corridas, informe en `qa-reports/qa-siembra-cosecha-informe.md`): 39/45 efectivos, y los 6 que faltaban eran bugs reales reproducidos 3/3 — cuatro de ellos en el número central de la campaña.

- **P0-1 — cosecha parcial × ha sembradas.** "ayer cosechamos 40 ha del Norte, rindió 42 qq/ha" registraba 42 qq/ha × 100 ha sembradas = 420 tn (en vez de 168): `areaHa` ignoraba `cmd.hectares`. De ahí salían el flete (× 420 tn), el costo/tn, el rinde por cultivo y el historial. Fix: con hectáreas parciales el total es rate × ha cosechadas y **se acumula** entre días (`addPlotCropYield`), en vez de pisar el rinde del día anterior.
- **P0-2 — el Resumen sumaba el rinde declarado del día 1 MÁS las cargas del día 2** del mismo lote (500 tn cuando el bot había confirmado 420), y el analytics tenía dos filas por lote con un kg/ha fantasma de 806. Las tres queries sumaban por EVENTO; ahora comparten `utils/harvest-campaign-kg.ts` (CTE por CAMPAÑA: GREATEST(rinde, Σ cargas netas, Σ quantity de eventos)), y el kg/ha por cultivo sale de Σ kg / Σ ha, nunca promediando ratios.
- **P1-3 — "para el Norte" en una compra de insumo se perdía.** `add_stock` no tenía lote: el gasto vinculado nacía a nivel campo y "Para revisar" delataba al propio bot. Ahora la tool lleva `plot` y el handler lo resuelve (fallo → log, nunca frena la carga).
- **P1-4 — venta "a fijar" imposible.** El partial-pending exigía monto; el CHECK `amount > 0` (migración 093) tampoco la dejaba entrar. Ahora es un ingreso completo con monto 0 + `price_status='a_fijar'` (migración 121 relaja el CHECK solo para ese caso) y descuenta del saldo en el acopio.
- **P1-5 — "Sí, cargar" al stock rompía por unidad** ("soja está en kg, no se puede cargar en tn") y el silo quedaba en dos verdades. `utils/mass-units.ts` (fuente única, el mapper re-exporta `normalizeToKg`) convierte tn/qq/kg sobre el ítem existente.
- **P1-6 — fecha de las cargas corrida un día** en el chat (`new Date(DATE)` = medianoche UTC formateada en AR). `fmtDay` usa `formatDateAR`.
- **P1-7 — venta sin lote se tragaba el mensaje siguiente.** "¿En qué lote lo registramos?" (income_flow) consumía "retiré 5 tn de soja de Cargill…" como lote, perdía el retiro y el comprador. Ahora una venta de grano con comprador **deduce el lote** de la única campaña reciente del cultivo (o queda a nivel campo con aviso), nunca abre flow; "retiré/saqué/entregué" son verbos de acción para el escape; comprador y estado del precio viajan por el partial y por el flow.
- **P2**: flete sobre las tn netas en camión (no el rinde declarado); kg/ha de `campaign_stats` sobre lo cosechado cuando hay avance parcial (misma fórmula que la confirmación); cerrar campaña con avance parcial pide confirmación y dice cuánto falta; "cosecha antes que su siembra" no dispara el mismo día; el botón de costo de cosecha se ofrece DESPUÉS del tap de stock (`harvest-cost-offer.ts`, compartido con el pipeline) en vez de perderse; "cuánta soja coseché en total" suma la producción de campañas sin camiones; el ranking nombra las campañas omitidas y su ventana de plata llega hasta `end_date` (el costo de cosecha con fecha de fin quedaba afuera → "margen $0"); variedad y densidad de siembra van al evento; la alerta de lluvia dice la fecha; el reset del test-bot borra recordatorios; superficie por cultivo del analytics incluye campañas cerradas; "camiónes" y "1 días".
- Regresiones: `pipeline.integration.test.ts` § "hallazgos del QA E2E de siembra/cosecha", `overview.integration.test.ts` (P0-2 y P2-11), `mass-units.test.ts`.
- **Corridas post-deploy (f54e024, 9 sep)**: 42/45 → 42/46 → **45/46**. Los fallos restantes fueron del plan (frase de confirmación aleatoria, `Monto:` matcheando el avoid de "monto", orden Cosecha/Flete en las estadísticas). El flete ahora sale $1.092.456 (18.000 × 60,7 tn en camión a acopio, sin el silo). **Abierto**: en la corrida 5 un POST al test-bot llegó dos veces con 0,5 s de diferencia (no fue el runner) y la cosecha parcial se aplicó dos veces; un dedup por contenido chocaría con las respuestas repetidas de los pendings, así que quedó documentado y sin fix.
