import { useDashboardData } from '../../hooks/useDashboardData';
import { useAnalyticsData } from '../../hooks/useAnalyticsData';
import KpiCard from './KpiCard';
import SparklineBar from './SparklineBar';
import MonthlyTrendChart from './MonthlyTrendChart';
import ExpensePieChart from './ExpensePieChart';
import QuickActions from './QuickActions';
import RecentFeed from './RecentFeed';
import AlertsBanner from './AlertsBanner';
import FieldMap from './FieldMap';

function formatArs(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${new Intl.NumberFormat('es-AR').format(n)}`;
}

function calcDelta(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? 100 : null;
  return ((current - previous) / previous) * 100;
}

export default function OverviewPage() {
  const { data, loading, error, refresh } = useDashboardData();
  const analytics = useAnalyticsData();

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

  const resultado = data.incomes_month_ars - data.expenses_month_ars;
  const resultadoPrev = data.incomes_prev_month_ars - data.expenses_prev_month_ars;

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="flex flex-col gap-3">
          <KpiCard
            label="Gastos del mes"
            value={formatArs(data.expenses_month_ars)}
            delta={calcDelta(data.expenses_month_ars, data.expenses_prev_month_ars)}
            tint="bg-red-50"
            icon="💸"
          />
          <SparklineBar
            current={data.expenses_month_ars}
            previous={data.expenses_prev_month_ars}
            color="bg-red-400"
          />
        </div>
        <div className="flex flex-col gap-3">
          <KpiCard
            label="Ingresos del mes"
            value={formatArs(data.incomes_month_ars)}
            delta={calcDelta(data.incomes_month_ars, data.incomes_prev_month_ars)}
            tint="bg-green-50"
            icon="💵"
          />
          <SparklineBar
            current={data.incomes_month_ars}
            previous={data.incomes_prev_month_ars}
            color="bg-green-400"
          />
        </div>
        <KpiCard
          label="Resultado"
          value={formatArs(resultado)}
          delta={calcDelta(resultado, resultadoPrev)}
          tint={resultado >= 0 ? 'bg-green-50' : 'bg-red-50'}
          icon={resultado >= 0 ? '📈' : '📉'}
        />
        <KpiCard
          label="Actividades"
          value={String(data.activities_month_count)}
          tint="bg-campo-50"
          icon="🌱"
        />
      </div>

      {/* Charts */}
      {analytics.data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <MonthlyTrendChart data={analytics.data.monthlyTrend} />
          <ExpensePieChart data={analytics.data.expenseCategories} />
        </div>
      )}

      {/* Map */}
      <FieldMap />

      {/* Quick Actions */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Acciones rapidas</h3>
        <QuickActions />
      </div>

      {/* Recent Feed */}
      <RecentFeed items={data.recent_items} />

      {/* Alerts */}
      <AlertsBanner
        stockAlerts={data.stock_alerts_count}
        livestockTotal={data.livestock_total}
      />
    </div>
  );
}
