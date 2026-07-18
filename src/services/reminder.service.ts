/**
 * reminder.service.ts — Recordatorios de labores futuras.
 *
 * "El sábado tengo que fumigar el lote 5" NO es una fumigación hecha: es un
 * PLAN. El agente lo captura con create_reminder(description, due_date) y el
 * scheduler avisa el día que corresponde (tick horario, franja 07-21 AR,
 * Telegram-first con fallback WhatsApp via sendAlertWithRetryMultiChannel).
 *
 * Resolución de fecha: el agente manda due_date ISO. Red de seguridad
 * server-side: resolveFutureDate() entiende "mañana", "pasado mañana",
 * "el sábado / el viernes que viene", "en N días" — SIEMPRE hacia adelante
 * (a diferencia de relative-dates.ts, que resuelve hacia atrás para
 * registros). Sin fecha resoluble → el handler pide la fecha (sin estado:
 * el usuario re-manda la frase completa).
 */
import { pool } from '../config/db.js';
import { getNowArgentina, getTodayISO } from '../utils/date.js';

export interface TaskReminder {
  id: number;
  description: string;
  due_date: string; // YYYY-MM-DD
  due_time?: string | null; // HH:MM (AR) — null = legacy sin hora
  status: 'pending' | 'sent' | 'done' | 'cancelled';
  plot_name?: string | null;
  field_name?: string | null;
}

const WEEKDAYS: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};

function toISO(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

/**
 * Resuelve una frase de fecha FUTURA a ISO (AR). Devuelve null si no hay
 * señal de fecha. "el sábado" = el PRÓXIMO sábado (si hoy es sábado → el que
 * viene, un recordatorio para "hoy" se dice "hoy").
 */
export function resolveFutureDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const now = getNowArgentina();

  if (/\bhoy\b/.test(t)) return toISO(now);
  if (/\bpasado\s+manana\b/.test(t)) {
    const d = new Date(now); d.setDate(d.getDate() + 2); return toISO(d);
  }
  if (/\bmanana\b/.test(t)) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return toISO(d);
  }
  const inDays = t.match(/\ben\s+(\d{1,2})\s+dias?\b/);
  if (inDays) {
    const d = new Date(now); d.setDate(d.getDate() + Number(inDays[1])); return toISO(d);
  }
  let weeks: number | null = null;
  if (/\ben\s+(?:una|1)\s+semana\b/.test(t)) weeks = 1;
  else {
    const mw = t.match(/\ben\s+(\d)\s+semanas\b/);
    if (mw) weeks = Number(mw[1]);
  }
  if (weeks) {
    const d = new Date(now); d.setDate(d.getDate() + 7 * weeks); return toISO(d);
  }
  const wd = t.match(/\b(?:el\s+|este\s+)?(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/);
  if (wd) {
    const target = WEEKDAYS[wd[1]];
    const d = new Date(now);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // "el sábado" dicho un sábado = el próximo
    d.setDate(d.getDate() + delta);
    return toISO(d);
  }
  return null;
}

export type ResolvedTime = { time: string } | { ambiguous: true; hour: number; minute: number } | null;

/**
 * Offsets relativos: "en un minuto / en 5 minutos / en media hora / en una
 * hora (y media) / en 2 horas" → hora Y fecha calculadas desde ahora (AR),
 * con rollover a mañana si cruza medianoche. Devuelve null si no hay frase
 * relativa de MINUTOS/HORAS ("en 3 días"/"en una semana" son de
 * resolveFutureDate, no de acá).
 *
 * Por qué existe: el agente NO tiene reloj — con "en un minuto" alucinó
 * due_time=23:59 en prod (Jul 18). Las frases relativas REQUIEREN conocer
 * la hora actual, así que se resuelven server-side y PISAN el valor del
 * agente (mismo precedente que relative-dates con los días de semana).
 */
