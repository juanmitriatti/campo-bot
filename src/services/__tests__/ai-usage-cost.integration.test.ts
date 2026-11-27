/**
 * ai_usage guarda modelo y costo de cada llamada (migración 139): el panel los
 * suma en vez de recalcular todo con la tarifa de Haiku 4.5.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { saveAiUsage } from '../expenses.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('costo guardado por llamada', () => {
  let userId: number;
  beforeAll(async () => {
    userId = (await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ('Costo', $1, 'x') RETURNING id`, [`zz-cost-${Date.now()}@test.local`],
    )).rows[0].id;
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM ai_usage WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it('guarda el modelo y el costo con la tarifa de ese modelo', async () => {
    await saveAiUsage(userId, { input_tokens: 1000, output_tokens: 100, cache_write_tokens: 114_000, model: 'claude-haiku-5-5' });
    await saveAiUsage(userId, { input_tokens: 1_000_000, output_tokens: 0, model: 'claude-haiku-4-5-20251001' });
    const { rows } = await pool.query(`SELECT model, cost_usd FROM ai_usage WHERE user_id = $1 ORDER BY id`, [userId]);
    expect(rows[0].model).toBe('claude-haiku-5-5');
    expect(Number(rows[0].cost_usd)).toBeCloseTo((1000 * 0.5 + 100 * 2.5 + 114_000 * 0.625) / 1e6, 6);
    expect(Number(rows[1].cost_usd)).toBeCloseTo(1, 6);
  });
});
