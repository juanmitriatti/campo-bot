// Entradas malas en los formularios (Flows de WhatsApp, form web, chat): el
// número se lee como lo escribe un argentino, lo imposible se rechaza y ningún
// texto supera su columna.
import { describe, it, expect } from 'vitest';
import { FORM_DEFINITIONS, validateFormPayload } from '../form-definitions.js';
import { parseNumberAR } from '../../utils/number-ar.js';
import { splitLivestockRows, applyLivestockExtra } from '../livestock-rows.js';

const TODAY = '2026-11-27';

const sow = (extra: Record<string, unknown>) => validateFormPayload(FORM_DEFINITIONS.sow_crop,
  { plot_id: 7, crop: 'soja', event_date: TODAY, ...extra }, TODAY);
const harvest = (extra: Record<string, unknown>) => validateFormPayload(FORM_DEFINITIONS.harvest_crop,
  { plot_id: 7, event_date: TODAY, ...extra }, TODAY);
const expense = (extra: Record<string, unknown>) => validateFormPayload(FORM_DEFINITIONS.log_expense,
  { amount: '1000', currency: 'ARS', category: 'Gasoil', event_date: TODAY, ...extra }, TODAY);
const livestock = (extra: Record<string, unknown>) => validateFormPayload(FORM_DEFINITIONS.add_livestock,
  { category: 'vaca', count: '10', location: 'p:7', event_date: TODAY, ...extra }, TODAY);
const activity = (extra: Record<string, unknown>) => validateFormPayload(FORM_DEFINITIONS.log_activity,
  { activity_type: 'spraying', plot_id: 7, product: 'glifosato', event_date: TODAY, ...extra }, TODAY);

const data = (r: ReturnType<typeof validateFormPayload>) => (r.ok ? r.data : { __errors: r.errors });
const errors = (r: ReturnType<typeof validateFormPayload>) => (r.ok ? '' : r.errors.join(' | '));

describe('parseNumberAR', () => {
  it.each([
    ['1.500', 1500], ['80,5', 80.5], ['1.500.000,50', 1500000.5], ['80.5', 80.5],
    ['$ 1.500', 1500], ['0.500', 0.5], [' 42 ', 42], [1500, 1500],
  ])('%s → %s', (raw, n) => { expect(parseNumberAR(raw)).toBe(n); });

  it.each(['', 'abc', '80 ha', '1,5,5', '1.50.0', null, undefined, NaN, Infinity])('%s → null', raw => {
    expect(parseNumberAR(raw as never)).toBeNull();
  });
});

describe('formato argentino en los formularios', () => {
  it('"1.500" de monto son mil quinientos', () => {
    expect(data(expense({ amount: '1.500' }))).toMatchObject({ amount: 1500 });
  });
  it('acepta coma decimal', () => {
    expect(data(sow({ hectares: '80,5' }))).toMatchObject({ hectares: 80.5 });
  });
  it('el camión de "28.500" pesa 28500 kg', () => {
    const r = harvest({ loads: [{ driver_name: 'Pedro', weight_kg: '28.500' }] });
    expect(data(r)).toMatchObject({ loads: [{ weight_kg: 28500 }] });
  });
  it('hacienda del Flow: kg promedio "1.200" y precio "2.500" no se leen como 1,2 y 2,5', () => {
    const [row] = splitLivestockRows({ category: 'toro', count: '2', avg_weight_kg: '1.200', price_mode: 'kg', unit_price: '2.500' });
    expect(row.extra.avgWeightKg).toBe(1200);
    const cmd: Record<string, unknown> = { count: 2, unit_price_ars: 2500 };
    applyLivestockExtra(cmd, row.extra);
    expect(cmd.total_weight_kg).toBe(2400);
  });
});

describe('lo imposible se rechaza', () => {
  it('montos que no entran en la base', () => {
    expect(errors(expense({ amount: '999999999999999' }))).toMatch(/Monto/);
  });
  it('un camión de 30 kg o de 500 toneladas', () => {
    expect(errors(harvest({ loads: [{ driver_name: 'Pedro', weight_kg: '30' }] }))).toMatch(/peso/i);
    expect(errors(harvest({ loads: [{ driver_name: 'Pedro', weight_kg: '500000' }] }))).toMatch(/peso/i);
  });
  it('rinde por hectárea escrito en quintales, y total absurdo', () => {
    expect(errors(harvest({ yield_kg_per_ha: '42' }))).toMatch(/Rinde/);
    expect(errors(harvest({ yield_kg: '99999999999' }))).toMatch(/Rinde/);
  });
  it('cabezas con decimales o un millón', () => {
    expect(errors(livestock({ count: '2,5' }))).toMatch(/Cabezas/);
    expect(errors(livestock({ count: '1000000' }))).toMatch(/Cabezas/);
  });
  it('100.000 hectáreas o más', () => {
    expect(errors(sow({ hectares: '200000' }))).toMatch(/Hectáreas/);
  });
  it('fecha de hace más de diez años (cargar campañas viejas sí vale)', () => {
    expect(errors(sow({ event_date: '1990-01-01' }))).toMatch(/Fecha/);
    expect(sow({ event_date: '2019-12-01' }).ok).toBe(true);
  });
  it('dosis imposible para su unidad', () => {
    expect(errors(activity({ quantity: '5000', unit: 'lt/ha' }))).toMatch(/Dosis/);
    expect(activity({ quantity: '2,5', unit: 'lt/ha' }).ok).toBe(true);
    expect(activity({ quantity: '500', unit: 'cc/ha' }).ok).toBe(true);
    expect(activity({ quantity: '1.200', unit: 'lt' }).ok).toBe(true);
  });
});

describe('largo de los textos', () => {
  const long = 'x'.repeat(5000);
  it('rechaza lo que no entra en su columna', () => {
    expect(errors(expense({ description: long }))).toMatch(/Detalle/);
    expect(errors(sow({ variety: long }))).toMatch(/Variedad/);
    expect(errors(sow({ crop: long }))).toMatch(/Cultivo/);
    expect(errors(expense({ category: long }))).toMatch(/Categoría/);
    expect(errors(harvest({ loads: [{ driver_name: long, weight_kg: '28000' }] }))).toMatch(/chofer/i);
  });
});
