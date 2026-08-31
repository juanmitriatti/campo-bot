import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { apiRequest } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Sidebar from '../components/layout/Sidebar';
import BottomNav from '../components/layout/BottomNav';
import MoreSheet from '../components/layout/MoreSheet';
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
import FieldsTab from '../components/FieldsTab';
import RemindersTab from '../components/RemindersTab';
import PaywallModal from '../components/billing/PaywallModal';
import { fetchSubscription, type SubscriptionStatus } from '../api/subscription';
import type { DashboardView } from '../components/layout/nav-model';

const viewFeatureMap: Record<DashboardView, string | null> = {
  overview: null,
  fields: null,
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
  reminders: null,
  account: null,
};

export default function Dashboard() {
  const { user, features } = useAuth();
  const location = useLocation();
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
  // Mobile "Más" sheet — the other 9 destinations that no longer fit (and never
  // fitted) in the bottom bar.
  const [moreOpen, setMoreOpen] = useState(false);
  // Observaciones is a sub-tab of Actividades now, not its own nav destination.
  const [activityTab, setActivityTab] = useState<'activities' | 'observations'>('activities');
  // Estado de suscripción: decide el paywall de prueba vencida. null = todavía
  // no sabemos → NO bloqueamos (un fetch lento no puede parecer un vencimiento).
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);

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
    // FIX M2: navegar desde /chat con { state: { view: 'account' } } abre la vista correcta.
    else if ((location.state as { view?: string } | null)?.view === 'account') setView('account');
    void refreshChannelStatus();
    fetchSubscription().then(setSub).catch(() => setSub(null));
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

  /**
   * "Para revisar" → the row that needs fixing. Activities and expenses can be
   * highlighted in place; a plot or a field just opens the Campos tab, which is
   * where they are edited.
   */
  const handleOpenReviewRef = (ref: { type: 'activity' | 'expense' | 'plot' | 'field'; id: number }) => {
    if (ref.type === 'activity') {
      setActivityTab('activities');
      setHighlight({ view: 'activities', id: ref.id });
      setView('activities');
      return;
    }
    if (ref.type === 'expense') {
      setHighlight({ view: 'expenses', id: ref.id });
      setView('expenses');
      return;
    }
    setView('fields');
  };

  // Once we navigate into the target view, consume the highlight after the
  // child table renders so it doesn't persist on next visit.
  const highlightForView = highlight?.view === view ? highlight.id : undefined;

  /**
   * Prueba vencida → el board queda borroso detrás de un modal de pago.
   *
   * "Mi cuenta" se exceptúa: ahí viven el checkout, exportar datos y eliminar
   * la cuenta. Bloquear eso también dejaría al usuario encerrado sin forma de
   * pagar ni de llevarse lo suyo. Y si los pagos están apagados
   * (`payments_enabled=false`) no hay nada que ofrecer: no lo encerramos.
   */
  const paywalled = Boolean(
    sub && sub.access_mode === 'trial_expired_readonly' && sub.payments_enabled && view !== 'account',
  );

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
            onGoToFields={() => setView('fields')}
            onOpenReviewRef={handleOpenReviewRef}
          />
        );
      case 'fields':
        return <FieldsTab />;
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
      // Actividades y Observaciones comparten destino: para quien le dicta al
      // bot, una observación ES un registro del lote. Eran dos tablas casi
      // iguales en dos lugares distintos del menú.
      case 'activities':
      case 'observations': {
        const tab = view === 'observations' ? 'observations' : activityTab;
        const tabs: Array<{ key: 'activities' | 'observations'; label: string }> = [
          { key: 'activities', label: 'Actividades' },
          { key: 'observations', label: 'Observaciones' },
        ];
        return (
          <div>
            <div className="flex items-center gap-1 border-b border-gray-200 dark:border-gray-700 mb-4">
              {tabs.map(t => {
                const isActive = t.key === tab;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => { setActivityTab(t.key); if (view === 'observations') setView('activities'); }}
                    aria-current={isActive ? 'page' : undefined}
                    className={`px-3 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
                      isActive
                        ? 'border-campo-600 text-campo-700 dark:text-campo-400'
                        : 'border-transparent text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-gray-100'
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
              {tab === 'activities'
                ? <ActivityTable highlightId={highlightForView} />
                : <ObservationTable />}
            </div>
          </div>
        );
      }
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
      case 'reminders':
        return <RemindersTab />;
      case 'account':
        return <ChannelLinking />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <Navbar onUserClick={() => setView('account')} />

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

      <div
        className={`flex ${paywalled ? 'blur-sm pointer-events-none select-none' : ''}`}
        aria-hidden={paywalled}
      >
        <Sidebar active={view} onChange={setView} features={features} />

        <main className="flex-1 min-w-0 px-4 md:px-8 py-6 pb-20 md:pb-6">
          {renderContent()}
        </main>
      </div>

      {paywalled && sub && (
        <PaywallModal status={sub} onGoToAccount={() => { setMoreOpen(false); setView('account'); }} />
      )}

      {/* Con el paywall arriba, la barra inferior no se renderiza: navega a
          vistas bloqueadas y en mobile compite por el z-index con el modal. */}
      {!paywalled && (
        <>
          <BottomNav
            active={view}
            onChange={v => { setMoreOpen(false); setView(v); }}
            features={features}
            moreOpen={moreOpen}
            onOpenMore={() => setMoreOpen(true)}
          />

          <MoreSheet
            open={moreOpen}
            active={view}
            features={features}
            onSelect={setView}
            onClose={() => setMoreOpen(false)}
          />
        </>
      )}
    </div>
  );
}
