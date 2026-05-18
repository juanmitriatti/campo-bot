import { useLivestockAnalyticsData } from '../../hooks/useLivestockAnalyticsData';
import LivestockStockByCategoryChart from './charts/LivestockStockByCategoryChart';
import AvgWeightByCategoryChart from './charts/AvgWeightByCategoryChart';
import FeedlotOccupancyChart from './charts/FeedlotOccupancyChart';
import LivestockHeadcountTrendChart from './charts/LivestockHeadcountTrendChart';
import FeedlotWeightCurveChart from './charts/FeedlotWeightCurveChart';
import LivestockHealthEventsChart from './charts/LivestockHealthEventsChart';
import LivestockReproEventsChart from './charts/LivestockReproEventsChart';

interface Props {
  fieldId: number | null;
}

export default function OverviewLivestockView({ fieldId }: Props) {
  const { data, loading, error, refresh } = useLivestockAnalyticsData(fieldId);

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
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-4">
          <LivestockStockByCategoryChart data={data.stockByCategory} />
        </div>
        <div className="lg:col-span-4">
          <AvgWeightByCategoryChart data={data.avgWeightByCategory} />
        </div>
        <div className="lg:col-span-4">
          <FeedlotOccupancyChart data={data.feedlotOccupancy} />
        </div>
      </div>

      <LivestockHeadcountTrendChart data={data.headcountTrendMonthly} />

      <FeedlotWeightCurveChart groups={data.feedlotWeightCurve} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LivestockHealthEventsChart data={data.healthEventsMonthly} />
        <LivestockReproEventsChart data={data.reproEventsMonthly} />
      </div>
    </div>
  );
}
