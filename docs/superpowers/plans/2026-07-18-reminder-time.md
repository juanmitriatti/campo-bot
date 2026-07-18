# Recordatorios con hora y minutos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El usuario puede setear día/fecha + hora y minutos exactos para cualquier recordatorio ("acordame el sábado a las 14:30 de fumigar"), con disparo al minuto.

**Architecture:** Se agrega `due_time TIME` (nullable, AR-local) a `task_reminders`; el tick del scheduler pasa a correr por minuto y dispara con-hora exacto / sin-hora legacy (franja 07-21). `resolveFutureTime()` parsea la hora en español argentino con desambiguación AM/PM vía botones. Cuando falta la hora, el handler deja un pending machine-readable (`missing:['time']`, slot nuevo en el slot-extractor) — nunca pregunta con texto suelto.

**Tech Stack:** TypeScript (ESM), vitest, PostgreSQL (migración), node-cron, harness de integración FakeAgent.

## Global Constraints

- ESM modules (`import`/`export` con extensión `.js` en los import paths), NO `require`.
- Todo texto de cara al usuario en español argentino.
- **NINGUNA pregunta al usuario puede ser texto suelto** — siempre pending machine-readable o botones.
- Nuevos comandos/params: mapeo explícito en `agent-response-mapper` (el genérico no copia `due_time`).
- El valor que manda el agente NUNCA se pisa server-side — solo se llena el hueco.
- Botones: payload via `callbackPayloadStore.set(payload) → token` (límite de 64 bytes de Telegram).
- Filas legacy (`due_time IS NULL`) mantienen el comportamiento actual: franja 07-21 AR, disparo a la mañana.
- Tipo de retorno de `resolveFutureTime`: `{ time: string } | { ambiguous: true; hour: number; minute: number } | null`.
- Timezone: `America/Argentina/Buenos_Aires` via helpers de `src/utils/date.ts` (`getNowArgentina`, `getTodayISO`).
- Sin recurrencia, sin edición de hora, sin UI de dashboard (YAGNI confirmado).

---

### Task 1: Migración + `resolveFutureTime` + `createReminder` con hora + `reminderTick` por minuto

**Files:**
- Create: `src/migrations/101_task_reminders_time.sql`
- Modify: `src/services/reminder.service.ts`
- Modify: `src/services/scheduler.js:1202` (cron `10 * * * *` → `* * * * *`)
- Test: `src/services/__tests__/reminder.service.test.ts` (agregar describes)

**Interfaces:**
- Consumes: `getNowArgentina()`, `getTodayISO()` de `../utils/date.js`; `pool` de `../config/db.js`.
- Produces (Task 2 depende de esto):
  - `export type ResolvedTime = { time: string } | { ambiguous: true; hour: number; minute: number } | null`
  - `export function resolveFutureTime(text: string | null | undefined): ResolvedTime`
  - `createReminder(userId, description, dueDate, opts)` — `opts` gana `dueTime?: string | null` (formato `HH:MM`); el `TaskReminder` devuelto gana `due_time?: string | null`.
  - `formatReminderList` muestra ` a las HH:MM` cuando hay hora.

- [ ] **Step 1: Write the failing tests**

En `src/services/__tests__/reminder.service.test.ts`, agregar el import de `resolveFutureTime` al import existente de `reminder.service.js` y estos describes al final:

