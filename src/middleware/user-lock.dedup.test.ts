import { describe, it, expect, beforeEach } from 'vitest';
import { withUserLock, _clearUserLocks } from './user-lock.js';

/**
 * Dedup por contenido EN VUELO (QA siembra/cosecha, 9 sep 2026): un POST con
 * el mismo texto llegó dos veces con 0,5 s de diferencia mientras el primero
 * todavía se procesaba; el dedup por id no lo vio y la cosecha parcial se
 * aplicó dos veces. Solo se descarta mientras el original está corriendo o
 * encolado: la misma respuesta repetida DESPUÉS sigue pasando.
 */
describe('withUserLock — dedup de texto idéntico en vuelo', () => {
  beforeEach(() => _clearUserLocks());

  const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

  it('descarta el mismo texto mientras el original está en vuelo y avisa por onDuplicate', async () => {
    let runs = 0;
    let dupes = 0;
    const first = withUserLock('u1', async () => { runs++; await sleep(60); return 'ok'; }, { dedupKey: 'ayer cosechamos 40 ha' });
    const second = withUserLock('u1', async () => { runs++; return 'ok'; }, { dedupKey: 'ayer cosechamos 40 ha', onDuplicate: () => { dupes++; return 'dup'; } });
    expect(await second).toBe('dup');
    expect(await first).toBe('ok');
    expect(runs).toBe(1);
    expect(dupes).toBe(1);
  });

  it('el mismo texto DESPUÉS de que terminó el original sí corre (respuesta repetida a un pending)', async () => {
    let runs = 0;
    await withUserLock('u2', async () => { runs++; }, { dedupKey: '5b' });
    await withUserLock('u2', async () => { runs++; }, { dedupKey: '5b' });
    expect(runs).toBe(2);
  });

  it('textos distintos del mismo usuario se encolan los dos; el mismo texto de OTRO usuario también corre', async () => {
    const order: string[] = [];
    const a = withUserLock('u3', async () => { await sleep(30); order.push('a'); }, { dedupKey: 'hola' });
    const b = withUserLock('u3', async () => { order.push('b'); }, { dedupKey: 'chau' });
    const c = withUserLock('u4', async () => { order.push('c'); }, { dedupKey: 'hola' });
    await Promise.all([a, b, c]);
    expect(order.sort()).toEqual(['a', 'b', 'c']);
  });

  it('sin dedupKey (callbacks, audios) nunca descarta', async () => {
    let runs = 0;
    const a = withUserLock('u5', async () => { runs++; await sleep(20); });
    const b = withUserLock('u5', async () => { runs++; });
    await Promise.all([a, b]);
    expect(runs).toBe(2);
  });

  it('un original que falla libera el texto: el reintento posterior corre', async () => {
    let runs = 0;
    await withUserLock('u6', async () => { runs++; throw new Error('boom'); }, { dedupKey: 'x' }).catch(() => {});
    await withUserLock('u6', async () => { runs++; }, { dedupKey: 'x' });
    expect(runs).toBe(2);
  });
});
