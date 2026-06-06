import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PendingPlotAreaStore } from '../pending-plot-area.js';
import { handlePendingPlotArea } from '../pending-plot-area-handler.js';

// Minimal FinancialService stand-in: only setPlotArea is exercised.
function makeService() {
  const calls: Array<{ plotId: number; ha: number }> = [];
  const svc = { setPlotArea: vi.fn(async (plotId: number, ha: number) => { calls.push({ plotId, ha }); }) } as any;
  return { svc, calls };
}

const PHONE = 'u1';
function seed(store: PendingPlotAreaStore, names: string[]) {
  store.setQueue(PHONE, names.map((n, i) => ({ plotId: i + 1, plotName: n, fieldName: 'Campo', timestamp: 0 })));
}

describe('handlePendingPlotArea', () => {
  let store: PendingPlotAreaStore;
  beforeEach(() => { store = new PendingPlotAreaStore(); });

  it('sets a single numeric answer and advances with a correct (N de M) counter', async () => {
    seed(store, ['A', 'B', 'C']);
    const { svc, calls } = makeService();
    const r = await handlePendingPlotArea('40', PHONE, store, svc);
    expect(r.handled).toBe(true);
    expect(calls).toEqual([{ plotId: 1, ha: 40 }]);
    expect(r.messages.join(' ')).toContain('(2 de 3)'); // not the old buggy "(1 de N)"
  });

  it('does NOT corrupt the lote on a financial pivot — bails out, no setPlotArea', async () => {
    seed(store, ['A', 'B']);
    const { svc, calls } = makeService();
    const r = await handlePendingPlotArea('gasté 50000 en gasoil', PHONE, store, svc);
    expect(r.handled).toBe(false);            // falls through to the pipeline
    expect(calls).toHaveLength(0);            // 50000 never written as hectares
    expect(store.remaining(PHONE)).toBe(0);   // queue cleared so it doesn't re-eat
  });

  it.each([
    'tengo 100 vacas en el lote Uno',
    'agregué 30 terneros en el lote A',
    'compré 120 novillos',
  ])('does NOT grab a livestock count as hectares: "%s"', async (msg) => {
    seed(store, ['A', 'B']);
    const { svc, calls } = makeService();
    const r = await handlePendingPlotArea(msg, PHONE, store, svc);
    expect(r.handled).toBe(false);   // escapes to the pipeline
    expect(calls).toHaveLength(0);   // no bogus area written
  });

  it('"todos 40" applies to every pending lote and clears the queue', async () => {
    seed(store, ['A', 'B', 'C']);
    const { svc, calls } = makeService();
    const r = await handlePendingPlotArea('todos 40', PHONE, store, svc);
    expect(r.handled).toBe(true);
    expect(calls.map(c => c.ha)).toEqual([40, 40, 40]);
    expect(store.remaining(PHONE)).toBe(0);
  });

  it('batch "A 10, B 20" matches lotes by name', async () => {
    seed(store, ['A', 'B', 'C']);
    const { svc, calls } = makeService();
    const r = await handlePendingPlotArea('A 10, B 20', PHONE, store, svc);
    expect(r.handled).toBe(true);
    expect(calls).toEqual([{ plotId: 1, ha: 10 }, { plotId: 2, ha: 20 }]);
    expect(r.messages.join(' ')).toContain('C'); // re-asks the remaining one
  });

  it('"saltar" defers the current lote (no area written) and advances', async () => {
    seed(store, ['A', 'B']);
    const { svc, calls } = makeService();
    const r = await handlePendingPlotArea('saltar', PHONE, store, svc);
    expect(r.handled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(r.messages.join(' ')).toContain('B');
  });

  it('"cancelar" clears the whole queue', async () => {
    seed(store, ['A', 'B']);
    const { svc } = makeService();
    const r = await handlePendingPlotArea('cancelar', PHONE, store, svc);
    expect(r.handled).toBe(true);
    expect(store.remaining(PHONE)).toBe(0);
  });
});
