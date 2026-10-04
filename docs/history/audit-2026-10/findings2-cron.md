# Ronda 2 — Tareas programadas (3 oct 2026). 4 graves, 9 medios, 4 menores; 7 reproducidos.
Inventario: todo en src/services/scheduler.js startScheduler() 1213-1306 (node-cron, sin lock entre procesos): tick semanal, monthlyTick, weatherAlertTick (cada min), proactiveAlertsTick (8 AR), dailyCleanupTick (3 AR), flowReminderTick (cada min), expenseTemplateTick (7 AR), subscriptionSweepTick (03:15), sweep pending_states (:30), reminderTick (cada min, guard en memoria), trialDripTick (:40), error-logger setInterval.
OJO contradicción a verificar: CRN dice que iniciar checkout en prueba NO bloquea (falso positivo); CTA-2 dice que sí bloquea (reproducido).
- CRN-1 G rep (= CTA-5): sweepExpired baja a free a quien tiene cancelada vieja + activa nueva, todas las noches. subscription.service.ts:290-300.
- CRN-2 G código: envíos proactivos WA fuera de ventana 24 h se pierden (error 131047 llega por webhook statuses, que no se procesa) y quedan 'sent'; sin plantillas. Recordatorios creados >24 h antes casi nunca llegan. whatsapp.js:62-89, whatsapp.controller.ts:169.
- CRN-3 G rep: flow_expires_at no se renueva con la actividad → a los 10 min cierra "por inactividad" un formulario en uso (y "¿Seguís ahí?" a los 5). conversation-engine.ts:417,1001-1017, scheduler.js:1022-1052.
- CRN-4 G rep: ticks concurrentes duplican: reminderTick sin claim atómico (reminder.service.ts:322-345), dedupKey mensual no chequeado (scheduler.js:1167-1173), flowReminderTick sin guard.
- CRN-5 M rep: rain_alerts=false igual manda alerta de lluvia. expenses.js:161-172, scheduler.js:487-505.
- CRN-6 M rep: resumen semanal a usuarios Telegram se manda por WhatsApp a tg_<id>; sin filtro borrados/testbot ni dedup. scheduler.js:379-399.
- CRN-7 M rep: Telegram falla → no cae a WhatsApp. alert.service.js:174-232.
- CRN-8 M código: sendMessageWithRetry reintenta errores permanentes 1+5+15 s → frena tick serial; testbot_* no excluidos en envíos. whatsapp.js:269-283.
- CRN-9 M rep: alertas proactivas ignoran plan y prueba vencida. scheduler.js:592-880.
- CRN-10 M código: recordatorio de monitoreo pregunta en texto suelto (invariante 5). scheduler.js:660.
- CRN-11 M código: resumen mensual sin forma de apagarlo; semanal/mensual/clima recorren cuentas borradas.
- CRN-12 M rep: gastos recurrentes fin de mes se corren (30 ene → 2 mar) y fecha = hoy, sin aviso, también cuentas borradas. expense-template.service.ts:96-149.
- CRN-13 M código (= CTA-6): borrar cuenta no cancela MP.
- CRN-14 m: semana del resumen depende de TZ de la DB (Railway UTC). scheduler.js:75-179.
- CRN-15 m: drip de prueba un día tarde (tramos 24 h vs días calendario). trial-drip.service.ts.
- CRN-16 m: dedup de lluvia solo primera ciudad; ventana 24 h exacta.
- CRN-17 m: sweepExpired sin try/catch por fila; fallos de sweeps sin logError.
