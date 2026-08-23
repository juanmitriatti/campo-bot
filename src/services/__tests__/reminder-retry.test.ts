import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pool } from '../../config/db.js';
import { reminderTick, MAX_REMINDER_ATTEMPTS } from '../reminder.service.js';

/**
 * Regresión del loop infinito de recordatorios.
 *
 * reminderTick solo marcaba la fila cuando el envío salía OK; si fallaba
 * quedaba 'pending' y el cron (cada minuto) la reintentaba para siempre. En
 * prod: 29.138 filas en alert_history por UN recordatorio, 1.440 por día
 * durante 20 días.
 *
 * Estos tests cubren el camino de FALLO, que es el que nadie había probado.
 */

let userId: number;
const created: number[] = [];

async function mkUser(opts: { phone?: string | null; telegramId?: string | null }): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO users (name, phone_number, telegram_id) VALUES ($1, $2, $3) RETURNING id`,
    [`rt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, opts.phone ?? null, opts.telegramId ?? null],
  );
  return rows[0].id as number;
}

async function mkReminder(uid: number, over: { attempts?: number; lastAttemptAt?: string | null } = {}): Promise<number> {
  // due_time explícita A PROPÓSITO: sin hora, reminderTick usa la rama legacy,
  // gateada por la franja 07-21 AR — el test pasaba de día y fallaba de noche.
  // Con hora, un vencido de ayer se toma siempre y el test no depende del reloj.
  const { rows } = await pool.query(
    `INSERT INTO task_reminders (user_id, description, due_date, due_time, status, attempts, last_attempt_at)
     VALUES ($1, 'fumigar el lote de prueba', CURRENT_DATE - 1, '08:00'::time, 'pending', $2, $3)
     RETURNING id`,
    [uid, over.attempts ?? 0, over.lastAttemptAt ?? null],
  );
  const id = rows[0].id as number;
  created.push(id);
  return id;
}

async function readRow(id: number) {
  const { rows } = await pool.query(
    `SELECT status, attempts, last_attempt_at, last_error FROM task_reminders WHERE id = $1`, [id],
  );
  return rows[0];
}

/** Envío que siempre falla — simula bot bloqueado o número inexistente. */
const alwaysFails = async () => false;
/** Envío que siempre anda. */
const alwaysOk = async () => true;

beforeEach(async () => {
  userId = await mkUser({ phone: '5490000000000' });
});

afterEach(async () => {
  if (created.length) await pool.query(`DELETE FROM task_reminders WHERE id = ANY($1)`, [created]);
  created.length = 0;
  await pool.query(`DELETE FROM task_reminders WHERE user_id = $1`, [userId]).catch(() => {});
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
});

describe('reminderTick — el envío que falla NO se reintenta para siempre', () => {
  it('un fallo cuenta el intento y sella el momento, en vez de dejar la fila intacta', async () => {
    const id = await mkReminder(userId);
    await reminderTick(alwaysFails);

    const r = await readRow(id);
    expect(r.attempts).toBe(1);
    expect(r.last_attempt_at).not.toBeNull();  // sin esto no había backoff posible
    expect(r.status).toBe('pending');          // todavía puede reintentar
    expect(r.last_error).toBeTruthy();
  });

  it('el backoff impide que el tick siguiente la vuelva a tomar', async () => {
    const id = await mkReminder(userId);
    await reminderTick(alwaysFails);
    expect((await readRow(id)).attempts).toBe(1);

    // Segunda pasada inmediata: es lo que hacía el cron cada 60 segundos.
    await reminderTick(alwaysFails);
    expect((await readRow(id)).attempts).toBe(1); // NO subió: quedó fuera por backoff
  });

  it('pasada la ventana de backoff sí reintenta', async () => {
    const id = await mkReminder(userId, { attempts: 1, lastAttemptAt: '2020-01-01T00:00:00Z' });
    await reminderTick(alwaysFails);
    expect((await readRow(id)).attempts).toBe(2);
  });

  it('al agotar los intentos queda en failed y sale de la cola', async () => {
    const id = await mkReminder(userId, {
      attempts: MAX_REMINDER_ATTEMPTS - 1,
      lastAttemptAt: '2020-01-01T00:00:00Z',
    });
    await reminderTick(alwaysFails);

    const r = await readRow(id);
    expect(r.attempts).toBe(MAX_REMINDER_ATTEMPTS);
    expect(r.status).toBe('failed');

    // Y ya no la levanta ninguna pasada futura.
    await reminderTick(alwaysFails);
    expect((await readRow(id)).attempts).toBe(MAX_REMINDER_ATTEMPTS);
  });
});

describe('reminderTick — usuario sin canal de contacto', () => {
  it('falla al primer intento sin llamar al envío (era la causa de las 29.138 filas)', async () => {
    const noChannel = await mkUser({ phone: null, telegramId: null });
    const { rows } = await pool.query(
      `INSERT INTO task_reminders (user_id, description, due_date, due_time, status)
       VALUES ($1, 'recordatorio huérfano', CURRENT_DATE - 1, '08:00'::time, 'pending') RETURNING id`,
      [noChannel],
    );
    const id = rows[0].id as number;

    let sendCalls = 0;
    await reminderTick(async () => { sendCalls++; return false; });

    const r = await readRow(id);
    expect(sendCalls).toBe(0);          // no se llama a send → no se escribe alert_history
    expect(r.status).toBe('failed');    // no vuelve nunca
    expect(r.last_error).toContain('sin canal');

    await pool.query(`DELETE FROM task_reminders WHERE id = $1`, [id]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [noChannel]);
  });
});

describe('reminderTick — el camino feliz sigue igual', () => {
  it('un envío exitoso marca sent y devuelve el conteo', async () => {
    const id = await mkReminder(userId);
    const n = await reminderTick(alwaysOk);

    expect(n).toBeGreaterThanOrEqual(1);
    const r = await readRow(id);
    expect(r.status).toBe('sent');
    expect(r.attempts).toBe(0); // un envío OK no cuenta intentos fallidos
  });

  it('tras un fallo previo, un envío exitoso lo marca sent igual', async () => {
    const id = await mkReminder(userId, { attempts: 2, lastAttemptAt: '2020-01-01T00:00:00Z' });
    await reminderTick(alwaysOk);
    expect((await readRow(id)).status).toBe('sent');
  });
});
