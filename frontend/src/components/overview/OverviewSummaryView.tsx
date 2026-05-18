import { Wallet, DollarSign, TrendingUp, TrendingDown, Sprout } from 'lucide-react';
import { useDashboardData } from '../../hooks/useDashboardData';
import { useAnalyticsData } from '../../hooks/useAnalyticsData';
import KpiCard from './KpiCard';
import RentabilidadPorLoteChart from './charts/RentabilidadPorLoteChart';
import CategoryDonutChart from './CategoryDonutChart';
import RecentFeed from './RecentFeed';
import AlertsBanner from './AlertsBanner';
import FieldMap from './FieldMap';

interface Props {
  fieldId: number | null;
  onRecentItemClick?: (type: 'expense' | 'income' | 'activity', id: number) => void;
}

export default function OverviewSummaryView({ fieldId, onRecentItemClick }: Props) {
  const { data, loading: dashLoading, error: dashError, refresh: dashRefresh } = useDashboardData(fieldId);
  const analytics = useAnalyticsData(fieldId);

  if (dashLoading || analytics.loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (dashError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
        {dashError}
        <button onClick={dashRefresh} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  if (!data) return null;

  const expMap = data.expenses_month ?? { ARS: data.expenses_month_ars, USD: 0 };
  const expPrev = data.expenses_prev_month ?? { ARS: data.expenses_prev_month_ars, USD: 0 };
  const incMap = data.incomes_month ?? { ARS: data.incomes_month_ars, USD: 0 };
  const incPrev = data.incomes_prev_month ?? { ARS: data.incomes_prev_month_ars, USD: 0 };

  const expRows = analytics.data?.expenseBreakdown ?? [];
  const arsRows = expRows.filter(r => r.currency === 'ARS');
  const totalArs = arsRows.reduce((s, r) => s + r.total, 0);
  const generalArs = arsRows.filter(r => r.plotId == null).reduce((s, r) => s + r.total, 0);
  const pctGeneral = totalArs > 0 ? Math.round((generalArs / totalArs) * 100) : 0;

  const resultMap = {
    ARS: { current: incMap.ARS - expMap.ARS, prev: incPrev.ARS - expPrev.ARS },
    USD: { current: incMap.USD - expMap.USD, prev: incPrev.USD - expPrev.USD },
  };
  const resultPrimary = Math.abs(resultMap.USD.current) > Math.abs(resultMap.ARS.current) ? resultMap.USD.current : resultMap.ARS.current;
  const resultPositive = resultPrimary >= 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard
          label="Gastos del mes"
          currencies={{ ARS: { current: expMap.ARS, prev: expPrev.ARS }, USD: { current: expMap.USD, prev: expPrev.USD } }}
          tint="bg-red-50" Icon={Wallet} iconColor="text-red-500"
        />
        <KpiCard
          label="Ingresos del mes"
          currencies={{ ARS: { current: incMap.ARS, prev: incPrev.ARS }, USD: { current: incMap.USD, prev: incPrev.USD } }}
          tint="bg-green-50" Icon={DollarSign} iconColor="text-green-600"
        />
        <KpiCard
          label="Resultado" currencies={resultMap} mode="dual"
          tint={resultPositive ? 'bg-green-50' : 'bg-red-50'}
          Icon={resultPositive ? TrendingUp : TrendingDown}
          iconColor={resultPositive ? 'text-green-600' : 'text-red-500'}
        />
        <KpiCard label="Actividades" value={String(data.activities_month_count)} tint="bg-campo-50" Icon={Sprout} iconColor="text-campo-600" />
        <KpiCard label="Gastos sin lote" value={`${pctGeneral}%`} tint="bg-amber-50" Icon={Wallet} iconColor="text-amber-600" />
      </div>

      {analytics.data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <CategoryDonutChart title="Gastos por categoría (mes actual)" data={analytics.data.expenseBreakdown} emptyText="Sin gastos este mes" />
          <CategoryDonutChart title="Ingresos por categoría (mes actual)" data={analytics.data.incomeBreakdown} emptyText="Sin ingresos este mes" />
        </div>
      )}

      <FieldMap />

      {analytics.data && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-4">
            <RecentFeed items={data.recent_items} onItemClick={onRecentItemClick} />
          </div>
          <div className="lg:col-span-8">
            <RentabilidadPorLoteChart
              expenses={analytics.data.expenseBreakdown}
              incomes={analytics.data.incomeBreakdown}
            />
          </div>
        </div>
      )}

      <AlertsBanner stockAlerts={data.stock_alerts_count} livestockTotal={data.livestock_total} />
    </div>
  );
}
