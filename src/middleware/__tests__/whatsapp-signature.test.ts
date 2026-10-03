// Firma de Meta en el webhook de WhatsApp (auditoría de aislamiento, oct 2026,
// AIS-9): sin esto cualquiera podía postear como cualquier número.
import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { isValidMetaSignature, verifyWhatsAppSignature } from '../whatsapp-signature.js';

const SECRET = 'app-secret-de-prueba';
const BODY = Buffer.from('{"entry":[{"changes":[{"value":{"messages":[{"from":"5491100000000","text":{"body":"hola"}}]}}]}]}');
const sign = (body: Buffer, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

function run(opts: { method?: string; header?: string; rawBody?: Buffer }) {
  const req = {
    method: opts.method ?? 'POST',
    rawBody: opts.rawBody,
    get: (h: string) => (h.toLowerCase() === 'x-hub-signature-256' ? opts.header : undefined),
  };
  const res = { status: 0, sendStatus(code: number) { this.status = code; return this; } };
  const next = vi.fn();
  verifyWhatsAppSignature(req as never, res as never, next);
  return { next, status: res.status };
}

describe('isValidMetaSignature', () => {
  it('acepta la firma correcta y rechaza body alterado, otro secreto, header mal formado', () => {
    expect(isValidMetaSignature(BODY, sign(BODY), SECRET)).toBe(true);
    expect(isValidMetaSignature(Buffer.from(BODY.toString().replace('hola', 'chau')), sign(BODY), SECRET)).toBe(false);
    expect(isValidMetaSignature(BODY, sign(BODY, 'otro'), SECRET)).toBe(false);
    expect(isValidMetaSignature(BODY, 'sha1=abc', SECRET)).toBe(false);
    expect(isValidMetaSignature(BODY, 'sha256=abc', SECRET)).toBe(false);
    expect(isValidMetaSignature(BODY, undefined, SECRET)).toBe(false);
  });
});

describe('verifyWhatsAppSignature', () => {
  afterEach(() => { delete process.env.WHATSAPP_APP_SECRET; });

  it('con el secreto configurado: firma válida pasa; ausente o inválida es 403', () => {
    process.env.WHATSAPP_APP_SECRET = SECRET;
    expect(run({ rawBody: BODY, header: sign(BODY) }).next).toHaveBeenCalled();
    const missing = run({ rawBody: BODY });
    expect(missing.next).not.toHaveBeenCalled();
    expect(missing.status).toBe(403);
    expect(run({ rawBody: BODY, header: sign(BODY, 'otro') }).status).toBe(403);
    expect(run({ header: sign(BODY) }).status).toBe(403); // sin body crudo no se puede verificar
  });

  it('el GET de verificación de Meta no va firmado y pasa', () => {
    process.env.WHATSAPP_APP_SECRET = SECRET;
    expect(run({ method: 'GET' }).next).toHaveBeenCalled();
  });

  it('sin el secreto configurado deja pasar (no corta el bot) y lo avisa', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(run({ rawBody: BODY }).next).toHaveBeenCalled();
    warn.mockRestore();
  });
});
