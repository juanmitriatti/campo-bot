# Auditoría QA — Hacienda (3 oct 2026)

65 escenarios (S01–S88), harness whatsapp + FakeAgent contra base local. 12 P0 · 11 P1 · 9 P2.
Estado = CONFIRMADO (visto fallar en la sonda) salvo indicación. Salidas crudas: probe-hacienda*.txt.

## P0
- HAC-1 Pending de precio abierto + "se me murió una vaca" → gasto de $5 (5 toros a $1); la muerte no se registra. Igual con "se murieron/perdí/llegaron/encerré N…". Con "¿A cuántos animales?" de sanidad abierto, una muerte quedó como vacunación de 1 vaca. Causa: conversation-guards.ts:82 ACTION_VERB sin murio/murieron/perdi/llegaron/encerre/meti/faene/pario; message-pipeline.ts:1083-1106 escape estricto + livestockPivot apagado con slot financiero; extractUnitPrice toma "una" como 1. Opciones: (1, rec.) sumar verbos de hacienda y "N + animal" como pivot; (2) exigir forma de plata; (3) pending de precio blando.
- HAC-2 "¿A cuánto fue la venta?" → "a 2800 el kilo" = ingreso $84.000 (30 × 2800 por cabeza). Causa: setLivestockPrice (livestock.handler.ts:95-157) solo por cabeza. Opciones: detectar kilo y pedir peso con pending; o rechazar y pedir por cabeza.
- HAC-3 remove_livestock con price_per_kg sin peso: descuenta stock, sin ingreso, sin pregunta, sin aviso. Causa: resolvePriceTotal null (livestock.service.ts:336-340) pero hasPrice=true (handler:888-891, 736-739).
- HAC-4 Rescate de precio del mapper toma cualquier "a N": "a 30 días" → ingreso $600; "a 180 kilos promedio" → gasto $9.000; en compound la venta heredó el precio de la compra (ingreso $4M). Causa: agent-response-mapper.ts:1019-1032. Opciones: exigir unidad de plata y excluir días/kg/ha; no aplicarlo en compound; eliminar el rescate.
- HAC-5 Ajuste o nacimiento sin raza crea grupo sin raza al lado del que tiene: "hay 45 vacas" con Angus=50 → 95. Causa: livestock.service.ts:912-918 y 821-824 (lookup indulgente + ensureGroup estricto).
- HAC-6 Raza en minúscula solo se canoniza en el alta: muerte/traslado "No hay vaca (angus)", ajuste/nacimiento duplican grupos. Causa: canonicalBreedName solo en addAnimals (:540); remove :631, transfer :750, birth :822, single :865, adjust :912 crudos.
- HAC-7 Ajuste/nacimiento sin lote hereda el lote del contexto: "son 45 vacas" → 45 nuevas en Norte con 50 en Sur. Causa: handler:1239-1253 y 1273-1288 sin presetLocationFromGroups; service:170-178 cae al context stack.
- HAC-8 Corregir cantidad en el pending de precio no chequea stock: "eran 80" con 50 → venta de 80, grupo en 0, ingreso $32M. Causa: livestock.repository.ts:701-727 GREATEST(0,…).
- HAC-9 Taps repetidos duplican existencias: [En un lote]/[En un feedlot] ×2 = 100; [Moverlos] ×2 = dos traslados. Causa: one-shot-callbacks.ts:31-39 sin lv_*; callbackPayloadStore.get no consume; handlers :415, :497, :562. Opciones: lv_loc_/lv_move_/lv_create_/lv_pick_loc_/lv_animals_ a ONE_SHOT_PREFIXES, o consumir token.
- HAC-10 Precio tardío se engancha a movimiento revertido o a la reversa: gasto $10M para 0 toros, o INGRESO $10M. Causa: findLatestUnpricedMovement (repo:736-767) y attachPriceToMovement no excluyen reversas; Borrar no limpia el pending.
- HAC-11 [↩️ Borrar]/revert devuelve stock pero deja vivo el gasto/ingreso vinculado. Causa: undoMovement (service:1013-1072) ignora linked_*. Opciones: (1, rec.) soft-delete del vinculado en la misma transacción + aviso; (2) avisar y ofrecer botón; (3) bloquear.
- HAC-12 Respuesta a "¿Cuántas cabezas?": "20 de 380 kilos" → 380; "20 a 800 dólares cada una" → 1; "20 a 500 mil cada una" → "excede el máximo" y muere el pending. Causa: extractCount fallback en slot-extractor (~198-214) y single-slot.

