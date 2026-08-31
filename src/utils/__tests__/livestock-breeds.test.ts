import { describe, it, expect } from 'vitest';
import {
  BREED_CATALOG,
  BREED_BY_CODE,
  breedKey,
  normalizeBreed,
  canonicalBreedName,
} from '../livestock-breeds.js';

describe('catálogo', () => {
  it('no tiene códigos duplicados', () => {
    const codes = BREED_CATALOG.map((b) => b.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('no tiene claves de búsqueda colisionando entre razas distintas', () => {
    const owner = new Map<string, string>();
    for (const def of BREED_CATALOG) {
      for (const form of [def.name, def.code, ...def.synonyms]) {
        const k = breedKey(form);
        const prev = owner.get(k);
        expect(prev === undefined || prev === def.code,
          `la clave "${k}" la reclaman ${prev} y ${def.code}`).toBe(true);
        owner.set(k, def.code);
      }
    }
  });

  it('ofrece las tres salidas estructuradas para raza no declarada', () => {
    expect(BREED_BY_CODE.get('cruza')?.kind).toBe('cruza');
    expect(BREED_BY_CODE.get('desconocida')?.kind).toBe('desconocida');
    expect(BREED_BY_CODE.get('otra')?.kind).toBe('otra');
  });
});

describe('normalizeBreed — el bug real: grafías que hoy crean grupos distintos', () => {
  it('todas las formas de Angus resuelven a la misma raza', () => {
    const forms = ['Angus', 'angus', 'ANGUS', 'Aberdeen Angus', 'aberdeen angus', 'black angus', 'Red Angus', ' angus '];
    const codes = forms.map((f) => normalizeBreed(f)?.code);
    expect(new Set(codes)).toEqual(new Set(['angus']));
  });

  it('normaliza acentos y puntuación', () => {
    expect(normalizeBreed('Limousín')?.code).toBe('limousin');
    expect(normalizeBreed('santa-gertrudis')?.code).toBe('santa_gertrudis');
  });

  it('resuelve la raza dentro de una frase', () => {
    expect(normalizeBreed('vacas angus')?.code).toBe('angus');
    expect(normalizeBreed('novillos hereford puros')?.code).toBe('hereford');
    expect(normalizeBreed('santa gertrudis de pedigrí')?.code).toBe('santa_gertrudis');
  });

  it('NO matchea por substring espurio', () => {
    expect(normalizeBreed('angustia')).toBeNull();
    expect(normalizeBreed('herramienta')).toBeNull();
  });

  it('mapea los sinónimos coloquiales a la salida estructurada', () => {
    expect(normalizeBreed('mestizo')?.code).toBe('cruza');
    expect(normalizeBreed('cruzada')?.code).toBe('cruza');
    expect(normalizeBreed('sin raza')?.code).toBe('desconocida');
    expect(normalizeBreed('holstein')?.code).toBe('holando');
  });

  it('devuelve null (no "Otra") cuando no reconoce — el llamador decide', () => {
    expect(normalizeBreed('wagyu japonés')).toBeNull();
    expect(normalizeBreed('')).toBeNull();
    expect(normalizeBreed(null)).toBeNull();
    expect(normalizeBreed(undefined)).toBeNull();
  });
});

describe('canonicalBreedName — lo que se guarda en livestock_groups.breed', () => {
  it('devuelve SIEMPRE el mismo string para grafías equivalentes', () => {
    const names = ['Angus', 'angus', 'ABERDEEN ANGUS', 'aberdeen angus'].map(canonicalBreedName);
    expect(new Set(names)).toEqual(new Set(['Angus']));
  });

  it('preserva el texto limpio cuando no hay match en el catálogo', () => {
    expect(canonicalBreedName('  Wagyu   Japonés ')).toBe('Wagyu Japonés');
  });

  it('devuelve null para vacío', () => {
    expect(canonicalBreedName(null)).toBeNull();
    expect(canonicalBreedName('   ')).toBeNull();
  });
});
