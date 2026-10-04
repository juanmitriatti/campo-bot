# Verificación — Campos, lotes y compartir (commit 333b89b)

REPRODUCIDOS (21): CAM-1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 24, 25. Ninguno es comportamiento intencional según CLAUDE.md.
No verificados: CAM-20..23, CAM-26..35.

Causas confirmadas (líneas actuales):
- CAM-1: financial.handler.ts:2802-2814 arma confirm_delete_plot_* antes del isOwner (2816); message-pipeline.ts:2199-2219 deletePlot sin dueño.
- CAM-2: handler:3364, 3373 sin rol; set_field_city 2483+ → expenses.js:745; restorePlot expenses.js:1177; add_plot handler:3213.
- CAM-3: message-pipeline.ts:2105-2113 → handleConfirm sin revalidar; pending-plot-area-handler.ts:189-192 setPlotArea(plotId); field-sharing.service.ts:590 removeMemberById no limpia pendings.
- CAM-4: expenses.js:848-856, 1158-1160 SET NULL (también gastos de miembros: sin filtro user_id); restoreField 868 / restorePlot 1177 no re-vinculan.
- CAM-5: parser.js:1373 + expenses.js:873 LOWER(name) (invariante 3); UNIQUE migración 001 incluye borrados.
- CAM-6: message-pipeline.ts:2185-2196 no one-shot ni askDestructiveConfirmation.
- CAM-7: confirmación de delete_plot en handler:3320-3349 y 2817 no cuenta nada (ni gastos); deletePlot expenses.js:1151 no mira hacienda/stock/campañas.
- CAM-8: parser.js:1275, 1298 (sin . - ' y {0,3}); con "3-4" y "O'Higgins" también se pierde la localidad.
- CAM-9: conversation-engine.ts:649 extractRenameCorrection en cualquier paso ≠ name.
- CAM-10: pending-plot-area-handler.ts parseNamedAreas 91-105, isBareHectaresAnswer 73, parseHectares 9.
- CAM-11: handler:3364-3370 sin validar.
- CAM-12: handler:3369, 3397 plots[0].
- CAM-13: parser.js:1051-1053.
- CAM-14: message-pipeline.ts:2134 (botón field_dup_update no pasa province); expenses.js:753-757 COALESCE(latitude) y LOWER(name). Sin acento la provincia SÍ se actualiza; quedan viejas las coordenadas.
- CAM-15: accept_invite falta en TRIVIAL_COMMANDS (intent-classifier.ts:77-115).
- CAM-16: message-pipeline.ts:805 solo plotName; mensaje de :1485. El botón funciona (P1 correcto).
- CAM-17: paso city del field_flow sin escape.
- CAM-18: UNIQUE de migraciones 001:8 y 007:17 sin WHERE deleted_at IS NULL.
- CAM-19: expenses.js:896-903.
- CAM-24: field-sharing.service.ts:276-282.
- CAM-25 PEOR DE LO INFORMADO: setFieldCity (expenses.js:745-758) hace UPDATE masivo por nombre sobre todos los campos accesibles: un miembro con un campo homónimo propio le cambia la ubicación al del dueño. Subir a grave (misma clase que CAM-2).
