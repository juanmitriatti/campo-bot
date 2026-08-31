import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BREED_CATALOG } from '../livestock-breeds.js';

/**
 * El catálogo vive en dos lados: la tabla `livestock_breeds` (seed de la
 * migración 111, que es lo que consulta el dashboard) y BREED_CATALOG en TS
 * (que es lo que normaliza en caliente el agente y el parser). Si divergen, el
 * bot normaliza "holstein" → "Holando Argentino" pero el dropdown del dashboard
 * no ofrece esa raza, o al revés. Este test los amarra.
 */

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'migrations', '111_livestock_breeds.sql',
);

interface SeedRow { code: string; name: string; kind: string; sortOrder: number; synonyms: string[] }

function parseSeed(sql: string): SeedRow[] {
  const rows: SeedRow[] = [];
  // ('code', 'Name', 'kind', 10, E'syn\nsyn')  |  ('otra', 'Otra', 'otra', 920, E'otro')
  const re = /\(\s*'([a-z_]+)'\s*,\s*'([^']+)'\s*,\s*'([a-z]+)'\s*,\s*(\d+)\s*,\s*E'((?:[^']|'')*)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    rows.push({
      code: m[1],
      name: m[2],
      kind: m[3],
      sortOrder: Number(m[4]),
      synonyms: m[5].split('\\n').filter(Boolean),
    });
  }
  return rows;
}

describe('paridad seed SQL ↔ BREED_CATALOG', () => {
  const seed = parseSeed(readFileSync(MIGRATION, 'utf8'));

  it('el parser encontró todas las filas del seed', () => {
    expect(seed.length).toBe(BREED_CATALOG.length);
  });

  it('mismos códigos en el mismo orden', () => {
    expect(seed.map((r) => r.code)).toEqual(BREED_CATALOG.map((b) => b.code));
  });

  it.each(BREED_CATALOG.map((b) => [b.code, b] as const))('%s: name/kind/sortOrder/synonyms coinciden', (code, def) => {
    const row = seed.find((r) => r.code === code);
    expect(row, `falta '${code}' en el seed de la migración 111`).toBeDefined();
    expect(row!.name).toBe(def.name);
    expect(row!.kind).toBe(def.kind);
    expect(row!.sortOrder).toBe(def.sortOrder);
    expect(row!.synonyms).toEqual(def.synonyms);
  });
});
