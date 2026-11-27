/**
 * Panel de admin: "Usuarios nuevos (semana)". Lunes a domingo en hora argentina,
 * sin administradores, bajas ni test-bot.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, withTransaction } from '../../config/db.js';
import { getWeeklySignups } from '../signup-stats.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('altas de la semana', () => {
  const ids: number[] = [];
  const tag = `zz-signup-${Date.now()}`;
  const WEEK_START = `date_trunc('week', NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires'`;

  const add = async (n: number, createdAtSql: string, extra: { role?: string; phone?: string; deleted?: boolean } = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone_number, deleted_at, created_at)
       VALUES ('Alta', $1, 'x', $2, $3, ${extra.deleted ? 'NOW()' : 'NULL'}, ${createdAtSql}) RETURNING id`,
      [`${tag}-${n}@test.local`, extra.role ?? 'end_user', extra.phone ?? null],
    );
    ids.push(rows[0].id);
  };

  afterAll(async () => {
    await pool.query(`DELETE FROM user_settings WHERE user_id = ANY($1::int[])`, [ids]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [ids]);
  });

  it('cuenta las de esta semana y la anterior, y deja afuera admin, bajas y test-bot', async () => {
    // REPEATABLE READ + rollback: otros tests crean usuarios en paralelo y ensuciaban la diferencia.
    const rollback = new Error('rollback');
    await expect(withTransaction(async () => {
    await pool.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const before = await getWeeklySignups();
    await add(1, 'DEFAULT'); // alta nueva: la columna se completa sola
    await add(2, `${WEEK_START}`); // lunes 00:00: entra en esta semana
    await add(3, `${WEEK_START} - INTERVAL '1 minute'`); // domingo anterior
    await add(4, `${WEEK_START} - INTERVAL '8 days'`); // hace dos semanas
    await add(5, 'NOW()', { role: 'admin' });
    await add(6, 'NOW()', { deleted: true });
    await add(7, 'NOW()', { phone: `testbot_${tag}` });

    const after = await getWeeklySignups();
    expect(after.thisWeek - before.thisWeek).toBe(2);
    expect(after.lastWeek - before.lastWeek).toBe(1);
    throw rollback;
    })).rejects.toBe(rollback);
  });
});
