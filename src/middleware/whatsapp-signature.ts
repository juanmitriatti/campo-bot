// Verificación de la firma de Meta en el webhook de WhatsApp.
//
// Meta firma cada POST con `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256
// del body CRUDO con el App Secret de la app. Sin esta verificación, cualquiera
// que conozca la URL podía mandar un POST con `from` = cualquier número y
// actuar como ese usuario: cargar, borrar y tocar botones (auditoría de
// aislamiento, oct 2026, AIS-9).
//
// El body crudo lo guarda el `verify` de express.json() en app.ts
// (`req.rawBody`): el HMAC se calcula sobre los bytes tal cual llegaron, nunca
// sobre un JSON re-serializado.
//
// Sin WHATSAPP_APP_SECRET no se puede verificar: se deja pasar con un aviso
// en el log (como verifyTelegramWebhook), para que un deploy sin la variable
// no corte el bot. Con la variable cargada, una firma ausente o inválida es 403.
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export type RequestWithRawBody = Request & { rawBody?: Buffer };

let lastMissingSecretWarn = 0;

export function isValidMetaSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  // timingSafeEqual exige el mismo largo; un largo distinto ya es inválido.
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export function verifyWhatsAppSignature(req: Request, res: Response, next: NextFunction): void {
  // El GET de verificación de Meta (hub.challenge) no va firmado.
  if (req.method !== 'POST') { next(); return; }

  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    // Un aviso por hora, no uno por mensaje.
    if (Date.now() - lastMissingSecretWarn > 60 * 60 * 1000) {
      lastMissingSecretWarn = Date.now();
      console.warn('[whatsapp-auth] WHATSAPP_APP_SECRET no está configurado: el webhook acepta POSTs SIN verificar la firma de Meta');
    }
    next();
    return;
  }

  const rawBody = (req as RequestWithRawBody).rawBody;
  const header = req.get('x-hub-signature-256') ?? undefined;
  if (!rawBody || !isValidMetaSignature(rawBody, header, secret)) {
    console.warn(`[whatsapp-auth] firma inválida o ausente — POST rechazado (header=${header ? 'presente' : 'ausente'})`);
    res.sendStatus(403);
    return;
  }
  next();
}
