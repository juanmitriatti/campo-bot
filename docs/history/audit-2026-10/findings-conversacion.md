# Auditoría QA — Conversación / pipeline entre capas (3 oct 2026, HEAD d23139c)

64 escenarios, harness whatsapp + FakeAgent, campo La Loma (Norte, Sur). 13 P0 · 13 P1 · 4 P2. Todo CONFIRMADO salvo indicación. Transcripciones: batch1.txt, batch2.txt.

## P0
- CONV-1 (inv 1/5) Tras "+ Otra" en el picker, cualquier mensaje ("hola", "sembré soja en el lote Sur") se toma como nombre de categoría: crea categoría basura, guarda el gasto ahí y pierde la acción. Estado sin TTL (según código). message-pipeline.ts:722-737 solo chequea isCancelIntent. Opciones: (1, rec.) TypedPendingStore con TTL + guardas de conversation-guards; (2) rechazar nombres con verbo de acción.
- CONV-2 Doble tap en cat_pick_exp_* → dos gastos idénticos (token no se consume; pickCategory financial.handler.ts:3707). cat_sim_* igual según código. Opciones: consumir token (take) o ONE_SHOT_PREFIXES.
- CONV-3 Doble tap en [En un feedlot] (lv_loc_feedlot_) → 100 vacas (livestock.handler.ts:415). (= HAC-9) Cubrir lv_loc_*, lv_move_*, sow_replace_*.
- CONV-4 (inv 1) stock_entry_yes de una compra vieja carga el producto de OTRA compra; segundo tap "📦 Stock cargado." sin escribir. Éxitos falsos con store vacío en stock_entry_yes (2243), stock_grain_yes (2305), stock_grain_sale_yes, stock_deduct (2346). message-pipeline.ts:2225-2243: un slot por teléfono, id del callback ignorado.
- CONV-5 (inv 1) Gasto en flujo guiado (paso lote o categoría) + "sembré soja en el lote Sur" → se consume como lote o como categoría; la siembra se pierde. message-pipeline.ts:842, 908; isPlotAnswerToFlow (plot-intent.ts:79) no mira paso ni verbo.
- CONV-6 (inv 1) En "¿Algún detalle?" (gasto completo) una consulta o pivot ("soja", "mis lotes", siembra) descarta el gasto sin aviso. commitFinancialFlowFieldLevel (message-pipeline.ts:576-578) solo en plotName/confirming.
- CONV-7 (inv 5) Venta sin precio + "300 dólares por tn" → "¿En qué lote lo registramos?" huérfano; el ingreso se pierde. message-pipeline.ts:1211-1272 re-rutea, handleIncome devuelve startFlow y applySideEffects lo ignora.
- CONV-8 (inv 1) Cola de pendings: respuesta inválida al primer ítem borra la cola (applySideEffects pisa nextInQueue, message-pipeline.ts:1263-1268); la siembra encolada se pierde.
- CONV-9 "el lunes a la mañana sembré…" y "el martes hice el pago…" quedan con fecha de hoy: FUTURE_INTENT_RE (relative-dates.ts) incluye "mañana" y "pago".
- CONV-10 "ayer fumigué … y hoy sembré …": el mapper pisa la fecha explícita del agente; la siembra queda de ayer (agent-response-mapper.ts:366-374, 472; resolveAllRelativeDates no reconoce "hoy").
- CONV-11 Fallback de slot único: "dale" como producto, "12345" como cultivo (pending-action-processor.ts:135, 165-205; NON_ANSWER_RE sin afirmaciones, sin validación por tipo).
- CONV-12 Compound con alta de lote: el gasto sin lote cae en el lote recién creado en vez de nivel campo + botón (según código: add_plot actualiza last_plot y handleExpense lo hereda en bulk).
- CONV-13 (DEPENDE DEL MODELO) respond_text + una tool: se pierde el gasto o la pregunta sin log (message-pipeline.ts:1400; compound-executor.ts:70 filtra 'unknown' sin log).

## P1
- CONV-14 (inv 5) Nombre de categoría >60 chars: "Probá de nuevo" huérfano (estado limpiado antes de validar, message-pipeline.ts:734 / financial.handler.ts:3758); el gasto se pierde.
- CONV-15 (inv 1) Cancelar el 1.º ítem de la cola cancela toda la cola sin decirlo (message-pipeline.ts:1060).
- CONV-16 "300 dólares la tonelada" no se entiende como precio unitario ("por tn" sí). Falta "la/el <unidad>" en lexicon/slot-extractor.
- CONV-17 (inv 6) activity_flow (conversation-engine.ts:745-766) y pendingObs (message-pipeline.ts:1052) repiten la misma pregunta 3-4+ veces.
- CONV-18 Saludo o "gracias" con pending abierto gastan la escalera; la escalación borra el pending (message-pipeline.ts:1094-1122, 1804); además "hola" metió category:"Soja".
- CONV-19 (inv 15) "cancelar" no limpia la primera acción diferida, que se re-inyecta después (message-pipeline.ts:1511).
- CONV-20 Flujo vencido (>10 min) + acción nueva: se descartan el mensaje y el gasto completo (message-pipeline.ts:771-777).
- CONV-21 Tap flow_new_* con pending abierto → dos colectores (message-pipeline.ts:1978).
- CONV-22 (inv 1) Tap harvest_cost_yes pisa un pending sin aviso; muestra la etiqueta "cost" sin traducir (SLOT_LABEL).
- CONV-23 "si" con botones de campo duplicado → excepción chk_expenses_amount_positive (setFieldDuplicate tratado como gasto de $0, message-pipeline.ts:543, 1484).
- CONV-24 (inv 5) Feedlot con 2 campos: "¿En qué campo?" en texto suelto (livestock.handler.ts:433); el rejoin usa el id del tap como mensaje original (intent-classifier.ts:842-866).
- CONV-25 Pregunta de hectáreas descartada por otra respuesta; compound abre 2 preguntas a la vez (handlePendingPlotArea, message-pipeline.ts:956).
- CONV-26 [Confirmar] viejo en paso categoría mata el flujo y pierde el monto (conversation-engine.ts:862-869).

## P2
- CONV-27 "maíz en el Este" (inexistente): el validador lo dropea y el bot dice "No sembré maíz en lote Norte: ya tiene soja".
- CONV-28 "🔁 Cancelé el gasto anterior ($0)" cuando se reemplazó una confirmación de borrado (pending-transactions.ts:61).
- CONV-29 En el paso lote, un texto con "suelos" cambia la categoría a "Sueldos".
- CONV-30 Merge de slots adyacentes metió category:"Soja" desde "hola" (pending-action-processor.ts:243).

## Probado y funciona
Rehidratación tras reinicio (cultivo, tarjeta, cola, descuento de stock); correcciones varios turnos después; pronombres; tarjeta A + gasto B; botón de borrado viejo; emojis/mensaje vacío con pending; mensaje de 4.600 chars; "cancelar" en cascada; acción diferida espera las hectáreas; escalera de pending simple; consulta read-only en el paso lote.

## No pude probar
Lock y dedup en vuelo (el harness no pasa por withUserLock); audio vacío; tokens vencidos reales; TTL de awaiting_new_category_name; pivot a lluvia dentro de una cola; log_health_event sin tipo.
