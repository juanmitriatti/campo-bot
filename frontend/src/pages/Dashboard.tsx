import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Sidebar from '../components/layout/Sidebar';
import BottomNav from '../components/layout/BottomNav';
import OverviewPage from '../components/overview/OverviewPage';
import ObservationTable from '../components/ObservationTable';
import ActivityTable from '../components/ActivityTable';
import ExpenseTable from '../components/ExpenseTable';
import IncomeTable from '../components/IncomeTable';
import StockTable from '../components/StockTable';
import LivestockTab from '../components/LivestockTab';
import type { DashboardView } from '../components/layout/Sidebar';

export default function Dashboard() {
  const { user, features } = useAuth();
  const [view, setView] = useState<DashboardView>('overview');

  if (!user) return null;

  const renderContent = () => {
    switch (view) {
      case 'overview':
        return <OverviewPage />;
      case 'expenses':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <ExpenseTable />
          </div>
        );
      case 'incomes':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <IncomeTable />
          </div>
        );
      case 'activities':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <ActivityTable />
          </div>
        );
      case 'observations':
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <ObservationTable />
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
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />

      <div className="flex">
        <Sidebar active={view} onChange={setView} features={features} />

        <main className="flex-1 px-4 md:px-8 py-6 pb-20 md:pb-6 max-w-6xl">
          {renderContent()}
        </main>
      </div>

      <BottomNav active={view} onChange={setView} />
    </div>
  );
}
