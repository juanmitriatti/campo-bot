import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useOverviewTab } from '../../hooks/useOverviewTab';
import OverviewTabs from './OverviewTabs';
import OverviewSummaryView from './OverviewSummaryView';
import OverviewAgronomicView from './OverviewAgronomicView';
import SubscriptionBanner from './SubscriptionBanner';
import EmailVerifyBanner from './EmailVerifyBanner';

interface OverviewPageProps {
  onGoToAccount?: () => void;
  onRecentItemClick?: (type: 'expense' | 'income' | 'activity', id: number) => void;
}

export default function OverviewPage({ onGoToAccount, onRecentItemClick }: OverviewPageProps = {}) {
  const { features } = useAuth();
  const [tab, setTab] = useOverviewTab();

  const showAgronomic = features.includes('agronomy');
  const showLivestock = features.includes('livestock');

  // If user lands on a tab they can't access, silently rewrite to Resumen
  useEffect(() => {
    if (tab === 'agronomico' && !showAgronomic) setTab('resumen');
    if (tab === 'ganadero' && !showLivestock) setTab('resumen');
  }, [tab, showAgronomic, showLivestock, setTab]);

  // Plain page reload — re-fetches whichever hooks the active view uses.
  const reload = () => window.location.reload();

  return (
    <div className="space-y-6">
      <EmailVerifyBanner />
      <SubscriptionBanner onGoToAccount={onGoToAccount ?? (() => {})} />

      <div className="flex items-center justify-between flex-wrap gap-2">
        <OverviewTabs active={tab} onChange={setTab} showAgronomic={showAgronomic} showLivestock={showLivestock} />
        <button
          onClick={reload}
          className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-800 border border-gray-200 bg-white rounded-md px-3 py-1.5 transition-colors hover:bg-gray-50"
          title="Recargar datos"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Actualizar
        </button>
      </div>

      {tab === 'resumen' && <OverviewSummaryView onRecentItemClick={onRecentItemClick} />}
      {tab === 'agronomico' && showAgronomic && <OverviewAgronomicView />}
      {tab === 'ganadero' && showLivestock && <div className="text-sm text-gray-500 py-8 text-center">Dashboard ganadero — próximamente</div>}
    </div>
  );
}
