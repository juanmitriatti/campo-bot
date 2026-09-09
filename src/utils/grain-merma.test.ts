import { describe, it, expect } from 'vitest';
import {
  computeMermaPct, computeNetWeight, getHumidityBase, resolveDeclaredWeight,
  parseBasesSetting, describeLoadWeight, sumNetKg,
} from './grain-merma.js';

describe('grain-merma — merma comercial por humedad (fuente única)', () => {
  it('soja al 16 %: aproxima la tabla de la Cámara Arbitral (≈3,2 %)', () => {
    expect(computeMermaPct(16, 13.5)).toBeCloseTo(3.19, 2);
    expect(computeMermaPct(14, 13.5)).toBeCloseTo(0.88, 2);
    expect(computeMermaPct(15, 13.5)).toBeCloseTo(2.03, 2);
  });

  it('con humedad igual o menor a la base no hay merma (tampoco manipuleo)', () => {
    expect(computeMermaPct(13.5, 13.5)).toBe(0);
    expect(computeMermaPct(12, 13.5)).toBe(0);
  });

  it('bases por cultivo: defaults, con y sin acento, y override por setting', () => {
    expect(getHumidityBase('soja')).toBe(13.5);
    expect(getHumidityBase('Maíz')).toBe(14.5);
    expect(getHumidityBase('maiz')).toBe(14.5);
    expect(getHumidityBase('trigo')).toBe(14);
    expect(getHumidityBase('quinoa')).toBeNull();
    expect(getHumidityBase('soja', { bases: { soja: 14 } })).toBe(14);
  });

  it('neto: 31.320 kg de soja al 16 % → 30.321 netos; sin humedad, neto = bruto', () => {
    const r = computeNetWeight(31320, 16, 'soja');
    expect(r.netKg).toBe(30321);
    expect(r.discounted).toBe(true);
    expect(r.mermaPct).toBeCloseTo(3.19, 2);

    const dry = computeNetWeight(31320, null, 'soja');
    expect(dry.netKg).toBe(31320);
    expect(dry.discounted).toBe(false);

    const unknown = computeNetWeight(31320, 20, 'quinoa');
    expect(unknown.netKg).toBe(31320);
    expect(unknown.basePct).toBeNull();
  });

  it('manipuleo configurable: 0 deja solo la pérdida de agua', () => {
    expect(computeMermaPct(16, 13.5, 0)).toBeCloseTo(2.89, 2);
    expect(computeNetWeight(30000, 16, 'soja', { manipuleoPct: 0 }).netKg).toBe(29133);
  });

  it('peso declarado: bruto − tara cuando vienen ambos; si no, lo que dijo el usuario', () => {
    expect(resolveDeclaredWeight({ gross_weight_kg: 45200, tare_kg: 14000 })).toBe(31200);
    expect(resolveDeclaredWeight({ weight_kg: 30000, gross_weight_kg: 45200, tare_kg: 14000 })).toBe(31200);
    expect(resolveDeclaredWeight({ weight_kg: 30000 })).toBe(30000);
    expect(resolveDeclaredWeight({ gross_weight_kg: 45200, tare_kg: 50000 })).toBe(45200);
    expect(resolveDeclaredWeight({})).toBeNull();
  });

  it('parseBasesSetting: JSON válido en minúsculas, inválido → {} sin tirar', () => {
    expect(parseBasesSetting('{"Soja":14,"trigo":"13.5","raro":900}')).toEqual({ soja: 14, trigo: 13.5 });
    expect(parseBasesSetting('no es json')).toEqual({});
    expect(parseBasesSetting('')).toEqual({});
    expect(parseBasesSetting(null)).toEqual({});
  });

  it('describeLoadWeight muestra bruto → neto solo cuando hubo merma', () => {
    const r = computeNetWeight(31320, 16, 'soja');
    expect(describeLoadWeight(r, 16)).toMatch(/31\.320 kg → \*30\.321 neto\*/);
    expect(describeLoadWeight(computeNetWeight(31320, null, 'soja'), null)).toBe('31.320 kg');
  });

  it('sumNetKg usa el neto cuando está y cae al bruto', () => {
    expect(sumNetKg([{ weight_kg: 1000, net_weight_kg: 950 }, { weight_kg: 1000, net_weight_kg: null }, { weight_kg: '500' }])).toBe(2450);
  });
});
