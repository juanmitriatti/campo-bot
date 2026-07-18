# Recordatorios con hora y minutos — Diseño

**Fecha:** 2026-07-18
**Estado:** Aprobado (pendiente de plan de implementación)

## Problema

La feature de recordatorios (migración 098, `reminder.service.ts`) solo maneja FECHA:

- `task_reminders.due_date` es `DATE` — sin hora.
- `resolveFutureDate()` entiende "mañana / el sábado / en N días" — nada de hora/minutos.
- `reminderTick` corre una vez por hora (cron `10 * * * *`, franja 07-21 AR) y manda TODOS
  los recordatorios que vencen hoy en el primer tick de la mañana (~07:10).
- La tool `create_reminder(description, due_date)` no tiene parámetro de hora.

El usuario no puede decir "acordame el sábado **a las 14:30** de fumigar" — la hora se
ignora y el aviso cae a la mañana.

## Decisiones acordadas

- **Precisión de disparo: exacta al minuto** — el cron del reminder pasa a `* * * * *`.
- **Sin hora → SE PREGUNTA** la hora (pending machine-readable). Todo recordatorio nuevo
  termina con hora explícita.
- **Solo una vez** — sin recurrencia ("todos los lunes" queda fuera de alcance).

## Diseño

### Schema (migración 100)

```sql
ALTER TABLE task_reminders ADD COLUMN due_time TIME; -- AR-local, nullable
```

Filas viejas quedan `due_time = NULL` (comportamiento legacy preservado).

### Disparo (`reminderTick`, ahora por minuto)

- Cron: `10 * * * *` → `* * * * *` en `scheduler.js` (~línea 1202).
- Fila **con** `due_time`: dispara cuando `due_date < hoy` O (`due_date = hoy` Y
  `due_time <= hora actual AR`). **Sin franja horaria** — el usuario eligió la hora.
- Fila **sin** `due_time` (legacy): comportamiento actual intacto (franja 07-21,
  dispara a la mañana del día que vence).
- Dedup igual que hoy: `pending → sent` (el UPDATE a `sent` previene el doble envío;
  el tick por minuto no cambia esa garantía).

### Parsing de hora (`resolveFutureTime`, nueva en `reminder.service.ts`)

Tipo de retorno: `{ time: string } | { ambiguous: true; hour: number; minute: number } | null`
— `{time}` cuando la hora es inequívoca (`HH:MM` 24h), el marcador `ambiguous` cuando es
1-11 sin calificador AM/PM, `null` cuando no hay señal de hora. Formas soportadas:

| Frase | Resultado |
|---|---|
| "a las 14:30" / "a las 14.30" / "14:30hs" | `14:30` |
| "a las 8" / "a las 8hs" (≥ 12 o con calificador) | ver ambigüedad |
| "a las 8 y media" | `08:30` (+ calificador) |
| "y cuarto" / "menos cuarto" | `:15` / `:45` de la hora anterior |
| "de la mañana" / "de la madrugada" | fuerza AM |
| "de la tarde" / "de la noche" | fuerza PM (+12 si < 12) |
| "al mediodía" | `12:00` |
| "a la tardecita" | `18:00` |
| "temprano" | `07:00` |
| "a la noche" | `21:00` |

**Ambigüedad AM/PM:** hora 1-11 SIN calificador ("a las 8") → NO se adivina: el handler
responde con botones `[🌅 8:00] [🌆 20:00]` (payload en `callbackPayloadStore`, mismo
patrón que los botones lote/feedlot de hacienda). Horas ≥ 12 o con calificador se
resuelven directo. `resolveFutureTime` devuelve para este caso un marcador
`{ ambiguous: true, hour: 8, minute: 0 }` para que el handler arme los botones.

### Tool `create_reminder`

- Gana parámetro opcional `due_time` (`HH:MM` 24h). Descripción: extraerla SOLO si el
  usuario la dijo — nunca inventarla; si no la dijo, omitir el param.
