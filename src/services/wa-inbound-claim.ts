// Idempotencia durable de los mensajes entrantes de WhatsApp (la de memoria,
// MessageDedup, se pierde en cada deploy).
//
// Un mensaje "recibido pero sin terminar" hace más de STALE_MINUTES se puede
// volver a tomar: si el proceso murió antes de responder, descartar el reintento
// de Meta sería perder el mensaje sin que nadie se entere.
import { pool } from '../config/db.js';

const STALE_MINUTES = 3;
const KEEP_DAYS = 7;

/** true = este proceso lo atiende; false = duplicado. Ante un fallo de la base, atiende. */
export async function claimInboundMessage(messageId: string): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO wa_inbound_messages (message_id) VALUES ($1)
       ON CONFLICT (message_id) DO UPDATE SET received_at = now()
         WHERE wa_inbound_messages.done_at IS NULL
           AND wa_inbound_messages.received_at < now() - make_interval(mins => $2::int)`,
      [messageId, STALE_MINUTES],
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    console.error('[whatsapp] no pude registrar el id del mensaje (se procesa igual):', (err as Error).message);
    return true;
  }
}

export async function markInboundDone(messageId: string): Promise<void> {
  try {
    await pool.query(`UPDATE wa_inbound_messages SET done_at = now() WHERE message_id = $1`, [messageId]);
  } catch (err) {
    console.error('[whatsapp] no pude marcar el mensaje como atendido:', (err as Error).message);
  }
}

export async function purgeInboundMessages(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM wa_inbound_messages WHERE received_at < now() - make_interval(days => $1::int)`,
    [KEEP_DAYS],
  );
  return rowCount ?? 0;
}
