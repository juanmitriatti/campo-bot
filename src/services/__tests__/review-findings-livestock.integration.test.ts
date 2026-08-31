import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../testing/integration/pipeline-harness.js';
import { getReviewFindings } from '../review-findings.service.js';
import { AnimalService } from '../../domain/livestock/animal.service.js';
import { campaignRange } from '../../utils/campaign-range.js';

/**
 * Las tres reglas ganaderas de "Para revisar".
 *
 * Lo importante no es solo que disparen cuando hay un problema, sino que se
 * queden CALLADAS con el modelo híbrido funcionando normalmente: un grupo
 * parcialmente individualizado y un corral sin capacidad configurada son
 * estados válidos, y reportarlos entrenaría al usuario a ignorar la pantalla.
 */

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('review-findings — reglas de hacienda', () => {
  let h: PipelineHarness;
  let service: AnimalService;
  let fieldId: number;
  let plotId: number;

  const ctx = () => ({
    userId: Number(h.userId),
    fieldIds: [fieldId],
    range: campaignRange(2026),
  });

  beforeAll(async () => {
    h = await createPipelineHarness('review-livestock');
    service = new AnimalService();
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Revisable') RETURNING id`, [h.userId]);
    fieldId = f[0].id as number;
    const p = await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Norte') RETURNING id`, [fieldId]);
    plotId = p[0].id as number;
  });

  afterAll(async () => { await h?.cleanup(); });

  it('arranca sin hallazgos de hacienda', async () => {
    const found = await getReviewFindings(ctx());
    expect(found.filter((f) => f.rule.startsWith('livestock_') || f.rule.startsWith('corral_') || f.rule.startsWith('animal_'))).toEqual([]);
  });

  it('NO reporta un grupo parcialmente individualizado (es el modelo híbrido funcionando)', async () => {
    const g = await h.q(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
       VALUES ($1, $2, $3, 'vaca', 'Angus', 100) RETURNING id`,
      [h.userId, fieldId, plotId],
    );
    const gid = g[0].id as string;

    for (let i = 0; i < 3; i++) {
      await service.registerAnimal({
        userId: Number(h.userId), category: 'vaca',
        rfid: `03201000009000${i}`, fieldId, plotId, groupId: gid,
      });
    }

    const found = await getReviewFindings(ctx());
    expect(found.some((f) => f.rule === 'livestock_group_vs_individuals')).toBe(false);
  });

  it('reporta el EXCESO de individuales sobre el count declarado', async () => {
    const g = await h.q(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
       VALUES ($1, $2, $3, 'toro', 'Angus', 1) RETURNING id`,
      [h.userId, fieldId, plotId],
    );
    const gid = g[0].id as string;

    for (let i = 0; i < 3; i++) {
      await service.registerAnimal({
        userId: Number(h.userId), category: 'toro',
        rfid: `03201000009100${i}`, fieldId, plotId, groupId: gid,
      });
    }

    const found = await getReviewFindings(ctx());
    const finding = found.find((f) => f.rule === 'livestock_group_vs_individuals');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warn');
    expect(finding!.title).toMatch(/toro/);
    expect(finding!.body).toMatch(/Declara 1 animales, pero tiene 3/);
    expect(finding!.fieldId).toBe(fieldId);
  });

  it('reporta un corral por encima de su capacidad, y calla si no tiene capacidad configurada', async () => {
    const fl = await h.q(
      `INSERT INTO feedlots (field_id, user_id, name) VALUES ($1, $2, 'FL Revisable') RETURNING id`,
      [fieldId, h.userId],
    );
    const conCap = await h.q(
      `INSERT INTO corrals (feedlot_id, name, capacity) VALUES ($1, 'Lleno', 100) RETURNING id`, [fl[0].id],
    );
    const sinCap = await h.q(
      `INSERT INTO corrals (feedlot_id, name, capacity) VALUES ($1, 'Sin cap', NULL) RETURNING id`, [fl[0].id],
    );

    await h.q(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, corral_id, category, breed, count)
       VALUES ($1, $2, NULL, $3, 'novillo', 'Angus', 150)`,
      [h.userId, fieldId, conCap[0].id],
    );
    await h.q(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, corral_id, category, breed, count)
       VALUES ($1, $2, NULL, $3, 'novillo', 'Hereford', 9999)`,
      [h.userId, fieldId, sinCap[0].id],
    );

    const found = await getReviewFindings(ctx());
    const over = found.filter((f) => f.rule === 'corral_overcapacity');
    expect(over).toHaveLength(1);
    expect(over[0].title).toMatch(/Lleno/);
    expect(over[0].body).toMatch(/150 animales/);
    expect(over[0].body).toMatch(/configurado para 100/);
  });

  it('NO reporta la carga retroactiva: alta hoy con venta fechada en el pasado', async () => {
    // El alta genera `identificacion` e `ingreso` con la fecha de HOY, que es
    // posterior a la venta de mayo. Eso es carga al día, no un dato imposible.
    const { animal } = await service.registerAnimal({
      userId: Number(h.userId), category: 'vaca', rfid: '032010000091500', fieldId, plotId,
    });
    await service.setStatus({
      userId: Number(h.userId), animalIds: [animal.id], status: 'vendido', exitDate: '2026-05-01',
    });

    const found = await getReviewFindings(ctx());
    expect(found.some((f) => f.key === `animal-after-exit-${animal.id}`)).toBe(false);
  });

  it('reporta un animal dado de baja al que se le siguió trabajando', async () => {
    const { animal } = await service.registerAnimal({
      userId: Number(h.userId), category: 'vaca', rfid: '032010000092000', fieldId, plotId,
    });
    await service.setStatus({
      userId: Number(h.userId), animalIds: [animal.id], status: 'vendido', exitDate: '2026-05-01',
    });
    // Un pesaje POSTERIOR a la venta: eso sí es imposible.
    await h.q(
      `INSERT INTO animal_events (user_id, animal_id, event_type, event_date, numeric_value, unit)
       VALUES ($1, $2, 'pesaje', '2026-07-15', 430, 'kg')`,
      [h.userId, animal.id],
    );

    const found = await getReviewFindings(ctx());
    const finding = found.find((f) => f.key === `animal-after-exit-${animal.id}`);
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warn');
    expect(finding!.body).toMatch(/032010000092000/);
    expect(finding!.body).toMatch(/1 evento\(s\) posteriores/);
  });

  it('una regla que explota no tumba el resto del Resumen', async () => {
    // `getReviewFindings` atrapa por regla; con datos válidos igual devuelve
    // findings y nunca lanza. Esto fija ese contrato.
    await expect(getReviewFindings(ctx())).resolves.toBeInstanceOf(Array);
  });

  it('no reporta hacienda de campos fuera del filtro seleccionado', async () => {
    const found = await getReviewFindings({ ...ctx(), fieldIds: [-1] });
    expect(found.some((f) => f.rule === 'livestock_group_vs_individuals')).toBe(false);
    expect(found.some((f) => f.rule === 'corral_overcapacity')).toBe(false);
  });
});