```ts
describe('resolveFutureTime — hora en español argentino', () => {
  it('formas explícitas 24h', () => {
    expect(resolveFutureTime('acordame a las 14:30 de fumigar')).toEqual({ time: '14:30' });
    expect(resolveFutureTime('a las 14.30')).toEqual({ time: '14:30' });
    expect(resolveFutureTime('14:30hs')).toEqual({ time: '14:30' });
    expect(resolveFutureTime('a las 20')).toEqual({ time: '20:00' });
    expect(resolveFutureTime('a las 12')).toEqual({ time: '12:00' });
  });

  it('calificador AM/PM resuelve horas chicas', () => {
    expect(resolveFutureTime('a las 8 de la mañana')).toEqual({ time: '08:00' });
    expect(resolveFutureTime('a las 8 de la noche')).toEqual({ time: '20:00' });
    expect(resolveFutureTime('a las 3 de la tarde')).toEqual({ time: '15:00' });
    expect(resolveFutureTime('a las 2 de la madrugada')).toEqual({ time: '02:00' });
  });

  it('fracciones: y media / y cuarto / menos cuarto', () => {
    expect(resolveFutureTime('a las 8 y media de la mañana')).toEqual({ time: '08:30' });
    expect(resolveFutureTime('a las 5 y cuarto de la tarde')).toEqual({ time: '17:15' });
    expect(resolveFutureTime('a las 8 menos cuarto de la noche')).toEqual({ time: '19:45' });
  });

  it('palabras de momento del día', () => {
    expect(resolveFutureTime('al mediodía')).toEqual({ time: '12:00' });
    expect(resolveFutureTime('a la tardecita')).toEqual({ time: '18:00' });
    expect(resolveFutureTime('temprano')).toEqual({ time: '07:00' });
    expect(resolveFutureTime('a la noche')).toEqual({ time: '21:00' });
  });

  it('hora 1-11 sin calificador → marcador ambiguo (se pregunta con botones)', () => {
    expect(resolveFutureTime('a las 8')).toEqual({ ambiguous: true, hour: 8, minute: 0 });
    expect(resolveFutureTime('a las 8 y media')).toEqual({ ambiguous: true, hour: 8, minute: 30 });
  });

  it('sin señal de hora → null', () => {
    expect(resolveFutureTime('acordame el sábado de fumigar')).toBeNull();
    expect(resolveFutureTime('fumigar el lote 5')).toBeNull();
    expect(resolveFutureTime(null)).toBeNull();
  });

  it('no confunde cantidades con horas', () => {
    expect(resolveFutureTime('comprar 8 bolsas')).toBeNull();
    expect(resolveFutureTime('pagar 14 mil')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/reminder.service.test.ts`
Expected: FAIL — `resolveFutureTime` is not exported.

- [ ] **Step 3: Implement `resolveFutureTime` + widen `createReminder`/`TaskReminder`/`formatReminderList`**

En `src/services/reminder.service.ts`:

(a) Agregar el tipo y la función después de `resolveFutureDate` (~línea 76):

```ts
export type ResolvedTime = { time: string } | { ambiguous: true; hour: number; minute: number } | null;

const MOMENT_WORDS: Array<[RegExp, string]> = [
  [/\bal\s+mediodia\b/, '12:00'],
  [/\ba\s+la\s+tardecita\b/, '18:00'],
  [/\btemprano\b/, '07:00'],
  [/\ba\s+la\s+noche\b/, '21:00'],
];

/**
 * Resuelve una frase de HORA a { time: 'HH:MM' } (24h). Hora 1-11 sin
 * calificador AM/PM → { ambiguous } (el handler pregunta con botones — NUNCA
 * adivinamos: "a las 8" puede ser 08:00 o 20:00). Sin señal de hora → null.
 * Solo detecta horas con marcador explícito ("a las", "hs", ":") — un número
 * suelto ("8 bolsas") no es una hora.
 */
export function resolveFutureTime(text: string | null | undefined): ResolvedTime {
  if (!text) return null;
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  for (const [re, time] of MOMENT_WORDS) {
    if (re.test(t)) return { time };
  }

  // "a las 14:30" / "a la 1:15" / "14.30hs" / "a las 8" / "8hs" / "a las 8 y media"
  const m = t.match(
    /\b(?:a\s+las?\s+)(\d{1,2})(?:[:.](\d{2}))?(?:\s*hs?\b)?(?:\s+(y\s+media|y\s+cuarto|menos\s+cuarto))?/,
  ) ?? t.match(/\b(\d{1,2})[:.](\d{2})\s*hs?\b/) ?? t.match(/\b(\d{1,2})\s*hs\b(?:\s+(y\s+media|y\s+cuarto|menos\s+cuarto))?/);
  if (!m) return null;

  let hour = Number(m[1]);
  let minute = m[2] != null && /^\d{2}$/.test(m[2]) ? Number(m[2]) : 0;
  const fraction = (m[3] ?? m[2]) as string | undefined; // según cuál regex matcheó
  if (typeof fraction === 'string' && /y\s+media/.test(fraction)) minute = 30;
  else if (typeof fraction === 'string' && /y\s+cuarto/.test(fraction)) minute = 15;
  else if (typeof fraction === 'string' && /menos\s+cuarto/.test(fraction)) { minute = 45; hour = hour - 1; }
  if (hour > 23 || minute > 59 || hour < 0) return null;

  const isAM = /de\s+la\s+(manana|madrugada)/.test(t);
  const isPM = /de\s+la\s+(tarde|noche)/.test(t);
  if (isPM && hour < 12) hour += 12;
  if (isAM && hour === 12) hour = 0;

  const pad = (n: number) => String(n).padStart(2, '0');
  // 1-11 sin calificador ni formato 24h explícito (":MM" cuenta como explícito
  // solo si la hora ya es >= 12): ambiguo → botones.
  if (!isAM && !isPM && hour >= 1 && hour <= 11) {
    return { ambiguous: true, hour, minute };
  }
  return { time: `${pad(hour)}:${pad(minute)}` };
}
```