- Mapeo explícito de `due_time` en `agent-response-mapper` (regla conocida:
  description/due_date/cancel ya necesitan mapeo explícito ahí; el genérico no los copia).
- Red de seguridad server-side: el handler corre `resolveFutureTime(originalText)` cuando
  el agente no mandó `due_time` (mismo patrón que `resolveFutureDate` hoy). El valor del
  agente nunca se pisa — solo se llena el hueco.

### Falta la hora → pending (decisión: preguntar)

- Handler: `setPendingActivity({ command: 'create_reminder', data: { description,
  due_date }, missing: ['time'], askPrompt: '⏰ ¿A qué hora te lo recuerdo? (ej: "a las
  14:30")' })`.
- Slot nuevo `time` en `slot-extractor.ts` (extractor #13, reusa `resolveFutureTime`).
- La respuesta ("a las 3 de la tarde") la consume el pending-processor — NUNCA texto
  suelto (regla dura del proyecto). La escalera de escalamiento existente (razón +
  attempts + rescate por agente) aplica gratis.
- `create_reminder` debe poder re-rutearse vía `DomainRouter.routeCommand` con los slots
  mergeados (ya está en el set de SYSTEM_COMMANDS del router).

### Validación de hora pasada

Si `due_date = hoy` y `due_time < ahora` → no guardar ciego: "Esa hora ya pasó hoy.
¿Te lo recuerdo mañana a las HH:MM?" con botones Sí/No (payload con el reminder completo
en `callbackPayloadStore`; Sí → crea con due_date+1; No → cancela).

### Confirmación y listado

- Mensaje de creación: `⏰ Listo, te lo recuerdo el *sáb 19/07* a las *14:30*: "..."`.
- `formatReminderList`: agrega ` a las HH:MM` cuando `due_time` existe.
- Mensaje del tick: sin cambio de formato (ya dice "hoy"/"desde el dd/mm").

## Componentes tocados

| Archivo | Cambio |
|---|---|
| `src/migrations/100_task_reminders_time.sql` *(nuevo)* | `ADD COLUMN due_time TIME`. |
| `src/services/reminder.service.ts` | `resolveFutureTime()`; `createReminder` acepta `dueTime`; `reminderTick` con lógica por minuto + branch legacy; `formatReminderList` muestra hora. |
| `src/services/scheduler.js` | Cron del reminder `10 * * * *` → `* * * * *`. |
| `src/ai/tool-definitions.ts` | `create_reminder.due_time` opcional. |
| `src/ai/agent-response-mapper.ts` | Mapeo explícito de `due_time`. |
| `src/middleware/slot-extractor.ts` | Slot `time` (#13). |
| `src/domain/system/system.handler.ts` | `create_reminder`: red de seguridad `resolveFutureTime`, pending `missing:['time']`, botones AM/PM, validación hora pasada. |
| `src/domain/interactive/interactive.router.ts` | Callbacks de botones AM/PM y "¿mañana?". |

## Fuera de alcance (YAGNI, confirmado)

- Recordatorios recurrentes ("todos los lunes a las 8").
- Editar la hora de un recordatorio existente (cancelar + re-crear).
- UI de dashboard (la feature es chat-only).
- Timezone por usuario (todo AR, como el resto del sistema).

## Testing

- **Unit** (`reminder.service.test.ts`): tabla ~15 frases → `resolveFutureTime`
  (`HH:MM` / marcador ambiguo / null); `reminderTick` con hora — dispara cuando
  `due_time <= ahora`, no dispara antes, legacy sin hora respeta franja 07-21.
- **Integración** (harness FakeAgent, `pipeline.integration.test.ts`):
  1. Crear con fecha+hora explícitas → fila con `due_time` correcto.
  2. Crear sin hora → pending pregunta → responder "a las 15" → `due_time = 15:00`.
  3. Hora ambigua ("a las 8") → botones AM/PM → tap → fila correcta.
- Regla del proyecto: todo bug de interacción entre capas deja su regresión en el
  harness de integración, no solo en el eval.
