/**
 * Datos silenciosos (auditoría oct 2026, tanda 3): montos, fechas y hectáreas
 * que se guardaban mal sin que el usuario lo viera.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { normalizarMonto } from '../parser.js';
import { resolveRelativeDate } from '../relative-dates.js';
import { parseHectares } from '../../middleware/pending-plot-area-handler.js';

describe('FIN-4: montos escritos', () => {
  it.each([
    ['veinticinco mil', 25000],
    ['dieciocho mil quinientos', 18500],
    ['2 millones 300 mil', 2300000],
    ['3 palos 200', 3200000],
    ['1.250.000,50', 1250000.5],
    ['veintidós mil', 22000],
    ['dieciséis mil', 16000],
    // lo que ya andaba sigue andando
    ['300 lucas', 300000],
    ['medio palo', 500000],
    ['1.500.000', 1500000],
    ['un millón doscientos mil', 1200000],
    ['120k', 120000],
    ['1,2 millones', 1200000],
  ])('%s → %d', (txt, n) => expect(normalizarMonto(txt as string)).toBe(n));
});

describe('FIN-7 / CONV-9: fechas', () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T15:00:00-03:00')); }); // jueves
  afterAll(() => { vi.useRealTimers(); });
  it('"en Santo Domingo" no es una fecha', () => expect(resolveRelativeDate('gasté 50 mil en Santo Domingo')).toBeNull());
  it('"a Domingo" (nombre propio) no es una fecha', () => expect(resolveRelativeDate('le pagué a Domingo 30 mil')).toBeNull());
  it('"el domingo" sí', () => expect(resolveRelativeDate('el domingo gasté 50 mil')).toBe('2026-10-04'));
  it('"el lunes a la mañana sembré" es el lunes pasado', () =>
    expect(resolveRelativeDate('el lunes a la mañana sembré soja')).toBe('2026-10-05'));
  it('"el martes hice el pago" es el martes pasado', () =>
    expect(resolveRelativeDate('el martes hice el pago del flete')).toBe('2026-10-06'));
  it('"el sábado cosecho" sigue siendo un plan (no se resuelve hacia atrás)', () =>
    expect(resolveRelativeDate('el sábado cosecho el maíz')).toBeNull());
});

describe('CAM-10: hectáreas', () => {
  it.each([
    ['1.500', 1500],
    ['1.500 ha', 1500],
    ['60,5', 60.5],
    ['el lote 7 tiene 50 ha', 50],
  ])('%s → %d', (txt, n) => expect(parseHectares(txt as string)).toBe(n));
  it('negativo no es superficie', () => expect(parseHectares('-20')).toBeNull());
  it('cero no es superficie', () => expect(parseHectares('0')).toBeNull());
});

import { parseCommand } from '../parser.js';
describe('FIN-13: el regex de presupuesto no se roba gastos', () => {
  it.each([
    'arreglé el techo del galpón, 300 mil',
    'puse alambrado en el límite con el vecino por 500 mil',
  ])('"%s" no es un presupuesto', (t) => expect(parseCommand(t)?.command).not.toBe('set_budget'));
  it('"presupuesto de 500 mil para combustible" sí', () => expect(parseCommand('presupuesto de 500 mil para combustible')?.command).toBe('set_budget'));
});
