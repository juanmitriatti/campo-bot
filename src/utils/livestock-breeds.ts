/**
 * livestock-breeds.ts — FUENTE ÚNICA de verdad para normalizar razas de hacienda.
 *
 * Por qué existe: `livestock_groups.breed` es texto libre Y forma parte del índice
 * único `(plot_id, category, breed)` (migración 053/055). Sin normalización,
 * "Angus", "angus" y "Aberdeen Angus" crean TRES grupos distintos en el mismo
 * lote — corrupción silenciosa de inventario, no un problema cosmético. Un
 * usuario que carga 20 vacas Angus y después 10 "angus" ve dos filas de 20 y 10
 * en vez de una de 30, y `list_livestock` le contesta mal.
 *
 * Regla: TODO camino que reciba una raza del usuario (agente, form, import CSV,
 * dashboard) pasa por `normalizeBreed()`. Nunca otra normalización inline —
 * misma razón que la invariante 3 para nombres de entidades.
 *
 * El catálogo canónico vive en la tabla `livestock_breeds` (migración 111); este
 * módulo es el espejo en código del seed, para poder normalizar sin ir a la DB
 * (el agente y el parser corren en caliente). El test de paridad verifica que el
 * seed SQL y esta tabla no diverjan.
 */

export type BreedKind = 'pura' | 'cruza' | 'desconocida' | 'otra';

export interface BreedDef {
  /** Código estable, usado como `livestock_breeds.code`. Nunca cambia. */
  code: string;
  /** Nombre canónico mostrado al usuario y guardado en `livestock_groups.breed`. */
  name: string;
  kind: BreedKind;
  /** Formas alternativas que el usuario puede escribir. Se normalizan igual que `name`. */
  synonyms: string[];
  sortOrder: number;
}

/**
 * Catálogo de razas bovinas usadas en Argentina. Ordenado por prevalencia real
 * en el rodeo nacional (Angus/Hereford/Braford/Brangus concentran la mayoría).
 *
 * Al agregar una raza: sumala ACÁ y al seed de la migración 111 (el test de
 * paridad falla si divergen).
 */
export const BREED_CATALOG: BreedDef[] = [
  { code: 'angus', name: 'Angus', kind: 'pura', sortOrder: 10,
    synonyms: ['aberdeen angus', 'aberdeen', 'angus negro', 'angus colorado', 'black angus', 'red angus', 'an'] },
  { code: 'hereford', name: 'Hereford', kind: 'pura', sortOrder: 20,
    synonyms: ['polled hereford', 'herford', 'hereford polled', 'hf'] },
  { code: 'braford', name: 'Braford', kind: 'pura', sortOrder: 30,
    synonyms: ['bradford'] },
  { code: 'brangus', name: 'Brangus', kind: 'pura', sortOrder: 40,
    synonyms: ['brangus negro', 'brangus colorado'] },
  { code: 'brahman', name: 'Brahman', kind: 'pura', sortOrder: 50,
    synonyms: ['brahaman', 'braman', 'cebu', 'cebu brahman'] },
  { code: 'limousin', name: 'Limousin', kind: 'pura', sortOrder: 60,
    synonyms: ['limousine', 'limusin'] },
  { code: 'charolais', name: 'Charolais', kind: 'pura', sortOrder: 70,
    synonyms: ['charolesa', 'charoles', 'charolais frances'] },
  { code: 'shorthorn', name: 'Shorthorn', kind: 'pura', sortOrder: 80,
    synonyms: ['short horn', 'durham'] },
  { code: 'holando', name: 'Holando Argentino', kind: 'pura', sortOrder: 90,
    synonyms: ['holando', 'holstein', 'holstein friesian', 'holando argentino', 'hollando', 'vaca lechera'] },
  { code: 'jersey', name: 'Jersey', kind: 'pura', sortOrder: 100,
    synonyms: ['yersey'] },
  { code: 'nelore', name: 'Nelore', kind: 'pura', sortOrder: 110,
    synonyms: ['nellore'] },
  { code: 'criollo', name: 'Criollo', kind: 'pura', sortOrder: 120,
    synonyms: ['criolla', 'criollo argentino'] },
  { code: 'santa_gertrudis', name: 'Santa Gertrudis', kind: 'pura', sortOrder: 130,
    synonyms: ['santa gertrudiz', 'gertrudis'] },
  { code: 'bonsmara', name: 'Bonsmara', kind: 'pura', sortOrder: 140,
    synonyms: ['bonsmara sudafricana'] },
  { code: 'simmental', name: 'Simmental', kind: 'pura', sortOrder: 150,
    synonyms: ['simental', 'fleckvieh'] },

  // Salidas estructuradas: el productor NO siempre sabe/quiere declarar la raza.
  // Sin estas, escribe cualquier cosa y volvemos al texto libre (§14 del spec).
  { code: 'cruza', name: 'Cruza', kind: 'cruza', sortOrder: 900,
    synonyms: ['cruzada', 'cruzado', 'mestizo', 'mestiza', 'mezcla', 'cruza indefinida', 'overo'] },
  { code: 'desconocida', name: 'Desconocida', kind: 'desconocida', sortOrder: 910,
    synonyms: ['sin raza', 'no se', 'ni idea', 'sin identificar', 'indefinida', 's/r'] },
  { code: 'otra', name: 'Otra', kind: 'otra', sortOrder: 920, synonyms: ['otro'] },
];

