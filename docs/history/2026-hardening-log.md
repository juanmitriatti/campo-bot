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
