import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface Localidad {
  nombre: string;
  provincia: string;
  departamento: string | null;
}

export interface LookupResult {
  status: 'exact' | 'disambiguate' | 'suggestions' | 'not_found';
  matches: Localidad[];
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f\u00AD]/g, '').toLowerCase().trim();
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

  lookup(input: string): LookupResult {
    this.ensureLoaded();

    const trimmed = input.trim();
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
    const normProvince = provincePart ? normalize(provincePart) : null;

    // 1. Exact normalized match
    const exactMatches = this.index!.get(normCity);
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
