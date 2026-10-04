# Auditoría QA — Finanzas por chat (3 oct 2026)

~42 escenarios, harness whatsapp + FakeAgent, base local. Campo "El Rincón" (Norte, Sur) con fila owner; confirm_before_save ON por defecto. 17 P0 · 13 P1 · 11 P2. "Encolé" = tool call del FakeAgent.

## P0
- FIN-1 (CONF) Tarjeta abierta + "no, era en el Sur": tarjeta y confirmación dicen Sur, se guarda Norte. Causa: pending-correction-interceptor.ts bloque correctedPlot (~48-75) solo cambia plotName; handleConfirm (financial.handler.ts:1605) usa pending.plotId. Arreglo: re-resolver plotId/fieldId con entity-matcher; si no resuelve, "no encontré el lote X".
- FIN-2 (CONF) Correcciones en la tarjeta corrompen categoría: "no, era en dólares" → cat 'dolares' + USD; "no, es de ayer" → cat 'de ayer' (fecha hoy); "no, es del lote Sur" → Otros y lote igual; "no, es sanidad" → 'sanidad' inexistente. Causa: extractCategoryCorrection (conversation-engine.ts:284-303; m1 acepta cualquier X, m2 pasa looksLikeCategoryWord). Arreglo: solo si resuelve contra categorías del usuario (si no, picker/askNewCategory); excluir moneda, fechas y lotes.
- FIN-3 (CONF) income_flow guarda toda cantidad como tn: 5000 kg → 5000 tn (quantity_kg 5.000.000); 20 cabezas → 20 tn. Causa: income.flow.ts execute `unit: quantity ? 'tn' : null`, ignora data.unit (financial.handler.ts:1306-1313); buildConfirmation pinta "tn". Arreglo: usar data.unit / data.unit_price.
- FIN-4 (CONF) Montos: "veinticinco mil" → $1.000; "dieciocho mil quinientos" → $1.500; "2 millones 300 mil" → $2M; "3 palos 200" → $3M; "1.250.000,50" no se entiende. Causa: normalizarMonto (parser.js:152-209); WRITTEN_NUMBERS (l.91) sin veintiuno…veintinueve ni dieciséis…diecinueve; matchMillones/matchMil toman el primer término. Arreglo: vocabulario completo, sumar compuestos, null si queda texto numérico sin consumir, aceptar 1.234.567,89.
- FIN-5 (CONF) "vendí 30 tn de soja" + "a 400 mil la tonelada" → $400.000 (esperado $12M). Causa: processPendingAction / slot-extractor extractAmount (~117) llena amount y gana al cross-fill cantidad × unit_price. Arreglo: con unit_price + cantidad, amount = producto.
- FIN-6 (CONF) Parcial "ayer cargué gasoil" + "50 mil" → fecha hoy. Causa: ramas parciales de mapExpense (agent-response-mapper.ts:629-657) y mapIncome (:751-777) no copian event_date. Arreglo: propagar.
- FIN-7 (CONF) "en Santo Domingo" / "a Domingo" → fecha del domingo pasado. Causa: resolveRelativeDate (relative-dates.ts ~148, artículo opcional); el mapper pisa la fecha del agente (:472-473). Opciones: (a, rec.) exigir artículo/demostrativo y descartar si es parte de un nombre de campo/lote o va capitalizado tras "a"/"Santo"; (b) no pisar fecha explícita del agente sin artículo.
- FIN-8 (CONF) Categorías propias pisadas: "Fletes"/"Seguros" (exact) → Otros; ingreso "Servicios" con "soja" en el texto → Soja. Causa: agent-response-mapper.ts:546-563 (EXPENSE_KEYWORD_MAP antes del catálogo, ignora category_match) y :713-722. Arreglo: con exact o si existe en user_categories, preservar.
- FIN-9 (CONF) cat_pick_* re-tocables: 2× Agroquímicos + 1 Arrendamiento = 3 gastos; ingreso ×2. Causa: pickCategory (financial.handler.ts:3708); router (interactive.router.ts:182-227) no consume token; no están en ONE_SHOT_PREFIXES. Arreglo: consumir token; re-tap → "ya lo guardé como X, ¿cambiar categoría?".
- FIN-10 (CONF) delete_last_expense{category_filter:'gasoil'}: preview "Semillas $30.000", borra Combustible $50.000. Causa: buildDeletePreview (message-pipeline.ts:1841-1866) ignora categoryFilter; delete_specific_expense sin preview. Arreglo: preview con la misma consulta, guardar el id y borrar ese id.
- FIN-11 (CONF) Venta de grano por picker de categoría pierde buyer y price_status (encode/decodePendingIncomePayload financial.handler.ts:361-400; también cat_sim_* y payload de similitud de income.flow.ts).
- FIN-12 (CONF) >200 movimientos: totales falsos sin aviso ($200k vs $250k gastos; $2M vs $2,3M ingresos; balance; "200 tn" vs 230). Causa: queryMovements (expenses.js:1677) LIMIT; handler limit:200 (financial.handler.ts:648). Arreglo: totales en SQL aparte + avisar recorte.
- FIN-13 (CONF) Regex de presupuesto roba gastos: "arreglé el techo del galpón, 300 mil" → presupuesto "Arregle galpon mil"; "puse alambrado en el límite con el vecino por 500 mil" → presupuesto Sueldos $500k; 0 gastos. Causa: parseBudget (parser.js:447) en STEP 2.7 (intent-classifier.ts:656), gatillos techo|limite|tope. Opciones: (a, rec.) exigir "presupuesto" o "límite/tope de gasto(s)" + categoría que resuelva; (b) tool set_budget y sacar el pre-router.
- FIN-14 (CONF) Dólar perdido: "u$s 500" en expense_flow y "US$ 1.200" en parcial → ARS; "500 verdes" no se entiende. Causa: expense.flow.ts / income.flow.ts isUsd=/d[oó]lar|usd/; extractCurrency (slot-extractor.ts:123). Arreglo: detectCurrencyTerm (invariante 4).
- FIN-15 (CONF) "Dejar a nivel campo" (flow_plot_field_level) guarda field_id NULL; "campo" escrito no se acepta. Causa: execute de expense/income.flow.ts solo resuelve fieldId con plotName; validatePlotAsync (field-step-helpers.ts:342). Arreglo: el botón lleva el campo (o se resuelve/pregunta) y aceptar "campo"/"todo el campo".
- FIN-16 (CONF / monto DEPENDE DEL MODELO) Venta "a fijar" no se puede pasar a fijada: edit_last_income deja price_status='a_fijar', unit_price NULL (financial.handler.ts:1840; updateIncomeFields expenses.js:536). Opciones: (a, rec.) fix_grain_price(buyer, crop, unit_price); (b) new_unit_price + price_status en edit_last_income.
- FIN-17 (CONF) "no, eran 80" sobre $50.000 → $80 (inheritAmountScale conversation-engine.ts:89-99 solo desde $100k). Opciones: (a, rec.) heredar desde $10.000 si la corrección <1000 y el previo es múltiplo de 1000; (b) preguntar "¿80 u 80 mil?".

