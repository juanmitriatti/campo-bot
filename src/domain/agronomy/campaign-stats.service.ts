import {
  getCampaignExpenses,
  getCampaignIncomes,
  getCampaignActivities,
  getCampaignObservations,
  getPlotById,
  getHarvestLoadsByCampaign,
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
  };

  observations: {
    count: number;
    list: { date: string; text: string }[];
  };

  areaHectares: number | null;
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
    const [activities, expenses, incomes, observations, harvestLoads] = await Promise.all([
      getCampaignActivities(campaign.id),
      getCampaignExpenses(resolved.plotId, campaign.start_date, campaign.end_date),
      getCampaignIncomes(resolved.plotId, campaign.start_date, campaign.end_date),
      getCampaignObservations(resolved.plotId, campaign.start_date, campaign.end_date),
      getHarvestLoadsByCampaign(campaign.id),
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

    // Observations
    const obsList = observations.map((o: any) => ({
      date: formatDateAR(o.observation_date),
      text: o.text || o.observation || '',
    }));

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
      profitability: { netARS, costPerHaARS: costPerHa, incomePerHaARS: incomePerHa },
      observations: { count: obsList.length, list: obsList },
      areaHectares: areaHa,
    };
  }
}
