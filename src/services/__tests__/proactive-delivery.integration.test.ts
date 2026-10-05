/**
 * Mensajes proactivos (auditoría oct 2026, causa 12): ventana de 24 h de
 * WhatsApp, filtros comunes y entrega diferida. Contra la DB real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../testing/integration/pipeline-harness.js';
import { sendAlertWithRetryMultiChannel } from '../alert.service.js';
import { getProactiveBlockReason } from '../proactive-delivery.js';
import { ExpenseTemplateService } from '../../domain/financial/expense-template.service.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('mensajes proactivos', () => {
  let h: PipelineHarness;
  let waUser: number;

  beforeAll(async () => {
    h = await createPipelineHarness('proactive');
    // Usuario de WhatsApp "real" (número no testbot) que nunca escribió: fuera de la ventana.
    const u = await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id, phone_number) VALUES ('WA', 'wa-proactive@test.local', 'x', 4, '5491100000001') RETURNING id`,
    );
    waUser = u.rows[0].id;
    await pool.query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [waUser]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM deferred_messages WHERE user_id = ANY($1::int[])`, [[waUser, Number(h.userId)]]);
    await pool.query(`DELETE FROM alert_history WHERE user_id = $1`, [waUser]);
    await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [waUser]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [waUser]);
    await h?.cleanup();
  });

  it('CRN-2: fuera de la ventana de 24 h no se manda: queda diferido y el historial lo dice', async () => {
    const res = await sendAlertWithRetryMultiChannel(waUser, { phone: '5491100000001' }, 'Resumen de la semana', 'weekly_summary');
    expect(res.sent).toBe(false);
    expect((res as { deferred?: boolean }).deferred).toBe(true);
    const d = await pool.query(`SELECT message FROM deferred_messages WHERE user_id = $1 AND delivered_at IS NULL`, [waUser]);
    expect(d.rows.map(r => r.message)).toContain('Resumen de la semana');
    const a = await pool.query(`SELECT status FROM alert_history WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [waUser]);
    expect(a.rows[0].status).toBe('deferred');
  });

  it('CRN-2: una alerta de clima fuera de la ventana no se difiere (llegaría tarde)', async () => {
    const res = await sendAlertWithRetryMultiChannel(waUser, { phone: '5491100000001' }, 'Mañana llueve 30 mm', 'weather');
    expect((res as { deferred?: boolean }).deferred).toBe(false);
    const d = await pool.query(`SELECT 1 FROM deferred_messages WHERE user_id = $1 AND message LIKE '%llueve%'`, [waUser]);
    expect(d.rows).toHaveLength(0);
  });

  it('CRN-2: lo diferido se entrega la próxima vez que el usuario escribe, una sola vez', async () => {
    await pool.query(
      `INSERT INTO deferred_messages (user_id, alert_type, message, expires_at) VALUES ($1, 'reminder', '⏰ Recordatorio: pagar el flete', NOW() + INTERVAL '7 days')`,
      [Number(h.userId)],
    );
    const first = h.allText(await h.send('hola'));
    expect(first).toMatch(/Mientras no estabas/);
    expect(first).toMatch(/pagar el flete/);
    const second = h.allText(await h.send('hola'));
    expect(second).not.toMatch(/pagar el flete/);
  });

  it('CRN-6/8: cuentas borradas y usuarios de prueba no reciben proactivos', async () => {
    await pool.query(`UPDATE users SET phone_number = 'testbot_proactive' WHERE id = $1`, [waUser]);
    try {
      expect(await getProactiveBlockReason(waUser, 'weekly_summary')).toMatch(/prueba/);
    } finally {
      await pool.query(`UPDATE users SET phone_number = '5491100000001' WHERE id = $1`, [waUser]);
    }
    await pool.query(`UPDATE users SET deleted_at = NOW() WHERE id = $1`, [waUser]);
    try {
      expect(await getProactiveBlockReason(waUser, 'weekly_summary')).toMatch(/borrada/);
    } finally {
      await pool.query(`UPDATE users SET deleted_at = NULL WHERE id = $1`, [waUser]);
    }
  });

  it('CRN-12: un gasto recurrente del 31 pasa al último día del mes siguiente, no al 2 del otro', () => {
    const svc = new ExpenseTemplateService() as unknown as { advanceDate: (t: string, d: string, r?: number) => string };
    expect(svc.advanceDate('monthly', '2027-01-31', 31)).toBe('2027-02-28');
    expect(svc.advanceDate('monthly', '2027-02-28', 31)).toBe('2027-03-31');
    expect(svc.advanceDate('monthly', '2026-12-15', 15)).toBe('2027-01-15');
  });
});
