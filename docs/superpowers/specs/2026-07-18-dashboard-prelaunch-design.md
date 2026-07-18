# Dashboard pre-lanzamiento — Diseño

**Fecha:** 2026-07-18
**Estado:** Aprobado (pendiente de plan de implementación)

## Contexto

Auditoría pre-prod del dashboard de usuario final (2026-07-18). Este paquete cubre los
bloqueantes de seguridad/limpieza + los "muy recomendados antes de anunciar". Fase 2
(creación manual de registros, edición de cosechas/monitoreos/documentos, campaign stats,
pizarra, presupuestos) queda explícitamente fuera.

## Decisiones acordadas

- Recordatorios: **tab propio** en el dashboard.
- Chat de prueba: **solo admin** (ruta frontend + endpoint backend), no se elimina.

## A. Chat de prueba solo-admin (bloqueante)

- `frontend/src/App.tsx`: la ruta `/chat` pasa de `allowedRoles={['end_user','admin']}` a
  `allowedRoles={['admin']}`.
- `src/controllers/test-bot.controller.ts`: `POST /api/test-bot` y `POST /api/test-bot/audio`
  ganan un check: `user.role === 'admin' || !IS_PROD_RUNTIME`. En prod, un usuario no-admin
  recibe 403. El eval y CI (no-prod) siguen funcionando sin cambios. Log del rechazo.
- Los endpoints QA (`/reset`, `/query-db`) ya están protegidos por `testEndpointGate`
  (404 en prod sin `TEST_BOT_SECRET`) — sin cambios.

## B. `/samples` afuera (bloqueante)

- Eliminar el mount `app.use('/samples', ...)` de `src/app.ts` (~línea 76, comentado como
  "temporary share — remove after demo") y la carpeta `src/public/samples` si existe.

## C. Verificación QA gate (bloqueante, solo verificación)

- Confirmar que `TEST_BOT_SECRET` NO está seteado en Railway (sin secret → 404 en prod).
- Sin cambios de código.

## D. Tab "Campos" (nuevo)

Vista de gestión de campos y lotes — el gap #1 de la auditoría (hoy solo aparecen como
filtros y en el mapa; no se puede renombrar ni corregir hectáreas desde la web).

- **Muestra:** lista de campos (nombre, localidad read-only, total has) con lotes anidados
  (nombre, hectáreas, cultivo activo).
- **Edita:** renombrar campo, renombrar lote, hectáreas de lote. NADA más en v1: sin
  crear, sin borrar, sin editar localidad (la localidad requiere validación de censo que
  vive en el flujo del bot).
- **Backend nuevo** (en `auth.routes.ts`, gate `requireFeature('fields')`):
  - `GET /api/auth/fields-tree` — campos + lotes + cultivo activo del usuario.
  - `PATCH /api/auth/fields/:id` — body `{ name }`. Valida no-vacío, único por usuario
    (case/acento-insensible vía `entity-matcher.sqlNormalizedName`).
  - `PATCH /api/auth/plots/:id` — body `{ name?, hectares? }`. Mismas validaciones de
    nombre (único dentro del campo); hectáreas > 0 y <= 100000.
- Todos los UPDATEs user-scoped (JOIN a fields.user_id). El rename es compatible con el
  bot: los lookups usan `entity-matcher` (normalización), así que el nombre nuevo resuelve
  igual que uno puesto por chat.
- **Frontend:** `FieldsTab.tsx` + entrada "Campos" en Sidebar y BottomNav (sin feature
  gate en el frontend — `fields` está en todos los planes). Edición inline o modal chico,
  siguiendo el patrón de los EditModal existentes.

## E. Eliminar en Gastos / Ingresos / Actividades

