import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Sidebar from '../components/layout/Sidebar';
import BottomNav from '../components/layout/BottomNav';
import OverviewPage from '../components/overview/OverviewPage';
import ObservationTable from '../components/ObservationTable';
import ScoutingTable from '../components/ScoutingTable';
import ActivityTable from '../components/ActivityTable';
import ExpenseTable from '../components/ExpenseTable';
import IncomeTable from '../components/IncomeTable';
import ReportTable from '../components/ReportTable';
import StockTable from '../components/StockTable';
import LivestockTab from '../components/LivestockTab';
import DocumentsTable from '../components/DocumentsTable';
import HarvestLoadsTable from '../components/HarvestLoadsTable';
import ChannelLinking from '../components/ChannelLinking';
import type { DashboardView } from '../components/layout/Sidebar';

const viewFeatureMap: Record<DashboardView, string | null> = {
  overview: null,
  expenses: 'expenses',
  incomes: 'incomes',
  activities: 'agronomy',
  observations: 'agronomy',
  scoutings: 'agronomy',
  reports: 'agronomy',
  harvests: 'agronomy',
  stock: 'stock',
  livestock: 'livestock',
  documents: 'documents',
  account: null,
};

export default function Dashboard() {
  const { user, features } = useAuth();
  const [view, setView] = useState<DashboardView>('overview');
  // When the user clicks a row in the overview "Actividad reciente" feed,
  // we remember which row to scroll-to + highlight in the target table.
  const [highlight, setHighlight] = useState<{ view: DashboardView; id: number } | null>(null);
  // When the user clicks the "stock bajo" alert in the overview banner,
  // open the Stock tab with the low-stock filter pre-checked.
  const [stockLowStockOnly, setStockLowStockOnly] = useState(false);

  useEffect(() => {
    const required = viewFeatureMap[view];
    if (required && !features.includes(required)) {
      setView('overview');
    }
  }, [view, features]);

  const handleRecentItemClick = (type: 'expense' | 'income' | 'activity', id: number) => {
    const target: DashboardView = type === 'expense' ? 'expenses' : type === 'income' ? 'incomes' : 'activities';
    setHighlight({ view: target, id });
    setView(target);
  };

  const handleGoToStock = ({ lowStockOnly }: { lowStockOnly: boolean }) => {
    setStockLowStockOnly(lowStockOnly);
    setView('stock');
  };

  const handleGoToLivestock = () => {
    setStockLowStockOnly(false);
    setView('livestock');
  };

  // Once we navigate into the target view, consume the highlight after the
  // child table renders so it doesn't persist on next visit.
  const highlightForView = highlight?.view === view ? highlight.id : undefined;

  if (!user) return null;

  const renderContent = () => {
    switch (view) {
      case 'overview':
        return (
          <OverviewPage
            onGoToAccount={() => setView('account')}
            onRecentItemClick={handleRecentItemClick}
            onGoToStock={handleGoToStock}
            onGoToLivestock={handleGoToLivestock}
          />
        );
      case 'expenses':
        return (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <ExpenseTable highlightId={highlightForView} />
          </div>
        );
      case 'incomes':
        return (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <IncomeTable highlightId={highlightForView} />
          </div>
        );
      case 'activities':
        return (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <ActivityTable highlightId={highlightForView} />
          </div>
        );
      case 'observations':
        return (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <ObservationTable />
          </div>
        );
      case 'scoutings':
        return (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <ScoutingTable />
          </div>
        );
      case 'reports':
        return (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <ReportTable />
          </div>
        );
      case 'stock':
        return (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <StockTable initialLowStockOnly={stockLowStockOnly} />
          </div>
        );
      case 'livestock':
        return <LivestockTab />;
      case 'documents':
        return (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <DocumentsTable />
          </div>
        );
      case 'harvests':
        return (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <HarvestLoadsTable />
          </div>
        );
      case 'account':
        return <ChannelLinking />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <Navbar />

      <div className="flex">
        <Sidebar active={view} onChange={setView} features={features} />

        <main className="flex-1 min-w-0 px-4 md:px-8 py-6 pb-20 md:pb-6">
          {renderContent()}
        </main>
      </div>

      <BottomNav active={view} onChange={setView} features={features} />
    </div>
  );
}
