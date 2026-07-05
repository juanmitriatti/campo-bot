import { describe, it, expect } from 'vitest';
import { GrainPriceService, formatGrainBoard, normalizeGrainCrop } from '../grain-price.service.js';

function fakeFetch(dataByProduct: Record<string, Array<{ dateTime: string; symbol: string; settlement: number | null }>>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    const product = decodeURIComponent(u.match(/product=([^&]+)/)?.[1] ?? '');
    const data = dataByProduct[product] ?? [];
    return {
      ok: true,
      json: async () => ({ data }),
    } as Response;
  }) as typeof fetch;
}

const SAMPLE = {
  'SOJ Disponible': [
    { dateTime: '2026-07-02T00:00:00.000Z', symbol: 'SOJ.ROS/DIS26', settlement: 318.0 },
    { dateTime: '2026-07-03T00:00:00.000Z', symbol: 'SOJ.ROS/DIS26', settlement: 320.0 },
  ],
  'SOJ Dolar MATba': [
    { dateTime: '2026-07-03T00:00:00.000Z', symbol: 'SOJ.ROS/NOV26', settlement: 331.0 },
    { dateTime: '2026-07-03T00:00:00.000Z', symbol: 'SOJ.ROS/JUL26', settlement: 323.5 },
    { dateTime: '2026-07-03T00:00:00.000Z', symbol: 'SOJ.ROS/SEP26', settlement: 329.0 },
    { dateTime: '2026-07-02T00:00:00.000Z', symbol: 'SOJ.ROS/JUL26', settlement: 322.0 }, // vieja, debe ignorarse
  ],
  'MAI Disponible': [
    { dateTime: '2026-07-03T00:00:00.000Z', symbol: 'MAI.ROS/DIS26', settlement: 178.0 },
  ],
  'MAI Dolar MATba': [],
  'TRI Disponible': [
    { dateTime: '2026-07-03T00:00:00.000Z', symbol: 'TRI.ROS/DIS26', settlement: 200.0 },
  ],
  'TRI Dolar MATba': [],
};

describe('GrainPriceService', () => {
  it('arma la pizarra: disponible más reciente + 2 futuros más cercanos ordenados', async () => {
    const svc = new GrainPriceService(fakeFetch(SAMPLE));
    const board = await svc.getBoard();
    expect(board).not.toBeNull();
    const soja = board!.quotes.find(q => q.crop === 'soja')!;
    expect(soja.spotUsd).toBe(320.0);          // la del 03/07, no la del 02
    expect(soja.spotDate).toBe('2026-07-03');
    expect(soja.futures.map(f => f.position)).toEqual(['JUL26', 'SEP26']); // orden por vencimiento, 2 max
    expect(soja.futures[0].priceUsd).toBe(323.5); // la fila del 03, no la del 02
  });

  it('cachea el board (no re-fetchea dentro del TTL)', async () => {
    let calls = 0;
    const counting = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return fakeFetch(SAMPLE)(url, init);
    }) as typeof fetch;
    const svc = new GrainPriceService(counting);
    await svc.getBoard();
    const after = calls;
    await svc.getBoard();
    expect(calls).toBe(after); // segundo getBoard = cache hit
  });

  it('API caída → null (sin cache previo), sin tirar', async () => {
    const failing = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const svc = new GrainPriceService(failing);
    expect(await svc.getBoard()).toBeNull();
  });
});

describe('normalizeGrainCrop', () => {
  it('mapea variantes y anglicismos', () => {
    expect(normalizeGrainCrop('soja')).toBe('soja');
    expect(normalizeGrainCrop('Maíz')).toBe('maíz');
    expect(normalizeGrainCrop('maiz')).toBe('maíz');
    expect(normalizeGrainCrop('wheat')).toBe('trigo');
    expect(normalizeGrainCrop('girasol')).toBe('unsupported');
    expect(normalizeGrainCrop(null)).toBeNull();
  });
});

describe('formatGrainBoard', () => {
  it('USD sin "$" (convención del bot) y filtro por grano', async () => {
    const svc = new GrainPriceService(fakeFetch(SAMPLE));
    const board = (await svc.getBoard())!;
    const full = formatGrainBoard(board);
    expect(full).toContain('Pizarra de granos');
    expect(full).toContain('USD/tn');
    expect(full).not.toMatch(/\$\s*\d+[\d.,]*\s*USD/); // nunca "$320 USD"
    const soloSoja = formatGrainBoard(board, 'soja');
    expect(soloSoja).toContain('Soja');
    expect(soloSoja).not.toContain('Trigo');
    expect(soloSoja).toContain('JUL26');
  });
});
