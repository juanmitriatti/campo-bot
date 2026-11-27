/**
 * Techo de rinde por cultivo (kg/ha): fuente ÚNICA de "esto parece un error de
 * tipeo o de unidades" para cosecha. Son techos GENEROSOS (muy por encima de los
 * récords de lote), no rindes esperables: lo que se busca es atrapar "42 tn/ha"
 * (= 42.000 kg/ha de soja) o un kg/ha tipeado como qq/ha, no discutir un buen año.
 * Un rinde por encima NO se bloquea: se le pregunta al usuario (botones).
 */

const CEILING_KG_PER_HA: Record<string, number> = {
  soja: 10_000,
  maiz: 30_000,
  trigo: 12_000,
  cebada: 10_000,
  girasol: 6_000,
  sorgo: 15_000,
  avena: 8_000,
  centeno: 8_000,
  mani: 8_000,
  arroz: 15_000,
  algodon: 8_000,
};
/** Cultivo no listado: igual hay un techo físico (nada rinde 40 tn/ha de grano). */
export const DEFAULT_CEILING_KG_PER_HA = 30_000;

const normCrop = (crop: string) => crop.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function yieldCeilingKgPerHa(crop: string | null | undefined): number {
  if (!crop) return DEFAULT_CEILING_KG_PER_HA;
  return CEILING_KG_PER_HA[normCrop(crop)] ?? DEFAULT_CEILING_KG_PER_HA;
}

/**
 * "rindió 40 kg/ha" casi siempre quiso decir 40 qq/ha: menos de 200 kg/ha que,
 * leído como quintales, es un rinde normal. Se pregunta, no se asume.
 */
export function looksLikeQuintalsAsKg(kgPerHa: number, crop: string | null | undefined): boolean {
  // Solo cultivos de la tabla: alfalfa, chía o sésamo rinden de verdad < 200 kg/ha.
  if (!crop || CEILING_KG_PER_HA[normCrop(crop)] === undefined) return false;
  return Number.isFinite(kgPerHa) && kgPerHa > 0 && kgPerHa < 200 && kgPerHa * 100 <= yieldCeilingKgPerHa(crop);
}

/** true si el rinde por hectárea supera el techo del cultivo. */
export function exceedsYieldCeiling(kgPerHa: number, crop: string | null | undefined): boolean {
  return Number.isFinite(kgPerHa) && kgPerHa > yieldCeilingKgPerHa(crop);
}
