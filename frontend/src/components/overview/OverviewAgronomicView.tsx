import { useAgronomicAnalyticsData } from '../../hooks/useAgronomicAnalyticsData';
import RainfallYieldTrendChart from './charts/RainfallYieldTrendChart';
import FieldPlotsTreemap from './charts/FieldPlotsTreemap';
import YieldByCropCard from './YieldByCropCard';
import ScoutingByPlotCard from './ScoutingByPlotCard';
import HarvestQualityCard from './HarvestQualityCard';

interface Props {
  fieldId: number | null;
  season: number | null;
}

/**
 * The agronomic tab: rain and yield, then everything the endpoint computes and
 * this view used to throw away — yield per crop, the latest scouting on each
 * lote, and the quality of what was delivered.
 */
export default function OverviewAgronomicView({ fieldId, season }: Props) {
  const { data, loading, error, refresh } = useAgronomicAnalyticsData(fieldId, season);

  if (loading && !data) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-300 text-sm">
        {error}
        <button onClick={refresh} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      <RainfallYieldTrendChart
        rainfall={data.rainfallMonthly}
        harvests={data.harvestsMonthly}
        campaignLabel={data.campaign?.label}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <YieldByCropCard rows={data.yieldByCrop} campaignLabel={data.campaign?.label} />
        <HarvestQualityCard loads={data.harvestQualityLoads} />
      </div>
      <ScoutingByPlotCard rows={data.scoutingByPlot} />
      <FieldPlotsTreemap fields={data.fieldPlotCrops} />
    </div>
  );
}
