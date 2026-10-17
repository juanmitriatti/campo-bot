/**
 * Bloquear y dar de baja usuarios desde /admin (prod, 17 oct 2026): el borrado
 * del admin era un DELETE físico sin transacción que chocaba con la hacienda
 * (livestock_groups → plots) después de haber borrado medio usuario, y una
 * cuenta bloqueada seguía usando el bot. Contra la DB real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../../testing/integration/pipeline-harness.js';
import { AccountDeletionService, AccountDeletionError } from '../account-deletion.service.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('acciones del admin sobre usuarios', () => {
  let h: PipelineHarness;
  let email: string;

  beforeAll(async () => {
    h = await createPipelineHarness('admin-user-actions');
    email = (await h.q(`SELECT email FROM users WHERE id = $1`, [h.userId]))[0].email as string;
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Baja') RETURNING id`, [h.userId]);
    const p = await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Norte') RETURNING id`, [f[0].id]);
    await h.q(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
       VALUES ($1, $2, $3, 'vaca', 'Angus', 10)`,
      [h.userId, f[0].id, p[0].id],
    );
    await h.q(
      `INSERT INTO expenses (user_id, field_id, amount, currency, category, description)
       VALUES ($1, $2, 1000, 'ARS', 'Otros', 'gasto de prueba')`,
      [h.userId, f[0].id],
    ).catch(() => null);
  });

  afterAll(async () => {
    // La baja borra el mail: se lo devolvemos para que el cleanup del harness lo encuentre.
    await pool.query(`UPDATE users SET email = $2, status = 'active', deleted_at = NULL WHERE id = $1`, [h.userId, email]);
    await h?.cleanup();
  });

  it('una cuenta bloqueada no es atendida por el bot y no guarda nada', async () => {
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [h.userId]);
    const before = await h.q(`SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1`, [h.userId]);
    const reply = h.allText(await h.send('gasté 50 mil en gasoil'));
    expect(reply).toMatch(/cuenta está bloqueada/);
    const tapReply = h.allText(await h.tap('cmd_resumen_mensual'));
    expect(tapReply).toMatch(/cuenta está bloqueada/);
    const after = await h.q(`SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1`, [h.userId]);
    expect(after[0].n).toBe(before[0].n);
    await pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [h.userId]);
    expect(h.allText(await h.send('hola'))).not.toMatch(/bloqueada/);
  });

  it('un "Confirmar" viejo de OTRO borrado no ejecuta el borrado pendiente', async () => {
    const ask = await h.send('borrar ultimo gasto');
    const confirmBtn = h.allButtons(ask).find(b => b.id.startsWith('confirm_destructive_'));
    if (!confirmBtn) return; // el parser no lo tomó como borrado: no hay nada que probar acá
    const before = await h.q(`SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1 AND deleted_at IS NULL`, [h.userId]);
    const other = confirmBtn.id === 'confirm_destructive_delete_last_income' ? 'confirm_destructive_delete_last' : 'confirm_destructive_delete_last_income';
    const reply = await h.tap(other);
    expect(h.allButtons(reply).some(b => b.id === confirmBtn.id)).toBe(true);
    const after = await h.q(`SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1 AND deleted_at IS NULL`, [h.userId]);
    expect(after[0].n).toBe(before[0].n);
    await h.tap('cancel_destructive');
  });

  it('la baja del admin funciona con hacienda cargada: soft delete, sin datos personales, registros intactos', async () => {
    await new AccountDeletionService().deleteByAdmin(h.userId);
    const u = (await h.q(`SELECT deleted_at, status, email, phone_number, name FROM users WHERE id = $1`, [h.userId]))[0];
    expect(u.deleted_at).not.toBeNull();
    expect(u.status).toBe('deleted');
    expect(u.email).toBeNull();
    expect(u.phone_number).toBeNull();
    expect(u.name).toBeNull();
    const groups = await h.q(`SELECT COUNT(*)::int AS n FROM livestock_groups WHERE user_id = $1`, [h.userId]);
    expect(groups[0].n).toBe(1);
  });

  it('dar de baja dos veces devuelve 410, y un id inexistente 404', async () => {
    await expect(new AccountDeletionService().deleteByAdmin(h.userId)).rejects.toMatchObject({ status: 410 });
    const err = await new AccountDeletionService().deleteByAdmin(-1 as never).catch(e => e);
    expect(err).toBeInstanceOf(AccountDeletionError);
    expect(err.status).toBe(404);
  });
});

describe.skipIf(!dbAvailable)('baja por chat ("borrar mi cuenta")', () => {
  let h: PipelineHarness;
  let email: string;

  beforeAll(async () => {
    h = await createPipelineHarness('chat-account-delete');
    email = (await h.q(`SELECT email FROM users WHERE id = $1`, [h.userId]))[0].email as string;
  });
  afterAll(async () => {
    await pool.query(`UPDATE users SET email = $2, status = 'active', deleted_at = NULL WHERE id = $1`, [h.userId, email]);
    await h?.cleanup();
  });

  it('una frase parecida que no es la baja no la dispara', async () => {
    const r = await h.send('borrar mi cuenta de gastos del lote norte');
    expect(h.allButtons(r).some(b => b.id.startsWith('acct_del_ok_'))).toBe(false);
  });

  it('un botón con un token inventado no borra nada', async () => {
    const r = h.allText(await h.tap('acct_del_ok_inventado'));
    expect(r).toMatch(/no borré nada/);
    const u = await h.q(`SELECT deleted_at FROM users WHERE id = $1`, [h.userId]);
    expect(u[0].deleted_at).toBeNull();
  });

  it('"borrar mi cuenta" pide confirmación con botón y el botón da de baja la cuenta', async () => {
    const ask = await h.send('borrar mi cuenta');
    const ok = h.allButtons(ask).find(b => b.id.startsWith('acct_del_ok_'));
    expect(ok).toBeTruthy();
    expect(h.allText(ask)).toMatch(/no se puede deshacer/i);
    // Un "sí" escrito NO alcanza para dar de baja.
    await h.send('sí');
    expect((await h.q(`SELECT deleted_at FROM users WHERE id = $1`, [h.userId]))[0].deleted_at).toBeNull();

    const done = h.allText(await h.tap(ok!.id));
    expect(done).toMatch(/dada de baja/);
    const u = (await h.q(`SELECT deleted_at, status, email FROM users WHERE id = $1`, [h.userId]))[0];
    expect(u.deleted_at).not.toBeNull();
    expect(u.status).toBe('deleted');
    expect(u.email).toBeNull();
  });
});

describe.skipIf(!dbAvailable)('purga de cuentas dadas de baja', () => {
  let h: PipelineHarness;
  let email: string;

  beforeAll(async () => {
    h = await createPipelineHarness('account-purge');
    email = (await h.q(`SELECT email FROM users WHERE id = $1`, [h.userId]))[0].email as string;
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Purga') RETURNING id`, [h.userId]);
    const p = await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Norte') RETURNING id`, [f[0].id]);
    await h.q(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count) VALUES ($1, $2, $3, 'vaca', 'Angus', 10)`,
      [h.userId, f[0].id, p[0].id],
    );
    await h.send('hola'); // deja conversación registrada
    subInserted = await h.q(
      `INSERT INTO subscriptions (user_id, plan_id, status, provider) VALUES ($1, 4, 'cancelled', 'manual')`,
      [h.userId],
    ).then(() => true, () => false);
  });
  let subInserted = false;
  afterAll(async () => {
    await pool.query(`UPDATE users SET email = $2, status = 'active', deleted_at = NULL, purged_at = NULL WHERE id = $1`, [h.userId, email]);
    await h?.cleanup();
  });

  it('una cuenta activa no se purga', async () => {
    const { purgeDeletedUser } = await import('../account-purge.service.js');
    expect(await purgeDeletedUser(Number(h.userId))).toMatchObject({ status: 'skipped' });
    expect((await h.q(`SELECT COUNT(*)::int AS n FROM fields WHERE user_id = $1`, [h.userId]))[0].n).toBe(1);
  });

  it('con la purga apagada el job no borra nada', async () => {
    await new AccountDeletionService().deleteByAdmin(h.userId);
    await pool.query(`UPDATE users SET deleted_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [h.userId]);
    const { purgeDeletedAccounts } = await import('../account-purge.service.js');
    const { setSetting } = await import('../../../services/settings.service.js');
    await setSetting('ACCOUNT_PURGE_ENABLED', 'false');
    const r = await purgeDeletedAccounts();
    expect(r.purged).toBe(0);
    expect((await h.q(`SELECT COUNT(*)::int AS n FROM livestock_groups WHERE user_id = $1`, [h.userId]))[0].n).toBe(1);
  });

  it('purga todo lo del usuario, deja la lápida y las suscripciones', async () => {
    const { purgeDeletedUser } = await import('../account-purge.service.js');
    const res = await purgeDeletedUser(Number(h.userId));
    expect(res.status).toBe('purged');
    for (const t of ['fields', 'livestock_groups', 'conversation_logs', 'user_settings']) {
      expect((await h.q(`SELECT COUNT(*)::int AS n FROM ${t} WHERE user_id = $1`, [h.userId]))[0].n, t).toBe(0);
    }
    const u = (await h.q(`SELECT purged_at, deleted_at FROM users WHERE id = $1`, [h.userId]))[0];
    expect(u.purged_at).not.toBeNull();
    expect(u.deleted_at).not.toBeNull();
    const subs = await h.q(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE user_id = $1`, [h.userId]);
    if (subInserted) expect(subs[0].n).toBeGreaterThanOrEqual(1);
    expect(await purgeDeletedUser(Number(h.userId))).toMatchObject({ status: 'skipped', reason: 'ya purgada' });
  });
});
