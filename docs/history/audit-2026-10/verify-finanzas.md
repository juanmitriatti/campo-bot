# Verificación — Finanzas (commit 333b89b)

REPRODUCIDOS: los 17 P0 (FIN-1..17) — ningún falso positivo. P1 reproducidos: FIN-18, 20, 22, 23, 26; FIN-28 parcial. No probados: FIN-19, 21, 24, 25, 27, 29, 30.

Causas confirmadas (líneas actuales):
- FIN-1: pending-correction-interceptor.ts:69-73 solo plotName; financial.handler.ts:1603 usa pending.plotId. También miente el "✅ Gasto registrado" (buildExpenseConfirmation usa pending.plotName). El P0 más claro: corrupción invisible.
- FIN-2: conversation-engine.ts:284-287 (m1) y :296-302 (m2); aplicado en pending-correction-interceptor.ts:61-67.
- FIN-3: income.flow.ts:249-250 y :213-214 fijan unit 'tn'; el handler sí manda data.unit (financial.handler.ts:1306-1308).
- FIN-4: parser.js:152 normalizarMonto, WRITTEN_NUMBERS :91, matchMillones/matchMil :186-190. También "veintiún mil" y "dieciséis mil" = 1000.
- FIN-5: pending-action-processor.ts:226-229 llena amount antes del cross-fill :274-280; slot-extractor.ts:116-119.
- FIN-6 MÁS AMPLIO: se pierde también un event_date explícito del agente, en gastos e ingresos parciales. agent-response-mapper.ts:635-656 y :755-779 (la rama completa sí copia, :618, :737).
- FIN-7: relative-dates.ts:137 + agent-response-mapper.ts:472-473. La fecha no se ve en la tarjeta previa.
- FIN-8: agent-response-mapper.ts:543-563 y :705-722. Requiere que "Otros" exista en el catálogo (caso normal).
- FIN-9 MÁS GRAVE: cat_pick guarda directo aun con confirm_before_save ON. financial.handler.ts:3708-3735; interactive.router.ts:182-207; one-shot-callbacks.ts:31-39.
- FIN-10: message-pipeline.ts:1841-1849 buildDeletePreview sin filtro (llamada en :402). Solo cuando el agente emite delete_last_expense{category_filter} (frecuencia DEPENDE DEL MODELO); por texto lo toma el regex (FIN-20).
- FIN-11: financial.handler.ts:361-400.
- FIN-12: expenses.js:1677 (LIMIT :1706); financial.handler.ts:648 y :2214.
- FIN-13: parser.js:447-449; pre-router intent-classifier.ts:656.
- FIN-14: expense.flow.ts:31, income.flow.ts:31; slot-extractor.ts:122-127.
- FIN-15: expense.flow.ts:150-170; field-step-helpers.ts:342. Severidad discutible (P1): el registro existe y avisa.
- FIN-16: expenses.js:536-548; no hay tool para fijar precio. Tool elegida DEPENDE DEL MODELO.
- FIN-17: conversation-engine.ts:89-91. Visible en la tarjeta: bajar a P1.
- FIN-18: message-pipeline.ts:2106-2113 (clear y después handleConfirm); explota en financial.handler.ts:1605.
- FIN-26: financial.handler.ts:778 y :1195.

Severidad: FIN-2, 4, 5, 17 se ven en la tarjeta antes de guardar (evitables si el usuario lee). Silenciosos: FIN-1, 3, 6, 7, 8, 11, 12.
