/**
 * Ciclo de vida completo de una cuenta web contra la DB real, sin API
 * externa: registro → verificación de email → login (case-insensitive) →
 * "olvidé mi contraseña" → reset → login nuevo → sesiones viejas muertas →
 * cuenta suspendida / borrada.
 *
 * El mailer está mockeado: capturamos los links que el usuario recibiría por
 * email y los seguimos como lo haría él. Cada bug de acá fue encontrado
 * revisando el flujo desde cero (sep 2026): registrarse con mayúsculas dejaba
 * la cuenta sin recuperación posible, el mismo link de verificación tocado dos
 * veces decía "inválido", y el lookup de tokens miraba solo los 50 más
 * recientes de TODO el sistema.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { pool } from '../../../config/db.js';

const sentLinks: { to: string; subject: string; link: string }[] = [];

vi.mock('../../../services/mailer.service.js', () => ({
  sendEmail: vi.fn(async ({ to, subject, text }: { to: string; subject: string; text: string }) => {
    const m = text.match(/https?:\/\/\S+|\/(?:reset-password|verify-email)\?token=\S+/);
    sentLinks.push({ to, subject, link: m ? m[0] : '' });
    return { ok: true, id: 'fake' };
  }),
  wrapHtml: (_t: string, body: string) => body,
}));

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

function tokenFrom(link: string): string {
  const m = link.match(/token=([^&\s]+)/);
  if (!m) throw new Error(`link sin token: ${link}`);
  return m[1];
}

describe.skipIf(!dbAvailable)('Auth — ciclo de vida de la cuenta (registro, verificación, reset, login)', () => {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const typedEmail = `  Auth.Lifecycle+${stamp}@Example.COM `;
  const email = `auth.lifecycle+${stamp}@example.com`;
  const createdUserIds: number[] = [];

  let AuthService: typeof import('../auth.service.js').AuthService;
  let PasswordRecoveryService: typeof import('../password-recovery.service.js').PasswordRecoveryService;
  let confirmVerificationToken: typeof import('../email-verification.service.js').confirmVerificationToken;
  let sendVerificationEmail: typeof import('../email-verification.service.js').sendVerificationEmail;
  let auth: InstanceType<typeof AuthService>;
  let recovery: InstanceType<typeof PasswordRecoveryService>;
  let userId: number;
  let firstRefreshToken: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-lifecycle-test-secret';
    ({ AuthService } = await import('../auth.service.js'));
    ({ PasswordRecoveryService } = await import('../password-recovery.service.js'));
    ({ confirmVerificationToken, sendVerificationEmail } = await import('../email-verification.service.js'));
    // subscriptions=null: sin trial (no es lo que se prueba acá).
    auth = new AuthService(undefined, undefined, undefined, null as unknown as undefined);
    recovery = new PasswordRecoveryService();
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM user_settings WHERE user_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
    }
  });

  it('registro: guarda el email normalizado y manda el link de verificación', async () => {
    const r = await auth.register({ name: 'Ciclo', email: typedEmail, password: 'clave-inicial-1' });
    userId = r.user.id;
    createdUserIds.push(userId);
    firstRefreshToken = r.tokens.refreshToken;

    expect(r.user.email).toBe(email);
    const row = await pool.query('SELECT email, email_verified_at FROM users WHERE id = $1', [userId]);
    expect(row.rows[0].email).toBe(email);
    expect(row.rows[0].email_verified_at).toBeNull();

    const verify = sentLinks.find(l => l.to === email && /verif/i.test(l.subject));
    expect(verify?.link).toMatch(/\/verify-email\?token=/);
  });

  it('registro duplicado con otra capitalización → 409', async () => {
    await expect(auth.register({ name: 'Otro', email: `AUTH.LIFECYCLE+${stamp}@example.com`, password: 'clave-inicial-1' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('login: acepta cualquier capitalización del email y rechaza la contraseña incorrecta', async () => {
    const ok = await auth.login({ email: `AUTH.Lifecycle+${stamp}@EXAMPLE.com`, password: 'clave-inicial-1' });
    expect(ok.user.id).toBe(userId);
    await expect(auth.login({ email, password: 'clave-equivocada' })).rejects.toMatchObject({ status: 401 });
  });

  it('verificación: el link activa el email; tocarlo de nuevo es idempotente', async () => {
    const verify = sentLinks.find(l => l.to === email && /verif/i.test(l.subject))!;
    const token = tokenFrom(verify.link);

    const first = await confirmVerificationToken(token);
    expect(first).toMatchObject({ userId });
    expect(first.alreadyVerified).toBeFalsy();

    const row = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [userId]);
    expect(row.rows[0].email_verified_at).not.toBeNull();

    const again = await confirmVerificationToken(token);
    expect(again).toMatchObject({ userId, alreadyVerified: true });

    // Ya verificado: reenviar no manda nada y lo dice.
    expect(await sendVerificationEmail(userId)).toMatchObject({ ok: false, reason: 'already_verified' });
  });

  it('verificación: un token inventado es 400', async () => {
    await expect(confirmVerificationToken('no-existe')).rejects.toMatchObject({ status: 400 });
  });

  it('olvidé mi contraseña: con el email en mayúsculas igual llega el link (antes: 200 mudo)', async () => {
    const before = sentLinks.length;
    await recovery.requestReset(`AUTH.LIFECYCLE+${stamp}@EXAMPLE.COM`);
    const reset = sentLinks.slice(before).find(l => /contraseña/i.test(l.subject));
    expect(reset?.to).toBe(email);
    expect(reset?.link).toMatch(/\/reset-password\?token=/);
  });

  it('olvidé mi contraseña: email desconocido → ok sin enviar nada', async () => {
    const before = sentLinks.length;
    await expect(recovery.requestReset(`nadie-${stamp}@example.com`)).resolves.toMatchObject({ ok: true });
    expect(sentLinks.length).toBe(before);
  });

  it('reset: valida la contraseña, es de un solo uso, mata las sesiones y el login pasa a la nueva', async () => {
    const reset = [...sentLinks].reverse().find(l => l.to === email && /contraseña/i.test(l.subject))!;
    const token = tokenFrom(reset.link);

    await expect(recovery.resetPassword(token, 'corta')).rejects.toMatchObject({ status: 400 });
    await expect(recovery.resetPassword(token, 'clave-nueva-2')).resolves.toMatchObject({ ok: true });
    await expect(recovery.resetPassword(token, 'clave-nueva-3')).rejects.toThrow(/ya se usó/);

    await expect(auth.login({ email, password: 'clave-inicial-1' })).rejects.toMatchObject({ status: 401 });
    const ok = await auth.login({ email, password: 'clave-nueva-2' });
    expect(ok.user.id).toBe(userId);

    // La sesión del registro quedó revocada.
    await expect(auth.refreshTokens(firstRefreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('reset: pedir dos links deja vigente solo el último', async () => {
    const before = sentLinks.length;
    await recovery.requestReset(email);
    await recovery.requestReset(email);
    const links = sentLinks.slice(before).filter(l => /contraseña/i.test(l.subject));
    expect(links).toHaveLength(2);
    await expect(recovery.resetPassword(tokenFrom(links[0].link), 'clave-nueva-4')).rejects.toThrow(/ya se usó/);
    await expect(recovery.resetPassword(tokenFrom(links[1].link), 'clave-nueva-4')).resolves.toMatchObject({ ok: true });
  });

  it('reset: un link vencido se rechaza con mensaje propio', async () => {
    const before = sentLinks.length;
    await recovery.requestReset(email);
    const link = sentLinks.slice(before).find(l => /contraseña/i.test(l.subject))!.link;
    await pool.query(
      `UPDATE password_reset_tokens SET expires_at = NOW() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    await expect(recovery.resetPassword(tokenFrom(link), 'clave-nueva-5')).rejects.toThrow(/venció/);
  });

  it('reset: los tokens bcrypt emitidos antes del cambio siguen valiendo (compatibilidad de deploy)', async () => {
    const raw = `legacy-${stamp}`;
    const legacyHash = await bcrypt.hash(raw, 4);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + interval '10 minutes')`,
      [userId, legacyHash],
    );
    await expect(recovery.resetPassword(raw, 'clave-legacy-6')).resolves.toMatchObject({ ok: true });
    await expect(auth.login({ email, password: 'clave-legacy-6' })).resolves.toMatchObject({ user: { id: userId } });
  });

  it('cuenta suspendida por admin: no entra, no refresca, no recibe link de reset', async () => {
    const session = await auth.login({ email, password: 'clave-legacy-6' });
    await pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [userId]);

    await expect(auth.login({ email, password: 'clave-legacy-6' })).rejects.toMatchObject({ status: 403 });
    await expect(auth.refreshTokens(session.tokens.refreshToken)).rejects.toMatchObject({ status: 403 });

    const before = sentLinks.length;
    await expect(recovery.requestReset(email)).resolves.toMatchObject({ ok: true });
    expect(sentLinks.length).toBe(before);

    await pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [userId]);
  });

  it('cuenta borrada: el login no la encuentra y un reset pendiente no le pone contraseña', async () => {
    const before = sentLinks.length;
    await recovery.requestReset(email);
    const link = sentLinks.slice(before).find(l => /contraseña/i.test(l.subject))!.link;

    // Soft-delete como lo hace AccountDeletionService (email nulo, deleted_at).
    await pool.query(`UPDATE users SET deleted_at = NOW(), status = 'deleted' WHERE id = $1`, [userId]);

    await expect(auth.login({ email, password: 'clave-legacy-6' })).rejects.toMatchObject({ status: 401 });
    await expect(recovery.resetPassword(tokenFrom(link), 'clave-zombie-7')).rejects.toMatchObject({ status: 400 });

    const row = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    expect(await bcrypt.compare('clave-zombie-7', row.rows[0].password_hash)).toBe(false);
  });
});
