# Auditoría QA — Aislamiento entre usuarios y permisos (3 oct 2026, commit d23139c)

Base local. Harness con usuarios A (dueño), B (ajeno o miembro), C (ex miembro), D (prueba vencida), G (plan free). REST: auditoría estática.
9 P0 (6 confirmados: AIS-1..6; 3 según código: AIS-9..11) · 11 P1 (AIS-7, AIS-8 confirmados; AIS-12..20 según código) · 9 P2.

## P0
- AIS-1 (CONF) cat_pick_exp_/cat_pick_inc_ aceptan payload base64 inline con field_id/plot_id y no validan acceso: B guardó gasto $987.654 e ingreso $555.555 en el campo/lote de A; aparecen en el Resumen de A. cat_new_* y cat_sim_* misma decodificación (según código). Causa: interactive.router.ts:187/201/212/222 (`callbackPayloadStore.get(t) ?? t`), :230-275 (cat_sim_ sin store); financial.handler.ts:333-401 decode; :3716-3732 pickCategory, ~3780 resumeCreateCategory, ~3818/3848 categorySimilar*; expenses.js:393/420. Arreglo: sin token = botón vencido + [INTERCEPT]; store atado a userId; validar field/plot con accessibleFieldsSql antes de guardar.
- AIS-2 (CONF) lv_pick_loc_(health|repro|weigh)_<b64>_<plotId>_<corralId> escribe un evento en el lote de A y le muestra a B el nombre del lote y campo. lv_animals_* misma vía (según código). Causa: livestock.handler.ts:1506-1513, :1523-1531 copian ids a __resolvedPlotId/CorralId; :1436-1456 resolveEventLocationOrAsk sin validar y SELECT de nombre sin scope.
- AIS-3 (CONF) doc_warehouse_<idGalpónDeA>_1 sumó 50 lt al Glifosato del galpón de A (100 → 150). Causa: document-pipeline.ts rama doc_warehouse_; stock.service.ts:359-388; stock.repository.ts:166-176 findStockItem y :442 applyMovement sin scope.
- AIS-4 (CONF) doc_plot_<plotIdDeA> guarda el gasto del documento con plot_id de A (field_id null). Causa: document-pipeline.ts rama doc_plot_ pasa el plotId crudo si no está entre los del usuario.
- AIS-5 (CONF) Un MIEMBRO borra el campo compartido y sus lotes tocando confirm_delete_field_<nombre> / confirm_delete_plot_<lote>_in_<campo>; desvincula gastos/ingresos del dueño (no se revierte al restaurar). Por texto sí se bloquea. Causa: message-pipeline.ts:2185-2196 y :2199-2222 sin isOwner; expenses.js:832 deleteField (getFieldByName accesibles) y :1151 deletePlot UPDATE por id. El chequeo solo existe al ARMAR el botón (financial.handler.ts:2818, :2843, :3327).
- AIS-6 (CONF) Prueba vencida: contestar un pending abierto antes del vencimiento escribe igual (fumigación registrada). Causa: message-pipeline.ts:1058-1346 procesa el pending antes de intentClassifier.classify (:1389); el gate de acceso está en STEP 0 (intent-classifier.ts:270-283); routeCommand aplica plan pero no access_mode. Probablemente igual: flows, confirm_pending, taps (handleInteractiveReply no llama getUserAccessMode). Arreglo: gate de access_mode en el borde (processTextMessage + handleInteractiveReply) o en routeCommand para escrituras.
- AIS-9 (código, verificado) Webhook de WhatsApp sin verificación de firma X-Hub-Signature-256 (app.ts:55; whatsapp.controller.ts:139-180 toma identidad de message.from). Un POST sin credenciales actúa como cualquier número. Arreglo: HMAC-SHA256 del body crudo con App Secret, timingSafeEqual, fallar cerrado en prod.
- AIS-10 (código) PATCH /api/auth/stock/:id: UPDATE solo por id (auth.routes.ts:1431-1458).
- AIS-11 (código) GET /api/auth/stock/:id/movements lee ítem y movimientos ajenos (auth.routes.ts:1413-1429; stock.repository.ts:371-381, :428-437).

