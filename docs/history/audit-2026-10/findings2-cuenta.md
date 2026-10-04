# Ronda 2 — Cuenta y cobro (3 oct 2026). 7 graves reproducidos, 5 medios, 4 menores.
Patrón común CTA-1..4: fila pendiente de pago = status 'trial' sin fecha que cancela la vigente antes de pagar + dedup del webhook por data.id. NO activar PAYMENTS_ENABLED hasta arreglar CTA-1..4.
- CTA-1 G rep: webhook dedup por data.id (preapproval) → el 'authorized' después del 'created' se descarta; pagador queda trial/free/readonly. subscription.service.ts:213,228. Arreglo: clave = id notificación o preapproval+status; reprocesar eventos con error.
- CTA-2 G rep: abrir checkout y no pagar → createPending cancela vigente e inserta trial sin trial_ends_at → readonly al instante, nunca vence. subscription.repository.ts:87-96, access-gate.service.ts:91. Arreglo: estado 'pending' propio, cancelar la vieja al authorized.
- CTA-3 G rep: cambio de plan/período no cancela la preapproval vieja en MP → doble cobro. subscription.repository.ts:87-91, subscription.service.ts:162.
- CTA-4 G rep: pagar con link viejo → authorized sobre fila cancelada choca idx_subscriptions_user_active, evento con error, ruta 200 sin reintento: cobrado sin plan. subscription.service.ts:233-246, webhooks.routes.ts.
- CTA-5 G rep: sweepExpired baja a free a quien tiene cancelada vieja + activa nueva, todos los días. subscription.service.ts:289-298.
- CTA-6 G rep: borrar cuenta no cancela suscripción ni MP. account-deletion.service.ts:30-84.
- CTA-7 G rep (con REQUIRE_VERIFIED_CHANNEL): vincular WA/TG de un número que ya usó el bot → 23505 unique, 500, código consumido. channel-verification.service.ts:171-187, 283-289. Arreglo: fusionar usuario no verificado o 409 sin consumir.
- CTA-8 M+ rep: miembro hereda access full del dueño Pro+ pero features por plan propio (free) → bloqueado en agronomía/hacienda. router.ts:271-273, feature-gate.ts:30.
- CTA-9 M rep: plan asignado por admin no destraba prueba vencida. dashboard.js:834-855.
- CTA-10 M rep: rate limit token endpoints por IP global (sin trust proxy) → 120 requests bloquean reset para todos. auth-rate-limit.ts:146.
- CTA-11 M código: prueba infinita reciclando WhatsApp (unlink + cuenta nueva).
- CTA-12 M parcial: borrado de cuenta deja name/last_name/city/province, historial; purga a 30 días no existe; cuentas del bot sin contraseña no pueden borrarse.
- CTA-13 m código: PATCH /me cambia email sin contraseña; no invalida resets.
- CTA-14 m código: MP_WEBHOOK_SECRET vacío = sin firma; ts sin frescura.
- CTA-15 m código: usuarios sin fila de suscripción = full para siempre (altas manuales admin).
- CTA-16 m código: JWT de cuenta borrada/suspendida/admin degradado sigue 15 min (incluye /admin/api).
