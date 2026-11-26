/**
 * Auditoría de datos (nov 2026), #15: "cuánta soja coseché" en el chat contaba solo
 * los campos PROPIOS (`f.user_id = $1`): un socio de un campo compartido recibía 0
 * mientras el dashboard le mostraba los kilos.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { getCampaignProductionKg, findPlotsWithCrop } from '../expenses.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('producción en un campo compartido (chat)', () => {
  let owner: number;
  let member: number;
  let stranger: number;
  let fieldId: number;
  let plotId: number;

  beforeAll(async () => {
    const mk = async (tag: string) => (await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id) VALUES ($1, $2, 'x', 4) RETURNING id`, [`Prod ${tag}`, `zz-prod-${tag}-${Date.now()}@test.local`],
    )).rows[0].id as number;
    owner = await mk('o'); member = await mk('m'); stranger = await mk('x');
    fieldId = (await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo compartido prod') RETURNING id`, [owner])).rows[0].id;
    await pool.query(
      `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2), ($1, $3, 'member', $2)`, [fieldId, owner, member],
    );
    plotId = (await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Lote prod', 100) RETURNING id`, [fieldId])).rows[0].id;
    await pool.query(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, harvested_at, yield_kg)
       VALUES ($1, 'soja', 2026, 'gruesa', CURRENT_DATE - 100, CURRENT_DATE - 10, 400000)`, [plotId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM plot_crops WHERE plot_id = $1`, [plotId]);
    await pool.query(`DELETE FROM plots WHERE id = $1`, [plotId]);
    await pool.query(`DELETE FROM field_members WHERE field_id = $1`, [fieldId]);
    await pool.query(`DELETE FROM fields WHERE id = $1`, [fieldId]);
    await pool.query(`DELETE FROM user_settings WHERE user_id = ANY($1::int[])`, [[owner, member, stranger]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [[owner, member, stranger]]);
  });

  it('el dueño y el socio ven la misma producción', async () => {
    expect(await getCampaignProductionKg(owner, { fieldId })).toBe(400000);
    expect(await getCampaignProductionKg(member, { fieldId })).toBe(400000);
  });

  it('un tercero sin acceso ve 0', async () => {
    expect(await getCampaignProductionKg(stranger, { fieldId })).toBe(0);
  });

  it('findPlotsWithCrop (deducir el lote de una venta de grano) también ve el campo del socio', async () => {
    const plots = await findPlotsWithCrop(member, 'soja');
    expect(plots.map((p: { id: number }) => p.id)).toContain(plotId);
    expect(await findPlotsWithCrop(stranger, 'soja')).toEqual([]);
  });
});
