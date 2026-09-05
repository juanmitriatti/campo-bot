import { useMemo } from 'react';
import { Beef, Scale, Home, Syringe, Activity } from 'lucide-react';
import { useLivestockAnalyticsData } from '../../hooks/useLivestockAnalyticsData';
import KpiCard from './KpiCard';
import LivestockStockByCategoryChart from './charts/LivestockStockByCategoryChart';
import AvgWeightByCategoryChart from './charts/AvgWeightByCategoryChart';
import FeedlotOccupancyChart from './charts/FeedlotOccupancyChart';
import LivestockHeadcountTrendChart from './charts/LivestockHeadcountTrendChart';
import FeedlotWeightCurveChart from './charts/FeedlotWeightCurveChart';
import LivestockHealthEventsChart from './charts/LivestockHealthEventsChart';
import LivestockReproEventsChart from './charts/LivestockReproEventsChart';
import IndividualizationCard from './IndividualizationCard';

interface Props {
  fieldId: number | null;
}

export default function OverviewLivestockView({ fieldId }: Props) {
  const { data, loading, error, refresh } = useLivestockAnalyticsData(fieldId);

  // Hooks must run unconditionally, so compute KPIs before any early return.
  const totalHeadcount = useMemo(
    () => (data?.stockByCategory ?? []).reduce((s, r) => s + r.headcount, 0),
    [data?.stockByCategory],
  );

  const feedlotAnimals = useMemo(
    () => (data?.feedlotOccupancy ?? []).reduce((s, r) => s + r.currentHeadcount, 0),
    [data?.feedlotOccupancy],
  );

  // Weighted by head, not a mean of per-category means: with 300 terneros at
  // 180 kg and 20 toros at 700 kg, the plain average said 440 and the rodeo
  // weighs 212. Categories without a headcount fall back to weight 1.
  const avgWeight = useMemo(() => {
    const list = data?.avgWeightByCategory ?? [];
    if (list.length === 0) return null;
    const head = new Map((data?.stockByCategory ?? []).map(r => [r.category, r.headcount]));
    let kg = 0;
    let n = 0;
    for (const r of list) {
      const w = head.get(r.category) ?? 1;
      kg += r.avgWeightKg * w;
      n += w;
    }
    return n > 0 ? Math.round(kg / n) : null;
  }, [data?.avgWeightByCategory, data?.stockByCategory]);

  // "This month" is the calendar month we are in, not the last month that had
  // an event: with the old lookup a March vaccination was still "Sanidad mes"
  // in September.
  const thisMonth = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).slice(0, 7);
  const countThisMonth = (list: Array<{ month: string; byType: Record<string, number> }> | undefined) => {
    const row = (list ?? []).find(m => m.month === thisMonth);
    return row ? Object.values(row.byType).reduce((s, v) => s + v, 0) : 0;
  };
  const healthThisMonth = useMemo(() => countThisMonth(data?.healthEventsMonthly), [data?.healthEventsMonthly, thisMonth]);
  const reproThisMonth = useMemo(() => countThisMonth(data?.reproEventsMonthly), [data?.reproEventsMonthly, thisMonth]);

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
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard label="Total cabezas" value={String(totalHeadcount)} tint="bg-amber-50" Icon={Beef} iconColor="text-amber-600" />
        <KpiCard label="En corral" value={`${feedlotAnimals}`} tint="bg-blue-50" Icon={Home} iconColor="text-blue-600" />
        <KpiCard label="Peso promedio (ponderado)" value={avgWeight != null ? `${avgWeight} kg` : '—'} tint="bg-green-50" Icon={Scale} iconColor="text-green-600" />
        <KpiCard label="Sanidad este mes" value={String(healthThisMonth)} tint="bg-purple-50" Icon={Syringe} iconColor="text-purple-600" />
        <KpiCard label="Repro este mes" value={String(reproThisMonth)} tint="bg-pink-50" Icon={Activity} iconColor="text-pink-600" />
      </div>

      {/* Trazabilidad individual. Esta vista es donde el productor mira el
          rodeo: sin esta tira, la capa de caravanas quedaba invisible salvo que
          supiera entrar a Recursos → Hacienda → Animales. */}
      <IndividualizationCard
        total={data.individualization?.total ?? totalHeadcount}
        identified={data.individualization?.identified ?? 0}
      />

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
