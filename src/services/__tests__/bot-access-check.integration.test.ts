/**
 * Panel de admin "¿Puede usar el bot?": cada chequeo tiene que decir lo mismo
 * que el camino real (gate de canal, cuenta bloqueada, prueba vencida).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { setSetting, getSetting } from '../settings.service.js';
import { getBotAccessReport } from '../bot-access-check.service.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('¿puede usar el bot? (panel de admin)', () => {
  const ids: number[] = [];
  const tag = `zz-botaccess-${Date.now()}`;
  const base = 5491100000000 + Math.floor(Math.random() * 90_000_000);
  let n = 0;
  let previousRequire: string | null = null;

  const add = async (opts: { verified?: boolean; status?: string; phone?: string | null } = {}) => {
    n += 1;
    const phone = opts.phone === undefined ? String(base + n) : opts.phone;
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone_number, status, whatsapp_verified_at)
       VALUES ('Chequeo', $1, 'x', 'end_user', $2, $3, ${opts.verified === false ? 'NULL' : 'NOW()'}) RETURNING id`,
      [`${tag}-${n}@test.local`, phone, opts.status ?? 'active'],
    );
    ids.push(rows[0].id);
    return Number(rows[0].id);
  };
  const check = (r: Awaited<ReturnType<typeof getBotAccessReport>>, key: string) => r!.checks.find(c => c.key === key);

  beforeAll(async () => {
    previousRequire = (await getSetting('REQUIRE_VERIFIED_CHANNEL')) as string | null;
    await setSetting('REQUIRE_VERIFIED_CHANNEL', 'true');
  });
  afterAll(async () => {
    await setSetting('REQUIRE_VERIFIED_CHANNEL', previousRequire ?? 'false');
    await pool.query(`DELETE FROM subscriptions WHERE user_id = ANY($1::int[])`, [ids]);
    await pool.query(`DELETE FROM user_settings WHERE user_id = ANY($1::int[])`, [ids]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [ids]);
  });

  it('verificado, activo y sin suscripción: puede (acceso sin vencimiento)', async () => {
    const id = await add();
    const r = await getBotAccessReport(id);
    expect(r!.verdict).toBe('puede');
    expect(check(r, 'routing')!.ok).toBe(true);
    expect(check(r, 'access')!.detail).toMatch(/sin vencimiento/);
    expect(check(r, 'window')!.ok).toBeNull();
  });

  it('cuenta bloqueada: no puede', async () => {
    const r = await getBotAccessReport(await add({ status: 'suspended' }));
    expect(r!.verdict).toBe('no_puede');
    expect(check(r, 'account')!.ok).toBe(false);
  });

  it('WhatsApp sin verificar con la verificación exigida: no puede', async () => {
    const r = await getBotAccessReport(await add({ verified: false }));
    expect(r!.verdict).toBe('no_puede');
    expect(check(r, 'verified')!.ok).toBe(false);
    expect(check(r, 'routing')!.ok).toBe(false);
  });

  it('sin número: no puede', async () => {
    const r = await getBotAccessReport(await add({ phone: null, verified: false }));
    expect(r!.verdict).toBe('no_puede');
    expect(check(r, 'phone')!.ok).toBe(false);
  });

  it('número verificado en otra cuenta anterior: el bot le contesta como esa', async () => {
    const first = await add();
    // Mismo celular en el formato viejo del OTP web (+54 sin el 9): el webhook lo canoniza igual.
    const phone = '+54' + String(base + n).slice(3);
    const second = await add({ phone });
    const r = await getBotAccessReport(second);
    expect(check(r, 'routing')!.ok).toBe(false);
    expect(check(r, 'routing')!.detail).toContain(`#${first}`);
    expect(r!.verdict).toBe('no_puede');
  });

  it('prueba vencida: puede escribir pero solo consultar', async () => {
    const id = await add();
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, provider, status, trial_ends_at)
       VALUES ($1, (SELECT id FROM plans WHERE name = 'pro_plus'), 'manual', 'trial', NOW() - INTERVAL '2 days')`,
      [id],
    );
    const r = await getBotAccessReport(id);
    expect(r!.verdict).toBe('solo_lectura');
    expect(check(r, 'access')!.ok).toBe(false);
    expect(check(r, 'access')!.detail).toMatch(/vencida/);
  });

  it('usuario inexistente: null', async () => {
    expect(await getBotAccessReport(999999999)).toBeNull();
  });
});
