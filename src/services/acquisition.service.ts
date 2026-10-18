/**
 * De dónde llega cada usuario (oct 2026, antes de pautar).
 *
 * Dos entradas, una tabla (`acquisition_touches`, migración 136):
 *   - WhatsApp: Meta adjunta `referral` al primer mensaje que llega desde un
 *     anuncio Click-to-WhatsApp o una publicación con botón de WA. Se guarda con
 *     el hash del teléfono (no el número): con REQUIRE_VERIFIED_CHANNEL el que
 *     llega del anuncio todavía no tiene cuenta, y el reporte lo cruza después
 *     con sha256(users.phone_number).
 *   - Web: la landing es de Lovable y no la tocamos, pero la sirve este mismo
 *     servidor. `captureWebSource` pone una cookie first-party con los utm_* /
 *     fbclid / gclid de la PRIMERA visita (no la pisa) y el registro la ata al
 *     user_id.
 *
 * Es telemetría: nada de esto puede romper un mensaje ni un registro. Todo
 * fallo se loguea con [ACQUISITION] y sigue.
 */
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';
import { normalizePhone } from '../utils/phone.js';

export const SOURCE_COOKIE = 'ma_src';
const COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_LEN = 300;

export interface AcquisitionTouch {
  channel: 'whatsapp' | 'web';
  userId?: number | null;
  phoneHash?: string | null;
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  content?: string | null;
  term?: string | null;
  adId?: string | null;
  adHeadline?: string | null;
  clickId?: string | null;
  landingPath?: string | null;
  referrer?: string | null;
}

/** Lo que Meta manda en `messages[0].referral` (Click-to-WhatsApp). */
export interface WhatsAppReferral {
  source_url?: string;
  source_id?: string;
  source_type?: string; // 'ad' | 'post'
  headline?: string;
  body?: string;
  media_type?: string;
  ctwa_clid?: string;
}

function clip(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, MAX_LEN) : null;
}

/** sha256 del teléfono canónico. Mismo cálculo que el SQL del reporte. */
export function phoneHash(phone: string): string {
  const canonical = normalizePhone(phone) ?? phone.trim();
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function touchFromReferral(phone: string, ref: WhatsAppReferral): AcquisitionTouch {
  const type = clip(ref.source_type);
  return {
    channel: 'whatsapp',
    phoneHash: phoneHash(phone),
    source: type === 'ad' ? 'meta_ad' : type === 'post' ? 'meta_post' : (type ? `meta_${type}` : 'meta'),
    medium: 'click_to_whatsapp',
    adId: clip(ref.source_id),
    adHeadline: clip(ref.headline),
    clickId: clip(ref.ctwa_clid),
    landingPath: clip(ref.source_url),
  };
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
const CLICK_KEYS = ['fbclid', 'gclid'] as const;

/** Los datos de origen de una visita web, o null si la URL no trae ninguno. */
export function webSourceFromQuery(
  query: Record<string, unknown>,
  path: string,
  referrer: string | undefined,
): AcquisitionTouch | null {
  const q = (k: string) => clip(Array.isArray(query[k]) ? (query[k] as unknown[])[0] : query[k]);
  const hasUtm = UTM_KEYS.some((k) => q(k));
  const fbclid = q('fbclid');
  const gclid = q('gclid');
  if (!hasUtm && !fbclid && !gclid) return null;
  return {
    channel: 'web',
    source: q('utm_source') ?? (fbclid ? 'facebook' : gclid ? 'google' : null),
    medium: q('utm_medium') ?? (fbclid || gclid ? 'paid' : null),
    campaign: q('utm_campaign'),
    content: q('utm_content'),
    term: q('utm_term'),
    clickId: fbclid ?? gclid,
    landingPath: clip(path),
    referrer: clip(referrer),
  };
}

export function encodeSourceCookie(t: AcquisitionTouch): string {
  return Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
}

export function decodeSourceCookie(raw: string | undefined): AcquisitionTouch | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as AcquisitionTouch;
    if (!t || t.channel !== 'web') return null;
    // La cookie la escribe el servidor, pero llega del cliente: se vuelve a recortar.
    return {
      channel: 'web',
      source: clip(t.source), medium: clip(t.medium), campaign: clip(t.campaign),
      content: clip(t.content), term: clip(t.term), clickId: clip(t.clickId),
      landingPath: clip(t.landingPath), referrer: clip(t.referrer),
    };
  } catch {
    return null;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * Middleware de las páginas (GET): primera visita con utm_* / fbclid / gclid →
 * cookie first-party. No pisa una cookie existente (gana el primer toque).
 */
export function captureWebSource(req: Request, res: Response, next: NextFunction): void {
  try {
    if (req.method === 'GET' && !readCookie(req, SOURCE_COOKIE)) {
      const touch = webSourceFromQuery(req.query as Record<string, unknown>, req.path, req.get('referer'));
      if (touch) {
        res.cookie(SOURCE_COOKIE, encodeSourceCookie(touch), {
          maxAge: COOKIE_MAX_AGE_MS,
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          path: '/',
        });
      }
    }
  } catch (err) {
    console.warn('[ACQUISITION] no pude leer el origen de la visita:', (err as Error).message);
  }
  next();
}

export async function recordTouch(t: AcquisitionTouch): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO acquisition_touches
         (channel, user_id, phone_hash, source, medium, campaign, content, term,
          ad_id, ad_headline, click_id, landing_path, referrer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [t.channel, t.userId ?? null, t.phoneHash ?? null, t.source ?? null, t.medium ?? null,
        t.campaign ?? null, t.content ?? null, t.term ?? null, t.adId ?? null, t.adHeadline ?? null,
        t.clickId ?? null, t.landingPath ?? null, t.referrer ?? null],
    );
    console.log(`[ACQUISITION] ${t.channel} source=${t.source ?? '-'} campaign=${t.campaign ?? '-'} ad=${t.adId ?? '-'} user=${t.userId ?? '-'}`);
  } catch (err) {
    console.warn('[ACQUISITION] no pude guardar el toque:', (err as Error).message);
  }
}