export function resolveRelativeFutureTime(
  text: string | null | undefined,
  now: Date = getNowArgentina(),
): { time: string; dueDate: string } | null {
  if (!text) return null;
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  let offsetMin: number | null = null;
  const mMin = t.match(/\ben\s+(un|una|\d{1,3})\s+min(?:utos?)?\b/);
  const mHalf = t.match(/\ben\s+media\s+hora\b/);
  const mHour = t.match(/\ben\s+(un|una|\d{1,2})\s+horas?(\s+y\s+media)?\b/);
  if (mMin) {
    offsetMin = /^\d+$/.test(mMin[1]) ? Number(mMin[1]) : 1;
  } else if (mHalf) {
    offsetMin = 30;
  } else if (mHour) {
    const h = /^\d+$/.test(mHour[1]) ? Number(mHour[1]) : 1;
    offsetMin = h * 60 + (mHour[2] ? 30 : 0);
  }
  if (offsetMin == null || offsetMin <= 0) return null;

  const target = new Date(now.getTime() + offsetMin * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    time: `${pad(target.getHours())}:${pad(target.getMinutes())}`,
    dueDate: `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`,
  };
}

const MOMENT_WORDS: Array<[RegExp, string]> = [
  [/\bal\s+mediod[ií]a\b/, '12:00'],
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
  // FIX M1: lookaheads negativos evitan que "14.300 pesos" matchee como hora.
  // (?!\d) tras el grupo de hora evita backtrack a "1" cuando el token es "14.xxx".
  // (?!\.\d{3}) bloquea el token completo "14.300" (separador de miles).
  // (?!\d) en el grupo de minutos evita que "300" → "30" si seguido de otro dígito.
  const m = t.match(
    /\b(?:a\s+las?\s+)(\d{1,2})(?!\d)(?!\.\d{3})(?:[:.](\d{2})(?!\d))?(?:\s*hs?\b)?(?:\s+(y\s+media|y\s+cuarto|menos\s+cuarto))?/,
  ) ?? t.match(/\b(\d{1,2})[:.](\d{2})(?!\d)\s*hs?\b/) ?? t.match(/\b(\d{1,2})\s*hs\b(?:\s+(y\s+media|y\s+cuarto|menos\s+cuarto))?/);
  if (!m) return null;

  let hour = Number(m[1]);
  let minute = m[2] != null && /^\d{2}$/.test(m[2]) ? Number(m[2]) : 0;
  const fraction = (m[3] ?? m[2]) as string | undefined; // según cuál regex matcheó
  if (typeof fraction === 'string' && /y\s+media/.test(fraction)) minute = 30;
  else if (typeof fraction === 'string' && /y\s+cuarto/.test(fraction)) minute = 15;
  else if (typeof fraction === 'string' && /menos\s+cuarto/.test(fraction)) {
    // FIX M2: capturar la hora HABLADA antes del decremento para que la verificación
    // de ambigüedad opere sobre el valor original. "a la 1 menos cuarto" → spokenHour=1
    // (rango 1-11 sin calificador) → ambiguo, no se resuelve silenciosamente a 00:45.
    const spokenHour = hour;
    minute = 45;
    hour = hour - 1;
    if (hour < 0) return null;

    const isAMEarly = /de\s+la\s+madrugada/.test(t);
    const isAMNormal = /de\s+la\s+manana/.test(t);
    const isAM = isAMEarly || isAMNormal;
    const isNoche = /de\s+la\s+noche/.test(t);
    const isPM = /de\s+la\s+tarde/.test(t) || isNoche;
    if (isPM && hour < 12) hour += 12;
    // FIX M3: "12 de la noche" / "12 de la madrugada" → medianoche (00:XX)
    if (isNoche && hour === 12) hour = 0;
    if (isAMEarly && hour === 12) hour = 0;

    const pad = (n: number) => String(n).padStart(2, '0');
    if (!isAM && !isPM && spokenHour >= 1 && spokenHour <= 11) {
      return { ambiguous: true, hour, minute };
    }
    if (hour > 23 || minute > 59 || hour < 0) return null;
    return { time: `${pad(hour)}:${pad(minute)}` };
  }
  if (hour > 23 || minute > 59 || hour < 0) return null;

  const isAMEarly = /de\s+la\s+madrugada/.test(t);
  const isAMNormal = /de\s+la\s+manana/.test(t);
  const isAM = isAMEarly || isAMNormal;
  const isNoche = /de\s+la\s+noche/.test(t);
  const isPM = /de\s+la\s+tarde/.test(t) || isNoche;
  if (isPM && hour < 12) hour += 12;
  // FIX M3: "12 de la noche" / "12 de la madrugada" → medianoche (00:XX)
  if (isNoche && hour === 12) hour = 0;
  if (isAMEarly && hour === 12) hour = 0;
  // "12 de la mañana" en AR coloquial = mediodía → se deja en 12 (isAMNormal no zeroes 12)

  const pad = (n: number) => String(n).padStart(2, '0');
  // 1-11 sin calificador ni formato 24h explícito (":MM" cuenta como explícito
  // solo si la hora ya es >= 12): ambiguo → botones.
  if (!isAM && !isPM && hour >= 1 && hour <= 11) {
    return { ambiguous: true, hour, minute };
  }
  return { time: `${pad(hour)}:${pad(minute)}` };
}

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

