import { pool } from '../config/db.js';
import { logError } from './error-logger.js';

/**
 * Phase 3 — access gate centralizado.
 *
 * Resuelve el modo de acceso de un usuario en runtime, leyendo
 * `subscriptions` directamente. NO depende del cron de sweep, así que
 * un trial que vence a las 02:00 queda bloqueado a las 02:00:01, no a
 * las 03:15 cuando corre el sweep.
 *
 * Diseño deliberadamente conservador con respecto a usuarios pre-existentes:
 * cualquier user que NO tenga fila de `subscriptions` se considera 'full'
 * (grandfathereo). Eso preserva a los users de QA/test del period
 * pre-billing y evita romperlos al activar Phase 3. Cuando se decida
 * "limpiar" esos users, se hace con UPDATE manual; no es parte de este flow.
 */

export type AccessMode =
  | 'full'                     // todo permitido
  | 'trial_expired_readonly';  // bloqueado de IA / audio / docs / writes complejas

interface SubscriptionRow {
  status: string;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
}

async function findActiveOrTerminalSubscription(userId: number): Promise<SubscriptionRow | null> {
  // Take the most recent row for this user. The partial unique index
  // already ensures at most one non-terminal sub, but a user can have
  // multiple historical rows (cancelled in past, then new trial, etc.).
  const { rows } = await pool.query(
    `SELECT status, trial_ends_at, current_period_end
       FROM subscriptions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Resolves the access mode for a user. Failures default to `full` so a
 * transient DB hiccup never silently locks a paying user out.
 */
/**
 * ¿Es miembro de un campo cuyo DUEÑO tiene acceso pleno?
 *
 * Por qué existe: el colaborador invitado tiene su propia cuenta, con su propia
 * prueba de 14 días. Al vencer quedaba en solo-lectura y no podía cargar nada
 * en el campo del dueño —aunque el dueño pague Pro+, que es justamente el plan
 * que incluye compartir—. El empleado se volvía inútil a las dos semanas y el
 * feature que se está pagando dejaba de funcionar.
 *
 * La regla: el dueño paga para que su equipo cargue. Se chequea acá, en el
 * STEP 0, porque el gate corre antes de saber a qué campo apunta el mensaje.
 * Alcanza con UN campo con dueño al día.
 */
async function inheritsAccessFromOwner(userId: number): Promise<number | null> {
  const owners = await fullAccessOwnersOf(userId);
  return owners[0] ?? null;
}

/**
 * Dueños de campos donde el usuario es MIEMBRO y que tienen acceso pleno. Lo
 * usa el gate de acceso (arriba) y el de FUNCIONES (`FeatureGate`, CTA-8): el
 * acceso se heredaba pero las funciones salían del plan propio del miembro, y
 * un empleado en `free` quedaba bloqueado en siembra/hacienda en el campo de
 * un dueño Pro+.
 */
export async function fullAccessOwnersOf(userId: number): Promise<number[]> {
  const { rows } = await pool.query(
    `SELECT f.user_id AS owner_id
       FROM field_members fm
       JOIN fields f ON f.id = fm.field_id
      WHERE fm.user_id = $1
        AND f.user_id <> $1
        AND f.deleted_at IS NULL
      ORDER BY f.id`,
    [userId],
  );
  const owners: number[] = [];
  for (const r of rows) {
    const ownerId = Number(r.owner_id);
    if (owners.includes(ownerId)) continue;
    // Sin recursión a propósito: se mira el modo propio del dueño. Una cadena
    // de herencias (A hereda de B que hereda de C) no es un caso real y sería
    // una forma de saltarse el pago encadenando cuentas vencidas.
    const ownerSub = await findActiveOrTerminalSubscription(ownerId);
    if (!ownerSub || ownerModeIsFull(ownerSub)) owners.push(ownerId); // sin sub = grandfathered = pleno
  }
  return owners;
}

/** El mismo criterio que `getUserAccessMode`, sin la parte de herencia. */
function ownerModeIsFull(sub: SubscriptionRow): boolean {
  const now = Date.now();
  switch (sub.status) {
    case 'active':
    case 'past_due':
      return true;
    case 'trial':
      return !!sub.trial_ends_at && sub.trial_ends_at.getTime() > now;
    case 'cancelled':
      return (
        (!!sub.current_period_end && sub.current_period_end.getTime() > now) ||
        (!!sub.trial_ends_at && sub.trial_ends_at.getTime() > now)
      );
    case 'expired':
      return false;
    default:
      return true;
  }
}

export async function getUserAccessMode(userId: number): Promise<AccessMode> {
  try {
    const sub = await findActiveOrTerminalSubscription(userId);

    // Grandfather: pre-billing users (or anyone without a sub row) → full.
    if (!sub) return 'full';

    const now = Date.now();

    if (ownerModeIsFull(sub)) return 'full';

    // Propio vencido: antes de bloquear, se mira si es COLABORADOR de alguien
    // que sí está al día. El dueño paga Pro+ para que su equipo cargue.
    const inheritedFrom = await inheritsAccessFromOwner(userId);
    if (inheritedFrom != null) {
      console.log(`[ACCESS] user=${userId} heredado de owner=${inheritedFrom}`);
      return 'full';
    }

    switch (sub.status) {
      case 'active':
      case 'past_due':
        // past_due is treated as full; the cron handles the grace window
        // and downgrades to cancelled/expired when grace runs out. If grace
        // ran out but cron didn't fire, this still grants full access — OK
        // for now, we're conservative on the side of paid users.
        return 'full';

      case 'trial':
        // Live check: trial is full ONLY if trial_ends_at is in the future.
        if (sub.trial_ends_at && sub.trial_ends_at.getTime() > now) return 'full';
        return 'trial_expired_readonly';

      case 'cancelled':
        // Honor the period the user already paid for.
        if (sub.current_period_end && sub.current_period_end.getTime() > now) return 'full';
        // For a cancelled-trial user (cancelled before paying anything),
        // honor trial_ends_at as the read-only-from date.
        if (sub.trial_ends_at && sub.trial_ends_at.getTime() > now) return 'full';
        return 'trial_expired_readonly';

      case 'expired':
        return 'trial_expired_readonly';

      default:
        // Unknown status — fail open to avoid breaking real users.
        return 'full';
    }
  } catch (err) {
    logError('access', 'ACCESS_GATE_FAILED', err as Error, { userId });
    // Fail open. Better to over-grant access during a DB hiccup than to lock
    // a paying user out of their data.
    return 'full';
  }
}

/**
 * Convenience wrapper for callers that only care if access is restricted.
 */
export async function isTrialExpired(userId: number): Promise<boolean> {
  const mode = await getUserAccessMode(userId);
  return mode === 'trial_expired_readonly';
}

/**
 * User-facing copy when an action is blocked because the trial expired.
 * Productor-friendly, no jargon. Usa PUBLIC_URL (setting) — antes la URL de
 * Railway estaba hardcodeada y un cambio de dominio dejaba el link muerto.
 */
export async function trialExpiredCopy(): Promise<string> {
  let base = 'https://campo-bot-production.up.railway.app';
  try {
    const { getSetting } = await import('./settings.service.js');
    const publicUrl = await getSetting('PUBLIC_URL');
    if (publicUrl && /^https?:\/\//.test(publicUrl)) base = publicUrl.replace(/\/$/, '');
  } catch { /* fallback al default */ }
  let supportLine = '';
  try {
    const { getSupportLine } = await import('./support-contact.js');
    supportLine = await getSupportLine();
  } catch { /* sin línea de soporte */ }
  return (
    '⏳ *Tu prueba terminó*\n\n' +
    'Para seguir usando las funciones completas (IA, audios, documentos, ' +
    'agronomía), activá tu plan desde tu panel:\n' +
    `${base}/dashboard\n\n` +
    'Tus datos siguen guardados — nada se pierde. Podés seguir consultando ' +
    'tus campos y lotes con *mis campos* / *mis lotes*.' +
    (supportLine ? `\n\n${supportLine}` : '')
  );
}
