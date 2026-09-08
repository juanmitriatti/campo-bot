import { describe, it, expect } from 'vitest';
import { impliesWholeGroup, stripNameLeadIn, numberOnlyAppearsAsArea } from '../lexicon.js';

// QA prod (7 sep 2026): "vacuné las vacas del Sur contra aftosa" preguntaba
// "¿A cuántos animales?" y el evento se perdía en el pivot siguiente.
describe('impliesWholeGroup', () => {
  it('artículo definido plural sin número = todo el grupo', () => {
    expect(impliesWholeGroup('vacuné las vacas del Sur contra aftosa')).toBe(true);
    expect(impliesWholeGroup('desparasité todos los terneros')).toBe(true);
    expect(impliesWholeGroup('eché los toros con las vacas')).toBe(true);
    expect(impliesWholeGroup('vacuné el rodeo contra aftosa')).toBe(true);
  });
  it('con número explícito o sin artículo NO', () => {
    expect(impliesWholeGroup('vacuné 20 vacas contra aftosa')).toBe(false);
    expect(impliesWholeGroup('vacuné vacas')).toBe(false);
    expect(impliesWholeGroup('pesé 10 terneros')).toBe(false);
    expect(impliesWholeGroup(null)).toBe(false);
  });
});

describe('stripNameLeadIn', () => {
  it('saca "se llama" / "que se llama" / "llamado" / comillas', () => {
    expect(stripNameLeadIn('se llama el rehue')).toBe('el rehue');
    expect(stripNameLeadIn('que se llama El Rehue')).toBe('El Rehue');
    expect(stripNameLeadIn('llamado La Loma')).toBe('La Loma');
    expect(stripNameLeadIn('" La bendición "')).toBe('La bendición');
    expect(stripNameLeadIn('Establecimiento Roma')).toBe('Establecimiento Roma');
  });
});

describe('numberOnlyAppearsAsArea — "5 hectáreas" no son 5 vacas (prod 8 sep 2026)', () => {
  it('el número aparece solo como superficie → true', () => {
    expect(numberOnlyAppearsAsArea('En 5 hectareas de ese lote tengo vacas', 5)).toBe(true);
    expect(numberOnlyAppearsAsArea('tengo vacas en 5 ha del norte', 5)).toBe(true);
    expect(numberOnlyAppearsAsArea('en 12,5 has hay novillos', 12.5)).toBe(true);
  });
  it('el número también es cantidad, o no aparece → false', () => {
    expect(numberOnlyAppearsAsArea('5 vacas en 5 hectáreas', 5)).toBe(false);
    expect(numberOnlyAppearsAsArea('compré 5 vacas', 5)).toBe(false);
    expect(numberOnlyAppearsAsArea('en 5 hectáreas tengo 20 vacas', 20)).toBe(false);
    expect(numberOnlyAppearsAsArea('en 5 hectáreas tengo vacas', 20)).toBe(false);
    expect(numberOnlyAppearsAsArea('', 5)).toBe(false);
  });
});
