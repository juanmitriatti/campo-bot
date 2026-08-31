import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../../testing/integration/pipeline-harness.js';
import { CorralCapacityService } from '../corral-capacity.service.js';

/**
 * `corrals.capacity` existía desde la migración 055 pero nunca se validaba: un
 * corral de 500 se llenaba con 900 sin que el sistema dijera nada.
 *
 * Lo que estos tests fijan, además del cálculo, es la REGLA DE PRODUCTO: se
 * advierte, no se bloquea, y un corral sin capacidad configurada nunca advierte
 * (NULL significa "no me dijiste", no "cero").
 */

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('CorralCapacityService', () => {
  let h: PipelineHarness;
  let svc: CorralCapacityService;
  let fieldId: number;
  let feedlotId: number;
  let corralConCap: number;
  let corralSinCap: number;

  beforeAll(async () => {
    h = await createPipelineHarness('corral-capacity');
    svc = new CorralCapacityService();

    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'El Encierre') RETURNING id`, [h.userId]);
    fieldId = f[0].id as number;

    const fl = await h.q(
      `INSERT INTO feedlots (field_id, user_id, name, capacity) VALUES ($1, $2, 'Feedlot Central', 2000) RETURNING id`,
      [fieldId, h.userId],
    );
    feedlotId = fl[0].id as number;

    const c1 = await h.q(
      `INSERT INTO corrals (feedlot_id, name, capacity) VALUES ($1, 'Corral 1', 500) RETURNING id`, [feedlotId],
    );
    corralConCap = c1[0].id as number;

    const c2 = await h.q(
      `INSERT INTO corrals (feedlot_id, name, capacity) VALUES ($1, 'Corral 2', NULL) RETURNING id`, [feedlotId],
    );
    corralSinCap = c2[0].id as number;

    // 470 cabezas en el corral con capacidad 500.
    await h.q(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, corral_id, category, breed, count)
       VALUES ($1, $2, NULL, $3, 'novillo', 'Angus', 470)`,
      [h.userId, fieldId, corralConCap],
    );
  });

  afterAll(async () => { await h?.cleanup(); });

  const uid = () => Number(h.userId);

  it('proyecta la ocupación sumando el delta', async () => {
    // El caso del spec §15: capacidad 500, actual 470, movimiento +120 → 590.
    const check = await svc.check(uid(), corralConCap, 120);
    expect(check).toMatchObject({
      capacity: 500, current: 470, delta: 120, projected: 590, exceeds: true, overBy: 90,
    });
  });

  it('no advierte cuando la proyección entra justo en la capacidad', async () => {
    const check = await svc.check(uid(), corralConCap, 30);   // 470 + 30 = 500
    expect(check?.projected).toBe(500);
    expect(check?.exceeds).toBe(false);
    expect(check?.overBy).toBe(0);
    expect(await svc.warningFor(uid(), corralConCap, 30)).toBeNull();
  });

  it('advierte con un mensaje que nombra el corral y el excedente', async () => {
    const msg = await svc.warningFor(uid(), corralConCap, 120);
    expect(msg).toMatch(/⚠️/);
    expect(msg).toMatch(/Corral 1/);
    expect(msg).toMatch(/590/);
    expect(msg).toMatch(/500/);
    expect(msg).toMatch(/90 de más/);
  });

  it('un corral SIN capacidad configurada nunca advierte', async () => {
    const check = await svc.check(uid(), corralSinCap, 100_000);
    expect(check?.capacity).toBeNull();
    expect(check?.exceeds).toBe(false);
    expect(await svc.warningFor(uid(), corralSinCap, 100_000)).toBeNull();
  });

  it('con delta 0 refleja la ocupación actual (uso post-escritura del handler)', async () => {
    const check = await svc.check(uid(), corralConCap, 0);
    expect(check?.projected).toBe(470);
    expect(check?.exceeds).toBe(false);
  });

  it('devuelve null para un corral de otro usuario en vez de filtrar datos', async () => {
    const other = await createPipelineHarness('corral-capacity-other');
    try {
      const of = await other.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Ajeno') RETURNING id`, [other.userId]);
      const ofl = await other.q(
        `INSERT INTO feedlots (field_id, user_id, name) VALUES ($1, $2, 'FL Ajeno') RETURNING id`,
        [of[0].id, other.userId],
      );
      const oc = await other.q(
        `INSERT INTO corrals (feedlot_id, name, capacity) VALUES ($1, 'Ajeno 1', 10) RETURNING id`, [ofl[0].id],
      );
      expect(await svc.check(uid(), oc[0].id as number, 5)).toBeNull();
      expect(await svc.warningFor(uid(), oc[0].id as number, 5)).toBeNull();
    } finally {
      await other.cleanup();
    }
  });

  it('devuelve null para un corral inexistente — un chequeo de capacidad nunca hace fallar la operación', async () => {
    expect(await svc.check(uid(), 999_999_999, 10)).toBeNull();
  });

  describe('findOvercapacity', () => {
    it('no lista nada mientras la ocupación esté dentro de la capacidad', async () => {
      expect(await svc.findOvercapacity(uid())).toEqual([]);
    });

    it('lista el corral una vez que se pasó', async () => {
      await h.q(
        `INSERT INTO livestock_groups (user_id, field_id, plot_id, corral_id, category, breed, count)
         VALUES ($1, $2, NULL, $3, 'vaquillona', 'Hereford', 80)`,
        [h.userId, fieldId, corralConCap],
      );
      const over = await svc.findOvercapacity(uid());
      expect(over).toHaveLength(1);
      expect(over[0]).toMatchObject({
        corralName: 'Corral 1', feedlotName: 'Feedlot Central',
        capacity: 500, current: 550, overBy: 50,
      });
    });

    it('ignora los grupos borrados al sumar la ocupación', async () => {
      await h.q(
        `UPDATE livestock_groups SET deleted_at = NOW()
          WHERE corral_id = $1 AND category = 'vaquillona'`,
        [corralConCap],
      );
      expect(await svc.findOvercapacity(uid())).toEqual([]);
    });
  });
});
