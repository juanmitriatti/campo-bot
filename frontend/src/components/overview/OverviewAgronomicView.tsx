import { useAgronomicAnalyticsData } from '../../hooks/useAgronomicAnalyticsData';
import RainfallYieldTrendChart from './charts/RainfallYieldTrendChart';
import ScoutingFieldMap from './charts/ScoutingFieldMap';
import YieldByCropChart from './charts/YieldByCropChart';
import HarvestQualityVsHumidityScatter from './charts/HarvestQualityVsHumidityScatter';

export default function OverviewAgronomicView() {
  const { data, loading, error, refresh } = useAgronomicAnalyticsData();

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
        {error}
        <button onClick={refresh} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <RainfallYieldTrendChart rainfall={data.rainfallMonthly} harvests={data.harvestsMonthly} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8">
          <ScoutingFieldMap scoutings={data.scoutingByPlot} />
        </div>
        <div className="lg:col-span-4">
          <YieldByCropChart data={data.yieldByCrop} />
        </div>
      </div>

      <HarvestQualityVsHumidityScatter loads={data.harvestQualityLoads} />
    </div>
  );
}