/**
 * Normalización de la CLAVE de búsqueda: minúsculas, sin acentos, sin puntuación,
 * espacios colapsados. Deliberadamente más agresiva que `normalizeEntityName`
 * (que preserva puntuación) porque acá matcheamos contra un catálogo cerrado,
 * no contra nombres que el usuario eligió.
 */
export function breedKey(raw: string): string {
  return String(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Índice clave→definición, construido una vez. */
const BY_KEY: Map<string, BreedDef> = (() => {
  const m = new Map<string, BreedDef>();
  for (const def of BREED_CATALOG) {
    m.set(breedKey(def.name), def);
    m.set(breedKey(def.code), def);
    for (const syn of def.synonyms) m.set(breedKey(syn), def);
  }
  return m;
})();

export const BREED_BY_CODE: Map<string, BreedDef> = new Map(
  BREED_CATALOG.map((d) => [d.code, d]),
);

/**
 * Resuelve lo que escribió el usuario a una raza canónica.
 *
 * Devuelve `null` cuando no hay match — y eso es DELIBERADO: no forzamos la raza
 * a "Otra" en silencio, porque el llamador tiene contexto para decidir (el
 * import CSV la marca como revisable, el agente puede preguntar, el handler
 * puede guardar el texto crudo). Convertir a "Otra" acá perdería el dato.
 */
export function normalizeBreed(raw: string | null | undefined): BreedDef | null {
  if (!raw) return null;
  const key = breedKey(raw);
  if (!key) return null;

  const exact = BY_KEY.get(key);
  if (exact) return exact;

  // "angus negro puro", "vacas angus" → el catálogo aparece como palabra dentro
  // de una frase. Se prueba por token para no matchear substrings espurios
  // ("angustia" no debe resolver a Angus).
  const tokens = key.split(' ');
  for (const token of tokens) {
    const hit = BY_KEY.get(token);
    if (hit) return hit;
  }

  // Frases de 2 palabras del catálogo ("santa gertrudis", "black angus").
  for (let i = 0; i < tokens.length - 1; i++) {
    const hit = BY_KEY.get(`${tokens[i]} ${tokens[i + 1]}`);
    if (hit) return hit;
  }

  return null;
}

/**
 * Nombre canónico para guardar, o el texto original limpio si no matcheó.
 * Este es el valor que va a `livestock_groups.breed` — nunca el raw sin tocar,
 * porque el índice único es sensible a la grafía.
 */
export function canonicalBreedName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const def = normalizeBreed(raw);
  if (def) return def.name;
  const cleaned = String(raw).trim().replace(/\s+/g, ' ');
  return cleaned || null;
}
