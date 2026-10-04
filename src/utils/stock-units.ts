/**
 * Unidades de STOCK (fuente ÚNICA): sinónimos, dimensión y conversión.
 *
 * Antes cada camino del stock comparaba la unidad como texto: "litros" ≠ "lt",
 * "kilos" ≠ "kg", "bolsas" ≠ "bolsa" daban error o no se ofrecía el descuento,
 * y una venta en tn sobre un ítem en kg fallaba (STK-10, STK-13, auditoría oct
 * 2026). Una DOSIS por hectárea ("lt/ha", "qq/ha") tampoco es una unidad de
 * stock: "rindió 42 qq/ha" + «Sí, cargar» creaba un ítem soja de 42 "qq/ha"
 * (STK-3).
 *
 * Masa delega en mass-units.ts (kg/tn/qq). Volumen: lt y cc. El resto son
 * unidades de conteo que solo se comparan entre sí (bolsa ≠ unidad).
 */
import { canonicalMassUnit, convertMass } from './mass-units.js';

type Dim = 'mass' | 'volume' | 'count';

const VOLUME: Record<string, { canon: 'lt' | 'cc'; perLt: number }> = {
  lt: { canon: 'lt', perLt: 1 }, l: { canon: 'lt', perLt: 1 }, lts: { canon: 'lt', perLt: 1 },
  litro: { canon: 'lt', perLt: 1 }, litros: { canon: 'lt', perLt: 1 },
  cc: { canon: 'cc', perLt: 1000 }, ml: { canon: 'cc', perLt: 1000 }, cm3: { canon: 'cc', perLt: 1000 },
};

const COUNT: Record<string, string> = {
  bolsa: 'bolsa', bolsas: 'bolsa', bolson: 'bolson', bolsones: 'bolson',
  u: 'u', un: 'u', unidad: 'u', unidades: 'u', uds: 'u',
  dosis: 'dosis', rollo: 'rollo', rollos: 'rollo', fardo: 'fardo', fardos: 'fardo',
  bidon: 'bidon', bidones: 'bidon', caja: 'caja', cajas: 'caja',
};

const norm = (u: string | null | undefined) =>
  (u || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\.$/, '');

/** "lt/ha", "kg/ha", "qq/ha", "por ha": una dosis o un rinde, no una cantidad en stock. */
export function isPerAreaUnit(unit: string | null | undefined): boolean {
  return /\/\s*ha\b|\bpor\s+(ha|hectarea)/.test(norm(unit));
}

/** Unidad canónica + dimensión, o null si es desconocida (se guarda como vino). */
export function canonicalStockUnit(unit: string | null | undefined): { unit: string; dim: Dim } | null {
  const u = norm(unit);
  if (!u || isPerAreaUnit(u)) return null;
  const mass = canonicalMassUnit(u);
  if (mass) return { unit: mass, dim: 'mass' };
  if (VOLUME[u]) return { unit: VOLUME[u].canon, dim: 'volume' };
  if (COUNT[u]) return { unit: COUNT[u], dim: 'count' };
  return null;
}

/** Forma a guardar en un ítem nuevo: la canónica, o la que vino si es desconocida. */
export function storageUnit(unit: string | null | undefined): string {
  return canonicalStockUnit(unit)?.unit ?? (norm(unit) || 'u');
}

/**
 * Convierte `quantity` de `from` a `to`. Misma unidad canónica → igual; masa y
 * volumen se convierten; conteos distintos o dimensiones distintas → null.
 */
export function convertStockQuantity(quantity: number, from: string | null | undefined, to: string | null | undefined): number | null {
  if (!Number.isFinite(quantity)) return null;
  const f = canonicalStockUnit(from);
  const t = canonicalStockUnit(to);
  if (!f || !t) return norm(from) === norm(to) && norm(from) !== '' ? quantity : null;
  if (f.unit === t.unit) return quantity;
  if (f.dim !== t.dim) return null;
  if (f.dim === 'mass') return convertMass(quantity, f.unit, t.unit);
  if (f.dim === 'volume') return (quantity / VOLUME[f.unit].perLt) * VOLUME[t.unit].perLt;
  return null;
}
