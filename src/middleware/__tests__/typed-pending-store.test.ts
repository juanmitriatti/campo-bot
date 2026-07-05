/**
 * TypedPendingStore — contrato único de pendings simples.
 * La parte DB (sobrevivir un "restart") corre solo si hay Postgres.
 */
import { describe, it, expect } from 'vitest';
import { TypedPendingStore } from '../typed-pending-store.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe('TypedPendingStore — API en memoria', () => {
  it('set/get/clear + delete como alias', () => {
    const s = new TypedPendingStore<{ a: number }>('it_mem_test');
    s.set('k1', { a: 1 });
    expect(s.get('k1')?.a).toBe(1);
    expect(s.get('k1')?.timestamp).toBeTypeOf('number');
    s.delete('k1'); // alias de clear — drop-in para los Maps migrados
    expect(s.get('k1')).toBeUndefined();
  });

  it('TTL expira y limpia', () => {
    const s = new TypedPendingStore<{ a: number }>('it_ttl_test', 1); // 1ms
    s.set('k', { a: 1 });
    const t0 = Date.now();
    while (Date.now() - t0 < 5) { /* esperar 5ms */ }
    expect(s.get('k')).toBeUndefined();
  });
});

describe.skipIf(!dbAvailable)('TypedPendingStore — sobrevive un restart (espejo DB)', () => {
  it('instancia nueva del mismo kind hidrata la entrada persistida', async () => {
    const key = `testbot_restart_${process.pid}`;
    const s1 = new TypedPendingStore<{ product: string; qty: number }>('it_restart_test');
    s1.set(key, { product: 'glifosato', qty: 100 });
    // el persist es fire-and-forget — darle un tick
    await new Promise(r => setTimeout(r, 150));

    // "Restart": instancia nueva, Map vacío
    const s2 = new TypedPendingStore<{ product: string; qty: number }>('it_restart_test');
    expect(s2.get(key)).toBeUndefined();
    await s2.hydrate(key);
    const rec = s2.get(key);
    expect(rec?.product).toBe('glifosato');
    expect(rec?.qty).toBe(100);

    // Limpieza (borra también la fila en DB)
    s2.clear(key);
    await new Promise(r => setTimeout(r, 100));
    const s3 = new TypedPendingStore<{ product: string; qty: number }>('it_restart_test');
    await s3.hydrate(key);
    expect(s3.get(key)).toBeUndefined();
  });

  it('clear + hydrate inmediato NO resucita (tombstone)', async () => {
    const key = `testbot_tomb_${process.pid}`;
    const s = new TypedPendingStore<{ x: number }>('it_tomb_test');
    s.set(key, { x: 1 });
    await new Promise(r => setTimeout(r, 100));
    s.clear(key);
    await s.hydrate(key); // el DELETE puede estar en vuelo — tombstone lo cubre
    expect(s.get(key)).toBeUndefined();
  });
});