## P1
- HAC-13 Preguntas huérfanas sin pending: "Necesito el destino" (handler:1011), "Necesito la cantidad" (:948, :1243, :1277), "❌ Decime en qué lote" en remove/death/birth (:710 solo add), "¿En qué ubicación lo registramos?" (:1662, :1902, :2057), "¿En qué corral?" (:476), "¿Dónde van?" (:393).
- HAC-14 Respuesta inválida a pending de ubicación ("Este", "las del Sur", "al Sur" en lote de lectura) mata el pending sin escalera. Causa: handleCommand (:226); animal.handler resolveLocation no limpia "al/en el".
- HAC-15 Baja por caravana imposible si el grupo del lote del animal no tiene stock (tras move_animals o mover el grupo). Causa: handler:1118-1125 + #singleMovement.
- HAC-16 Mover o vender el grupo entero deja los animales con caravana activos en el lote viejo. Decisión de producto.
- HAC-17 Revertir muerte/venta por caravana no revive al animal. Causa: undoMovement no mira animal_events.livestock_movement_id.
- HAC-18 Borrar corral/feedlot/lote con hacienda: animales atrapados, vender falla, tap da duplicate key. Causa: feedlot.service.ts:54-66 y :106-112 sin chequeo; listGroups no filtra borrados.
- HAC-19 Corral/feedlot borrado no se puede recrear con el mismo nombre (unique no parcial, feedlot.repository.ts:79 y :176).
- HAC-20 Ofrece "crear lote y continuar" y después "Para esta versión, creá el lote primero" (handler:250-253 vs :367-372).
- HAC-21 Botones que WhatsApp rechazaría: lv_pick_loc 266–293 chars, lv_create 286–335, lv_animals 407, títulos de 21, askLivestockCorral hasta 8 botones (SEGÚN CÓDIGO + medición).
- HAC-22 Corral por subcadena: "corral 1" cayó en "12" (feedlot.service.ts:188-190).
- HAC-23 Pesaje sin rango (19.000 kg promedio); Borrar no restaura el peso del grupo (handler:2050, :2112).

## P2
- HAC-24 Misma caravana corta dos veces → duplicate key uq_animal_ident_current (animal.service.ts:97-106 vs :132).
- HAC-25 Count 2.5 → error de tipo; 999.999.999 aceptado; fechas 2031 y 1985 aceptadas en muerte/nacimiento (validaciones solo en alta, handler:655-662).
- HAC-26 Sanidad de 500 vacas con 50 en el grupo sin aviso.
- HAC-27 Venta por kilo guarda unit_price_ars=2800 y el historial muestra "$2.800/cab".
- HAC-28 GDPV calculado entre una vaca y un ternero (:2186-2202).
- HAC-29 "cuándo pasé vacas al lote Sur" no encuentra el traslado (COALESCE origen/destino, :2314).
- HAC-30 Inventario filtrado vacío dice "No tenés grupos de hacienda cargados" (:1327).
- HAC-31 "vendí 10 vacas del lote Norte" con vacas solo en Sur descuenta de Sur sin preguntar (service:632-652).
- HAC-32 Con el gasto vinculado borrado, la compra no se puede re-preciar (linked_expense_id sin deleted_at).

## Probado y funciona
Bajas/traslados mayores a la existencia rechazados; traslado al mismo lote rechazado; compra/venta por cabeza ARS/USD con vinculado correcto; precio diferido USD; venta por kilo con peso total; doble Borrar; Borrar de entrada ya vendida bloqueado; recategorización + reversa; canonización de raza en el alta; pending de ubicación con "en el Sur"; pending de cantidad con "unas 20"; cola serial de compound; muerte/venta por caravana transaccional; animal muerto no se re-mata; CII duplicado; lote de lectura sin agente; crear corral y continuar; invariante 16 (S85).

## No pude probar
400 real de Meta/Telegram (solo longitudes); elección de tool del modelo real; taps concurrentes; dashboard (/api/auth/animals, import) y review-findings.
