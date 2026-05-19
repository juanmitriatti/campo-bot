import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useOverviewTab } from '../../hooks/useOverviewTab';
import { useUserFields } from '../../hooks/useUserFields';
import { useSelectedField } from '../../hooks/useSelectedField';
import { useDashboardData } from '../../hooks/useDashboardData';
import OverviewTabs from './OverviewTabs';
import OverviewSummaryView from './OverviewSummaryView';
import OverviewAgronomicView from './OverviewAgronomicView';
import OverviewLivestockView from './OverviewLivestockView';
import FieldSelector from './FieldSelector';
import SubscriptionBanner from './SubscriptionBanner';
import EmailVerifyBanner from './EmailVerifyBanner';
import AlertsBanner from './AlertsBanner';

interface OverviewPageProps {
  onGoToAccount?: () => void;
  onRecentItemClick?: (type: 'expense' | 'income' | 'activity', id: number) => void;
  onGoToStock?: (opts: { lowStockOnly: boolean }) => void;
  onGoToLivestock?: () => void;
}

export default function OverviewPage({
  onGoToAccount,
  onRecentItemClick,
  onGoToStock,
  onGoToLivestock,
}: OverviewPageProps = {}) {
  const { features } = useAuth();
  const [tab, setTab] = useOverviewTab();
  const { fields, loading: fieldsLoading } = useUserFields();
  const [fieldId, setFieldId] = useSelectedField();
  const { data: dashData } = useDashboardData(fieldId);

  const showAgronomic = features.includes('agronomy');
  const showLivestock = features.includes('livestock');

  // If user lands on a tab they can't access, silently rewrite to Resumen
  useEffect(() => {
    if (tab === 'agronomico' && !showAgronomic) setTab('resumen');
    if (tab === 'ganadero' && !showLivestock) setTab('resumen');
  }, [tab, showAgronomic, showLivestock, setTab]);

  // Default: first field alphabetically when fields finish loading and no field is selected
  // (or the URL pointed to a field the user no longer has access to).
  useEffect(() => {
    if (fieldsLoading || fields.length === 0) return;
    const validIds = new Set(fields.map(f => f.id));
    if (fieldId == null || !validIds.has(fieldId)) {
      setFieldId(fields[0].id);
    }
  }, [fieldsLoading, fields, fieldId, setFieldId]);

  const reload = () => window.location.reload();

  return (
    <div className="space-y-6">
      <AlertsBanner
        stockAlerts={dashData?.stock_alerts_count}
        livestockTotal={dashData?.livestock_total}
        onStockClick={onGoToStock ? () => onGoToStock({ lowStockOnly: true }) : undefined}
        onLivestockClick={onGoToLivestock}
      />

      <EmailVerifyBanner />
      <SubscriptionBanner onGoToAccount={onGoToAccount ?? (() => {})} />

      {!fieldsLoading && fields.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800 text-sm">
          Aún no tenés campos cargados. Creá tu primer campo para ver el dashboard.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-4 flex-wrap">
              <OverviewTabs active={tab} onChange={setTab} showAgronomic={showAgronomic} showLivestock={showLivestock} />
              <FieldSelector fields={fields} value={fieldId} onChange={setFieldId} />
            </div>
            <button
              onClick={reload}
              className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-800 border border-gray-200 bg-white rounded-md px-3 py-1.5 transition-colors hover:bg-gray-50"
              title="Recargar datos"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Actualizar
            </button>
          </div>

          {tab === 'resumen' && <OverviewSummaryView fieldId={fieldId} onRecentItemClick={onRecentItemClick} />}
          {tab === 'agronomico' && showAgronomic && <OverviewAgronomicView fieldId={fieldId} />}
          {tab === 'ganadero' && showLivestock && <OverviewLivestockView fieldId={fieldId} />}
        </>
      )}
    </div>
  );
}
