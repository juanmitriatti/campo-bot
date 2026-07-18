import { describe, it, expect } from 'vitest';
import { resolveFutureDate, formatReminderList, resolveFutureTime } from '../reminder.service.js';
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

describe('resolveFutureTime — hora en español argentino', () => {
  it('formas explícitas 24h', () => {
    expect(resolveFutureTime('acordame a las 14:30 de fumigar')).toEqual({ time: '14:30' });
    expect(resolveFutureTime('a las 14.30')).toEqual({ time: '14:30' });
    expect(resolveFutureTime('14:30hs')).toEqual({ time: '14:30' });
    expect(resolveFutureTime('a las 20')).toEqual({ time: '20:00' });
    expect(resolveFutureTime('a las 12')).toEqual({ time: '12:00' });
  });

  it('calificador AM/PM resuelve horas chicas', () => {
    expect(resolveFutureTime('a las 8 de la mañana')).toEqual({ time: '08:00' });
    expect(resolveFutureTime('a las 8 de la noche')).toEqual({ time: '20:00' });
    expect(resolveFutureTime('a las 3 de la tarde')).toEqual({ time: '15:00' });
    expect(resolveFutureTime('a las 2 de la madrugada')).toEqual({ time: '02:00' });
  });

  it('fracciones: y media / y cuarto / menos cuarto', () => {
    expect(resolveFutureTime('a las 8 y media de la mañana')).toEqual({ time: '08:30' });
    expect(resolveFutureTime('a las 5 y cuarto de la tarde')).toEqual({ time: '17:15' });
    expect(resolveFutureTime('a las 8 menos cuarto de la noche')).toEqual({ time: '19:45' });
  });

  it('palabras de momento del día', () => {
    expect(resolveFutureTime('al mediodía')).toEqual({ time: '12:00' });
    expect(resolveFutureTime('a la tardecita')).toEqual({ time: '18:00' });
    expect(resolveFutureTime('temprano')).toEqual({ time: '07:00' });
    expect(resolveFutureTime('a la noche')).toEqual({ time: '21:00' });
  });

  it('hora 1-11 sin calificador → marcador ambiguo (se pregunta con botones)', () => {
    expect(resolveFutureTime('a las 8')).toEqual({ ambiguous: true, hour: 8, minute: 0 });
    expect(resolveFutureTime('a las 8 y media')).toEqual({ ambiguous: true, hour: 8, minute: 30 });
  });

  it('sin señal de hora → null', () => {
    expect(resolveFutureTime('acordame el sábado de fumigar')).toBeNull();
    expect(resolveFutureTime('fumigar el lote 5')).toBeNull();
    expect(resolveFutureTime(null)).toBeNull();
  });

  it('no confunde cantidades con horas', () => {
    expect(resolveFutureTime('comprar 8 bolsas')).toBeNull();
    expect(resolveFutureTime('pagar 14 mil')).toBeNull();
  });

  it('no parsea montos con separador de miles ("14.300 pesos")', () => {
    expect(resolveFutureTime('acordame pagar a las 14.300 pesos')).toBeNull();
  });

  it('"a la 1 menos cuarto" sin calificador → ambiguo (00:45 vs 12:45)', () => {
    // spokenHour=1 está en rango 1-11, no hay AM/PM → ambiguo.
    // Los botones del handler usan hour y hour+12: 0→00:45, 0+12→12:45.
    expect(resolveFutureTime('a la 1 menos cuarto')).toEqual({ ambiguous: true, hour: 0, minute: 45 });
  });

  it('"12 de la noche" → medianoche', () => {
    expect(resolveFutureTime('a las 12 de la noche')).toEqual({ time: '00:00' });
    expect(resolveFutureTime('a las 12 de la madrugada')).toEqual({ time: '00:00' });
  });
});
