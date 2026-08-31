import { describe, it, expect } from 'vitest';
import {
  normalizeAnimalId,
  parseAnimalId,
  isValidCii,
  formatCii,
  ciiFromNii,
  looksLikeIdList,
  extractIdList,
  splitIdLines,
  AR_COUNTRY_CODE,
  SPECIES_BOVINE,
} from '../animal-id.js';

describe('normalizeAnimalId', () => {
  it('colapsa las tres formas en que se escribe el mismo CII', () => {
    const forms = ['032 01 0001234567', '032-01-0001234567', '032.01.0001234567', '032010001234567'];
    const normalized = forms.map(normalizeAnimalId);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('032010001234567');
  });

  it('pasa a mayúscula y descarta símbolos en caravanas alfanuméricas', () => {
    expect(normalizeAnimalId(' a-12/b ')).toBe('A12B');
  });

  it('devuelve string vacío para null/undefined/vacío', () => {
    expect(normalizeAnimalId(null)).toBe('');
    expect(normalizeAnimalId(undefined)).toBe('');
    expect(normalizeAnimalId('   ')).toBe('');
  });
});

describe('parseAnimalId — CII de 15 dígitos (Res. SENASA 530/2025 Art. 15)', () => {
  it('reconoce un CII argentino bovino bien formado', () => {
    const p = parseAnimalId('032010001234567');
    expect(p.idType).toBe('rfid');
    expect(p.isFullCii).toBe(true);
    expect(p.countryCode).toBe(AR_COUNTRY_CODE);
    expect(p.speciesCode).toBe(SPECIES_BOVINE);
    expect(p.nii).toBe('0001234567');
    expect(p.warning).toBeNull();
  });

  it('acepta un CII de otro país pero lo marca como extranjero', () => {
    const p = parseAnimalId('076010001234567');
    expect(p.isFullCii).toBe(true);
    expect(p.idType).toBe('rfid');
    expect(p.countryCode).toBe('076');
    expect(p.warning).toMatch(/extranjero/i);
  });

  it('acepta una especie distinta de bovino pero lo advierte', () => {
    const p = parseAnimalId('032040001234567');
    expect(p.isFullCii).toBe(true);
    expect(p.speciesCode).toBe('04');
    expect(p.warning).toMatch(/especie/i);
  });
});

describe('parseAnimalId — NII suelto de 10 dígitos', () => {
  it('trata 10 dígitos como RFID (la cinta en machos muestra solo el NII)', () => {
    const p = parseAnimalId('0001234567');
    expect(p.idType).toBe('rfid');
    expect(p.isFullCii).toBe(false);
    expect(p.nii).toBe('0001234567');
    expect(p.warning).toBeNull();
  });
});

describe('parseAnimalId — el sistema registra, no bloquea', () => {
  it('un largo inesperado nunca tira: cae en caravana_visual con warning', () => {
    const p = parseAnimalId('12345');
    expect(p.idType).toBe('caravana_visual');
    expect(p.warning).toMatch(/no es un CII/i);
    expect(p.normalized).toBe('12345');
  });

  it('una caravana alfanumérica se acepta como visual', () => {
    const p = parseAnimalId('A-123');
    expect(p.idType).toBe('caravana_visual');
    expect(p.normalized).toBe('A123');
    expect(p.warning).toMatch(/no numérico/i);
  });

  it('vacío devuelve interno con warning, sin tirar', () => {
    const p = parseAnimalId('');
    expect(p.idType).toBe('interno');
    expect(p.warning).toMatch(/vacío/i);
  });
});

