/**
 * Fuera de la ventana de 24 h de WhatsApp: copia por mail + plantilla de
 * WhatsApp (out-of-window-channels.js). Contra la DB real; el mail (Resend) y
 * el envío a Meta se simulan.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const sent = vi.hoisted(() => ({
  emails: [] as Array<{ to: string; subject: string; html: string; text: string }>,
  templates: [] as Array<{ to: string; name: string; lang: string; params: string[] }>,
  settings: {} as Record<string, string>,
}));

vi.mock('../mailer.service.js', async (orig) => ({
  ...(await orig<typeof import('../mailer.service.js')>()),
  sendEmail: vi.fn(async (args: { to: string; subject: string; html: string; text: string }) => {
    sent.emails.push(args);
    return { ok: true, id: 'test' };
  }),
}));

vi.mock('../whatsapp.js', async (orig) => ({
  ...(await orig<typeof import('../whatsapp.js')>()),
  sendTemplate: vi.fn(async (to: string, name: string, lang: string, params: string[]) => {
    sent.templates.push({ to, name, lang, params });
  }),
}));

vi.mock('../settings.service.js', async (orig) => {
  const real = await orig<typeof import('../settings.service.js')>();
  return {
    ...real,
    getSetting: vi.fn(async (key: string) => (key in sent.settings ? sent.settings[key] : real.getSetting(key))),
    getSettingBool: vi.fn(async (key: string) =>
      key in sent.settings ? sent.settings[key] === 'true' : real.getSettingBool(key)),
  };
});

import { pool } from '../../config/db.js';
import { sendAlertWithRetryMultiChannel } from '../alert.service.js';
import { whatsappTextToHtml } from '../out-of-window-channels.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

const PHONE = '5491100000077';

describe.skipIf(!dbAvailable)('mensajes fuera de la ventana de 24 h: mail + plantilla', () => {
  let userId: number;

  beforeAll(async () => {
    const u = await pool.query(
      `INSERT INTO users (name, email, email_verified_at, password_hash, plan_id, phone_number)
       VALUES ('Marta Gómez', 'oow-test@test.local', NOW(), 'x', 4, $1) RETURNING id`,
      [PHONE],
    );
    userId = u.rows[0].id;
    await pool.query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
  });

  beforeEach(async () => {
    sent.emails.length = 0;
    sent.templates.length = 0;
    sent.settings = { PROACTIVE_EMAIL_FALLBACK_ENABLED: 'true', WHATSAPP_REENGAGE_TEMPLATE: '' };
    await pool.query(`DELETE FROM deferred_messages WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM alert_history WHERE user_id = $1`, [userId]);
    await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [userId]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM deferred_messages WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM alert_history WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it('un recordatorio fuera de la ventana sale por mail y además queda diferido para WhatsApp', async () => {
    const res = await sendAlertWithRetryMultiChannel(userId, { phone: PHONE }, '⏰ *Recordatorio:* pagar el flete', 'reminder');
    expect(res).toMatchObject({ sent: false, deferred: true, email: 'sent' });
    expect(sent.emails).toHaveLength(1);
    expect(sent.emails[0].to).toBe('oow-test@test.local');
    expect(sent.emails[0].subject).toMatch(/Recordatorio/);
    expect(sent.emails[0].html).toContain('<strong>Recordatorio:</strong> pagar el flete');
    expect(sent.emails[0].text).not.toContain('*');
    const d = await pool.query(`SELECT 1 FROM deferred_messages WHERE user_id = $1 AND delivered_at IS NULL`, [userId]);
    expect(d.rows).toHaveLength(1);
    const a = await pool.query(`SELECT status, payload FROM alert_history WHERE user_id = $1 AND alert_type = 'reminder'`, [userId]);
    expect(a.rows[0].status).toBe('deferred');
    expect(a.rows[0].payload.email).toBe('sent');
  });

  it('un mail sin verificar no recibe nada, y queda dicho en el historial', async () => {
    await pool.query(`UPDATE users SET email_verified_at = NULL WHERE id = $1`, [userId]);
    const res = await sendAlertWithRetryMultiChannel(userId, { phone: PHONE }, 'Resumen', 'weekly_summary');
    expect((res as { email?: string }).email).toBe('skipped:mail sin verificar');
    expect(sent.emails).toHaveLength(0);
  });

  it('con el setting apagado no se manda mail', async () => {
    sent.settings.PROACTIVE_EMAIL_FALLBACK_ENABLED = 'false';
    const res = await sendAlertWithRetryMultiChannel(userId, { phone: PHONE }, 'Resumen', 'weekly_summary');
    expect((res as { email?: string }).email).toBe('skipped:apagado');
    expect(sent.emails).toHaveLength(0);
  });

  it('el clima no se difiere pero sí sale por mail (llega a tiempo)', async () => {
    const res = await sendAlertWithRetryMultiChannel(userId, { phone: PHONE }, 'Mañana llueve 30 mm', 'weather');
    expect(res).toMatchObject({ deferred: false, email: 'sent' });
    expect(sent.emails[0].subject).toMatch(/clima/);
  });

  it('el "¿Seguís ahí?" de un flujo no se difiere ni va por mail', async () => {
    const res = await sendAlertWithRetryMultiChannel(userId, { phone: PHONE }, '¿Seguís ahí?', 'flow_timeout');
    expect(res).toMatchObject({ deferred: false });
    expect(sent.emails).toHaveLength(0);
    const d = await pool.query(`SELECT 1 FROM deferred_messages WHERE user_id = $1`, [userId]);
    expect(d.rows).toHaveLength(0);
  });

  it('sin plantilla configurada no se manda ninguna', async () => {
    const res = await sendAlertWithRetryMultiChannel(userId, { phone: PHONE }, 'Resumen', 'weekly_summary');
    expect((res as { template?: string }).template).toBe('skipped:sin plantilla configurada');
    expect(sent.templates).toHaveLength(0);
  });

  it('con plantilla: una sola cada 24 h, con nombre y cantidad de mensajes guardados', async () => {
    sent.settings.WHATSAPP_REENGAGE_TEMPLATE = 'novedades_campo';
    await sendAlertWithRetryMultiChannel(userId, { phone: PHONE }, 'Recordatorio 1', 'reminder');
    const second = await sendAlertWithRetryMultiChannel(userId, { phone: PHONE }, 'Recordatorio 2', 'reminder');
    expect(sent.templates).toHaveLength(1);
    expect(sent.templates[0]).toMatchObject({ to: PHONE, name: 'novedades_campo', lang: 'es_AR', params: ['Marta', '1'] });
    expect((second as { template?: string }).template).toMatch(/últimas 24 h/);
  });

  it('con plantilla: si no quedó nada diferido (clima) no se manda', async () => {
    sent.settings.WHATSAPP_REENGAGE_TEMPLATE = 'novedades_campo';
    await sendAlertWithRetryMultiChannel(userId, { phone: PHONE }, 'Mañana llueve', 'weather');
    expect(sent.templates).toHaveLength(0);
  });
});

describe('whatsappTextToHtml', () => {
  it('escapa HTML y convierte negrita, cursiva y párrafos', () => {
    const html = whatsappTextToHtml('*Hola* <b>x</b>\n_ojo_ con esto\n\nOtro párrafo');
    expect(html).toContain('<strong>Hola</strong> &lt;b&gt;x&lt;/b&gt;<br /><em>ojo</em> con esto');
    expect(html.match(/<p /g)).toHaveLength(2);
  });
});
