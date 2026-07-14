import { pool } from '../config/db.js';
import { getSetting, getSettingBool, getSettingNumber } from './settings.service.js';
import { getNowArgentina } from '../utils/date.js';

/**
 * Drip de descubrimiento del trial (Jul 2026): mensajes proactivos en días
 * configurables del trial mostrando UNA capacidad por vez con ejemplo
 * copy-paste. Motivación: el usuario no sabe todo lo que el bot puede hacer
 * (los tips reactivos solo se disparan tras usar cada función — el drip
 * empuja las que nunca descubriría solo).
 *
 * Todo configurable desde admin (grupo bot), sin deploy:
 *  - TRIAL_DRIP_ENABLED  — kill switch
 *  - TRIAL_DRIP_DAYS     — "2,5,8,11" (día N del trial; día 0 = registro)
 *  - TRIAL_DRIP_HOUR     — hora AR de envío (el tick corre cada hora y gatea)
 *  - TRIAL_DRIP_MESSAGES — mensajes separados por línea "---", posición i ↔ día i
 *
 * Reglas: solo suscripciones en status 'trial'; respeta el opt-out de tips
 * ("no más tips" apaga tips Y drip); excluye testbots y usuarios borrados;
 * cada paso se envía UNA vez (user_settings.trial_drips_sent, migración 100).
 * Envío Telegram-first con fallback WhatsApp (mismo canal que recordatorios).
 */

export interface DripStep {
  day: number;
  message: string;
}

/** Parsea la config de días+mensajes en pasos. Tolerante: si hay menos
 * mensajes que días, los días sin mensaje se ignoran (y viceversa). */
export function parseDripSchedule(daysStr: string, messagesStr: string): DripStep[] {
  const days = (daysStr || '')
    .split(',')
    .map((d) => parseInt(d.trim(), 10))
    .filter((d) => Number.isFinite(d) && d >= 0);
  const messages = (messagesStr || '')
    .split(/\n\s*---\s*\n?/)
    .map((m) => m.trim())
    .filter(Boolean);
  const steps: DripStep[] = [];
  for (let i = 0; i < Math.min(days.length, messages.length); i++) {
    steps.push({ day: days[i], message: messages[i] });
  }
  return steps;
}

/** Día del trial (0 = día del registro), en días calendario enteros. */
export function computeTrialDay(trialStartedAt: Date, now: Date): number {
  return Math.floor((now.getTime() - trialStartedAt.getTime()) / 86_400_000);
}

type SendFn = (
  userId: number,
  contact: { phone: string | null; telegramId: string | null },
  message: string,
) => Promise<boolean>;

export async function trialDripTick(send: SendFn): Promise<number> {
  if ((await getSettingBool('TRIAL_DRIP_ENABLED')) === false) return 0;

  const targetHour = (await getSettingNumber('TRIAL_DRIP_HOUR')) ?? 10;
  const now = getNowArgentina();
  if (now.getHours() !== targetHour) return 0;

  const steps = parseDripSchedule(
    (await getSetting('TRIAL_DRIP_DAYS')) ?? '',
    (await getSetting('TRIAL_DRIP_MESSAGES')) ?? '',
  );
  if (steps.length === 0) return 0;

  // Trials activos con canal, sin testbots, respetando el opt-out de tips.
  const { rows } = await pool.query(
    `SELECT s.user_id, s.created_at AS trial_started,
            u.phone_number, u.telegram_id,
            COALESCE(us.tips_enabled, TRUE) AS tips_enabled,
            COALESCE(us.trial_drips_sent, '[]'::jsonb) AS drips_sent
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN user_settings us ON us.user_id = u.id
      WHERE s.status = 'trial'
        AND u.deleted_at IS NULL
        AND (u.phone_number IS NOT NULL OR u.telegram_id IS NOT NULL)
        AND COALESCE(u.phone_number, '') NOT LIKE 'testbot%'`,
  );

  let sent = 0;
  for (const row of rows) {
    if (row.tips_enabled === false) continue;
    const trialDay = computeTrialDay(new Date(row.trial_started), now);
    const stepIdx = steps.findIndex((st) => st.day === trialDay);
    if (stepIdx === -1) continue;
    const already: number[] = Array.isArray(row.drips_sent) ? row.drips_sent : [];
    if (already.includes(stepIdx)) continue;

    try {
      const ok = await send(Number(row.user_id), {
        phone: row.phone_number ?? null,
        telegramId: row.telegram_id != null ? String(row.telegram_id) : null,
      }, steps[stepIdx].message);
      if (!ok) continue;
      // Marcar enviado (upsert: el usuario puede no tener fila en user_settings).
      await pool.query(
        `INSERT INTO user_settings (user_id, trial_drips_sent)
         VALUES ($1, to_jsonb(ARRAY[$2::int]))
         ON CONFLICT (user_id) DO UPDATE
           SET trial_drips_sent = user_settings.trial_drips_sent || to_jsonb($2::int)`,
        [row.user_id, stepIdx],
      );
      sent++;
      console.log(`[trial-drip] enviado paso ${stepIdx} (día ${trialDay}) a user=${row.user_id}`);
    } catch (err) {
      console.error(`[trial-drip] fallo user=${row.user_id}:`, (err as Error).message);
    }
  }
  return sent;
}
