# Verificación — Conversación (commit 333b89b)

REPRODUCIDOS: CONV-1..8, 10, 11, 12 (causa distinta), 14..20. PARCIAL: CONV-9 (depende del modelo: solo si el agente omite event_date). CONV-13: mecanismo reproducido, DEPENDE DEL MODELO. No verificados: CONV-21..30.

Causas confirmadas / correcciones:
- CONV-1: message-pipeline.ts:722-737 (solo isCancelIntent, sin TTL); financial.handler.ts:3738 estado ad-hoc en conversation_state (sin TypedPendingStore). Con el estado de 2 días, "gasté 5 mil en gasoil" se volvió categoría.
- CONV-2: interactive.router.ts:187/201/212 sin consumir; financial.handler.ts:3708-3720; también cat_sim_use_exp_*.
- CONV-3: livestock.handler.ts:415-416. Nota: "agregá 50 vacas" con 2 lotes contesta "Decime en qué lote. Opciones…" en texto suelto sin pending visible (posible invariante 5, revisar aparte).
- CONV-4: message-pipeline.ts:2225-2243, :2305 y else de stock_grain_sale. CORRECCIÓN: stock_deduct_yes con store vacío responde honesto (:2265-2268); mienten stock_entry_yes, stock_grain_yes, stock_grain_sale_yes.
- CONV-5: plot-intent.ts:73-75 isPlotAnswerToFlow desactiva los escapes de message-pipeline.ts:842 y :909; consumo en :918 processFlowMessage. En paso lote se pierde la siembra (el gasto queda con Lote=Sur).
- CONV-6: message-pipeline.ts:576-578 y :842-853. Con una siembra no se pierde el gasto: la siembra queda como "Detalle" (variante de CONV-5); con consulta o cultivo suelto sí se pierde el gasto.
- CONV-7: message-pipeline.ts:1253-1272; handleIncome devuelve startFlow (financial.handler.ts:1276/1303/1356) y applySideEffects lo ignora.
- CONV-8: pending-queue-advancer.ts arma la cola; message-pipeline.ts:1268 re-setea el pending sin nextInQueue.
- CONV-9: relative-dates.ts:165 FUTURE_INTENT_RE con mañana/pago. Red de seguridad que no actúa; con fecha correcta del agente se respeta → P1 / depende del modelo.
- CONV-10: agent-response-mapper.ts:366-368 (no reconoce "hoy") y :473 (pisa con "ayer").
- CONV-11: pending-action-processor.ts:135 y :202-204.
- CONV-12 CAUSA DISTINTA: financial.handler.ts:802-804 — hasPlotContextSignal(text) ve "lote" en el texto completo del compound, habilita el fallback a context_stack, y add_plot acaba de poner el lote nuevo arriba. No es last_plot ni exclusivo de bulk.
- CONV-13: intent-classifier.ts:711-736 (primary = primer resultado) y message-pipeline.ts:1400; compound-executor no participa con una sola tool. Perder el texto cuando hay tool es en parte intencional (agent-prompt-builder.ts:234); lo que no: perder la tool cuando respond_text viene primero, y sin log.
- CONV-14: message-pipeline.ts:734 clearFlow antes de validar; financial.handler.ts:3759.
- CONV-15: message-pipeline.ts:1060-1062.
- CONV-16: falta "la/el <unidad>" en slot-extractor/lexicon.
- CONV-17: conversation-engine.ts:745-766 y message-pipeline.ts:1052. pendingObs solo con nombres pelados.
- CONV-18: message-pipeline.ts:1278 + clear en escalatePendingToAgent (:1804). "category:Soja" probablemente sale de la descripción del pending, no del saludo.
- CONV-19: message-pipeline.ts:1511-1516 no limpia deferredFirstActionStore.
- CONV-20: message-pipeline.ts:771-777.
