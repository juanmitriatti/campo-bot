import {
  getCampaignExpenses,
  getCampaignIncomes,
  getCampaignActivities,
  getCampaignObservations,
  getPlotById,
  getHarvestLoadsByCampaign,
  getScoutingsForPlotCampaign,
  getCampaignTotals,
} from '../../services/expenses.js';
import { CropService, formatSeasonLabel, getCampaignState } from '../plots/crop.service.js';
import { PlotDiscoveryService } from '../plots/plot-discovery.service.js';
import { getActivityLabel } from './activity.service.js';
import { formatDateAR } from '../../utils/date.js';
import type { UserId, PlotCropRow } from '../../types/index.js';

export interface CampaignStats {
  crop: string;
  plot: string;
  field: string;
  seasonLabel: string;
  startDate: string;
  harvestedAt: string | null;
  endDate: string | null;
  state: 'active' | 'harvested' | 'closed';
  durationDays: number;

  activities: {
    total: number;
    byType: Record<string, number>;
    list: { date: string; type: string; label: string; product?: string; quantity?: number; unit?: string }[];
  };

  expenses: {
    totalARS: number;
    totalUSD: number;
    byCategory: Record<string, number>;
    count: number;
  };

  incomes: {
    totalARS: number;
    totalUSD: number;
    count: number;
  };

  /** Movimientos categoría Hacienda en el lote durante la campaña — EXCLUIDOS
   * del margen del cultivo (la hacienda tiene su propia economía), mostrados
   * aparte para no ocultar datos. null cuando no hubo ninguno. */
  livestockAside: {
    expensesARS: number;
    expensesUSD: number;
    incomesARS: number;
    incomesUSD: number;
    count: number;
  } | null;

  yield: {
    kg: number | null;
    kgPerHa: number | null;
    notes: string | null;
    loads: { driver_name: string; weight_kg: number; destination: string | null; destinatario: string | null; event_date: string; humidity_pct: number | null; quality_metrics: Record<string, unknown> | null }[];
    avgHumidity: number | null;
  };

  profitability: {
    netARS: number;
    netUSD: number;
    costPerHaARS: number | null;
    incomePerHaARS: number | null;
    costPerTnARS: number | null;
    costPerTnUSD: number | null;
    incomePerTnARS: number | null;
  };

  observations: {
    count: number;
    list: { date: string; text: string }[];
  };

  scouting: {
    count: number;
    lastStage: string | null;
    lastStageDate: string | null;
    avgWeedPct: number | null;
    maxPestSeverity: number | null;
    maxPestSpecies: string | null;
    avgPlantDensity: number | null;
    lastEmergencePct: number | null;
  } | null;

  areaHectares: number | null;
}

export interface CampaignComparison {
  crop: string;
  plot: string;
  field: string;
  season1: { label: string; stats: CampaignStats };
  season2: { label: string; stats: CampaignStats };
  deltas: {
    yieldKgPerHaPct: number | null;
    expensesPct: number | null;
    incomesPct: number | null;
    netPerHaPct: number | null;
    costPerHaPct: number | null;
  };
}

function pctDelta(a: number, b: number): number | null {
  if (b === 0) return a > 0 ? 100 : null;
  return Math.round(((a - b) / Math.abs(b)) * 100);
}

export class CampaignStatsService {
  private plotDiscovery = new PlotDiscoveryService();
  private cropService = new CropService();

