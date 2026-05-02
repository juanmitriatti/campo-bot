import { Resend } from 'resend';
import { getSetting } from './settings.service.js';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let cachedClient: Resend | null = null;
let cachedKey: string | null = null;

function getClient(apiKey: string): Resend {
  if (cachedClient && cachedKey === apiKey) return cachedClient;
  cachedClient = new Resend(apiKey);
  cachedKey = apiKey;
  return cachedClient;
}

/**
 * Send a transactional email via Resend. When RESEND_API_KEY is empty
 * (typical in dev), the email is logged to stdout and the call resolves
 * successfully — callers should treat email delivery as best-effort.
 */
export async function sendEmail({ to, subject, html, text }: SendArgs): Promise<{ ok: boolean; id?: string; reason?: string }> {
  const apiKey = (await getSetting('RESEND_API_KEY')) as string | null;
  const fromEmail = ((await getSetting('MAIL_FROM_EMAIL')) as string | null) || 'noreply@campo-bot.com';
  const fromName = ((await getSetting('MAIL_FROM_NAME')) as string | null) || 'Campo Bot';
  const from = `${fromName} <${fromEmail}>`;

  if (!apiKey) {
    console.warn(`[MAILER] RESEND_API_KEY missing — email NOT sent. to=${to} subject="${subject}"`);
    console.warn(`[MAILER] (text body):\n${text}`);
    return { ok: false, reason: 'no_api_key' };
  }

  try {
    const result = await getClient(apiKey).emails.send({ from, to, subject, html, text });
    if (result.error) {
      console.error('[MAILER] Resend error:', result.error);
      return { ok: false, reason: result.error.message };
    }
    return { ok: true, id: result.data?.id };
  } catch (err) {
    console.error('[MAILER] Unexpected send error:', (err as Error).message);
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Wraps a body in a minimal HTML template so emails render decently
 * across clients without needing per-template duplication.
 */
export function wrapHtml(title: string, bodyHtml: string, ctaUrl?: string, ctaLabel?: string): string {
  const cta = ctaUrl && ctaLabel
    ? `<p style="margin:32px 0;text-align:center;">
         <a href="${ctaUrl}" style="background:#16a34a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">${ctaLabel}</a>
       </p>
       <p style="font-size:12px;color:#6b7280;text-align:center;">Si el botón no funciona, copiá y pegá este link:<br /><span style="word-break:break-all;">${ctaUrl}</span></p>`
    : '';

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8" /><title>${title}</title></head>
<body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
    <h1 style="font-size:20px;margin:0 0 16px;color:#15803d;">🌾 Campo Bot</h1>
    <h2 style="font-size:18px;margin:0 0 16px;">${title}</h2>
    ${bodyHtml}
    ${cta}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 16px;" />
    <p style="font-size:12px;color:#6b7280;margin:0;">Si no fuiste vos, ignorá este email.</p>
  </div>
</body></html>`;
}