## P1
- AIS-7 (CONF) Ex miembro completa un pending de superficie abierto antes de ser quitado y cambia un lote del dueño. Causa: setPlotArea (expenses.js:1201) UPDATE por id. Arreglo: revalidar acceso al consumir pendings; al quitar miembro, clearAllUserPendingState.
- AIS-8 (CONF) Miembro crea lotes en el campo del dueño con create_plot_*_in_<campo> (message-pipeline.ts:2159-2177 sin isOwner). Decisión de política.
- AIS-12 POST /animals y POST /animals/batches/:id/apply aceptan ids ajenos: devuelven nombres y tocan individualized_count ajeno (auth.routes.ts:1807, :1994; animal.repository.ts:318-345, :355-366, :387-425).
- AIS-13 /analytics/livestock y /analytics/agronomic no validan field_id (auth.routes.ts:2256-2278, :2496-2518; no usan resolveFieldIds).
- AIS-14 Miembro pisa la localidad del campo del dueño vía POST /api/auth/fields (auth.routes.ts:608-639; setFieldCity expenses.js:753).
- AIS-15 Miembro renombra/borra feedlots y corrales (auth.routes.ts:2055-2185, sin assertFieldOwner). Política.
- AIS-16 Ex miembro conserva edición/borrado de lo que cargó en el campo ajeno por REST (filtran por autor). Decisión de producto.
- AIS-17 Paywall de prueba vencida solo en frontend: ninguna ruta REST llama getUserAccessMode; submitForm tampoco. Arreglo: requireWriteAccess en no-GET y en submitForm.
- AIS-18 /api/test-bot/text-with-attachment sin gate de admin en prod (test-bot.controller.ts:201-217), sin withUserLock.
- AIS-19 /api/test-bot/query-db ejecuta SQL libre con header x-test-secret + cualquier JWT, sin rol admin (test-bot.controller.ts:414-440); si no detecta Railway, el gate queda abierto. Arreglo: rol admin o deshabilitar en prod.
- AIS-20 Formularios no chequean prueba vencida (token conversacional hasta 24 h).

## P2
1. callbackPayloadStore no ata el token al usuario (token 48 bits, 10 min). Arreglo: userId en set(), exigirlo en get().
2. SELECT de nombre por id sin scope: livestock.handler.ts:548-552, :574-578; agronomy.handler.ts:4289.
3. UPDATE por id sin usuario en deletePlot, setPlotArea, setPlotGrupo, renameField, renamePlot, setFieldCoordinates, setFieldPolygon (expenses.js) — causa raíz de AIS-5/AIS-7.
4. link_document_to_expense no valida expenseId propio (document.repository.ts:44).
5. removeMemberByIdentifier no llama invalidateUserContext ni limpia pendings (field-sharing.service.ts:386-445).
6. Webhooks de Telegram/MercadoPago abiertos si falta el secreto; GET /webhook con VERIFY_TOKEN indefinido acepta undefined===undefined y refleja hub.challenge.
7. POST /sharing/join sin rate limit, filtra el teléfono invitado, canje no atómico (código legacy).
8. /overview y /review sin requireFeature; PATCH /activities/:id acepta lote borrado ajeno y filtra su nombre (observation.service.ts:637-650).
9. requireAuth no revalida estado/rol (15 min de gracia); PATCH /me cambia email sin contraseña; sin rate limit en OTP de WhatsApp y join; sin helmet ni rate limit global.

## Probado y seguro (sonda)
cmd_historial_, lv_post_undo_movement_/event_, harvest_cost_yes_, bap2_/bap_ v1, lv_post_stock_/gdpv_/health_hist_, rain_field_, confirm_delete_*/create_plot_ con campo NO compartido, animal_batch_move_; sow_replace_ con token ajeno escribe solo en lo propio; miembro por texto rechazado en share/remove/borrar/renombrar; ex miembro no ve el campo; plan free bloqueado en textos, taps y pendings (gate en DomainRouter.dispatchCommand); prueba vencida bloquea mensajes nuevos de escritura.

## No pude probar
cform_ y /api/forms/:token con usuario ajeno; rutas REST con sonda HTTP; lv_animals_*, cat_new_*, cat_sim_* sin sonda propia; lv_loc_*, lv_move_*, lv_create_*_continue_, wcity_, remt_/remtmw_, rain_batch_; prueba vencida en flow_confirm, confirm_pending, taps de stock y formularios; caché de contexto de 60 s; audio y documentos con prueba vencida.