## P1
- FIN-18 (CONF) Tap a confirm_pending viejo con borrado pendiente → excepción chk_expenses_amount_positive y se pierde el borrado. Causa: askDestructiveConfirmation (message-pipeline.ts:403-409) guarda como pending expense amount 0; confirm_pending (:2106-2118) no mira _destructiveCommand. Arreglo: rechazar el botón y re-mostrar la tarjeta de borrado, o store propio.
- FIN-19 (CONF) Moneda de un registro guardado no se corrige sola; la de ingreso nunca; "el ingreso eran 3000 dólares" → "no encontré un gasto de tipo ingreso". Causa: guard financial.handler.ts:1678 antes de detectCurrencyTerm (:1718); updateIncomeFields sin moneda; extractor de corrección con referente (conversation-engine.ts ~126).
- FIN-20 (CONF) "borrá el último gasto de gasoil" (regex delete_last parser.js:1472) ignora "de gasoil" y borra Semillas; delete_specific_expense{filter_category:'gasoil'} no encuentra (findExpenseByCriteria expenses.js:1443 exacto). Arreglo: canonicalizar, buscar en descripción/producto, pasar "de X" como filtro.
- FIN-21 (CONF) Reporte "la canada" → "No hay registros" (buildMovementFilters ~1620 LOWER(name), invariante 3); si el validador dropea el lote, muestra el total del campo sin avisar. Arreglo: filtrar por plot_id resuelto; avisar/preguntar si se dropea.
- FIN-22 (CONF) Alerta de presupuesto suma USD como ARS ($90.030) (getCategoryMonthlyTotal expenses.js:649). Opciones: (a, rec.) solo moneda del presupuesto; (b) convertir.
- FIN-23 (CONF) "presupuesto de 2000 dólares" → $2.000 ARS (parseBudget / setBudget expenses.js:628, sin moneda). Opciones: (a, rec.) currency en budgets; (b) "por ahora en pesos".
- FIN-24 (CONF) Borrar el gasto vinculado a compra de hacienda deja linked_expense_id colgado; no se puede re-preciar (deleteExpense expenses.js:1408; livestock.repository.ts:708/757). (= HAC-32)
- FIN-25 (CONF) "Cargil" / "Cargill SA" parten el saldo por acopio (getGrainBalance expenses.js:3416). Arreglo: comparar buyer con existentes (entity-matcher + soundsLikeToken + sufijos SA/SRL) y preguntar.
- FIN-26 (CONF) "del 1 - 15 de septiembre" / "gasoil - 50 mil" → "no puede ser negativo" (financial.handler.ts:777, :1194 regex sobre todo el texto).
- FIN-27 (día 31 SEGÚN CÓDIGO; lote CONF) Template recurrente día 31 saltea meses (advanceDate setMonth); lote inexistente ignorado (financial.handler.ts:2389-2393). Arreglo: 1-28 o "último día", validar lote.
- FIN-28 (CONF) "borrar gasto fijo de internet" cae en delete_specific (parser.js:1464). Arreglo: excluir fijo|recurrente|automático.
- FIN-29 (CONF) "el de Lucía" / "los dos" no se aceptan en "¿De qué campo?"; escala al agente. Causa: fallback single-slot + stripAnswerPrefix sin "el de". Arreglo: matchear contra las opciones ofrecidas.
- FIN-30 (CONF / monto DEPENDE DEL MODELO) Editar monto de gasto con cantidad × precio deja unit_price viejo (updateExpenseFields expenses.js:1472). Arreglo: new_unit_price o recalcular.

