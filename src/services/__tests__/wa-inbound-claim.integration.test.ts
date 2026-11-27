// El id de un mensaje de WhatsApp se toma una sola vez, también después de un
// reinicio (la base sobrevive; el Map en memoria no).
import { describe, it, expect, afterAll } from 'vitest';
import { claimInboundMessage, markInboundDone } from '../wa-inbound-claim.js';

let dbAvailable = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;
try {
  pool = (await import('../../config/db.js')).pool;
  await pool.query('SELECT 1 FROM wa_inbound_messages LIMIT 1');
} catch {
  dbAvailable = false;
  console.warn('[wa-inbound-claim] DB no disponible — suite salteada');
}

describe.skipIf(!dbAvailable)('claimInboundMessage', () => {
  const id = `wamid.test-${process.pid}-${Date.now()}`;
  const age = (minutes: number) =>
    pool.query(`UPDATE wa_inbound_messages SET received_at = now() - make_interval(mins => $2::int) WHERE message_id = $1`, [id, minutes]);

  afterAll(async () => { await pool.query(`DELETE FROM wa_inbound_messages WHERE message_id LIKE 'wamid.test-%'`); });

  it('toma una vez; el reintento se descarta', async () => {
    expect(await claimInboundMessage(id)).toBe(true);
    expect(await claimInboundMessage(id)).toBe(false);
  });

  it('si quedó sin terminar (el proceso murió) se puede volver a tomar', async () => {
    await age(10);
    expect(await claimInboundMessage(id)).toBe(true);
  });

  it('terminado: nunca se vuelve a procesar', async () => {
    await markInboundDone(id);
    await age(600);
    expect(await claimInboundMessage(id)).toBe(false);
  });
});