(b) `TaskReminder` gana el campo:

```ts
export interface TaskReminder {
  id: number;
  description: string;
  due_date: string; // YYYY-MM-DD
  due_time?: string | null; // HH:MM (AR) — null = legacy sin hora
  status: 'pending' | 'sent' | 'done' | 'cancelled';
  plot_name?: string | null;
  field_name?: string | null;
}
```

(c) `createReminder` acepta y persiste la hora (reemplazar la función entera):

```ts
export async function createReminder(
  userId: number,
  description: string,
  dueDate: string,
  opts: { fieldId?: number | null; plotId?: number | null; dueTime?: string | null } = {},
): Promise<TaskReminder> {
  const { rows } = await pool.query(
    `INSERT INTO task_reminders (user_id, description, due_date, due_time, field_id, plot_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, description, due_date::text, to_char(due_time, 'HH24:MI') AS due_time, status`,
    [userId, description, dueDate, opts.dueTime ?? null, opts.fieldId ?? null, opts.plotId ?? null],
  );
  return rows[0];
}
```

(d) `listReminders`: agregar `to_char(r.due_time, 'HH24:MI') AS due_time,` al SELECT (después de `r.due_date::text,`).

(e) `formatReminderList`: en el loop de líneas, reemplazar la línea del push por:

```ts
    const hora = r.due_time ? ` a las ${r.due_time}` : '';
    lines.push(`• ${r.description}${loc} — *${fmtDue(r.due_date)}${hora}*${overdue}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/reminder.service.test.ts`
Expected: PASS (los describes previos + los 7 nuevos).

- [ ] **Step 5: Create the migration**

Create `src/migrations/101_task_reminders_time.sql`:

```sql
-- Recordatorios con hora y minutos: "acordame el sábado a las 14:30 de
-- fumigar". due_time es AR-local y nullable — las filas viejas (NULL)
-- mantienen el comportamiento legacy (aviso a la mañana, franja 07-21).
-- El tick del scheduler pasa de horario a por-minuto para honrar minutos.
ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS due_time TIME;
```

Nota: verificar antes que no exista ya una `100_*.sql` (`ls src/migrations/ | tail -5`); si existe, usar el siguiente número libre y ajustar el nombre en todos lados.

- [ ] **Step 6: Rework `reminderTick` (con-hora exacto / sin-hora legacy) + cron por minuto**

En `src/services/reminder.service.ts`, reemplazar la función `reminderTick` entera:

```ts
/**
 * Tick del scheduler (POR MINUTO desde Jul 2026): dos poblaciones.
 *  - CON due_time: dispara cuando llega la hora exacta (o quedó vencido) —
 *    SIN franja horaria, el usuario eligió la hora.
 *  - SIN due_time (legacy): comportamiento original — franja 07-21 AR,
 *    dispara a la mañana del día que vence.
 * Dedup: pending → sent (igual que siempre).
 */
export async function reminderTick(
  send: (userId: number, contact: { phone: string | null; telegramId: string | null }, message: string) => Promise<boolean>,
): Promise<number> {
  const now = getNowArgentina();
  const hour = now.getHours();
  const today = getTodayISO();
  const nowHM = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const legacyInWindow = hour >= 7 && hour < 21;

  const { rows } = await pool.query(
    `SELECT r.id, r.description, r.due_date::text, to_char(r.due_time, 'HH24:MI') AS due_time,
            r.user_id, u.phone_number, u.telegram_id,
            p.name AS plot_name, f.name AS field_name
     FROM task_reminders r
     JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
     LEFT JOIN plots p ON p.id = r.plot_id
     LEFT JOIN fields f ON f.id = r.field_id
     WHERE r.status = 'pending'
       AND (
         -- Con hora: vencidos de días anteriores, u hoy cuando la hora llegó
         (r.due_time IS NOT NULL AND (r.due_date < $1 OR (r.due_date = $1 AND to_char(r.due_time, 'HH24:MI') <= $2)))
         -- Legacy sin hora: igual que siempre, gateado por franja en JS
         OR (r.due_time IS NULL AND r.due_date <= $1 AND $3)
       )
     ORDER BY r.id
     LIMIT 200`,
    [today, nowHM, legacyInWindow],
  );

  let sent = 0;
  for (const r of rows) {
    const loc = r.plot_name ? ` (lote ${r.plot_name})` : r.field_name ? ` (${r.field_name})` : '';
    const hora = r.due_time ? ` a las ${r.due_time}` : '';
    const when = r.due_date === today ? `hoy${hora}` : `desde el ${r.due_date.slice(8, 10)}/${r.due_date.slice(5, 7)}${hora}`;
    const msg = `⏰ *Recordatorio* (${when}):\n${r.description}${loc}\n\n_"listo el recordatorio" cuando lo hagas, o "mis recordatorios" para ver todos._`;
    try {
      const ok = await send(r.user_id, { phone: r.phone_number, telegramId: r.telegram_id }, msg);
      if (ok) {
        await pool.query(`UPDATE task_reminders SET status = 'sent', sent_at = NOW() WHERE id = $1`, [r.id]);
        sent++;
      }
    } catch (err) {
      console.error(`[reminders] send failed for #${r.id}:`, (err as Error).message);
    }
  }
  return sent;
}
```

En `src/services/scheduler.js` (~línea 1198), reemplazar el comentario + la línea del cron:

```js
  // Recordatorios de labores ("el sábado a las 14:30 tengo que fumigar") —
  // POR MINUTO desde Jul 2026 (precisión exacta para due_time). El tick separa
  // internamente con-hora (exacto, sin franja) de legacy sin-hora (franja
  // 07-21 AR). Telegram-first con fallback WhatsApp.
  cron.schedule("* * * * *", () => {
```

(El cuerpo del `.then(...)` no cambia.)

- [ ] **Step 7: Run full reminder tests + typecheck**

Run: `npx vitest run src/services/__tests__/reminder.service.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` — comparar contra el conteo en HEAD antes del cambio (hay ~195 pre-existentes); no debe crecer.

- [ ] **Step 8: Commit**

```bash
git add src/migrations/101_task_reminders_time.sql src/services/reminder.service.ts src/services/scheduler.js src/services/__tests__/reminder.service.test.ts
git commit -m "feat(reminders): due_time + resolveFutureTime + tick por minuto

Migración 101 (due_time TIME nullable, AR-local). resolveFutureTime parsea
hora argentina (14:30 / 8 y media de la mañana / mediodía) con marcador de
ambigüedad AM/PM para 1-11 sin calificador. reminderTick pasa a por-minuto:
con-hora dispara exacto sin franja; legacy sin-hora mantiene franja 07-21.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Tool + mapper + slot `time` + handler (pending de hora, botones AM/PM, hora pasada) + tests de integración

**Files:**
- Modify: `src/ai/tool-definitions.ts:761-773` (schema `create_reminder`)
- Modify: `src/ai/agent-response-mapper.ts:818-824` (mapeo `due_time`)
- Modify: `src/middleware/slot-extractor.ts` (slot `time`)
- Modify: `src/middleware/pending-action-processor.ts:308` (`SLOT_LABEL.time`)
- Modify: `src/domain/system/system.handler.ts:403-418` (case `create_reminder`)
- Modify: `src/domain/interactive/interactive.router.ts` (callbacks `remt_` y `remtmw_`)
- Test: `src/testing/integration/__tests__/pipeline.integration.test.ts` (describe nuevo)

**Interfaces:**
- Consumes de Task 1: `resolveFutureTime(text): ResolvedTime` (`{time: 'HH:MM'} | {ambiguous, hour, minute} | null`), `createReminder(userId, desc, dueDate, { dueTime })`, `resolveFutureDate` (existente).
- Produces: comportamiento observable — crear con hora, pending `missing:['time']`, botones `remt_<token>_am|pm`, botón `remtmw_<token>_si|no` para hora pasada.

- [ ] **Step 1: Write the failing integration tests**

En `src/testing/integration/__tests__/pipeline.integration.test.ts`, agregar al final:

```ts
describe('recordatorios con hora', () => {
  it('crea con fecha y hora explícitas', async () => {
    const h = await createPipelineHarness('rem-hora');
    try {
      h.fakeAgent.enqueueTool('create_reminder', {
        description: 'fumigar el lote 5', due_date: '2099-01-05', due_time: '14:30',
      });
      const items = await h.send('acordame el 5 de enero a las 14:30 de fumigar el lote 5');
      expect(h.allText(items)).toContain('14:30');
      const rows = await h.q(
        `SELECT to_char(due_time, 'HH24:MI') AS t FROM task_reminders WHERE user_id = $1`,
        [h.userId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].t).toBe('14:30');
    } finally {
      await h.cleanup();
    }
  });

  it('sin hora → pregunta con pending; "a las 3 de la tarde" la completa', async () => {
    const h = await createPipelineHarness('rem-pending');
    try {
      h.fakeAgent.enqueueTool('create_reminder', {
        description: 'vacunar las vacas', due_date: '2099-01-05',
      });
      const ask = await h.send('acordame el 5 de enero de vacunar las vacas');
      expect(h.allText(ask)).toContain('hora');

      // La respuesta la consume el pending-processor — el agente NO se llama
      const callsBefore = h.fakeAgent.calls.length;
      const done = await h.send('a las 3 de la tarde');
      expect(h.fakeAgent.calls.length).toBe(callsBefore);
      expect(h.allText(done)).toContain('15:00');
      const rows = await h.q(
        `SELECT to_char(due_time, 'HH24:MI') AS t FROM task_reminders WHERE user_id = $1`,
        [h.userId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].t).toBe('15:00');
    } finally {
      await h.cleanup();
    }
  });

  it('hora ambigua ("a las 8") → botones AM/PM → tap crea con 20:00', async () => {
    const h = await createPipelineHarness('rem-ampm');
    try {
      h.fakeAgent.enqueueTool('create_reminder', {
        description: 'regar la huerta', due_date: '2099-01-05', due_time: 'a las 8',
      });
      const items = await h.send('acordame el 5 de enero a las 8 de regar la huerta');
      const buttons = h.allButtons(items);
      expect(buttons.length).toBe(2);
      const pm = buttons.find(b => b.title.includes('20:00'));
      expect(pm).toBeTruthy();

      const after = await h.tap(pm!.id);
      expect(h.allText(after)).toContain('20:00');
      const rows = await h.q(
        `SELECT to_char(due_time, 'HH24:MI') AS t FROM task_reminders WHERE user_id = $1`,
        [h.userId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].t).toBe('20:00');
    } finally {
      await h.cleanup();
    }
  });
});
```

Nota para el implementador: el 3er test manda `due_time: 'a las 8'` a propósito — el mapper solo copia strings y el handler debe pasar CUALQUIER `due_time` no-`HH:MM` por `resolveFutureTime`, cayendo al camino ambiguo. Si al implementar resulta más natural que el agente omita `due_time` y la ambigüedad se detecte desde `originalText`, ajustar el enqueue a `{ description, due_date }` y el `send` con el texto "a las 8" — lo que importa es que el flujo botones→tap→fila con 20:00 se ejercite de verdad.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/testing/integration/__tests__/pipeline.integration.test.ts -t "recordatorios con hora"`
Expected: FAIL — el primer test no encuentra `due_time` en la fila (columna existe por Task 1, pero el handler no la pasa). Requiere DB local (`docker compose up -d db`); sin DB los tests se saltean.

- [ ] **Step 3: Tool schema + mapper**

En `src/ai/tool-definitions.ts`, dentro de `create_reminder.input_schema.properties`, agregar después de `due_date`:

```ts
        due_time: { type: 'string', description: 'Hora del recordatorio HH:MM (24h), SOLO si el usuario la dijo ("a las 14:30" → "14:30", "a las 8 de la noche" → "20:00"). Si no dijo hora, OMITIR — el sistema la pregunta. NUNCA inventarla.' },
```

Y en la `description` de la tool, agregar al final: ` Si dice hora ("a las 14:30"), pasala en due_time.`

En `src/ai/agent-response-mapper.ts` (~línea 823), junto al mapeo existente de `due_date`:

```ts
      if (typeof input.due_time === 'string') cmd.due_time = input.due_time;
```

- [ ] **Step 4: Slot `time` en el slot-extractor + label**

En `src/middleware/slot-extractor.ts`:

(a) Agregar `| 'time'` al union `SlotName` (después de `| 'hectares'`).

(b) En `extractSlots`, antes del `return out;`:

```ts
  const time = extractTime(stripped);
  if (time) out.time = time;
```

(c) Agregar el extractor al final del archivo:

```ts
/**
 * Hora para recordatorios ("a las 14:30", "a las 3 de la tarde"). Devuelve
 * SOLO horas inequívocas en HH:MM — el caso ambiguo (1-11 sin AM/PM) NO se
 * extrae acá: el handler lo detecta vía resolveFutureTime y pregunta con
 * botones. Import dinámico no: reminder.service es liviano y sin ciclos.
 */
function extractTime(text: string): string | null {
  const r = resolveFutureTime(text);
  return r && 'time' in r ? r.time : null;
}
```

con el import arriba del archivo: `import { resolveFutureTime } from '../services/reminder.service.js';`

(d) En `src/middleware/pending-action-processor.ts`, agregar a `SLOT_LABEL` (~línea 308):

```ts
  time: 'la hora',
```

- [ ] **Step 5: Handler `create_reminder` (red de seguridad, pending, botones, hora pasada)**

En `src/domain/system/system.handler.ts`, reemplazar el case `create_reminder` completo (líneas ~403-418):

```ts
      case 'create_reminder': {
        const desc = (cmd.description as string | null)?.trim();
        if (!desc) {
          return { messages: ['¿Qué te recuerdo y cuándo? Ej: *"acordame el sábado a las 14:30 de fumigar el lote 5"*.'] };
        }
        const { createReminder, resolveFutureDate, resolveFutureTime } = await import('../../services/reminder.service.js');
        const { getTodayISO, getNowArgentina } = await import('../../utils/date.js');
        const dueDate = (cmd.due_date as string | null)
          || resolveFutureDate(cmd.originalText as string | null)
          || resolveFutureDate(desc);
        if (!dueDate) {
          return { messages: [`¿Para cuándo te lo recuerdo? Decime la frase completa con la fecha, ej: *"acordame el viernes a las 9 de ${desc}"*.`] };
        }

        // Hora: agente (due_time) → red de seguridad server-side (texto original).
        // El valor del agente nunca se pisa; si no es HH:MM válido, se re-parsea.
        const agentTime = (cmd.due_time as string | null) ?? null;
        let resolved = /^\d{2}:\d{2}$/.test(agentTime ?? '')
          ? { time: agentTime as string }
          : resolveFutureTime(agentTime)
            ?? resolveFutureTime(cmd.originalText as string | null)
            ?? resolveFutureTime(desc);

        // 1-11 sin AM/PM → botones (NUNCA adivinar, NUNCA pregunta de texto suelto)
        if (resolved && 'ambiguous' in resolved) {
          const { callbackPayloadStore } = await import('../../middleware/callback-payload-store.js');
          const pad = (n: number) => String(n).padStart(2, '0');
          const am = `${pad(resolved.hour)}:${pad(resolved.minute)}`;
          const pm = `${pad(resolved.hour + 12)}:${pad(resolved.minute)}`;
          const token = callbackPayloadStore.set(JSON.stringify({ d: desc, dd: dueDate }));
          return {
            messages: [],
            interactive: {
              type: 'buttons',
              body: `⏰ "${desc}" el ${dueDate.slice(8, 10)}/${dueDate.slice(5, 7)} — ¿a la mañana o a la noche?`,
              buttons: [
                { id: `remt_${token}_${am}`, title: `🌅 ${am}` },
                { id: `remt_${token}_${pm}`, title: `🌆 ${pm}` },
              ],
            },
          };
        }

        // Sin hora → pending machine-readable (missing:['time']) — regla dura
        if (!resolved) {
          return {
            messages: ['⏰ ¿A qué hora te lo recuerdo? (ej: *"a las 14:30"* o *"a las 8 de la mañana"*)'],
            sideEffects: {
              setPendingActivity: {
                command: 'create_reminder',
                data: { description: desc, due_date: dueDate },
                missing: ['time'],
                askPrompt: '⏰ ¿A qué hora te lo recuerdo? (ej: "a las 14:30")',
              },
            },
          };
        }

        const dueTime = resolved.time;
        // Hora pasada HOY → ofrecer mañana con botones (no guardar ciego)
        const now = getNowArgentina();
        const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (dueDate === getTodayISO() && dueTime < nowHM) {
          const { callbackPayloadStore } = await import('../../middleware/callback-payload-store.js');
          const token = callbackPayloadStore.set(JSON.stringify({ d: desc, dd: dueDate, t: dueTime }));
          return {
            messages: [],
            interactive: {
              type: 'buttons',
              body: `⏰ Las ${dueTime} de hoy ya pasaron. ¿Te lo recuerdo *mañana* a las ${dueTime}?`,
              buttons: [
                { id: `remtmw_${token}_si`, title: '👍 Sí, mañana' },
                { id: `remtmw_${token}_no`, title: '❌ No, dejalo' },
              ],
            },
          };
        }

        const r = await createReminder(Number(userId), desc, dueDate, { dueTime });
        const dd = `${r.due_date.slice(8, 10)}/${r.due_date.slice(5, 7)}`;
        return { messages: [`⏰ Listo, te lo recuerdo el *${dd}* a las *${dueTime}*:\n"${r.description}"\n\n_"mis recordatorios" para ver todos._`] };
      }
```

Nota: `cmd.due_time` llega vía el mapeo del Step 3. El re-ruteo del pending (`missing:['time']`) mergea el slot `time` como `cmd.time` (via `slotToCmdKeys` default) — por eso agregar TAMBIÉN, al inicio del case, la línea que promueve el slot mergeado:

```ts
        if (!cmd.due_time && typeof cmd.time === 'string') cmd.due_time = cmd.time;
```

(colocarla justo después de `const desc = ...` y antes del chequeo `if (!desc)`).

- [ ] **Step 6: Callbacks en el interactive router**

En `src/domain/interactive/interactive.router.ts`, junto a los otros callbacks con token (~línea 100), agregar:

```ts
    // Recordatorio — desambiguación AM/PM: remt_<token>_<HH:MM>
    const remtMatch = callbackId.match(/^remt_([A-Za-z0-9_-]+)_(\d{2}:\d{2})$/);
    if (remtMatch) {
      const payload = callbackPayloadStore.get(remtMatch[1]);
      if (payload) {
        try {
          const { d, dd } = JSON.parse(payload) as { d: string; dd: string };
          return { type: 'command', data: { command: 'create_reminder', description: d, due_date: dd, due_time: remtMatch[2] } };
        } catch { /* fall through */ }
      }
      return { type: 'command', data: { command: 'noop_expired_button' } };
    }

    // Recordatorio — hora pasada hoy: remtmw_<token>_si|no
    const remtmwMatch = callbackId.match(/^remtmw_([A-Za-z0-9_-]+)_(si|no)$/);
    if (remtmwMatch) {
      const payload = callbackPayloadStore.get(remtmwMatch[1]);
      if (remtmwMatch[2] === 'no' || !payload) {
        return { type: 'command', data: { command: 'noop_cancel_reminder' } };
      }
      try {
        const { d, dd, t } = JSON.parse(payload) as { d: string; dd: string; t: string };
        const next = new Date(dd + 'T12:00:00');
        next.setDate(next.getDate() + 1);
        const tomorrow = next.toISOString().slice(0, 10);
        return { type: 'command', data: { command: 'create_reminder', description: d, due_date: tomorrow, due_time: t } };
      } catch {
        return { type: 'command', data: { command: 'noop_expired_button' } };
      }
    }
```

Verificar cómo el router maneja botones expirados/cancelaciones hoy (buscar `noop` en el archivo): si existe un patrón establecido (ej: devolver `null` y que el pipeline responda "ese botón expiró"), usar ESE patrón en lugar de `noop_expired_button`/`noop_cancel_reminder`. Si `noop_cancel_reminder` no existe como comando, devolver en su lugar `null` para el "no" y que el handler del tap responda el texto por defecto — el implementador debe mirar 2 callbacks vecinos y copiar el patrón real del archivo, no inventar comandos nuevos sin registrarlos en el router de dominios.

- [ ] **Step 7: Run the integration tests**

Run: `npx vitest run src/testing/integration/__tests__/pipeline.integration.test.ts -t "recordatorios con hora"`
Expected: PASS (3 tests).

- [ ] **Step 8: Full integration + unit + typecheck**

Run: `npx vitest run src/testing/integration/__tests__/pipeline.integration.test.ts`
Expected: todos PASS (los previos + 3 nuevos).
Run: `npx vitest run src/services/__tests__/reminder.service.test.ts src/middleware/__tests__/ 2>/dev/null || npx vitest run src/services/__tests__/reminder.service.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` — sin errores nuevos vs pre-existentes.

- [ ] **Step 9: Commit**

```bash
git add src/ai/tool-definitions.ts src/ai/agent-response-mapper.ts src/middleware/slot-extractor.ts src/middleware/pending-action-processor.ts src/domain/system/system.handler.ts src/domain/interactive/interactive.router.ts src/testing/integration/__tests__/pipeline.integration.test.ts
git commit -m "feat(reminders): hora vía tool + slot time + botones AM/PM + hora pasada

create_reminder gana due_time (mapeo explícito). Sin hora → pending
missing:['time'] (slot nuevo #13, reusa resolveFutureTime). 1-11 sin
calificador → botones [🌅][🌆] (payload en callbackPayloadStore). Hora ya
pasada hoy → ofrece mañana con botones. Regresiones de integración (crear
con hora, pending de hora, ambiguo AM/PM).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Verificación final

**Files:** ninguno (solo verificación).

- [ ] **Step 1: Baseline de unit tests**

Run: `npm test`
Expected: mismos fails pre-existentes que en HEAD antes de la feature (comparar con `git stash` si hay duda — ver técnica en el ledger de la feature anterior); CERO fails nuevos. Los nuevos tests de reminder suman al total de passing.

- [ ] **Step 2: Migración aplica limpia en Docker local**

Run: `docker compose restart app 2>/dev/null || docker compose up -d; sleep 8; docker compose logs app --tail 20 | grep -i "migra\|100_"`
Expected: `101_task_reminders_time.sql` aplicada (o ya presente en `schema_migrations`). Verificar: `docker compose exec -T db psql -U campo -d campo_bot -c "\d task_reminders" | grep due_time` → muestra la columna `time`.

- [ ] **Step 3: Smoke del tick por minuto**

Insertar un reminder con hora en el pasado inmediato y verificar que el tick lo tomaría:

```bash
docker compose exec -T db psql -U campo -d campo_bot -c "SELECT to_char(due_time,'HH24:MI') FROM task_reminders LIMIT 1" 2>/dev/null
```

(El disparo real por canal se valida en prod con un recordatorio de prueba a 2 minutos vista — anotarlo como paso post-deploy.)

---

## Self-Review

**Spec coverage:** migración → T1S5; resolveFutureTime + tabla de formas → T1S1-S4; tick por minuto con dos poblaciones → T1S6; cron `* * * * *` → T1S6; tool due_time + mapper → T2S3; slot time + SLOT_LABEL → T2S4; pending missing:['time'] → T2S5; botones AM/PM + callbackPayloadStore → T2S5-S6; hora pasada → mañana → T2S5-S6; confirmación/listado con hora → T1S3(e) + T2S5; tests unit+integración → T1S1, T2S1. Sin gaps.

**Placeholder scan:** limpio — cada step tiene código o comando concreto. Los dos puntos donde el implementador debe mirar el archivo real (patrón noop del router; numeración de migración libre) están explícitamente instruidos con qué buscar y qué copiar, no son TBDs.

**Type consistency:** `ResolvedTime` con `{time} | {ambiguous,hour,minute} | null` usado igual en T1 (definición+tests) y T2 (handler `'ambiguous' in resolved` / extractor `'time' in r`). `createReminder(..., { dueTime })` definido T1S3(c), consumido T2S5. Slot `time` (T2S4) → `cmd.time` → promovido a `cmd.due_time` (T2S5). `due_time` como `to_char(...,'HH24:MI')` en los 3 SELECTs (create/list/tick).
