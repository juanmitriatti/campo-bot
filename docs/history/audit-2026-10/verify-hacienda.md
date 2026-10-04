# Verificación — Hacienda (commit 333b89b)

P0: 10 REPRODUCIDOS (HAC-1,2,3,4,5,7,8,10,11,12) + 2 PARCIALES (HAC-6, HAC-9). Ninguno depende del modelo.
P1: HAC-14, 15, 17, 18, 19 reproducidos; HAC-13 parcial; HAC-16 reproducido pero es decisión de producto (invariante 16).

Causas confirmadas / correcciones:
- HAC-1: conversation-guards.ts:82 ACTION_VERB; message-pipeline.ts:1089-1090 (slot count cuenta como financiero) y :1118 (livestockPivot apagado); pending-action-processor.ts:175 normalizarMonto("…una vaca")=1. Dos síntomas: con "un/una" → gasto falso de $5; con "se murieron 2 / perdí 3 / llegaron 10 / encerré 4" → el mensaje se descarta y re-pregunta el precio (evento perdido, sin dato corrupto).
- HAC-2: livestock.handler.ts:95-157; extractSlots("a 2800 el kilo") = unit_price 2800.
- HAC-3: livestock.service.ts:314-340 resolvePriceTotal null; handler :888-891 y :736-739 hasPrice=true. Confirma HAC-27.
- HAC-4: agent-response-mapper.ts:1022-1032 regex \ba\s+N sobre todo el texto, también en compuestos.
- HAC-5: livestock.service.ts:912-918 (ajuste), :822-824 (nacimiento): findGroupAtLocation indulgente + ensureGroupAtLocation(breed=null) estricto (repo :36 IS NOT DISTINCT FROM).
- HAC-6 PARCIAL: canonicalBreedName solo en service:540. Fallan muerte y traslado; ajuste y nacimiento duplican. La venta funciona por el fallback case-insensitive de removeAnimals (service:632-652) cuando hay un solo grupo.
- HAC-7: handler :1239-1253 y :1273-1288 sin presetLocationFromGroups (:530); service:170-178 cae al contexto.
- HAC-8: livestock.repository.ts:701-727 GREATEST(0,…); message-pipeline.ts:1157-1170.
- HAC-9 PARCIAL: duplica en [En un feedlot], en usuario con un solo lote y en [Moverlos]; [En un lote] con 2+ lotes pregunta y no duplica. one-shot-callbacks.ts:31-39 sin lv_*; handlers :415, :497, :562.
- HAC-10: repo :736-767 findLatestUnpricedMovement y attachPriceToMovement (service:463) no excluyen reversas; el Borrar no limpia el pending de precio.
- HAC-11: service:1013-1072 undoMovement ignora linked_*; lo usan el botón Borrar y animal.handler.ts:693.
- HAC-12 CAUSA DISTINTA: pending-action-processor.ts:175 aplica normalizarMonto al slot count ("…cada una" → 1, "500 mil" → 500000) y el fallback count-in-phrase :186-192 toma el ÚLTIMO número (380).
- HAC-13 PARCIAL: "Necesito el destino" / "Necesito la cantidad" sin pending (handler :948, :1011, :1243, :1277). "Decime en qué lote" en muerte/nacimiento no reproducido (gana el contexto = HAC-7).
- HAC-14: resolvePlot (service:194-196) sin escalera; stripAnswerPrefix no saca "las del".
- HAC-15: handler :1119-1121 + #singleMovement (service:865-871). Origen: move_animals mueve la ficha sin mover la cabeza entre grupos.
- HAC-16: decisión de producto (invariante 16: individualización parcial válida), no bug.
- HAC-17: undoMovement no mira animal_events.
- HAC-18: feedlot.service.ts:106-112, :54-66; listGroups no filtra borrados.
- HAC-19 CAUSA EN MIGRACIÓN: 055_feedlot_corrals.sql:28 UNIQUE (feedlot_id, name) y :12 UNIQUE (field_id) no parciales.