- Botón 🗑 por fila + modal de confirmación que muestra el registro (fecha, monto/desc).
- **Backend nuevo:** `DELETE /api/auth/expenses/:id`, `DELETE /api/auth/incomes/:id`,
  `DELETE /api/auth/activities/:id` — **soft-delete** (`deleted_at = NOW()`), mismo
  mecanismo que usa el bot. User-scoped. Gates: `expenses`/`incomes`/`agronomy`
  respectivamente. Nota: `domain_events` (actividades) — verificar si tiene `deleted_at`;
  si no la tiene, agregar migración con la columna + filtrar en las queries de lectura
  del dashboard y el bot (paridad con expenses/incomes).
- **Frontend:** botón en `ExpenseTable`/`IncomeTable`/`ActivityTable` (desktop y cards
  mobile), refresco de la lista tras borrar.

## F. Cambio de contraseña (Mi cuenta)

- Card "Contraseña" en `ChannelLinking.tsx` (Mi cuenta): contraseña actual + nueva ×2
  (mín 8 chars).
- **Backend nuevo:** `POST /api/auth/me/password` — body `{ currentPassword, newPassword }`.
  Verifica bcrypt actual (403 si no coincide), hashea la nueva (mismo `BCRYPT_ROUNDS` que
  el resto), **revoca los refresh tokens del usuario** (menos opcionalmente el actual;
  si la infraestructura de tokens no distingue sesión actual, revocar todos y el frontend
  re-loguea con un mensaje claro).
- Errores en español: "La contraseña actual no es correcta", "La nueva contraseña debe
  tener al menos 8 caracteres".

## G. Tab "Recordatorios" (nuevo)

- **Muestra:** lista de `task_reminders` del usuario: descripción, fecha + hora
  (`due_time`, feature de hoy), lote/campo, estado (pendiente / avisado / hecho /
  cancelado). Pendientes+avisados arriba (orden por due_date+due_time), hechos/cancelados
  colapsados o con filtro.
- **Acciones:** marcar hecho, cancelar (con confirmación). Sin crear/editar desde web en
  v1 — se crean por chat.
- **Backend nuevo** (sin feature gate más allá de auth):
  - `GET /api/auth/reminders` — query param opcional `status=all|open` (default open =
    pending+sent).
  - `PATCH /api/auth/reminders/:id` — body `{ action: 'done' | 'cancel' }`. Reusa
    `completeReminder(userId, { id, cancel })` de `reminder.service.ts`.
- **Frontend:** `RemindersTab.tsx` + entrada "Recordatorios" en Sidebar y BottomNav.

## Fuera de alcance (fase 2, confirmado)

- Crear gastos/ingresos/actividades/lluvia desde la web.
- Editar cosechas, monitoreos, eventos de hacienda, documentos.
- Campaign stats, pizarra de granos, presupuestos, plantillas de gastos en el dashboard.
- Crear/borrar campos y lotes desde la web; editar localidad.
- Crear/editar recordatorios desde la web.
- Edición de perfil (nombre/email/ciudad) — se difiere; el cambio de contraseña es lo
  crítico para el lanzamiento.

## Testing

- **Backend:** tests de integración de rutas (vitest + DB) para los endpoints nuevos:
  fields-tree scoping (no ve campos ajenos), rename con colisión de nombre, hectáreas
  inválidas, soft-delete + que la lectura ya no lo devuelve, password (actual mala → 403,
  nueva corta → 400, éxito → tokens revocados), reminders list + done/cancel + scoping.
- **Frontend:** `cd frontend && npm run build` sin errores TS; verificación manual.
- **Regresión bot:** el rename de lote desde web debe seguir resolviendo en el bot
  ("gasté 5000 en <nuevo nombre>") — cubierto conceptualmente por entity-matcher; test
  de integración del pipeline con FakeAgent: renombrar por SQL → registrar por chat.

## Orden de ejecución

1. **Task 1 (seguridad/limpieza):** A + B + C.
2. **Task 2 (datos):** D + E (backend + frontend).
3. **Task 3 (cuenta + recordatorios):** F + G (backend + frontend).
