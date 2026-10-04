# Auditoría QA — Campos, lotes y compartir (3 oct 2026)

~45 escenarios, 5 corridas, 2-3 usuarios. Harness whatsapp + FakeAgent. 14 P0 · 13 P1 · 8 P2. Salidas crudas: probe-campos-2..5.txt.

## P0 (confirmados)
- CAM-1 Miembro borra un lote del dueño desde la botonera de homónimos ("borrar lote Norte" → tap La Compartida) sin confirmación ni chequeo de dueño. financial.handler.ts:2803-2815 arma confirm_delete_plot_* antes del isOwner (2818); message-pipeline.ts:2185-2222 nunca chequea dueño. (= AIS-5)
- CAM-2 Miembro cambia superficie, ubicación y grupo de lotes ajenos, crea lotes y RESTAURA un lote que la dueña borró. set_plot_area (handler:3364), set_plot_grupo (3373), set_field_city (2483 + expenses.js:745), restorePlot (expenses.js:1177), add_plot sin chequeo de rol. Opciones: (1, rec.) restaurar/borrar/superficie/ubicación/grupo solo dueño; (2) permitir con aviso; (3) rol editor.
- CAM-3 Miembro quitado conserva tarjeta "¿Confirmo gasto?" y pending de hectáreas: al confirmar escribe en el campo del dueño. handleConfirm / handlePendingPlotArea no revalidan; removeMember (field-sharing.service.ts:441, 590) no limpia pendings (invariante 15). (≈ AIS-7)
- CAM-4 Restaurar campo/lote no re-vincula gastos, ingresos ni lluvias (quedan field_id/plot_id NULL). También saca del reporte los gastos de los miembros. expenses.js:848-856, 1158-1160 SET NULL; restoreField/restorePlot (868/1177) no re-vinculan. Opciones: (1, rec.) no desvincular y filtrar por deleted_at del padre; (2) deletion_log y re-vincular.
- CAM-5 Campo con acento ("La Peña") borrado no se restaura (LOWER vs normalizado, expenses.js:873/1183, invariante 3) ni se re-crea (UNIQUE incluye borrados).
- CAM-6 Botón viejo "Confirmar" de borrado vuelve a borrar un campo ya restaurado (no one-shot, no askDestructiveConfirmation).
- CAM-7 Borrar lote/campo deja hacienda, stock y cultivo activo atrapados o invisibles; vender imposible; "crear y continuar" no hace nada; la confirmación solo cuenta gastos/ingresos/lluvias (handler:2848-2855). Opciones: (1, rec.) bloquear con hacienda/stock/campaña activa y explicar; (2) avisar y ofrecer mover; (3) cascada con registro.
- CAM-8 Nombres de campo truncados: "Sta. Rosa"→"Sta", "3-4"→"3", "O'Higgins"→"O", >4 palabras cortado y pierde localidad. parser.js:1275/1298.
- CAM-9 "no figura, es un paraje" en el paso localidad renombra el campo a "un paraje" (extractor de correcciones de conversation-engine aplicado en el paso city).
- CAM-10 Hectáreas mal leídas: "1 40, 2 30" → 1 ha; "el lote 7 tiene 50 ha" → 7; "1.500" → 1,5; "-20" → 20. pending-plot-area-handler.ts parseNamedAreas (93), parseHectares (9), isBareHectaresAnswer.
- CAM-11 set_plot_area acepta 0, negativos y 99999999999 ha (handler:3364 sin validar; el pending sí valida).
- CAM-12 Lotes homónimos: superficie y grupo van al primero sin preguntar (plots[0] en handler:3369/3397).
- CAM-13 Batch "Fondo 60,5 ha" crea lote "Fondo 60" sin ha (split por coma, parser.js:1052).
- CAM-14 Actualizar ubicación deja provincia o coordenadas viejas (Rafaela con lat/lon de Pergamino); con acento dice "actualizado" y no cambia nada. message-pipeline.ts:2134; expenses.js:753-757 COALESCE(latitude,$5) y LOWER(name).

