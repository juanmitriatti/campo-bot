// El aviso del gasto guardado solo sale por WhatsApp CON su botón «Deshacer».
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const sendText = vi.fn().mockResolvedValue({ success: true, attempts: 1 });
const sendButtons = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp.js', () => ({
  sendMessage: sendText,
  sendMessageWithRetry: sendText,
  sendInteractiveButtons: sendButtons,
}));

const { pool } = await import('../../config/db.js');
const { sendAlertWithRetryMultiChannel } = await import('../alert.service.js');

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('aviso proactivo con botones', () => {
  const phone = '5491100000077';
  let userId: number;

  beforeAll(async () => {
    await pool.query(`DELETE FROM users WHERE email = 'wa-buttons@test.local'`);
    const u = await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id, phone_number) VALUES ('WA', 'wa-buttons@test.local', 'x', 4, $1) RETURNING id`,
      [phone],
    );
    userId = u.rows[0].id;
    await pool.query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
    // Escribió recién: la ventana de 24 h está abierta.
    await pool.query(
      `INSERT INTO conversation_logs (user_id, phone, direction, message_text, channel) VALUES ($1, $2, 'inbound', 'hola', 'whatsapp')`,
      [userId, phone],
    );
  });
  afterAll(async () => {
    for (const t of ['alert_history', 'conversation_logs', 'user_settings']) await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it('manda el texto y después el botón', async () => {
    const buttons = [{ id: 'undo_auto_expense_1', title: 'Deshacer' }];
    const res = await sendAlertWithRetryMultiChannel(userId, { phone, telegramId: null }, 'Guardé el gasto', 'flow_timeout', { buttons });
    expect(res.sent, JSON.stringify(res)).toBe(true);
    expect(sendText).toHaveBeenCalledWith(phone, 'Guardé el gasto');
    expect(sendButtons).toHaveBeenCalledWith(phone, '¿Lo deshago?', buttons);
  });
});