/** Mensaje de WhatsApp con `referral`: lo guarda, con el usuario si ya existe. */
export async function recordWhatsAppReferral(phone: string, ref: WhatsAppReferral): Promise<void> {
  const touch = touchFromReferral(phone, ref);
  try {
    const canonical = normalizePhone(phone) ?? phone;
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE phone_number = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1',
      [canonical],
    );
    touch.userId = rows[0]?.id ?? null;
  } catch { /* sin usuario: el reporte cruza por hash */ }
  await recordTouch(touch);
}

/** Registro web: ata la cookie de origen (si hay) al usuario nuevo y la borra. */
export async function recordWebSignup(req: Request, res: Response, userId: number): Promise<void> {
  const touch = decodeSourceCookie(readCookie(req, SOURCE_COOKIE));
  if (!touch) return;
  await recordTouch({ ...touch, userId });
  res.clearCookie(SOURCE_COOKIE, { path: '/' });
}

export interface AcquisitionReportRow {
  channel: string;
  source: string;
  campaign: string;
  ad: string;
  signups: number;
  activated: number; // cargó al menos un registro (gasto, ingreso o actividad)
  paying: number;    // tiene una suscripción paga activa (MercadoPago)
}

/**
 * Usuarios dados de alta en los últimos `days` días, agrupados por su PRIMER toque.
 * `users` no tiene created_at: el alta es su primera suscripción (toda alta
 * arranca la prueba, por la web o por el primer mensaje del chat).
 * WhatsApp cruza por hash del teléfono; web por user_id. Sin toque = "directo".
 */
export async function acquisitionReport(days = 30): Promise<AcquisitionReportRow[]> {
  const { rows } = await pool.query(
    `WITH new_users AS (
       SELECT u.id, u.phone_number AS phone
         FROM users u
         JOIN LATERAL (SELECT MIN(s.created_at) AS at FROM subscriptions s WHERE s.user_id = u.id) first_sub ON TRUE
        WHERE u.deleted_at IS NULL AND first_sub.at >= NOW() - make_interval(days => $1)
     ),
     first_touch AS (
       SELECT DISTINCT ON (u.id) u.id AS user_id, t.channel, t.source, t.campaign,
              COALESCE(t.ad_headline, t.ad_id) AS ad
         FROM new_users u
         JOIN acquisition_touches t
           ON t.user_id = u.id
           OR (u.phone IS NOT NULL AND t.phone_hash = encode(sha256(convert_to(u.phone, 'UTF8')), 'hex'))
        ORDER BY u.id, t.created_at
     )
     SELECT COALESCE(f.channel, 'directo') AS channel,
            COALESCE(f.source, '-')        AS source,
            COALESCE(f.campaign, '-')      AS campaign,
            COALESCE(f.ad, '-')            AS ad,
            COUNT(*)::int AS signups,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM expenses e WHERE e.user_id = u.id)
                               OR EXISTS (SELECT 1 FROM incomes i WHERE i.user_id = u.id)
                               OR EXISTS (SELECT 1 FROM domain_events d WHERE d.user_id = u.id))::int AS activated,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM subscriptions s
                                            WHERE s.user_id = u.id AND s.status = 'active'
                                              AND s.provider = 'mercadopago'))::int AS paying
       FROM new_users u
       LEFT JOIN first_touch f ON f.user_id = u.id
      GROUP BY 1, 2, 3, 4
      ORDER BY signups DESC`,
    [days],
  );
  return rows as AcquisitionReportRow[];
}
