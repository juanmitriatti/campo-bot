import {
  getCampaignExpenses,
  getCampaignIncomes,
  getCampaignActivities,
  getCampaignObservations,
  getPlotById,
  getHarvestLoadsByCampaign,
  getScoutingsForPlotCampaign,
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

  yield: {
    kg: number | null;
    kgPerHa: number | null;
    notes: string | null;
    loads: { driver_name: string; weight_kg: number; destination: string | null; destinatario: string | null; event_date: string }[];
  };

  profitability: {
    netARS: number;
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
    // Resolve plot
    const resolved = await this.plotDiscovery.resolveFromNames(userId, fieldName ?? null, plotName ?? null);
    if (!resolved.plotId) {
      return 'No pude identificar el lote. Indicá el lote para ver las estadísticas de la campaña.';
    }

    // Find campaign
    let campaign: PlotCropRow | null = null;

    if (crop || seasonYear) {
      // Search history for matching campaign
      const history = await this.cropService.getHistory(resolved.plotId);
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
      campaign = await this.cropService.getActive(resolved.plotId);
      if (!campaign) {
        const history = await this.cropService.getHistory(resolved.plotId);
        if (history.length > 0) campaign = history[0];
      }
    }

    if (!campaign) {
      return `No encontré una campaña${crop ? ` de ${crop}` : ''} en *${resolved.plotName}*.`;
    }

    // Get plot info for area
    const plotInfo = await getPlotById(resolved.plotId, userId);
    const areaHa = plotInfo?.area_hectares ? Number(plotInfo.area_hectares) : null;

    const state = getCampaignState(campaign);
    const startDate = new Date(campaign.start_date);
    const endRef = campaign.end_date ? new Date(campaign.end_date) : new Date();
    const durationDays = Math.ceil((endRef.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    // Fetch data in parallel
    const [activities, expenses, incomes, observations, harvestLoads, scoutings] = await Promise.all([
      getCampaignActivities(campaign.id),
      getCampaignExpenses(resolved.plotId, campaign.start_date, campaign.end_date),
      getCampaignIncomes(resolved.plotId, campaign.start_date, campaign.end_date),
      getCampaignObservations(resolved.plotId, campaign.start_date, campaign.end_date),
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

    // Aggregate expenses
    let expTotalARS = 0;
    let expTotalUSD = 0;
    const expByCategory: Record<string, number> = {};
    for (const e of expenses) {
      const amt = Number(e.amount);
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
    }));

    // Profitability
    const netARS = incTotalARS - expTotalARS;
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
      plot: resolved.plotName || '',
      field: resolved.fieldName || '',
      seasonLabel: formatSeasonLabel(campaign.season_year, campaign.season_type),
      startDate: formatDateAR(campaign.start_date),
      harvestedAt: campaign.harvested_at ? formatDateAR(campaign.harvested_at) : null,
      endDate: campaign.end_date ? formatDateAR(campaign.end_date) : null,
      state,
      durationDays,
      activities: { total: actList.length, byType: actByType, list: actList },
      expenses: { totalARS: expTotalARS, totalUSD: expTotalUSD, byCategory: expByCategory, count: expenses.length },
      incomes: { totalARS: incTotalARS, totalUSD: incTotalUSD, count: incomes.length },
      yield: { kg: yieldKg, kgPerHa: yieldKgPerHa, notes: campaign.yield_notes || null, loads: loadsList },
      profitability: { netARS, costPerHaARS: costPerHa, incomePerHaARS: incomePerHa, costPerTnARS, costPerTnUSD, incomePerTnARS },
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
}