describe('isValidCii / formatCii / ciiFromNii', () => {
  it('isValidCii solo es true para el CII argentino bovino limpio', () => {
    expect(isValidCii('032 01 0001234567')).toBe(true);
    expect(isValidCii('076010001234567')).toBe(false); // extranjero → tiene warning
    expect(isValidCii('0001234567')).toBe(false);      // NII suelto, no CII
    expect(isValidCii('nada')).toBe(false);
  });

  it('formatCii separa los tres bloques y deja intacto lo que no es CII', () => {
    expect(formatCii('032010001234567')).toBe('032 01 0001234567');
    expect(formatCii('A-123')).toBe('A123');
  });

  it('ciiFromNii reconstruye el CII argentino bovino', () => {
    expect(ciiFromNii('0001234567')).toBe('032010001234567');
    expect(ciiFromNii('123')).toBeNull();
    expect(ciiFromNii(null)).toBeNull();
  });

  it('ciiFromNii es la inversa de parseAnimalId().nii', () => {
    const cii = '032010009876543';
    expect(ciiFromNii(parseAnimalId(cii).nii)).toBe(cii);
  });
});

describe('looksLikeIdList — intercepción determinística antes del agente', () => {
  it('detecta una lectura pegada de caravanas', () => {
    const text = Array.from({ length: 12 }, (_, i) => `03201000123456${i}`).join('\n');
    expect(looksLikeIdList(text)).toBe(true);
  });

  it('acepta separadores por coma y punto y coma', () => {
    const text = Array.from({ length: 8 }, (_, i) => `000123456${i}`).join(', ');
    expect(looksLikeIdList(text)).toBe(true);
  });

  it('NO se dispara con menos líneas que el mínimo', () => {
    expect(looksLikeIdList('032010001234567\n032010001234568')).toBe(false);
  });

  it('NO se dispara con lenguaje natural, aunque tenga números', () => {
    const text = [
      'gasté 50 mil en gasoil',
      'compré 20 vacas angus',
      'vendí 15 novillos a 1500 el kilo',
      'llovieron 30 mm en el lote norte',
      'sembré 120 hectáreas de soja',
      'pagué 80000 de arrendamiento',
    ].join('\n');
    expect(looksLikeIdList(text)).toBe(false);
  });

  it('NO se dispara con una lista de números cortos (cantidades, no caravanas)', () => {
    expect(looksLikeIdList('20\n15\n30\n45\n12\n8')).toBe(false);
  });

  it('devuelve false para null/undefined/vacío', () => {
    expect(looksLikeIdList(null)).toBe(false);
    expect(looksLikeIdList(undefined)).toBe(false);
    expect(looksLikeIdList('')).toBe(false);
  });
});

describe('splitIdLines — lo que consume un lote de lectura', () => {
  it('NO deduplica ni filtra: el resumen tiene que poder contar repetidos e ilegibles', () => {
    // Regresión: usar extractIdList acá hacía que 4 líneas pegadas se
    // reportaran como "leí 2", y el productor no podía cuadrar la diferencia.
    expect(splitIdLines('0001234567\n0001234567\n0009999999\nxx'))
      .toEqual(['0001234567', '0001234567', '0009999999', 'xx']);
  });

  it('parte por saltos, comas y punto y coma, y descarta solo lo vacío', () => {
    expect(splitIdLines('a\n\n b ;c,, d ')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('devuelve lista vacía para entrada nula', () => {
    expect(splitIdLines(null)).toEqual([]);
    expect(splitIdLines('')).toEqual([]);
  });
});

describe('extractIdList', () => {
  it('deduplica preservando el orden de lectura y reporta los repetidos', () => {
    const { values, duplicates } = extractIdList('0001234567\n0001234568\n0001234567\n0001234569');
    expect(values).toEqual(['0001234567', '0001234568', '0001234569']);
    expect(duplicates).toEqual(['0001234567']);
  });

  it('normaliza cada línea antes de deduplicar (mismo animal, dos grafías)', () => {
    const { values, duplicates } = extractIdList('032 01 0001234567\n032-01-0001234567');
    expect(values).toEqual(['032010001234567']);
    expect(duplicates).toEqual(['032010001234567']);
  });

  it('ignora líneas vacías y fragmentos demasiado cortos', () => {
    const { values } = extractIdList('0001234567\n\n  \nab\n0001234568');
    expect(values).toEqual(['0001234567', '0001234568']);
  });

  it('devuelve listas vacías para entrada nula', () => {
    expect(extractIdList(null)).toEqual({ values: [], duplicates: [] });
  });
});
