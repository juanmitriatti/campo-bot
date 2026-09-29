/**
 * Qué lotes (o qué parte de cada lote) están SIN SEMBRAR.
 *
 * Misma fuente que `active_crop`: una campaña de `plot_crops` con
 * `end_date IS NULL`. Pero para "¿qué tengo libre?" una campaña ya COSECHADA
 * (cerrada o no) no ocupa el lote: el lote está listo para la siguiente siembra.
 *
 * Siembra parcial: un lote de 88 ha con 40 ha de soja tiene 48 ha libres.
 * Si alguna campaña que ocupa el lote no dice cuántas ha se sembraron, se toma
 * el lote entero como ocupado (mismo criterio que active_crop: sowed ?? area).
 * Un lote SIN superficie cargada y sin cultivo es libre (`needsArea`: el
 * mensaje le pide que la cargue).
 */

export interface PlotForSowing {
  id: number;
  name: string;
  field_name: string;
  area_hectares: number | string | null;
}

export interface ActiveCropForSowing {
  plot_id: number;
  crop: string;
  sowed_hectares: number | string | null;
  harvested_at: Date | string | null;
}

export interface UnsownPlot {
  plotId: number;
  plotName: string;
  fieldName: string;
  /** Superficie del lote; null si no se cargó. */
  areaHa: number | null;
  /** Ha libres; null si el lote no tiene superficie cargada. */
  freeHa: number | null;
  /** Cultivos que ocupan PARTE del lote (siembra parcial). */
  sownCrops: { crop: string; ha: number }[];
  /** Cultivos ya cosechados con la campaña todavía abierta. */
  harvestedCrops: string[];
  /** El lote no tiene superficie cargada: no se puede calcular lo libre. */
  needsArea: boolean;
}

/** Menos de media hectárea de diferencia es redondeo, no superficie libre. */
const MIN_FREE_HA = 0.5;

const num = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function computeUnsownPlots(
  plots: PlotForSowing[],
  activeCrops: ActiveCropForSowing[],
): UnsownPlot[] {
  const byPlot = new Map<number, ActiveCropForSowing[]>();
  for (const c of activeCrops) {
    const list = byPlot.get(c.plot_id) ?? [];
    list.push(c);
    byPlot.set(c.plot_id, list);
  }

  const out: UnsownPlot[] = [];
  for (const p of plots) {
    const areaHa = num(p.area_hectares);
    const crops = byPlot.get(p.id) ?? [];
    const occupying = crops.filter((c) => c.harvested_at == null);
    const harvestedCrops = crops.filter((c) => c.harvested_at != null).map((c) => c.crop);

    const base = { plotId: p.id, plotName: p.name, fieldName: p.field_name, areaHa, harvestedCrops, needsArea: areaHa == null };

    if (occupying.length === 0) {
      out.push({ ...base, freeHa: areaHa, sownCrops: [] });
      continue;
    }

    // Una siembra sin ha es "todo el lote" (sow_crop omite hectares cuando se
    // sembró entero): ocupado, aunque el lote no tenga superficie cargada.
    if (occupying.some((c) => num(c.sowed_hectares) == null)) continue;

    const sownCrops = occupying.map((c) => ({ crop: c.crop, ha: num(c.sowed_hectares)! }));

    // Siembra parcial en un lote sin superficie: no se sabe cuánto queda. Se
    // muestra igual para pedirle la superficie.
    if (areaHa == null) {
      out.push({ ...base, freeHa: null, sownCrops });
      continue;
    }

    const sownHa = sownCrops.reduce((s, c) => s + c.ha, 0);
    const freeHa = Math.round((areaHa - sownHa) * 100) / 100;
    if (freeHa < MIN_FREE_HA) continue;

    out.push({ ...base, freeHa, sownCrops });
  }
  return out;
}
