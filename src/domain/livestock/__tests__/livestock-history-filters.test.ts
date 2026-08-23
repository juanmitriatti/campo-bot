import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../config/db.js';
import { LivestockHandler } from '../livestock.handler.js';
import { asUserId } from '../../../types/index.js';

/**
 * Regresión de los filtros de livestock_history.
 *
 * Antes el handler exigía categoría Y ubicación juntas; si faltaba una caía a
 * un volcado de TODOS los movimientos, sin filtrar por tipo ni fecha. Por eso
 * "cuándo nacieron terneros en el lote 1C" devolvía ventas, muertes y entradas
 * mezcladas: el dato estaba, la respuesta no servía.
 */

let userId: number;
let fieldId: number;
let plotA: number;
let plotB: number;
const handler = new LivestockHandler();

async function ask(cmd: Record<string, unknown>): Promise<string> {
  const res = await handler.handleCommand(
    { command: 'livestock_history', ...cmd } as never,
    asUserId(userId),
    { id: asUserId(userId), phone_number: 'test', name: 'T', city: null } as never,
    {} as never,
  );
  return (res.messages ?? []).join('\n');
}

beforeAll(async () => {
  const u = await pool.query(
    `INSERT INTO users (name, phone_number, plan_id) VALUES ('lh-test', $1, 4) RETURNING id`,
    [`lhtest_${Date.now()}`],
  );
  userId = u.rows[0].id;
  const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo LH') RETURNING id`, [userId]);
  fieldId = f.rows[0].id;
  const pa = await pool.query(`INSERT INTO plots (field_id, name) VALUES ($1, 'Alfa') RETURNING id`, [fieldId]);
  const pb = await pool.query(`INSERT INTO plots (field_id, name) VALUES ($1, 'Beta') RETURNING id`, [fieldId]);
  plotA = pa.rows[0].id; plotB = pb.rows[0].id;

  const mkGroup = async (plotId: number, category: string, count: number) => {
    const g = await pool.query(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, count)
       VALUES ($1, $2, $3, $4::livestock_category, $5) RETURNING id`,
      [userId, fieldId, plotId, category, count],
    );
    return g.rows[0].id as number;
  };
  const gVacaA = await mkGroup(plotA, 'vaca', 30);
  const gTernA = await mkGroup(plotA, 'ternero', 10);
  const gNoviB = await mkGroup(plotB, 'novillo', 20);
  const gNoviA = await mkGroup(plotA, 'novillo', 0);

  // chk_movement_endpoints exige endpoints coherentes por tipo: las altas
  // (entrada/nacimiento) sólo tienen destino, las bajas (salida/muerte) sólo
  // origen, y las transferencias los dos.
  const mkMov = async (
    type: string, count: number, date: string,
    ends: { source?: number; dest?: number },
  ) => {
    await pool.query(
      `INSERT INTO livestock_movements (user_id, movement_type, source_group_id, dest_group_id, count, movement_date)
       VALUES ($1, $2, $3, $4, $5, $6::date)`,
      [userId, type, ends.source ?? null, ends.dest ?? null, count, date],
    );
  };
  await mkMov('nacimiento', 8, '2026-02-10', { dest: gVacaA });
  await mkMov('nacimiento', 5, '2026-05-20', { dest: gTernA });
  await mkMov('salida', 10, '2026-03-25', { source: gNoviB });
  await mkMov('muerte', 1, '2026-02-28', { source: gTernA });
  await mkMov('transferencia', 20, '2026-06-21', { source: gNoviB, dest: gNoviA });
});

afterAll(async () => {
  await pool.query(`DELETE FROM livestock_movements WHERE user_id = $1`, [userId]).catch(() => {});
  await pool.query(`DELETE FROM livestock_groups WHERE user_id = $1`, [userId]).catch(() => {});
  await pool.query(`DELETE FROM plots WHERE field_id = $1`, [fieldId]).catch(() => {});
  await pool.query(`DELETE FROM conversation_state WHERE user_id = $1`, [userId]).catch(() => {});
  await pool.query(`DELETE FROM fields WHERE id = $1`, [fieldId]).catch(() => {});
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
});

describe('livestock_history — filtro por tipo de movimiento', () => {
  it('nacimientos NO trae ventas ni muertes', async () => {
    const out = await ask({ movementType: 'nacimiento' });
    expect(out).toContain('Nacimientos');
    expect(out).not.toContain('Ventas/salidas');
    expect(out).not.toContain('Muertes');
  });

  it('cada tipo trae lo suyo', async () => {
    expect(await ask({ movementType: 'salida' })).toContain('Ventas/salidas');
    expect(await ask({ movementType: 'muerte' })).toContain('Muertes');
    expect(await ask({ movementType: 'transferencia' })).toContain('Transferencias');
  });

  it('sin filtro de tipo sigue trayendo el panorama completo', async () => {
    const out = await ask({});
    expect(out).toContain('Nacimientos');
    expect(out).toContain('Ventas/salidas');
  });
});

describe('livestock_history — filtros de categoría y lote', () => {
  it('la categoría acota sin necesitar también el lote', async () => {
    // Antes: sin lote, el handler ignoraba la categoría y volcaba todo.
    const out = await ask({ movementType: 'nacimiento', category: 'ternero' });
    expect(out).toContain('*5*');       // sólo el nacimiento de terneros
    expect(out).not.toContain('*8*');   // no el de vacas
  });

  it('el lote acota sin necesitar también la categoría', async () => {
    const out = await ask({ plotName: 'Beta' });
    expect(out).toContain('Ventas/salidas');
    expect(out).not.toContain('Nacimientos'); // los nacimientos son de Alfa
  });

  it('un lote sin movimientos del tipo pedido responde vacío nombrando los filtros', async () => {
    const out = await ask({ movementType: 'nacimiento', plotName: 'Beta' });
    expect(out).toContain('No encontré');
    expect(out).toContain('nacimientos');
    expect(out).toContain('Beta'); // el usuario entiende POR QUÉ vino vacío
  });
});

describe("livestock_history — view='last' contesta CUÁNDO", () => {
  it('devuelve el movimiento puntual con su fecha, no el historial', async () => {
    const out = await ask({ movementType: 'transferencia', view: 'last' });
    expect(out).toContain('21/06/2026');
    expect(out).toContain('Último movimiento');
    expect(out).not.toContain('Totales:'); // no es el volcado
  });

  it('incluye hace cuánto fue', async () => {
    const out = await ask({ movementType: 'salida', view: 'last' });
    expect(out).toMatch(/Hace \d+ días?/);
  });

  it('top_n trae varios', async () => {
    const out = await ask({ movementType: 'nacimiento', view: 'last', topN: 2 });
    expect(out).toContain('20/05/2026');
    expect(out).toContain('10/02/2026');
  });
});

describe('livestock_history — período y vista agregada', () => {
  it('aggregate devuelve totales sin listado', async () => {
    const out = await ask({ movementType: 'nacimiento', view: 'aggregate' });
    expect(out).toContain('Totales:');
    expect(out).not.toContain('Últimos:');
  });

  it('el período acota por fecha', async () => {
    // Sólo el nacimiento de mayo entra en este rango.
    const out = await ask({ movementType: 'nacimiento', desde: '2026-04-01', hasta: '2026-12-31' });
    expect(out).toContain('*5*');
    expect(out).not.toContain('*8*');
  });
});