export async function listReminders(userId: number): Promise<TaskReminder[]> {
  const { rows } = await pool.query(
    `SELECT r.id, r.description, r.due_date::text, to_char(r.due_time, 'HH24:MI') AS due_time, r.status,
            p.name AS plot_name, f.name AS field_name
     FROM task_reminders r
     LEFT JOIN plots p ON p.id = r.plot_id
     LEFT JOIN fields f ON f.id = r.field_id
     WHERE r.user_id = $1 AND r.status IN ('pending', 'sent')
     ORDER BY r.due_date, r.id`,
    [userId],
  );
  return rows;
}

/** Marca done/cancelled. Sin id → la más próxima pendiente. Devuelve la afectada o null. */
export async function completeReminder(
  userId: number,
  opts: { id?: number | null; descriptionLike?: string | null; cancel?: boolean } = {},
): Promise<TaskReminder | null> {
  const newStatus = opts.cancel ? 'cancelled' : 'done';
  let target: { rows: TaskReminder[] };
  if (opts.id) {
    target = await pool.query(
      `SELECT id, description, due_date::text, status FROM task_reminders
       WHERE user_id = $1 AND id = $2 AND status IN ('pending','sent')`,
      [userId, opts.id],
    );
  } else if (opts.descriptionLike) {
    target = await pool.query(
      `SELECT id, description, due_date::text, status FROM task_reminders
       WHERE user_id = $1 AND status IN ('pending','sent') AND description ILIKE '%' || $2 || '%'
       ORDER BY due_date LIMIT 1`,
      [userId, opts.descriptionLike],
    );
  } else {
    target = await pool.query(
      `SELECT id, description, due_date::text, status FROM task_reminders
       WHERE user_id = $1 AND status IN ('pending','sent')
       ORDER BY due_date LIMIT 1`,
      [userId],
    );
  }
  if (target.rows.length === 0) return null;
  const r = target.rows[0];
  await pool.query(`UPDATE task_reminders SET status = $2 WHERE id = $1`, [r.id, newStatus]);
  return { ...r, status: newStatus as TaskReminder['status'] };
}

function fmtDue(iso: string): string {
  const today = getTodayISO();
  if (iso === today) return 'HOY';
  const d = new Date(iso + 'T12:00:00');
  const tomorrow = new Date(new Date(today + 'T12:00:00').getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const dd = `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const day = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][d.getDay()];
  if (iso === tomorrow) return `mañana (${day} ${dd})`;
  return `${day} ${dd}`;
}

export function formatReminderList(reminders: TaskReminder[]): string {
  if (reminders.length === 0) {
    return '📋 No tenés recordatorios pendientes.\n\n_Para crear uno: "acordame el sábado de fumigar el lote 5"._';
  }
  const lines = ['⏰ *Tus recordatorios*', ''];
  const today = getTodayISO();
  for (const r of reminders) {
    const overdue = r.due_date < today ? ' ⚠️ vencido' : '';
    const loc = r.plot_name ? ` (lote ${r.plot_name})` : r.field_name ? ` (${r.field_name})` : '';
    const hora = r.due_time ? ` a las ${r.due_time}` : '';
    lines.push(`• ${r.description}${loc} — *${fmtDue(r.due_date)}${hora}*${overdue}`);
  }
  lines.push('');
  lines.push('_"listo el recordatorio de X" para marcarlo hecho._');
  return lines.join('\n');
}

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
