import { describe, it, expect } from 'vitest';
import { processPendingAction } from './pending-action-processor.js';
import type { PendingActivity } from './pending-activities.js';

function mkPending(over: Partial<PendingActivity>): PendingActivity {
  return { command: 'set_livestock_price', data: {}, missing: ['unit_price'], timestamp: Date.now(), ...over } as PendingActivity;
}

describe('processPendingAction — fallback numérico argentino (#17)', () => {
  it('"500 mil" completa unit_price (precio de compra de hacienda)', () => {
    const pending = mkPending({ data: { movementId: 'mov1', kind: 'expense' }, missing: ['unit_price'] });
    const r = processPendingAction('500 mil', pending);
    expect(r.next).toBeNull(); // todos los slots llenos → re-route
    expect(r.finalData.unit_price).toBe(500000);
  });

  it('"medio palo" → 500000', () => {
    const pending = mkPending({ data: { movementId: 'mov1', kind: 'income' }, missing: ['unit_price'] });
    const r = processPendingAction('medio palo', pending);
    expect(r.finalData.unit_price).toBe(500000);
  });

  it('"1,5 millones" → 1500000', () => {
    const pending = mkPending({ data: { movementId: 'mov1', kind: 'expense' }, missing: ['unit_price'] });
    const r = processPendingAction('1,5 millones', pending);
    expect(r.finalData.unit_price).toBe(1500000);
  });

  it('dígitos puros "350000" siguen funcionando', () => {
    const pending = mkPending({ data: { movementId: 'mov1', kind: 'expense' }, missing: ['unit_price'] });
    const r = processPendingAction('350000', pending);
    expect(r.finalData.unit_price).toBe(350000);
  });

  it('texto sin número deja el slot vacío y re-pregunta', () => {
    const pending = mkPending({ data: { movementId: 'mov1', kind: 'expense' }, missing: ['unit_price'] });
    const r = processPendingAction('no sé todavía', pending);
    expect(r.next).not.toBeNull();
    expect(r.stillMissing).toContain('unit_price');
  });

  it('frase de demora ("después te digo") NO se guarda como slot (NON_ANSWER)', () => {
    const pending = mkPending({ command: 'log_health_event', data: {}, missing: ['product'] });
    const r = processPendingAction('después te digo', pending);
    // product NO debe quedar con "después te digo"
    expect(r.finalData.product).not.toBe('después te digo');
  });
});
