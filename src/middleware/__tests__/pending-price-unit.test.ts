/**
 * Auditoría de datos (nov 2026), #2: el precio "la tonelada" se multiplicaba por
 * una cantidad en kg/qq sin convertir → ventas con el monto ×1000 / ×100.
 */
import { describe, it, expect } from 'vitest';
import { processPendingAction } from '../pending-action-processor.js';
import { extractPriceMassUnit } from '../slot-extractor.js';
import type { PendingActivity } from '../pending-activities.js';

const incomePending = (quantity: number, unit: string): PendingActivity => ({
  command: 'income_partial',
  data: { quantity, unit, currency: 'USD', category: 'Soja' },
  timestamp: Date.now(),
  missing: ['amount'],
});

describe('#2 precio por unidad de masa', () => {
  it('detecta la unidad del precio', () => {
    expect(extractPriceMassUnit('a 300 dólares la tonelada')).toBe('tn');
    expect(extractPriceMassUnit('2800 el kilo')).toBe('kg');
    expect(extractPriceMassUnit('a 30 mil el quintal')).toBe('qq');
    expect(extractPriceMassUnit('a 900 c/u')).toBeNull();
  });

  it('30.000 kg a 300 dólares la tonelada = USD 9.000 (no 9.000.000)', () => {
    const r = processPendingAction('a 300 dólares la tonelada', incomePending(30000, 'kg'));
    expect(r.finalData.amount).toBe(9000);
  });

  it('300 qq a 300 dólares la tonelada = USD 9.000 (no 90.000)', () => {
    const r = processPendingAction('a 300 dólares la tonelada', incomePending(300, 'qq'));
    expect(r.finalData.amount).toBe(9000);
  });

  it('misma unidad: sigue multiplicando directo (30 tn a 300 la tonelada)', () => {
    const r = processPendingAction('a 300 dólares la tonelada', incomePending(30, 'tn'));
    expect(r.finalData.amount).toBe(9000);
  });

  it('precio c/u sobre cabezas: no convierte nada', () => {
    const r = processPendingAction('a 500 mil c/u', { ...incomePending(10, 'cabezas'), data: { quantity: 10, unit: 'cabezas', currency: 'ARS' } });
    expect(r.finalData.amount).toBe(5000000);
  });
});