  async getCampaignStats(
    userId: UserId,
    plotName?: string | null,
    fieldName?: string | null,
    crop?: string | null,
    seasonYear?: string | null,
  ): Promise<CampaignStats | string> {
    // Resolve plot — fall back to recently referenced plot when nothing was
    // specified, so questions like "promedio?" right after talking about a
    // lote work without re-typing the name.
    const resolved = await this.plotDiscovery.resolveFromNamesWithContext(userId, fieldName ?? null, plotName ?? null);
    let resolvedPlotId = resolved.plotId;
    let resolvedPlotName = resolved.plotName;

    // FQR-4: auto-pick when only ONE active campaign matches the crop/season filter,
    // or list all active campaigns when the query is broad ("cómo viene la campaña").
    if (!resolvedPlotId) {
      const { pool } = await import('../../config/db.js');
      const params: unknown[] = [userId];
      const conds = ['f.user_id = $1', 'p.deleted_at IS NULL', 'pc.harvested_at IS NULL'];
      if (crop) {
        conds.push(`TRANSLATE(LOWER(pc.crop), 'áéíóúñ', 'aeioun') = TRANSLATE(LOWER($${params.length + 1}), 'áéíóúñ', 'aeioun')`);
        params.push(crop);
      }
      if (seasonYear) {
        conds.push(`(pc.season_year::text = $${params.length + 1} OR pc.season_year::text || '/' || (pc.season_year + 1)::text = $${params.length + 1})`);
        params.push(seasonYear);
      }
      const matches = await pool.query(
        `SELECT DISTINCT p.id, p.name, pc.crop, pc.season_year FROM plots p
         JOIN fields f ON p.field_id = f.id
         JOIN plot_crops pc ON pc.plot_id = p.id
         WHERE ${conds.join(' AND ')}
         ORDER BY p.name
         LIMIT 10`,
        params,
      );
      if (matches.rows.length === 1) {
        resolvedPlotId = Number(matches.rows[0].id);
        resolvedPlotName = String(matches.rows[0].name);
      } else if (matches.rows.length > 1) {
        // Broad query — return a panorama of all active campaigns.
        const list = matches.rows
          .map((r: { name: string; crop: string; season_year: number }) =>
            `  • *${r.name}* — ${r.crop} (${r.season_year}/${r.season_year + 1})`,
          )
          .join('\n');
        return `🌱 *Campañas activas* (${matches.rows.length})\n${list}\n\n💡 Pedí "campaña <lote>" para ver detalles de cada una.`;
      }
    }

    if (!resolvedPlotId) {
      return 'No tenés campañas activas. Cuando siembres en un lote, te puedo dar estadísticas.';
    }

    // Find campaign
    let campaign: PlotCropRow | null = null;

    if (crop || seasonYear) {
      // Search history for matching campaign
      const history = await this.cropService.getHistory(resolvedPlotId);
      for (const row of history) {
        if (crop && row.crop.toLowerCase() !== crop.toLowerCase()) continue;
        if (seasonYear) {
          const label = formatSeasonLabel(row.season_year, row.season_type);
          if (label !== seasonYear && String(row.season_year) !== seasonYear) continue;
        }
        campaign = row;
        break;
      }
    } else {
      // Default: active or last harvested campaign
      campaign = await this.cropService.getActive(resolvedPlotId);
      if (!campaign) {
        const history = await this.cropService.getHistory(resolvedPlotId);
        if (history.length > 0) campaign = history[0];
      }
    }

    if (!campaign) {
      return `No encontré una campaña${crop ? ` de ${crop}` : ''} en *${resolvedPlotName}*.`;
    }

    // Get plot info for area — la superficie SEMBRADA de la campaña manda
    // (siembra parcial: kg/ha y costo/ha sobre el área del lote inflaban o
    // diluían los ratios; test fuerte Ago 2026).
    const plotInfo = await getPlotById(resolvedPlotId, userId);
    const sowedHa = (campaign as { sowed_hectares?: number | null }).sowed_hectares
      ? Number((campaign as { sowed_hectares?: number | null }).sowed_hectares) : null;
    const areaHa = sowedHa ?? (plotInfo?.area_hectares ? Number(plotInfo.area_hectares) : null);

    const state = getCampaignState(campaign);
    const startDate = new Date(campaign.start_date);
    const endRef = campaign.end_date ? new Date(campaign.end_date) : new Date();
    const durationDays = Math.ceil((endRef.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    // Fetch data in parallel
    const [activities, expenses, incomes, observations, harvestLoads, scoutings] = await Promise.all([
      getCampaignActivities(campaign.id),
      getCampaignExpenses(resolvedPlotId, campaign.start_date, campaign.end_date),
      getCampaignIncomes(resolvedPlotId, campaign.start_date, campaign.end_date),
      getCampaignObservations(resolvedPlotId, campaign.start_date, campaign.end_date),
      getHarvestLoadsByCampaign(campaign.id),
      getScoutingsForPlotCampaign(campaign.id),
    ]);

    // Aggregate activities
    const actByType: Record<string, number> = {};
    const actList = activities.map((a: any) => {
      const type = a.event_type as string;
      actByType[type] = (actByType[type] || 0) + 1;
      const { label } = getActivityLabel(type);
      return {
        date: formatDateAR(a.event_date),
        type,
        label,
        product: a.product || undefined,
        quantity: a.quantity ? Number(a.quantity) : undefined,
        unit: a.unit || undefined,
      };
    });

    // Los movimientos de HACIENDA no entran en la economía del CULTIVO: una
    // compra de terneros en el mismo lote mostraba un maíz con -$19,4M de
    // resultado (visto en prod). Se acumulan aparte y el formatter los muestra
    // como línea separada — excluidos del margen, no ocultos.
    const isLivestockCat = (c: unknown) => String(c ?? '').toLowerCase() === 'hacienda';
    const livestockAside = { expensesARS: 0, expensesUSD: 0, incomesARS: 0, incomesUSD: 0, count: 0 };
    let excludedExpCount = 0;
    let excludedIncCount = 0;

    // Aggregate expenses
    let expTotalARS = 0;
    let expTotalUSD = 0;
    const expByCategory: Record<string, number> = {};
    for (const e of expenses) {
      const amt = Number(e.amount);
      if (isLivestockCat(e.category)) {
        livestockAside.count++;
        excludedExpCount++;
        if (e.currency === 'USD') livestockAside.expensesUSD += amt;
        else livestockAside.expensesARS += amt;
        continue;
      }
      if (e.currency === 'USD') {
        expTotalUSD += amt;
      } else {
        expTotalARS += amt;
      }
      const cat = e.category || 'Otros';
      expByCategory[cat] = (expByCategory[cat] || 0) + amt;
    }

    // Aggregate incomes
    let incTotalARS = 0;
    let incTotalUSD = 0;
    for (const i of incomes) {
      const amt = Number(i.amount);
      if (isLivestockCat(i.category)) {
        livestockAside.count++;
        excludedIncCount++;
        if (i.currency === 'USD') livestockAside.incomesUSD += amt;
        else livestockAside.incomesARS += amt;
        continue;
      }
      if (i.currency === 'USD') {
        incTotalUSD += amt;
      } else {
        incTotalARS += amt;
      }
    }

    // Yield
    const yieldKg = campaign.yield_kg ? Number(campaign.yield_kg) : null;
    const yieldKgPerHa = yieldKg && areaHa ? Math.round(yieldKg / areaHa) : null;

    // Harvest loads
    const loadsList = (harvestLoads || []).map((hl: any) => ({
      driver_name: hl.driver_name as string,
      weight_kg: Number(hl.weight_kg),
      destination: hl.destination || null,
      destinatario: hl.destinatario || null,
      event_date: formatDateAR(hl.event_date),
      humidity_pct: hl.humidity_pct != null ? Number(hl.humidity_pct) : null,
      quality_metrics: hl.quality_metrics || null,
    }));

    // Average humidity (only loads that reported it)
    const humLoads = (harvestLoads || []).filter((hl: any) => hl.humidity_pct != null);
    const avgHumidity = humLoads.length > 0
      ? Math.round(humLoads.reduce((a: number, hl: any) => a + Number(hl.humidity_pct), 0) / humLoads.length * 10) / 10
      : null;

    // Profitability
    const netARS = incTotalARS - expTotalARS;
    const netUSD = (incTotalUSD || 0) - (expTotalUSD || 0);
    const costPerHa = areaHa ? Math.round(expTotalARS / areaHa) : null;
    const incomePerHa = areaHa ? Math.round(incTotalARS / areaHa) : null;
    const yieldTn = yieldKg ? yieldKg / 1000 : null;
    const costPerTnARS = yieldTn ? Math.round(expTotalARS / yieldTn) : null;
    const costPerTnUSD = yieldTn && expTotalUSD ? Math.round(expTotalUSD / yieldTn) : null;
    const incomePerTnARS = yieldTn ? Math.round(incTotalARS / yieldTn) : null;

    // Observations
    const obsList = observations.map((o: any) => ({
      date: formatDateAR(o.observation_date),
      text: o.text || o.observation || '',
    }));

    // Scouting aggregates (last stage observed, max pest severity, avg weed coverage, density, emergence)
    let scoutingAgg = null as null | {
      count: number;
      lastStage: string | null;
      lastStageDate: string | null;
      avgWeedPct: number | null;
      maxPestSeverity: number | null;
      maxPestSpecies: string | null;
      avgPlantDensity: number | null;
      lastEmergencePct: number | null;
    };
    if (scoutings.length > 0) {
      const sorted = [...scoutings].sort((a: any, b: any) => new Date(b.scouting_date).getTime() - new Date(a.scouting_date).getTime());
      const stagesRow = sorted.find((s: any) => s.stage_code) as any;
      const weeds = scoutings.filter((s: any) => s.weed_coverage_pct != null);
      const avgWeed = weeds.length ? weeds.reduce((a: number, s: any) => a + Number(s.weed_coverage_pct), 0) / weeds.length : null;
      let maxSev = null as number | null;
      let maxSevSpecies = null as string | null;
      for (const s of scoutings as any[]) {
        if (s.pest_severity_1_5 != null && (maxSev == null || s.pest_severity_1_5 > maxSev)) {
          maxSev = s.pest_severity_1_5;
          maxSevSpecies = s.pest_species || null;
        }
      }
      const densities = scoutings.filter((s: any) => s.plant_density_m2 != null);
      const avgDensity = densities.length ? densities.reduce((a: number, s: any) => a + Number(s.plant_density_m2), 0) / densities.length : null;
      const emergRow = sorted.find((s: any) => s.emergence_pct != null) as any;
      scoutingAgg = {
        count: scoutings.length,
        lastStage: stagesRow?.stage_code || null,
        lastStageDate: stagesRow ? formatDateAR(stagesRow.scouting_date) : null,
        avgWeedPct: avgWeed != null ? Math.round(avgWeed * 10) / 10 : null,
        maxPestSeverity: maxSev,
        maxPestSpecies: maxSevSpecies,
        avgPlantDensity: avgDensity != null ? Math.round(avgDensity * 10) / 10 : null,
        lastEmergencePct: emergRow?.emergence_pct != null ? Number(emergRow.emergence_pct) : null,
      };
    }

    return {
      crop: campaign.crop,
      plot: resolvedPlotName || '',
      field: resolved.fieldName || '',
      seasonLabel: formatSeasonLabel(campaign.season_year, campaign.season_type),
      startDate: formatDateAR(campaign.start_date),
      harvestedAt: campaign.harvested_at ? formatDateAR(campaign.harvested_at) : null,
      endDate: campaign.end_date ? formatDateAR(campaign.end_date) : null,
      state,
      durationDays,
      activities: { total: actList.length, byType: actByType, list: actList },
      expenses: { totalARS: expTotalARS, totalUSD: expTotalUSD, byCategory: expByCategory, count: expenses.length - excludedExpCount },
      incomes: { totalARS: incTotalARS, totalUSD: incTotalUSD, count: incomes.length - excludedIncCount },
      livestockAside: livestockAside.count > 0 ? livestockAside : null,
      yield: { kg: yieldKg, kgPerHa: yieldKgPerHa, notes: campaign.yield_notes || null, loads: loadsList, avgHumidity },
      profitability: { netARS, netUSD, costPerHaARS: costPerHa, incomePerHaARS: incomePerHa, costPerTnARS, costPerTnUSD, incomePerTnARS },
      observations: { count: obsList.length, list: obsList },
      scouting: scoutingAgg,
      areaHectares: areaHa,
    };
  }

  async compareCampaigns(
    userId: UserId,
    plotName?: string | null,
    fieldName?: string | null,
    crop?: string | null,
    seasonYear1?: string | null,
    seasonYear2?: string | null,
  ): Promise<CampaignComparison | string> {
    const resolved = await this.plotDiscovery.resolveFromNames(userId, fieldName ?? null, plotName ?? null);
    if (!resolved.plotId) {
      return 'No pude identificar el lote. Indicá el lote para comparar campañas.';
    }

    const history = await this.cropService.getHistory(resolved.plotId);
    if (history.length < 2) {
      return `El lote *${resolved.plotName}* no tiene suficientes campañas para comparar.`;
    }

    // Find the two campaigns to compare
    let campaign1: PlotCropRow | null = null;
    let campaign2: PlotCropRow | null = null;

    if (seasonYear1 && seasonYear2) {
      for (const row of history) {
        if (crop && row.crop.toLowerCase() !== crop.toLowerCase()) continue;
        const label = formatSeasonLabel(row.season_year, row.season_type);
        if (label === seasonYear1 || String(row.season_year) === seasonYear1) campaign1 = row;
        if (label === seasonYear2 || String(row.season_year) === seasonYear2) campaign2 = row;
      }
    } else {
      // Auto: find most recent two campaigns of the same crop
      const targetCrop = crop?.toLowerCase() ?? null;
      const matches: PlotCropRow[] = [];
      for (const row of history) {
        if (targetCrop && row.crop.toLowerCase() !== targetCrop) continue;
        matches.push(row);
        if (matches.length === 2) break;
      }
      if (matches.length === 2) {
        campaign1 = matches[0];
        campaign2 = matches[1];
      } else if (!targetCrop && history.length >= 2) {
        // Fallback: last two regardless of crop
        campaign1 = history[0];
        campaign2 = history[1];
      }
    }

    if (!campaign1 || !campaign2) {
      return `No encontré dos campañas${crop ? ` de ${crop}` : ''} para comparar en *${resolved.plotName}*.`;
    }

    const label1 = formatSeasonLabel(campaign1.season_year, campaign1.season_type);
    const label2 = formatSeasonLabel(campaign2.season_year, campaign2.season_type);

    const [stats1, stats2] = await Promise.all([
      this.getCampaignStats(userId, plotName, fieldName, campaign1.crop, String(campaign1.season_year)),
      this.getCampaignStats(userId, plotName, fieldName, campaign2.crop, String(campaign2.season_year)),
    ]);

    if (typeof stats1 === 'string') return stats1;
    if (typeof stats2 === 'string') return stats2;

    const deltas = {
      yieldKgPerHaPct: stats1.yield.kgPerHa != null && stats2.yield.kgPerHa != null
        ? pctDelta(stats1.yield.kgPerHa, stats2.yield.kgPerHa) : null,
      expensesPct: pctDelta(stats1.expenses.totalARS, stats2.expenses.totalARS),
      incomesPct: pctDelta(stats1.incomes.totalARS, stats2.incomes.totalARS),
      netPerHaPct: stats1.profitability.incomePerHaARS != null && stats2.profitability.incomePerHaARS != null
        ? pctDelta(
            stats1.profitability.incomePerHaARS - (stats1.profitability.costPerHaARS ?? 0),
            stats2.profitability.incomePerHaARS - (stats2.profitability.costPerHaARS ?? 0),
          ) : null,
      costPerHaPct: stats1.profitability.costPerHaARS != null && stats2.profitability.costPerHaARS != null
        ? pctDelta(stats1.profitability.costPerHaARS, stats2.profitability.costPerHaARS) : null,
    };

    return {
      crop: campaign1.crop,
      plot: resolved.plotName || '',
      field: resolved.fieldName || '',
      season1: { label: label1, stats: stats1 },
      season2: { label: label2, stats: stats2 },
      deltas,
    };
  }

  /**
   * Ranking entre campañas: "¿qué lote tuvo mejor margen?", "¿me fue mejor con
   * soja o con maíz?", "¿cuánto me costó la tonelada en cada lote?".
   *
   * Una sola query agregada (getCampaignTotals) en vez de N × getCampaignStats.
   */
  async rankCampaigns(
    userId: UserId,
    opts: {
      metric?: RankMetric;
      groupBy?: RankGroupBy;
      topN?: number;
      seasonYear?: string | null;
      crop?: string | null;
      fieldName?: string | null;
    } = {},
  ): Promise<CampaignRanking> {
    const raw = await getCampaignTotals(Number(userId), {
      seasonYear: opts.seasonYear ?? null,
      crop: opts.crop ?? null,
      fieldName: opts.fieldName ?? null,
    });

    const scopeBits: string[] = [];
    if (opts.crop) scopeBits.push(opts.crop);
    if (opts.fieldName) scopeBits.push(`campo ${opts.fieldName}`);
    if (opts.seasonYear) scopeBits.push(opts.seasonYear);

    return buildCampaignRanking(raw as never, {
      metric: opts.metric,
      groupBy: opts.groupBy,
      topN: opts.topN,
      scopeLabel: scopeBits.join(' · '),
    });
  }
}

// ---------------------------------------------------------------------------
// Ranking entre campañas (Ago 2026)
//
// getCampaignStats responde UNA campaña. Eso deja afuera justo las preguntas
// que un productor hace primero: "¿qué lote tuvo mejor margen?", "¿cuánto me
// costó la tonelada en cada uno?", "¿me fue mejor con soja o con maíz?".
// Acá se agrega sobre TODAS las campañas del usuario con una sola query.
// ---------------------------------------------------------------------------

export type RankMetric = 'margin' | 'yield_kg_ha' | 'cost_per_ha' | 'cost_per_tn';
export type RankGroupBy = 'plot' | 'crop';

export interface CampaignRankRow {
  label: string;
  crop: string;
  plot: string | null;
  field: string | null;
  seasonLabel: string | null;
  areaHa: number | null;
  yieldKg: number | null;
  yieldKgPerHa: number | null;
  expensesARS: number;
  incomesARS: number;
  expensesUSD: number;
  incomesUSD: number;
  marginARS: number;
  costPerHaARS: number | null;
  costPerTnARS: number | null;
  /** Valor de la métrica elegida; null cuando no hay datos para calcularla. */
  value: number | null;
}

export interface CampaignRanking {
  metric: RankMetric;
  groupBy: RankGroupBy;
  rows: CampaignRankRow[];
  /** Campañas que quedaron fuera del ranking por no tener con qué calcular. */
  skipped: number;
  scopeLabel: string;
}

interface RawTotals {
  crop: string;
  plot_name: string;
  field_name: string;
  season_year: string | number | null;
  season_type: string | null;
  effective_ha: string | number | null;
  yield_kg: string | number | null;
  exp_ars: string | number;
  exp_usd: string | number;
  inc_ars: string | number;
  inc_usd: string | number;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Deriva las métricas SIEMPRE desde los totales, nunca promediando ratios:
 *  el promedio de kg/ha de dos lotes de tamaño distinto no es el kg/ha real. */
function deriveMetrics(
  areaHa: number | null,
  yieldKg: number | null,
  expARS: number,
  incARS: number,
): Pick<CampaignRankRow, 'yieldKgPerHa' | 'marginARS' | 'costPerHaARS' | 'costPerTnARS'> {
  const ha = areaHa && areaHa > 0 ? areaHa : null;
  const tn = yieldKg && yieldKg > 0 ? yieldKg / 1000 : null;
  return {
    yieldKgPerHa: ha && yieldKg && yieldKg > 0 ? Math.round(yieldKg / ha) : null,
    marginARS: incARS - expARS,
    costPerHaARS: ha && expARS > 0 ? Math.round(expARS / ha) : null,
    costPerTnARS: tn && expARS > 0 ? Math.round(expARS / tn) : null,
  };
}

function pickValue(row: CampaignRankRow, metric: RankMetric): number | null {
  switch (metric) {
    case 'margin': return row.marginARS;
    case 'yield_kg_ha': return row.yieldKgPerHa;
    case 'cost_per_ha': return row.costPerHaARS;
    case 'cost_per_tn': return row.costPerTnARS;
    default: return null;
  }
}

export function buildCampaignRanking(
  raw: RawTotals[],
  opts: { metric?: RankMetric; groupBy?: RankGroupBy; topN?: number; scopeLabel?: string } = {},
): CampaignRanking {
  const metric: RankMetric = opts.metric ?? 'margin';
  const groupBy: RankGroupBy = opts.groupBy ?? 'plot';

  let rows: CampaignRankRow[];

  if (groupBy === 'crop') {
    const acc = new Map<string, { ha: number; yieldKg: number; exp: number; inc: number; expU: number; incU: number; crop: string }>();
    for (const r of raw) {
      const key = String(r.crop ?? '—').toLowerCase();
      const cur = acc.get(key) ?? { ha: 0, yieldKg: 0, exp: 0, inc: 0, expU: 0, incU: 0, crop: String(r.crop ?? '—') };
      cur.ha += n(r.effective_ha);
      cur.yieldKg += Math.max(0, n(r.yield_kg));
      cur.exp += n(r.exp_ars);
      cur.inc += n(r.inc_ars);
      cur.expU += n(r.exp_usd);
      cur.incU += n(r.inc_usd);
      acc.set(key, cur);
    }
    rows = [...acc.values()].map(a => {
      const base = {
        label: a.crop, crop: a.crop, plot: null, field: null, seasonLabel: null,
        areaHa: a.ha || null, yieldKg: a.yieldKg || null,
        expensesARS: a.exp, incomesARS: a.inc, expensesUSD: a.expU, incomesUSD: a.incU,
      };
      const d = deriveMetrics(base.areaHa, base.yieldKg, a.exp, a.inc);
      const row = { ...base, ...d, value: null } as CampaignRankRow;
      row.value = pickValue(row, metric);
      return row;
    });
  } else {
    rows = raw.map(r => {
      const areaHa = n(r.effective_ha) || null;
      const yieldKg = Math.max(0, n(r.yield_kg)) || null;
      const expARS = n(r.exp_ars);
      const incARS = n(r.inc_ars);
      const season = r.season_year != null ? String(r.season_year) : null;
      const base = {
        label: `${r.plot_name}${r.field_name ? ` (${r.field_name})` : ''} — ${r.crop}`,
        crop: String(r.crop ?? '—'),
        plot: r.plot_name ?? null,
        field: r.field_name ?? null,
        seasonLabel: season,
        areaHa, yieldKg,
        expensesARS: expARS, incomesARS: incARS,
        expensesUSD: n(r.exp_usd), incomesUSD: n(r.inc_usd),
      };
      const d = deriveMetrics(areaHa, yieldKg, expARS, incARS);
      const row = { ...base, ...d, value: null } as CampaignRankRow;
      row.value = pickValue(row, metric);
      return row;
    });
  }

  const usable = rows.filter(r => r.value != null);
  const skipped = rows.length - usable.length;

  // margin y yield: más es mejor. costos: menos es mejor.
  const asc = metric === 'cost_per_ha' || metric === 'cost_per_tn';
  usable.sort((a, b) => (asc ? (a.value! - b.value!) : (b.value! - a.value!)));

  const topN = opts.topN && opts.topN > 0 ? opts.topN : usable.length;
  return {
    metric,
    groupBy,
    rows: usable.slice(0, topN),
    skipped,
    scopeLabel: opts.scopeLabel ?? '',
  };
}
