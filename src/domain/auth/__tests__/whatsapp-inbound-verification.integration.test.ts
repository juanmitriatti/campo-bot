/**
 * Vincular WhatsApp mandándole el código AL bot (migración 134, 12 oct 2026).
 *
 * En prod un usuario recién registrado tocaba "Enviar código" y no le llegaba
 * nada: Meta rechaza un mensaje libre a quien no le escribió al bot en las
 * últimas 24 h (131047) y no hay plantillas. La pantalla decía "te mandamos el
 * código" igual. Ahora la web muestra el código + link wa.me, el usuario manda
 * "verificar 123456" y el webhook vincula el número que lo mandó.
 *
 * Lo que tiene que valer siempre: el código está A LA VISTA en la pantalla, así
 * que (1) no se puede confirmar escribiéndolo en la web y (2) solo vincula si
 * llega desde el número que el usuario puso.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pool } from '../../../config/db.js';

const BOT_NUMBER = '5491178199790';
let botNumber: string | null = BOT_NUMBER;

const sent: { to: string; text: string }[] = [];
vi.mock('../../../services/whatsapp.js', () => ({
  sendMessage: vi.fn(async (to: string, text: string) => { sent.push({ to, text }); }),
}));

vi.mock('../../../services/settings.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/settings.service.js')>();
  return {
    ...actual,
    getSetting: vi.fn(async (key: string) => (key === 'WHATSAPP_BOT_NUMBER' ? botNumber : actual.getSetting(key))),
  };
});

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

function randomPhone(): string {
  return `54911${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

describe.skipIf(!dbAvailable)('WhatsApp — vinculación por mensaje entrante', () => {
  const created: number[] = [];
  let svc: InstanceType<typeof import('../channel-verification.service.js').ChannelVerificationService>;
  let WHATSAPP_VERIFY_RE: RegExp;

  async function newUser(): Promise<number> {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, name) VALUES ($1, 'Inbound Test') RETURNING id`,
      [`wa-inbound+${stamp}@test.local`],
    );
    created.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(async () => {
    const mod = await import('../channel-verification.service.js');
    svc = new mod.ChannelVerificationService();
    ({ WHATSAPP_VERIFY_RE } = await import('../../../utils/lexicon.js'));
  });

  afterAll(async () => {
    for (const id of created) {
      await pool.query('DELETE FROM channel_verifications WHERE user_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
    }
  });

  it('con número de bot: no manda nada saliente y devuelve el link wa.me con "verificar <código>"', async () => {
    const userId = await newUser();
    const phone = randomPhone();
    sent.length = 0;
    const r = await svc.startWhatsApp(userId as never, `+${phone}`);
    expect(r.mode).toBe('inbound');
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.wa_text).toBe(`verificar ${r.code}`);
    expect(r.wa_link).toBe(`https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent(`verificar ${r.code}`)}`);
    expect(r.ttl_minutes).toBeGreaterThanOrEqual(30);
    // El envío saliente era justo lo que Meta descartaba en silencio.
    expect(sent).toHaveLength(0);
    // Y el texto del link es lo que el webhook reconoce.
    expect(WHATSAPP_VERIFY_RE.exec(r.wa_text!)?.[1]).toBe(r.code);
  });

  it('el código a la vista NO se puede confirmar escribiéndolo en la web', async () => {
    const userId = await newUser();
    const r = await svc.startWhatsApp(userId as never, `+${randomPhone()}`);
    await expect(svc.confirmWhatsApp(userId as never, r.code!)).rejects.toMatchObject({ code: 'SEND_TO_BOT' });
    const { rows } = await pool.query('SELECT whatsapp_verified_at FROM users WHERE id = $1', [userId]);
    expect(rows[0].whatsapp_verified_at).toBeNull();
  });

  it('desde OTRO número no vincula nada', async () => {
    const userId = await newUser();
    const r = await svc.startWhatsApp(userId as never, `+${randomPhone()}`);
    await expect(svc.redeemWhatsAppInbound(randomPhone(), r.code!)).rejects.toMatchObject({ code: 'OTHER_PHONE' });
    const { rows } = await pool.query('SELECT phone_number, whatsapp_verified_at FROM users WHERE id = $1', [userId]);
    expect(rows[0].whatsapp_verified_at).toBeNull();
    expect(rows[0].phone_number).toBeNull();
  });

  it('desde el número correcto vincula, y el mismo mensaje dos veces es idempotente', async () => {
    const userId = await newUser();
    const phone = randomPhone();
    const r = await svc.startWhatsApp(userId as never, `+${phone}`);
    const first = await svc.redeemWhatsAppInbound(phone, r.code!);
    expect(first).toEqual({ user_id: userId, already_linked: false });
    const status = await svc.getStatus(userId as never);
    expect(status.whatsapp_verified).toBe(true);
    expect(status.phone_number).toBe(phone);

    const again = await svc.redeemWhatsAppInbound(phone, r.code!);
    expect(again).toEqual({ user_id: userId, already_linked: true });
  });

  it('un código vencido o inexistente se explica, no vincula', async () => {
    const userId = await newUser();
    const phone = randomPhone();
    const r = await svc.startWhatsApp(userId as never, `+${phone}`);
    await pool.query(
      `UPDATE channel_verifications SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1 AND verified_at IS NULL`,
      [userId],
    );
    await expect(svc.redeemWhatsAppInbound(phone, r.code!)).rejects.toMatchObject({ code: 'EXPIRED' });
    await expect(svc.redeemWhatsAppInbound(phone, r.code === '000000' ? '000001' : '000000')).rejects.toMatchObject({ code: 'NO_PENDING' });
  });

  it('sin número de bot configurado sigue el camino viejo (código saliente)', async () => {
    botNumber = null;
    try {
      const userId = await newUser();
      const phone = randomPhone();
      sent.length = 0;
      const r = await svc.startWhatsApp(userId as never, `+${phone}`);
      expect(r.mode).toBe('outbound');
      expect(r.wa_link).toBeUndefined();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(phone);
    } finally {
      botNumber = BOT_NUMBER;
    }
  });
});

describe('WHATSAPP_VERIFY_RE', () => {
  it('reconoce el texto del link y variantes tipeadas', async () => {
    const { WHATSAPP_VERIFY_RE } = await import('../../../utils/lexicon.js');
    expect(WHATSAPP_VERIFY_RE.exec('verificar 123456')?.[1]).toBe('123456');
    expect(WHATSAPP_VERIFY_RE.exec('Verificar: 123456.')?.[1]).toBe('123456');
    expect(WHATSAPP_VERIFY_RE.exec('código 123456')?.[1]).toBe('123456');
    // Nada que se parezca a una carga normal.
    expect(WHATSAPP_VERIFY_RE.test('verificar el lote 123456')).toBe(false);
    expect(WHATSAPP_VERIFY_RE.test('123456')).toBe(false);
    expect(WHATSAPP_VERIFY_RE.test('verificar 12345')).toBe(false);
  });
});