## P2
- FIN-31 Sugerencia de stock "200 lt de undefined" y bloque duplicado (financial.handler.ts:1150, 1152-1157).
- FIN-32 "ok"/"listo" con la tarjeta → "👍" sin guardar ni re-mostrar (regex ack parser.js:738). Opciones: (a, rec.) re-mostrar la tarjeta; (b) tomarlo como confirmación.
- FIN-33 expense_flow pierde unit_price (financial.handler.ts:919-930; expense.flow.ts execute).
- FIN-34 Ingreso con buyer por la rama needPlotSelection pierde buyer/price_status (financial.handler.ts:1299-1314).
- FIN-35 "cancelar" en gasto parcial dice "❌ Actividad cancelada."
- FIN-36 Comentario con la tarjeta abierta auto-guarda y pierde el detalle (message-pipeline.ts:1359-1367).
- FIN-37 Mismo mensaje reenviado con la tarjeta abierta duplica (con aviso).
- FIN-38 flow_skip fuera de paso → "Hubo un problema con el flujo".
- FIN-39 "no sé" en el paso de lote muestra el menú de ayuda completo.
- FIN-40 Fecha futura en gasto pasado sin aviso (validateDate permite +5 años).
- FIN-41 (SEGÚN CÓDIGO) Templates sin categoría generan gastos con category NULL; borrar template por nombre aproximado no encuentra.

## Probado y funciona
Correcciones de monto ≥ $100k; consulta read-only con tarjeta abierta; compound de 2 gastos; parcial nuevo guarda el anterior con aviso; "sí"/"Dale!"; montos 300 lucas, medio palo, 1.500.000, $ 85.000, 1,2 millones, 120k, un millón doscientos mil, 500 dólares; "2-4-D" no negativo; "ayer" con monto; event_date explícito; gasto de campo con 2 campos pregunta con botones; venta a fijar monto 0 y saldo por acopio; qq → kg; sobreventa avisada; reportes ARS/USD separados; filtro por campo y lote exacto; CSV; delete_specific por monto; preview sin filtro; edición de categoría/lote; gasto vinculado de add_stock y add_livestock; plantillas crear/listar/borrar exacto; flow manual completo, cancelar, corrección en el flow.

## No pude probar
processTemplates (templates vencidos de otros usuarios en la base local); elección de tool del modelo real; alertas de presupuesto por cron; Telegram (64 bytes); si borrar el gasto vinculado de add_stock debe deshacer el stock (decisión de producto).
