/**
 * Unidades de masa comerciales (fuente ÚNICA): kg, tn, qq.
 *
 * Argentina: tn = 1.000 kg, qq (quintal) = 100 kg. `t`/`ton`/`tonelada(s)` son
 * abreviaturas comunes de tonelada — sin reconocerlas caían al default kg y el
 * rinde quedaba ÷1000 en silencio.
 *
 * La usan el mapper del agente (`normalizeToKg`), el rinde de cosecha y el
 * stock de granos: "cargar 130 tn de soja" sobre un ítem que está en kg se
 * convierte en vez de fallar (P1-5, QA sep 2026: el botón «Sí, cargar» decía
 * «"soja" está en kg, no se puede cargar en tn» y el silo quedaba incompleto).
 */

export type MassUnit = 'kg' | 'tn' | 'qq';

/** Unidad canónica de masa, o null si no es una unidad de masa conocida. */
export function canonicalMassUnit(unit: string | null | undefined): MassUnit | null {
  const u = (unit || '').toLowerCase().trim();
  if (u === '' || u === 'kg' || u === 'kgs' || u === 'kilo' || u === 'kilos' || u === 'k') return 'kg';
  if (u === 'tn' || u === 't' || u === 'ton' || u === 'tons' || u.startsWith('tonel')) return 'tn';
  if (u === 'qq' || u.startsWith('quint')) return 'qq';
  return null;
}

const KG_PER: Record<MassUnit, number> = { kg: 1, tn: 1000, qq: 100 };

/** Convierte una cantidad entre unidades de masa; null si alguna no es de masa. */
export function convertMass(quantity: number, from: string | null | undefined, to: string | null | undefined): number | null {
  const f = canonicalMassUnit(from);
  const t = canonicalMassUnit(to);
  if (!f || !t || !Number.isFinite(quantity)) return null;
  return (quantity * KG_PER[f]) / KG_PER[t];
}

/**
 * (cantidad, unidad) → kg. Una unidad desconocida se asume kg y queda en el
 * log: así se detectan abreviaturas nuevas antes de que corrompan rindes.
 */
export function normalizeToKg(quantity: number | null | undefined, unit: string | null | undefined): number | null {
  if (quantity == null || !Number.isFinite(Number(quantity))) return null;
  const q = Number(quantity);
  const canon = canonicalMassUnit(unit);
  if (!canon) {
    console.warn(`[INTERCEPT] normalizeToKg: unidad desconocida "${unit}" asumida como kg (q=${q})`);
    return q;
  }
  return q * KG_PER[canon];
}
