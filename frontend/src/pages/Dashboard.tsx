import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';
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
import CategoriesTab from '../components/CategoriesTab';
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
  categories: null,
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
  // One-shot welcome toast after registering. Register page leaves a flag in
  // sessionStorage; we read it once on mount, show the message, then clear.
  const [welcomeEmail, setWelcomeEmail] = useState<string | null>(null);
  // Onboarding guiado (Jul 2026): el bot SOLO funciona por WhatsApp/Telegram
  // (REQUIRE_VERIFIED_CHANNEL) pero la vinculación vivía escondida en "Mi
  // cuenta" — el usuario se registraba, caía a un dashboard vacío y nadie le
  // decía el paso siguiente. true = sin ningún canal verificado.
  const [needsChannel, setNeedsChannel] = useState(false);

  const refreshChannelStatus = async () => {
    try {
      const s = await apiRequest<{ whatsapp_verified: boolean; telegram_verified: boolean }>('/verify/status');
      setNeedsChannel(!s.whatsapp_verified && !s.telegram_verified);
    } catch { /* sin señal: no mostramos el banner */ }
  };

  useEffect(() => {
    let postRegister = false;
    try {
      const flag = sessionStorage.getItem('campo:postRegisterToast');
      if (flag) {
        postRegister = true;
        setWelcomeEmail(flag);
        sessionStorage.removeItem('campo:postRegisterToast');
      }
    } catch { /* ignore */ }
    // Recién registrado → directo al paso de conexión, no al dashboard vacío.
    if (postRegister) setView('account');
    void refreshChannelStatus();
  }, []);

  // Al salir de "Mi cuenta" re-chequeamos: si acaba de vincular, el banner
  // desaparece sin recargar la página.
  useEffect(() => {
    if (view !== 'account') void refreshChannelStatus();
  }, [view]);

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
            onGoToActivities={() => setView('activities')}
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
      case 'categories':
        return <CategoriesTab />;
      case 'account':
        return <ChannelLinking />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <Navbar />

      {welcomeEmail && (
        <div className="bg-campo-50 dark:bg-campo-900/30 border-b border-campo-200 dark:border-campo-800 text-campo-800 dark:text-campo-200 text-sm">
          <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
            <span>
              <span className="font-semibold">¡Bienvenido!</span> Te mandamos un email a <span className="font-mono">{welcomeEmail}</span> para verificar tu cuenta.
            </span>
            <button
              type="button"
              onClick={() => setWelcomeEmail(null)}
              className="text-campo-700 dark:text-campo-300 hover:text-campo-900 dark:hover:text-campo-100 transition-colors"
              aria-label="Cerrar"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {needsChannel && view !== 'account' && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-sm">
          <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
            <span>
              <span className="font-semibold">⚠️ Te falta un paso:</span> el asistente funciona por WhatsApp o Telegram y todavía no conectaste el tuyo.
            </span>
            <button
              type="button"
              onClick={() => setView('account')}
              className="shrink-0 px-3 py-1 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-medium transition-colors"
            >
              Conectar ahora
            </button>
          </div>
        </div>
      )}

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
