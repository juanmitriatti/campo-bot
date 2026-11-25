/**
 * "Para revisar" → campos sin actividad (QA nov 2026). Una cuenta nueva con un
 * campo y sus lotes, sin ningún registro, veía "Campos sin actividad" bajo
 * "cosas que el bot pudo haber entendido mal" antes de haberle hablado al bot.
 * Solo es sospechoso al lado de otro campo que SÍ tiene registros.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../testing/integration/pipeline-harness.js';
import { getReviewFindings } from '../review-findings.service.js';
import { campaignRange, currentSeasonYear } from '../../utils/campaign-range.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('Para revisar — campos sin actividad', () => {
  let h: PipelineHarness;
  let userId: number;
  let emptyField: number;
  let activeField: number;
  const range = campaignRange(currentSeasonYear());

  beforeAll(async () => {
    h = await createPipelineHarness('hollow-new');
    userId = Number(h.userId);
    const f1 = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Vacío') RETURNING id`, [userId]);
    emptyField = f1.rows[0].id;
    await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100)`, [emptyField]);
    const f2 = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Activo') RETURNING id`, [userId]);
    activeField = f2.rows[0].id;
    await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Sur', 50)`, [activeField]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM expenses WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM plots WHERE field_id = ANY($1::int[])`, [[emptyField, activeField]]);
    await pool.query(`DELETE FROM fields WHERE id = ANY($1::int[])`, [[emptyField, activeField]]);
    await h?.cleanup();
  });

  it('cuenta nueva sin ningún registro: no lo marca', async () => {
    const findings = await getReviewFindings({ userId, fieldIds: [emptyField, activeField], range });
    expect(findings.find((f) => f.rule === 'hollow_fields')).toBeUndefined();
  });

  it('otro campo con registros: marca el vacío', async () => {
    await pool.query(
      `INSERT INTO expenses (user_id, field_id, amount, currency, category, description, expense_date)
       VALUES ($1, $2, 1000, 'ARS', 'Gasoil', 'test', $3)`,
      [userId, activeField, range.from],
    );
    const findings = await getReviewFindings({ userId, fieldIds: [emptyField, activeField], range });
    const hollow = findings.find((f) => f.rule === 'hollow_fields');
    expect(hollow?.body).toMatch(/Vacío/);
    expect(hollow?.body).not.toMatch(/Activo/);
  });
});
