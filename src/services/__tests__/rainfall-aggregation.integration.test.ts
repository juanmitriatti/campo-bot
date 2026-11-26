/**
 * Auditoría de datos (nov 2026), #3: la lluvia del Resumen se sumaba entre campos
 * y entre socios. Una cifra por campo y día (MAX) y promedio entre campos.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../testing/integration/pipeline-harness.js';
import { getOverview } from '../overview.service.js';
import { campaignRange, currentSeasonYear } from '../../utils/campaign-range.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('lluvia del Resumen: una cifra por campo y día, promedio entre campos', () => {
  let h: PipelineHarness;
  let owner: number;
  let member: number;
  let f1: number;
  let f2: number;
  let f3: number;
  const range = campaignRange(currentSeasonYear());
  const day = range.from; // 1 sep: dentro de la campaña, mes 0 de la ventana

  beforeAll(async () => {
    h = await createPipelineHarness('rain-agg');
    owner = Number(h.userId);
    member = (await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id) VALUES ('Socio lluvia', $1, 'x', 4) RETURNING id`,
      [`socio-rain-${Date.now()}@test.local`],
    )).rows[0].id;
    const mk = async (name: string) => (await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, $2) RETURNING id`, [owner, name])).rows[0].id as number;
    f1 = await mk('Lluvia 1'); f2 = await mk('Lluvia 2'); f3 = await mk('Lluvia 3');
    for (const f of [f1, f2, f3]) {
      await pool.query(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [f, owner]);
    }
    await pool.query(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'member', $3)`, [f1, member, owner]);
    // 30 mm el mismo día en cada uno de los 3 campos (cargados por el dueño)…
    for (const f of [f1, f2, f3]) {
      await pool.query(`INSERT INTO rainfall (user_id, field_id, rainfall_date, millimeters) VALUES ($1, $2, $3, 30)`, [owner, f, day]);
    }
    // …y el socio carga la MISMA lluvia en el campo compartido (otra fila: el índice es por usuario).
    await pool.query(`INSERT INTO rainfall (user_id, field_id, rainfall_date, millimeters) VALUES ($1, $2, $3, 30)`, [member, f1, day]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM rainfall WHERE field_id = ANY($1::int[])`, [[f1, f2, f3]]);
    await pool.query(`DELETE FROM field_members WHERE field_id = ANY($1::int[])`, [[f1, f2, f3]]);
    await pool.query(`DELETE FROM fields WHERE id = ANY($1::int[])`, [[f1, f2, f3]]);
    await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [member]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [member]);
    await h?.cleanup();
  });

  it('un campo compartido: la misma lluvia cargada por dos socios cuenta una vez', async () => {
    const o = await getOverview(owner, [f1], range);
    expect(o.rainfall.months[0].mm).toBe(30);
    expect(o.rainfall.total).toBe(30);
  });

  it('"Todos los campos": 30 mm en cada uno de 3 campos es 30 mm, no 90', async () => {
    const o = await getOverview(owner, [f1, f2, f3], range);
    expect(o.rainfall.months[0].mm).toBe(30);
    expect(o.rainfall.total).toBe(30);
  });
});
