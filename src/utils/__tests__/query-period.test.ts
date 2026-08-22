import { describe, it, expect } from 'vitest';
import { resolvePeriodRange, resolveDaysRange, QUERY_PERIODS } from '../query-period.js';

/**
 * Fecha fija de referencia: miércoles 2026-08-19, 15:00 hora argentina.
 * Se elige un miércoles a propósito — un lunes o un domingo esconderían
 * errores de off-by-one en el cálculo de semana.
 */
const WED = new Date('2026-08-19T18:00:00Z'); // 15:00 AR (UTC-3)

describe('resolvePeriodRange — semántica de calendario', () => {
  it('today = solo el día en curso', () => {
    expect(resolvePeriodRange('today', WED)).toMatchObject({
      desde: '2026-08-19', hasta: '2026-08-19', isAll: false,
    });
  });

  it('week arranca el LUNES de la semana en curso, no hace 7 días', () => {
    // Miércoles 19 → lunes 17. Una ventana rodante daría 12, que era el bug.
    expect(resolvePeriodRange('week', WED)).toMatchObject({
      desde: '2026-08-17', hasta: '2026-08-19',
    });
  });

  it('last_week es la semana pasada COMPLETA y no toca la actual', () => {
    // Regresión del bug de lluvias: hacía "hoy - 14", devolviendo 10-19
    // (dos semanas, incluida la corriente). Lo correcto es lunes-domingo.
    const r = resolvePeriodRange('last_week', WED)!;
    expect(r.desde).toBe('2026-08-10');
    expect(r.hasta).toBe('2026-08-16');
    expect(r.hasta < '2026-08-17').toBe(true); // no invade la semana actual
  });

  it('month es el mes calendario, no 30 días rodantes', () => {
    expect(resolvePeriodRange('month', WED)).toMatchObject({
      desde: '2026-08-01', hasta: '2026-08-19',
    });
  });

  it('last_month cubre el mes anterior entero', () => {
    expect(resolvePeriodRange('last_month', WED)).toMatchObject({
      desde: '2026-07-01', hasta: '2026-07-31',
    });
  });

  it('year y last_year', () => {
    expect(resolvePeriodRange('year', WED)).toMatchObject({ desde: '2026-01-01', hasta: '2026-08-19' });
    expect(resolvePeriodRange('last_year', WED)).toMatchObject({ desde: '2025-01-01', hasta: '2025-12-31' });
  });

  it('all marca isAll para que el renderer omita el rango', () => {
    const r = resolvePeriodRange('all', WED)!;
    expect(r.isAll).toBe(true);
    expect(r.desde).toBe('2000-01-01');
  });

  it('un period desconocido devuelve null en vez de inventar un rango', () => {
    expect(resolvePeriodRange('trimestre', WED)).toBeNull();
    expect(resolvePeriodRange('', WED)).toBeNull();
    expect(resolvePeriodRange(null, WED)).toBeNull();
  });

  it('todos los valores del enum resuelven', () => {
    for (const p of QUERY_PERIODS) {
      expect(resolvePeriodRange(p, WED), `period=${p}`).not.toBeNull();
    }
  });
});

describe('resolvePeriodRange — bordes de calendario', () => {
  it('un LUNES, week arranca ese mismo día', () => {
    const mon = new Date('2026-08-17T18:00:00Z');
    expect(resolvePeriodRange('week', mon)).toMatchObject({ desde: '2026-08-17', hasta: '2026-08-17' });
  });

  it('un DOMINGO sigue perteneciendo a la semana que arrancó el lunes', () => {
    // Con semana domingo-a-sábado esto daría el propio domingo; en AR no.
    const sun = new Date('2026-08-23T18:00:00Z');
    expect(resolvePeriodRange('week', sun)).toMatchObject({ desde: '2026-08-17', hasta: '2026-08-23' });
  });

  it('en enero, last_month cruza el año', () => {
    const jan = new Date('2026-01-10T18:00:00Z');
    expect(resolvePeriodRange('last_month', jan)).toMatchObject({
      desde: '2025-12-01', hasta: '2025-12-31',
    });
  });

  it('last_month respeta febrero bisiesto', () => {
    const mar = new Date('2028-03-05T18:00:00Z'); // 2028 es bisiesto
    expect(resolvePeriodRange('last_month', mar)).toMatchObject({
      desde: '2028-02-01', hasta: '2028-02-29',
    });
  });

  it('last_month en un mes de 30 días', () => {
    const may = new Date('2026-05-05T18:00:00Z');
    expect(resolvePeriodRange('last_month', may)).toMatchObject({
      desde: '2026-04-01', hasta: '2026-04-30',
    });
  });

  it('la semana puede cruzar el fin de mes', () => {
    const tue = new Date('2026-09-01T18:00:00Z'); // martes 1 de septiembre
    expect(resolvePeriodRange('week', tue)).toMatchObject({ desde: '2026-08-31', hasta: '2026-09-01' });
  });
});

describe('resolvePeriodRange — hora argentina', () => {
  it('a las 22:00 AR el día sigue siendo el local, no el UTC del día siguiente', () => {
    // 2026-08-19 22:00 AR = 2026-08-20 01:00 UTC. Sin manejo de TZ daría el 20.
    const lateNight = new Date('2026-08-20T01:00:00Z');
    expect(resolvePeriodRange('today', lateNight)).toMatchObject({
      desde: '2026-08-19', hasta: '2026-08-19',
    });
  });
});

describe('resolveDaysRange', () => {
  it('cuenta el día de hoy dentro de la ventana', () => {
    // days:7 = hoy + los 6 anteriores, no hoy - 7.
    expect(resolveDaysRange(7, WED)).toMatchObject({ desde: '2026-08-13', hasta: '2026-08-19' });
  });

  it('days:1 es solo hoy', () => {
    expect(resolveDaysRange(1, WED)).toMatchObject({ desde: '2026-08-19', hasta: '2026-08-19' });
  });

  it('rechaza valores inválidos en vez de devolver un rango absurdo', () => {
    expect(resolveDaysRange(0, WED)).toBeNull();
    expect(resolveDaysRange(-5, WED)).toBeNull();
    expect(resolveDaysRange(99999, WED)).toBeNull();
    expect(resolveDaysRange(NaN, WED)).toBeNull();
  });
});
