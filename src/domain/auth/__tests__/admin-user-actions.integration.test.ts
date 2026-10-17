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
