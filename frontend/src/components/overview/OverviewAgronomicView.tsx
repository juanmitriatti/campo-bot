import { useAgronomicAnalyticsData } from '../../hooks/useAgronomicAnalyticsData';
import RainfallYieldTrendChart from './charts/RainfallYieldTrendChart';
import YieldByCropChart from './charts/YieldByCropChart';

interface Props {
  fieldId: number | null;
}

export default function OverviewAgronomicView({ fieldId }: Props) {
  const { data, loading, error, refresh } = useAgronomicAnalyticsData(fieldId);

  if (loading) {
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
    <div className="space-y-6">
      <RainfallYieldTrendChart rainfall={data.rainfallMonthly} harvests={data.harvestsMonthly} />
      <YieldByCropChart data={data.yieldByCrop} />
    </div>
  );
}
