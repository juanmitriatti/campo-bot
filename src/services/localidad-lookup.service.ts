import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface Localidad {
  nombre: string;
  provincia: string;
  departamento: string | null;
  /** Centroide de la localidad (censo georef) — para clima por coordenadas y centrado de mapas. */
  lat: number | null;
  lon: number | null;
}

export interface LookupResult {
  status: 'exact' | 'disambiguate' | 'suggestions' | 'not_found';
  matches: Localidad[];
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f\u00AD]/g, '').toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Normalizaci\u00F3n de la ENTRADA del usuario (fuente \u00FAnica \u2014 la usan el flow de
// campo, el pending de ciudad y el handler de add_field v\u00EDa `lookup()`).
//
// Visto en prod (Tom\u00E1s, 6 sep 2026, usuario reci\u00E9n registrado): en un mismo
// alta de campo tipe\u00F3/dict\u00F3 "Lincoln Bs as", "Localidad de Lincoln", "Junin bs
// as", "Est\u00E1 en la localidad de Jun\u00EDn, Buenos Aires." y "junin buenos aires"
// (Whisper le saca la coma). Las cinco fallaban con "No encontr\u00E9 la localidad"
// y el bot repet\u00EDa "\u00BFEn qu\u00E9 localidad?" \u2014 cada una es una respuesta
// perfectamente razonable a esa pregunta.
// ---------------------------------------------------------------------------

/** Alias coloquiales/abreviados \u2192 nombre de provincia tal como est\u00E1 en el censo. */
const PROVINCE_ALIASES: Array<[RegExp, string]> = [
  [/^(?:bs\.?\s*as\.?|bsas|bs\.?\s*aires|b\.?\s*aires|pba|buenos\s+aires|pcia\.?\s+bs\.?\s*as\.?)$/, 'Buenos Aires'],
  [/^(?:caba|capital\s+federal|capital|ciudad\s+(?:autonoma\s+)?de\s+buenos\s+aires|c\.?a\.?b\.?a\.?)$/, 'Ciudad Aut\u00F3noma de Buenos Aires'],
  [/^(?:sta\.?\s*fe|santa\s+fe|sfe)$/, 'Santa Fe'],
  [/^(?:cba|cordoba)$/, 'C\u00F3rdoba'],
  [/^(?:e\.?\s*rios|entre\s+rios|entrerrios)$/, 'Entre R\u00EDos'],
  [/^(?:sgo\.?\s+del\s+estero|santiago\s+del\s+estero|santiago)$/, 'Santiago del Estero'],
  [/^(?:mza|mendoza)$/, 'Mendoza'],
  [/^(?:tuc|tucuman)$/, 'Tucum\u00E1n'],
  [/^(?:la\s+pampa)$/, 'La Pampa'],
  [/^(?:rio\s+negro)$/, 'R\u00EDo Negro'],
  [/^(?:san\s+luis)$/, 'San Luis'],
  [/^(?:san\s+juan)$/, 'San Juan'],
  [/^(?:ctes|corrientes)$/, 'Corrientes'],
  [/^(?:chaco)$/, 'Chaco'],
  [/^(?:misiones)$/, 'Misiones'],
  [/^(?:nqn|neuquen)$/, 'Neuqu\u00E9n'],
  [/^(?:salta)$/, 'Salta'],
  [/^(?:jujuy)$/, 'Jujuy'],
  [/^(?:catamarca)$/, 'Catamarca'],
  [/^(?:la\s+rioja)$/, 'La Rioja'],
  [/^(?:formosa)$/, 'Formosa'],
  [/^(?:chubut)$/, 'Chubut'],
  [/^(?:santa\s+cruz)$/, 'Santa Cruz'],
  [/^(?:tierra\s+del\s+fuego|tdf)$/, 'Tierra del Fuego, Ant\u00E1rtida e Islas del Atl\u00E1ntico Sur'],
];

/** "pcia. de buenos aires" / "provincia de bs as" / "prov. cba" \u2192 provincia can\u00F3nica, o null. */
export function canonicalProvince(raw: string): string | null {
  const s = normalize(raw)
    .replace(/[.]+$/, '')
    .replace(/^(?:provincia|pcia|prov)\.?\s*(?:de\s+)?/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  for (const [re, name] of PROVINCE_ALIASES) {
    if (re.test(s)) return name;
  }
  return null;
}

/** Frases con las que la gente contesta "\u00BFen qu\u00E9 localidad?" adem\u00E1s del nombre. */
const LEAD_IN_PATTERNS: RegExp[] = [
  /^(?:hola|buenas|buen\s+d[i\u00ED]a)[,!.\s]+/i,
  /^(?:(?:el|mi|nuestro)\s+campo\s+)?(?:est[a\u00E1]|queda|es|se\s+encuentra|se\s+ubica|ubicad[oa])\s+(?:en\s+)?/i,
  /^(?:en\s+)?(?:la\s+)?(?:localidad|ciudad|pueblo|zona|partido|paraje)\s+de\s+/i,
  /^(?:cerca|al\s+lado)\s+de\s+/i,
  /^en\s+/i,
];

/**
 * Deja solo el nombre de la localidad (con provincia si vino) a partir de lo
 * que escribi\u00F3 o dict\u00F3 el usuario. No consulta el censo: es puro texto.
 *
 *   "Est\u00E1 en la localidad de Jun\u00EDn, Buenos Aires." \u2192 "Jun\u00EDn, Buenos Aires"
 *   "Localidad de Lincoln"                          \u2192 "Lincoln"
 *   "junin buenos aires"                            \u2192 "junin, Buenos Aires"
 *   "Lincoln Bs as"                                 \u2192 "Lincoln, Buenos Aires"
 *   "Jun\u00EDn (Buenos Aires)"                          \u2192 "Jun\u00EDn, Buenos Aires"
 */
export function normalizeLocalityInput(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  // Comillas y puntuaci\u00F3n final (Whisper cierra con punto).
  s = s.replace(/^["'\u00AB\u201C\u201D]+|["'\u00BB\u201C\u201D]+$/g, '').replace(/[.!?\u2026]+$/g, '').trim();
  // "(Buenos Aires)" / " - Buenos Aires" / " / Buenos Aires" \u2192 coma
  s = s.replace(/\s*\(([^)]+)\)\s*$/, ', $1').replace(/\s+[-\u2013/]\s+/, ', ');
  // ", Argentina" al final no aporta nada.
  s = s.replace(/\s*,?\s*argentina$/i, '').trim();

  for (let i = 0; i < 3; i++) {
    let changed = false;
    for (const re of LEAD_IN_PATTERNS) {
      const next = s.replace(re, '').trim();
      if (next && next !== s) { s = next; changed = true; }
    }
    if (!changed) break;
  }

  if (s.includes(',')) {
    const commaIdx = s.indexOf(',');
    const head = s.slice(0, commaIdx).trim();
    const tail = s.slice(commaIdx + 1).trim();
    const prov = canonicalProvince(tail);
    if (prov) s = `${head}, ${prov}`;
  }
  return s;
}

/**
 * Provincia pegada sin coma al final: "junin buenos aires" / "lincoln bs as"
 * \u2192 "junin, Buenos Aires". Devuelve null si no hay sufijo de provincia o si la
 * ciudad quedar\u00EDa vac\u00EDa ("Mendoza" solo es una ciudad). `lookup()` lo aplica
 * SOLO cuando el texto entero no es una localidad exacta, para no partir un
 * nombre real que termine como una provincia.
 */
export function splitProvinceSuffix(s: string): string | null {
  if (s.includes(',')) return null;
  const words = s.trim().split(/\s+/);
  for (let n = Math.min(4, words.length - 1); n >= 1; n--) {
    const tail = words.slice(words.length - n).join(' ');
    const head = words.slice(0, words.length - n).join(' ').trim();
    const prov = canonicalProvince(tail);
    if (prov && head) return `${head}, ${prov}`;
  }
  return null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

class LocalidadLookupService {
  private index: Map<string, Localidad[]> | null = null;
  private allNormalized: Array<{ norm: string; loc: Localidad }> | null = null;

  private ensureLoaded(): void {
    if (this.index) return;

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const filePath = join(__dirname, '..', 'data', 'localidades_censales.json');
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    this.index = new Map();
    this.allNormalized = [];

    for (const loc of data.localidades_censales) {
      const localidad: Localidad = {
        nombre: loc.nombre.replace(/\u00AD/g, ''),
        provincia: loc.provincia.nombre.replace(/\u00AD/g, ''),
        departamento: loc.departamento?.nombre?.replace(/\u00AD/g, '') ?? null,
        lat: typeof loc.centroide?.lat === 'number' ? loc.centroide.lat : null,
        lon: typeof loc.centroide?.lon === 'number' ? loc.centroide.lon : null,
      };

      const norm = normalize(loc.nombre);
      const existing = this.index.get(norm);
      if (existing) {
        existing.push(localidad);
      } else {
        this.index.set(norm, [localidad]);
      }
      this.allNormalized.push({ norm, loc: localidad });
    }
  }

  /**
   * Coordenadas del centroide para una ciudad ya guardada (match exacto normalizado).
   * Con múltiples homónimas: si hay provincia, filtra; sin provincia devuelve null
   * (mejor string a OpenWeather que coordenadas de la provincia equivocada).
   */
  coordsFor(city: string, province?: string | null): { lat: number; lon: number } | null {
    this.ensureLoaded();
    const matches = this.index!.get(normalize(city)) ?? [];
    let pick: Localidad | undefined;
    if (matches.length === 1) {
      pick = matches[0];
    } else if (matches.length > 1 && province) {
      const provNorm = normalize(province);
      const filtered = matches.filter(m => normalize(m.provincia) === provNorm);
      if (filtered.length === 1) pick = filtered[0];
    }
    if (pick && pick.lat != null && pick.lon != null) return { lat: pick.lat, lon: pick.lon };
    return null;
  }

  lookup(input: string): LookupResult {
    this.ensureLoaded();

    // Frases ("está en la localidad de X"), abreviaturas de provincia ("bs as")
    // y puntuación de Whisper se limpian ACÁ, para todos los callers.
    const trimmed = normalizeLocalityInput(input);
    if (!trimmed) return { status: 'not_found', matches: [] };

    // Parse "City, Province" format
    let cityPart = trimmed;
    let provincePart: string | null = null;
    const commaIdx = trimmed.indexOf(',');
    if (commaIdx > 0) {
      cityPart = trimmed.slice(0, commaIdx).trim();
      provincePart = trimmed.slice(commaIdx + 1).trim();
    }

    const normCity = normalize(cityPart);
    const normProvince = provincePart ? normalize(canonicalProvince(provincePart) ?? provincePart) : null;

    // 1. Exact normalized match
    const exactMatches = this.index!.get(normCity);

    // 1.5 "junin buenos aires" (sin coma — típico de audio): el texto entero no
    // es una localidad, pero termina en provincia → reintentar partido.
    if (!exactMatches) {
      const split = splitProvinceSuffix(trimmed);
      if (split) return this.lookup(split);
    }

    if (exactMatches) {
      // If province specified, filter
      if (normProvince) {
        const filtered = exactMatches.filter(
          m => normalize(m.provincia).includes(normProvince) || normProvince.includes(normalize(m.provincia))
        );
        if (filtered.length === 1) return { status: 'exact', matches: filtered };
        if (filtered.length > 1) return { status: 'disambiguate', matches: filtered };
        // Province didn't match any — fall through to suggestions
      } else {
        if (exactMatches.length === 1) return { status: 'exact', matches: exactMatches };
        // Multiple matches in different provinces
        return { status: 'disambiguate', matches: exactMatches };
      }
    }

    // 2. startsWith matches (max 5)
    const startsWithMatches: Localidad[] = [];
    const seen = new Set<string>();
    for (const { norm, loc } of this.allNormalized!) {
      if (norm.startsWith(normCity)) {
        const key = `${norm}|${normalize(loc.provincia)}`;
        if (!seen.has(key)) {
          seen.add(key);
          startsWithMatches.push(loc);
          if (startsWithMatches.length >= 5) break;
        }
      }
    }
    if (startsWithMatches.length > 0) {
      return { status: 'suggestions', matches: startsWithMatches };
    }

    // 2.5 Word-contains fallback: colloquial names are often a WORD inside the
    // official census name ("Bolívar" → "San Carlos de Bolívar", "Carlos Tejedor"
    // etc.). Match the input as a whole word within a locality name. Only for
    // inputs ≥4 chars to avoid noise.
    if (normCity.length >= 4) {
      const wordRe = new RegExp(`(?:^|\\s)${normCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
      const containsMatches: Localidad[] = [];
      const seenC = new Set<string>();
      for (const { norm, loc } of this.allNormalized!) {
        if (wordRe.test(norm)) {
          if (normProvince && !(normalize(loc.provincia).includes(normProvince) || normProvince.includes(normalize(loc.provincia)))) continue;
          const key = `${norm}|${normalize(loc.provincia)}`;
          if (!seenC.has(key)) { seenC.add(key); containsMatches.push(loc); if (containsMatches.length >= 6) break; }
        }
      }
      if (containsMatches.length === 1) return { status: 'exact', matches: containsMatches };
      if (containsMatches.length > 1) return { status: 'disambiguate', matches: containsMatches };
    }

    // 3. Levenshtein suggestions (distance <= 3, max 5)
    const fuzzyMatches: Array<{ loc: Localidad; dist: number }> = [];
    const seenFuzzy = new Set<string>();
    for (const { norm, loc } of this.allNormalized!) {
      const dist = levenshtein(normCity, norm);
      if (dist <= 3 && dist > 0) {
        const key = `${norm}|${normalize(loc.provincia)}`;
        if (!seenFuzzy.has(key)) {
          seenFuzzy.add(key);
          fuzzyMatches.push({ loc, dist });
        }
      }
    }
    fuzzyMatches.sort((a, b) => a.dist - b.dist);
    if (fuzzyMatches.length > 0) {
      return { status: 'suggestions', matches: fuzzyMatches.slice(0, 5).map(m => m.loc) };
    }

    return { status: 'not_found', matches: [] };
  }
}

export const localidadLookup = new LocalidadLookupService();
