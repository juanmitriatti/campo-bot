import { describe, it, expect } from 'vitest';
import { resolvePeriodFromText, resolvePeriodRange } from '../query-period.js';

// Miércoles 2026-08-19, 15:00 AR.
const WED = new Date('2026-08-19T18:00:00Z');

describe('resolvePeriodFromText — períodos canónicos', () => {
  it.each([
    ['gastos de la semana pasada', 'last_week'],
    ['¿qué gasté esta semana?', 'week'],
    ['lluvias del mes pasado', 'last_month'],
    ['gastos de este mes', 'month'],
    ['cuánto gasté este año', 'year'],
    ['ingresos del año pasado', 'last_year'],
  ])('%s → %s', (text, expected) => {
    expect(resolvePeriodFromText(text, WED)).toEqual({ kind: 'period', period: expected });
  });

  it('"la semana pasada" gana sobre "semana" — el orden de las reglas importa', () => {
    // Si la rama de "esta semana" corriera primero, esto daría 'week'.
    expect(resolvePeriodFromText('la semana pasada', WED)).toMatchObject({ period: 'last_week' });
    expect(resolvePeriodFromText('semana anterior', WED)).toMatchObject({ period: 'last_week' });
  });

  it('acepta texto sin tildes y en mayúsculas', () => {
    expect(resolvePeriodFromText('GASTOS DEL MES PASADO', WED)).toMatchObject({ period: 'last_month' });
    expect(resolvePeriodFromText('gastos de este ano', WED)).toMatchObject({ period: 'year' });
  });
});

describe('resolvePeriodFromText — rangos sin period equivalente', () => {
  it('ayer y anteayer son un solo día', () => {
    expect(resolvePeriodFromText('qué registré ayer', WED)).toEqual({
      kind: 'range', desde: '2026-08-18', hasta: '2026-08-18', label: 'ayer',
    });
    expect(resolvePeriodFromText('gastos de anteayer', WED)).toMatchObject({
      desde: '2026-08-17', hasta: '2026-08-17',
    });
  });

  it('"antes de ayer" no cae en la rama de "ayer"', () => {
    expect(resolvePeriodFromText('antes de ayer', WED)).toMatchObject({ desde: '2026-08-17' });
  });

  it('los últimos N días es una ventana rodante que incluye hoy', () => {
    expect(resolvePeriodFromText('gastos de los últimos 10 días', WED)).toMatchObject({
      desde: '2026-08-10', hasta: '2026-08-19',
    });
  });

  it('acepta el número escrito con palabras', () => {
    expect(resolvePeriodFromText('lluvias de los ultimos tres dias', WED)).toMatchObject({
      desde: '2026-08-17', hasta: '2026-08-19',
    });
  });

  it('las últimas N semanas', () => {
    expect(resolvePeriodFromText('monitoreos de las últimas 2 semanas', WED)).toMatchObject({
      desde: '2026-08-06', hasta: '2026-08-19',
    });
  });

  it('el finde = sábado y domingo más recientes', () => {
    expect(resolvePeriodFromText('qué hice el finde', WED)).toMatchObject({
      desde: '2026-08-15', hasta: '2026-08-16',
    });
  });

  it('un mes por nombre ya transcurrido este año', () => {
    expect(resolvePeriodFromText('cuánto gasté en mayo', WED)).toMatchObject({
      desde: '2026-05-01', hasta: '2026-05-31',
    });
  });

  it('un mes que todavía no llegó se entiende como el del año pasado', () => {
    // En agosto, "en diciembre" es el diciembre que pasó, no uno futuro.
    expect(resolvePeriodFromText('gastos en diciembre', WED)).toMatchObject({
      desde: '2025-12-01', hasta: '2025-12-31',
    });
  });
});

describe('resolvePeriodFromText — no dispara de más', () => {
  it('sin frase de período devuelve null', () => {
    expect(resolvePeriodFromText('cuánto gasté en combustible', WED)).toBeNull();
    expect(resolvePeriodFromText('gastos del lote Norte', WED)).toBeNull();
    expect(resolvePeriodFromText('', WED)).toBeNull();
    expect(resolvePeriodFromText(null, WED)).toBeNull();
  });

  it('no confunde "el finde" con intención futura', () => {
    // "el finde voy a fumigar" es un plan, no una consulta del pasado.
    expect(resolvePeriodFromText('el finde voy a fumigar', WED)).toBeNull();
  });

  it('"hoy" con intención futura no resuelve a today', () => {
    expect(resolvePeriodFromText('hoy tengo que fumigar', WED)).toBeNull();
  });
});

describe('coherencia con resolvePeriodRange', () => {
  it('el period que devuelve el texto resuelve al mismo rango que el enum', () => {
    const fromText = resolvePeriodFromText('gastos de la semana pasada', WED);
    expect(fromText?.kind).toBe('period');
    const range = resolvePeriodRange((fromText as { period: string }).period, WED)!;
    expect(range).toMatchObject({ desde: '2026-08-10', hasta: '2026-08-16' });
  });
});
