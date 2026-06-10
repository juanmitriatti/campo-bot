import { describe, it, expect } from 'vitest';
import { resolveRelativeDate, resolveAllRelativeDates } from './relative-dates.js';
import { getNowArgentina } from './date.js';

function isoDaysAgo(n: number): string {
  const now = getNowArgentina();
  const d = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

describe('resolveRelativeDate — frases base', () => {
  it('ayer', () => {
    expect(resolveRelativeDate('ayer pagué 50mil de gasoil')).toBe(isoDaysAgo(1));
  });
  it('anteayer', () => {
    expect(resolveRelativeDate('anteayer fumigué el lote norte')).toBe(isoDaysAgo(2));
  });
  it('antes de ayer', () => {
    expect(resolveRelativeDate('antes de ayer llovieron 20mm')).toBe(isoDaysAgo(2));
  });
  it('hace 3 días', () => {
    expect(resolveRelativeDate('hace 3 días sembré soja')).toBe(isoDaysAgo(3));
  });
});

describe('resolveRelativeDate — frases nuevas', () => {
  it('anoche → ayer', () => {
    expect(resolveRelativeDate('anoche llovieron 35mm')).toBe(isoDaysAgo(1));
  });
  it('la noche pasada → ayer', () => {
    expect(resolveRelativeDate('la noche pasada cayeron 12mm')).toBe(isoDaysAgo(1));
  });
  it('esta mañana → hoy', () => {
    expect(resolveRelativeDate('esta mañana vacuné las terneras')).toBe(isoDaysAgo(0));
  });
  it('esta madrugada → hoy', () => {
    expect(resolveRelativeDate('esta madrugada heló')).toBe(isoDaysAgo(0));
  });
  it('hoy temprano → hoy', () => {
    expect(resolveRelativeDate('hoy temprano pasé el disco')).toBe(isoDaysAgo(0));
  });
  it('la semana pasada → ~7 días', () => {
    expect(resolveRelativeDate('la semana pasada cosechamos el lote sur')).toBe(isoDaysAgo(7));
  });
  it('el mes pasado → ~30 días', () => {
    expect(resolveRelativeDate('el mes pasado pagué el arrendamiento')).toBe(isoDaysAgo(30));
  });
  it('el finde → sábado más reciente (nunca futuro)', () => {
    const result = resolveRelativeDate('el finde llovió mal');
    expect(result).not.toBeNull();
    expect(result! <= isoDaysAgo(0)).toBe(true);
    expect(result! >= isoDaysAgo(7)).toBe(true);
  });
  it('el fin de semana pasado → sábado, nunca hoy si hoy es sábado', () => {
    const result = resolveRelativeDate('el fin de semana pasado desteté los terneros');
    expect(result).not.toBeNull();
    expect(result! <= isoDaysAgo(0)).toBe(true);
  });
  it('"mañana" a secas (futuro) NO resuelve', () => {
    expect(resolveRelativeDate('mañana voy a sembrar')).toBeNull();
  });
  it('texto sin fecha relativa → null', () => {
    expect(resolveRelativeDate('gasté 50mil en gasoil')).toBeNull();
  });
});

describe('resolveRelativeDate — intención futura NO retrocede', () => {
  it('"el sábado cosecho" (plan) → null, no el sábado pasado', () => {
    expect(resolveRelativeDate('el sábado cosecho el lote sur')).toBeNull();
  });
  it('"el lunes voy a pagar el alquiler" → null', () => {
    expect(resolveRelativeDate('el lunes voy a pagar el alquiler')).toBeNull();
  });
  it('"el finde vamos a sembrar" → null', () => {
    expect(resolveRelativeDate('el finde vamos a sembrar maíz')).toBeNull();
  });
  it('"el sábado pasado coseché" (pasado explícito) SÍ resuelve aunque haya verbo presente', () => {
    const r = resolveRelativeDate('el sábado pasado coseché el lote sur');
    expect(r).not.toBeNull();
  });
  it('"el lunes pagué el alquiler" (pretérito) sigue resolviendo', () => {
    expect(resolveRelativeDate('el lunes pagué el alquiler')).not.toBeNull();
  });
  it('"ayer" con verbo futuro cercano sigue resolviendo (ayer es inequívoco)', () => {
    expect(resolveRelativeDate('ayer llovió y mañana voy a sembrar')).toBe(isoDaysAgo(1));
  });
});

describe('resolveAllRelativeDates — frases nuevas en mensajes multi-día', () => {
  it('mezcla anoche + la semana pasada en orden', () => {
    const dates = resolveAllRelativeDates('anoche 20mm y la semana pasada 35mm');
    expect(dates).toEqual([isoDaysAgo(1), isoDaysAgo(7)]);
  });
  it('el mes pasado no colisiona con hace N meses', () => {
    const dates = resolveAllRelativeDates('el mes pasado pagué la luz y hace dos meses el gas');
    expect(dates).toEqual([isoDaysAgo(30), isoDaysAgo(60)]);
  });
});
