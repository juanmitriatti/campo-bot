import { describe, it, expect } from 'vitest';
import { parseBudget } from '../parser.js';

describe('parseBudget', () => {
  const cases = [
    ['poné un presupuesto de 500 mil para gasoil', 'Combustible', 500000],
    ['presupuesto de 800 mil para semillas', 'Semillas', 800000],
    ['presupuesto gasoil 500 mil', 'Combustible', 500000],
    ['poné límite de 1 palo en fertilizante', 'Fertilizantes', 1000000],
    ['presupuesto mensual de 1 palo para fertilizante', 'Fertilizantes', 1000000],
    ['tope de 300000 en semillas', 'Semillas', 300000],
  ];
  it.each(cases)('"%s" → %s / %i', (msg, cat, amt) => {
    const r = parseBudget(msg);
    expect(r).toBeTruthy();
    expect(r.command).toBe('set_budget');
    expect(r.category).toBe(cat);
    expect(r.amount).toBe(amt);
  });
  it('NEVER produces category "De"', () => {
    expect(parseBudget('presupuesto de 500 mil para gasoil').category).not.toBe('De');
  });
  it('budget QUERY (no amount) → null', () => {
    expect(parseBudget('cuánto me queda de presupuesto de gasoil')).toBeNull();
    expect(parseBudget('cómo voy con el presupuesto')).toBeNull();
  });
  it('expense mentioning presupuesto in passing → null', () => {
    expect(parseBudget('gasté 500 mil, casi me paso del presupuesto')).toBeNull();
  });
  it('alert toggle → null', () => {
    expect(parseBudget('activar alertas de presupuesto')).toBeNull();
  });
});
