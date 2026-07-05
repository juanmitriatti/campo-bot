import { describe, it, expect } from 'vitest';
import { resolveFutureDate, formatReminderList } from '../reminder.service.js';
import { getTodayISO } from '../../utils/date.js';

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

describe('resolveFutureDate — SIEMPRE hacia adelante', () => {
  const today = getTodayISO();

  it('hoy / mañana / pasado mañana', () => {
    expect(resolveFutureDate('acordame hoy de regar')).toBe(today);
    expect(resolveFutureDate('mañana tengo que fumigar')).toBe(addDays(today, 1));
    expect(resolveFutureDate('pasado mañana vacuno')).toBe(addDays(today, 2));
  });

  it('en N días / en una semana', () => {
    expect(resolveFutureDate('en 3 días cosecho')).toBe(addDays(today, 3));
    expect(resolveFutureDate('en una semana pago el arrendamiento')).toBe(addDays(today, 7));
  });

  it('día de semana → el PRÓXIMO (nunca hoy ni pasado)', () => {
    const r = resolveFutureDate('el sábado tengo que fumigar el lote 5');
    expect(r).not.toBeNull();
    expect(r! > today).toBe(true); // estrictamente futuro
    const d = new Date(r! + 'T12:00:00');
    expect(d.getDay()).toBe(6); // sábado
    // a lo sumo 7 días adelante
    expect(r! <= addDays(today, 7)).toBe(true);
  });

  it('sin señal de fecha → null (el handler pide la fecha)', () => {
    expect(resolveFutureDate('acordame de fumigar')).toBeNull();
    expect(resolveFutureDate('')).toBeNull();
    expect(resolveFutureDate(null)).toBeNull();
  });
});

describe('formatReminderList', () => {
  it('lista vacía guía al usuario', () => {
    expect(formatReminderList([])).toContain('acordame el sábado');
  });

  it('marca vencidos y HOY', () => {
    const today = getTodayISO();
    const out = formatReminderList([
      { id: 1, description: 'fumigar lote 5', due_date: addDays(today, -2), status: 'pending' },
      { id: 2, description: 'vacunar', due_date: today, status: 'pending' },
    ]);
    expect(out).toContain('vencido');
    expect(out).toContain('HOY');
  });
});
