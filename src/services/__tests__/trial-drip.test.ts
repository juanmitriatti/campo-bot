import { describe, it, expect } from 'vitest';
import { parseDripSchedule, computeTrialDay } from '../trial-drip.service.js';

describe('trial drip — parseDripSchedule', () => {
  it('parsea días y mensajes emparejados por posición', () => {
    const steps = parseDripSchedule('2,5,8', 'audio\n---\nfotos\n---\nhacienda');
    expect(steps).toEqual([
      { day: 2, message: 'audio' },
      { day: 5, message: 'fotos' },
      { day: 8, message: 'hacienda' },
    ]);
  });

  it('config default: 4 días ↔ 4 mensajes', () => {
    const days = '2,5,8,11';
    const messages = 'a\n---\nb\n---\nc\n---\nd';
    expect(parseDripSchedule(days, messages)).toHaveLength(4);
  });

  it('tolerante a desbalance: usa el mínimo de ambos', () => {
    expect(parseDripSchedule('2,5,8', 'solo uno')).toHaveLength(1);
    expect(parseDripSchedule('2', 'a\n---\nb\n---\nc')).toHaveLength(1);
  });

  it('ignora días inválidos y mensajes vacíos', () => {
    expect(parseDripSchedule('x,-1, 3', 'a\n---\n\n---\nb')).toEqual([
      { day: 3, message: 'a' },
    ]);
    expect(parseDripSchedule('', '')).toEqual([]);
  });

  it('mensajes multilínea sobreviven (--- solo como separador de línea entera)', () => {
    const steps = parseDripSchedule('2,5', 'línea 1\nlínea 2\n---\notro');
    expect(steps[0].message).toBe('línea 1\nlínea 2');
    expect(steps[1].message).toBe('otro');
  });
});

describe('trial drip — computeTrialDay', () => {
  it('día 0 el mismo día del registro, día 2 a las 48h', () => {
    const start = new Date('2026-07-01T12:00:00Z');
    expect(computeTrialDay(start, new Date('2026-07-01T18:00:00Z'))).toBe(0);
    expect(computeTrialDay(start, new Date('2026-07-03T12:00:01Z'))).toBe(2);
    expect(computeTrialDay(start, new Date('2026-07-12T12:00:01Z'))).toBe(11);
  });
});
