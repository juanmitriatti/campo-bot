/**
 * Auditoría de datos (nov 2026), #12: borrar una cosecha descontaba del silo la
 * suma de las ENTRADAS (ignoraba los "Camión corregido") y dejaba el stock en
 * negativo cuando el grano ya se había vendido.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { deleteDomainEvent } from '../expenses.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('borrar una cosecha y el stock del silo', () => {
  let userId: number;
  let fieldId: number;
  let plotId: number;
  let warehouseId: number;

  const plotIds: number[] = [];
  const harvestWithSiloStock = async (onHand: number) => {
    // Un lote por caso: borrar la cosecha reabre la campaña (índice de una activa por lote).
    plotId = (await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, $2, 100) RETURNING id`, [fieldId, `Lote Silo ${plotIds.length}`])).rows[0].id;
    plotIds.push(plotId);
    const pc = (await pool.query(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, harvested_at)
       VALUES ($1, 'soja', 2099, 'gruesa', '2099-01-01', '2099-04-01') RETURNING id`, [plotId],
    )).rows[0].id;
    const ev = (await pool.query(
      `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop) VALUES ($1, $2, $3, 'harvest', '2099-04-01', 'soja') RETURNING id`,
      [userId, plotId, pc],
    )).rows[0].id;
    const item = (await pool.query(
      `INSERT INTO stock_items (user_id, warehouse_id, name, unit, current_quantity) VALUES ($1, $2, $3, 'kg', $4) RETURNING id`,
      [userId, warehouseId, `Soja silo ${Date.now()}${Math.random()}`, onHand],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO stock_movements (stock_item_id, user_id, movement_type, quantity, reason, domain_event_id) VALUES ($1, $2, 'entrada', 30000, 'Cosecha', $3)`,
      [item, userId, ev],
    );
    // El camión se corrigió de 30.000 a 28.000 kg.
    await pool.query(
      `INSERT INTO stock_movements (stock_item_id, user_id, movement_type, quantity, reason, domain_event_id) VALUES ($1, $2, 'salida', 2000, 'Camión corregido', $3)`,
      [item, userId, ev],
    );
    return { pc, ev, item };
  };
  const onHand = async (item: number) => Number((await pool.query(`SELECT current_quantity FROM stock_items WHERE id = $1`, [item])).rows[0].current_quantity);

  beforeAll(async () => {
    userId = (await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id) VALUES ('Silo', $1, 'x', 4) RETURNING id`, [`zz-silo-${Date.now()}@test.local`],
    )).rows[0].id;
    fieldId = (await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo Silo') RETURNING id`, [userId])).rows[0].id;
    warehouseId = (await pool.query(`INSERT INTO warehouses (field_id, name) VALUES ($1, 'Galpón Silo') RETURNING id`, [fieldId])).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM stock_movements WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM stock_items WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM domain_events WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM plot_crops WHERE plot_id = ANY($1::int[])`, [plotIds]);
    await pool.query(`DELETE FROM warehouses WHERE field_id = $1`, [fieldId]);
    await pool.query(`DELETE FROM plots WHERE id = ANY($1::int[])`, [plotIds]);
    await pool.query(`DELETE FROM fields WHERE id = $1`, [fieldId]);
    await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it('descuenta el NETO (30.000 − 2.000 corregidos = 28.000), no la suma de entradas', async () => {
    const { ev, item } = await harvestWithSiloStock(28000);
    await deleteDomainEvent(ev);
    expect(await onHand(item)).toBe(0); // antes: 28.000 − 30.000 = −2.000
  });

  it('si parte del grano ya salió del silo, saca lo que queda y no deja stock negativo', async () => {
    const { ev, item } = await harvestWithSiloStock(10000); // se vendieron 18.000
    await deleteDomainEvent(ev);
    expect(await onHand(item)).toBe(0); // antes: 10.000 − 30.000 = −20.000
    const mov = await pool.query(`SELECT quantity FROM stock_movements WHERE stock_item_id = $1 AND reason = 'Cosecha borrada'`, [item]);
    expect(Number(mov.rows[0].quantity)).toBe(10000);
  });

  it('con grano de sobra solo saca lo de la cosecha', async () => {
    const { ev, item } = await harvestWithSiloStock(50000); // había otro grano en el silo
    await deleteDomainEvent(ev);
    expect(await onHand(item)).toBe(22000); // 50.000 − 28.000
  });
});