## P1 (confirmados salvo nota)
- CAM-15 accept_invite no está en TRIVIAL_COMMANDS (intent-classifier.ts:77-115): "unirme X" siempre va al agente; con agente caído el invitado no entra. Contradice CLAUDE.md.
- CAM-16 Confirmar alta de campo con "si/sí/confirmar/dale" → "No hay nada pendiente", el campo no se crea (message-pipeline.ts:806).
- CAM-17 Paso localidad sin escape: "saltar/omitir/sin localidad/después te digo" repiten 5+ veces (invariante 6). Rec.: aceptar "sin localidad".
- CAM-18 UNIQUE (user_id,name) y (field_id,name) incluyen borrados → 23505 al re-crear. Rec.: índice parcial WHERE deleted_at IS NULL.
- CAM-19 Renombrar a nombre existente → 23505 (expenses.js:896-921).
- CAM-20 Nombres >100 caracteres → "value too long".
- CAM-21 Frases sugeridas por el bot fallan: "ubicar campo X en Y" (pending-field-city-handler.ts:120 / parser.js:1385) y "restaurar lote X del campo Y" (handler:2822 / parser.js:1373).
- CAM-22 "agregar lote Norte de 50 ha en campo La Loma" toma "50 ha en campo La Loma" como campo; "lote El Bajo del Arroyo" toma "Arroyo" como campo (parser.js:1064-1083).
- CAM-23 "borrar lote 3-4" propone el lote "3" (parser.js:1194).
- CAM-24 Se acepta invitación a un campo borrado (field-sharing.service.ts:276-300 no mira f.deleted_at).
- CAM-25 Campo propio y compartido con el mismo nombre: todo va al propio; el compartido es inalcanzable por nombre; "Ya existe" con [Actualizar ubic.] tocaría el del dueño (getFieldByName expenses.js:776 primera fila).
- CAM-26 "¿En qué lote?" del gasto: "lote 7" inexistente + "si" guarda con field_id y plot_id NULL aunque hay un solo campo.
- CAM-27 Siembra en lote homónimo: pregunta en texto sin botones; "el de San Jorge" repite la pregunta.

## P2
- CAM-28 "mis lotes" fusiona dos campos con el mismo nombre (handler:3055).
- CAM-29 Aviso de localidades homónimas/sugerencias (handler:2737-2753) no llega; "la de buenos aires" no se entiende.
- CAM-30 Mensajes muestran el nombre normalizado ("*la pena*").
- CAM-31 Miembro que pide "compartir campo X" sin número: primero "¿A qué número?" y después el rechazo (sharing.handler.ts:56).
- CAM-32 La dueña no puede borrar un gasto que cargó el miembro en su campo. Decisión de producto.
- CAM-33 No hay comando de chat para que el miembro salga de un campo.
- CAM-34 "¿Qué querés hacer?" duplicado en el aviso de campo duplicado.
- CAM-35 "Sí, crear y continuar" (hacienda en lote borrado) contesta "creá el lote primero". (= HAC-20)

## Probado y funciona
Alta de campo con localidad exacta/provincia/"Junin bs as"; flow por botones; mapa; duplicado exacto; lotes simples; batch con ha; cola de hectáreas con saltar/cancelar; límites 0/250000 en el pending; "sin sembrar" y "sembrados"; homónimos en borrar/renombrar con dueño único; onboarding con primera acción diferida; teléfonos argentinos canónicos; reenviar/revocar/código usado/inexistente/minúsculas; miembro como autor y la dueña lo ve; miembro no borra/renombra con nombre único ni comparte; quitar miembro por nombre o teléfono; herencia de acceso con prueba vencida; leaveField/removeMemberById.

## No pude probar
Elección de tool del modelo real; rutas HTTP y UI del dashboard; ubicación real de WhatsApp; vencimiento real a 7 días; recordatorios ligados a un lote borrado.
