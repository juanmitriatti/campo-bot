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

  // Once we navigate into the target view, consume the highlight after the
  // child table renders so it doesn't persist on next visit.
  const highlightForView = highlight?.view === view ? highlight.id : undefined;

  if (!user) return null;

  const renderContent = () => {
    switch (view) {
      case 'overview':
        return <OverviewPage onGoToAccount={() => setView('account')} onRecentItemClick={handleRecentItemClick} />;
      case 'expenses':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <ExpenseTable highlightId={highlightForView} />
          </div>
        );
      case 'incomes':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <IncomeTable highlightId={highlightForView} />
          </div>
        );
      case 'activities':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <ActivityTable highlightId={highlightForView} />
          </div>
        );
      case 'observations':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <ObservationTable />
          </div>
        );
      case 'scoutings':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <ScoutingTable />
          </div>
        );
      case 'reports':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <ReportTable />
          </div>
        );
      case 'stock':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <StockTable />
          </div>
        );
      case 'livestock':
        return <LivestockTab />;
      case 'documents':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <DocumentsTable />
          </div>
        );
      case 'harvests':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <HarvestLoadsTable />
          </div>
        );
      case 'account':
        return <ChannelLinking />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
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
