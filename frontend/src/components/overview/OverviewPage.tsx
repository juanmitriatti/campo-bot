import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useCurrency } from '../../context/CurrencyContext';
import { useOverviewTab } from '../../hooks/useOverviewTab';
import { useUserFields } from '../../hooks/useUserFields';
import { useSelectedField } from '../../hooks/useSelectedField';
import { useSelectedCampaign } from '../../hooks/useSelectedCampaign';
import { useOverviewData } from '../../hooks/useOverviewData';
import OverviewTabs from './OverviewTabs';
import OverviewSummaryView from './OverviewSummaryView';
import OverviewAgronomicView from './OverviewAgronomicView';
import OverviewLivestockView from './OverviewLivestockView';
import SubscriptionBanner from './SubscriptionBanner';
import EmailVerifyBanner from './EmailVerifyBanner';
import AlertsBanner from './AlertsBanner';
import FieldChips from './FieldChips';
import CampaignPicker from './CampaignPicker';
import type { Finding } from '../../hooks/useReviewFindings';

interface OverviewPageProps {
  onGoToAccount?: () => void;
  onRecentItemClick?: (type: 'expense' | 'income' | 'activity', id: number) => void;
  onGoToStock?: (opts: { lowStockOnly: boolean }) => void;
  onGoToLivestock?: () => void;
  onGoToActivities?: () => void;
  onGoToFields?: () => void;
  onOpenReviewRef?: (ref: NonNullable<Finding['ref']>) => void;
}

export default function OverviewPage({
  onGoToAccount,
  onRecentItemClick,
  onGoToStock,
  onGoToLivestock,
  onGoToActivities,
  onGoToFields,
  onOpenReviewRef,
}: OverviewPageProps = {}) {
  const { features, user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { currency, setCurrency } = useCurrency();
  const [tab, setTab] = useOverviewTab();
  const { fields, loading: fieldsLoading } = useUserFields();
  const [fieldId, setFieldId] = useSelectedField();
  const [season, setSeason] = useSelectedCampaign();
  const { data, loading, refresh } = useOverviewData(fieldId, season);

  const showAgronomic = features.includes('agronomy');
  const showLivestock = features.includes('livestock');

  // If user lands on a tab they can't access, silently rewrite to Resumen
  useEffect(() => {
    if (tab === 'agronomico' && !showAgronomic) setTab('resumen');
    if (tab === 'ganadero' && !showLivestock) setTab('resumen');
  }, [tab, showAgronomic, showLivestock, setTab]);

  // Default selection = "Todos los campos" (`null`). We never auto-pick a
  // specific field on first load — the user sees the aggregated view by
  // default. Only intervene if the URL points to a field they lost access to.
  useEffect(() => {
    if (fieldsLoading || fields.length === 0) return;
    if (fieldId == null) return;
    const validIds = new Set(fields.map(f => f.id));
    if (!validIds.has(fieldId)) setFieldId(fields[0].id);
  }, [fieldsLoading, fields, fieldId, setFieldId]);

  return (
    <div className="space-y-4">
      <AlertsBanner
        stockAlerts={data?.counts.stockAlerts}
        livestockTotal={data?.counts.livestock}
        onStockClick={onGoToStock ? () => onGoToStock({ lowStockOnly: true }) : undefined}
        onLivestockClick={onGoToLivestock}
      />

      <EmailVerifyBanner />
      <SubscriptionBanner onGoToAccount={onGoToAccount ?? (() => {})} />

      {!fieldsLoading && fields.length === 0 ? (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-xl p-6 text-amber-800 dark:text-amber-300">
          <h2 className="text-lg font-semibold mb-1">Bienvenido a Campo Bot 👋</h2>
          <p className="text-sm mb-3">
            Para empezar a ver tu dashboard, creá tu primer campo. Probá escribirle al bot algo como:
          </p>
          <pre className="bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2 text-xs font-mono text-gray-700 dark:text-gray-200 mb-4 whitespace-pre-wrap">
agregar campo La Esperanza en Pergamino con lotes 1A, 1B y 1C
          </pre>
          {isAdmin ? (
            <a
              href="/chat"
              className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white font-medium text-sm rounded-md px-4 py-2 transition-colors"
            >
              Abrir chat de prueba →
            </a>
          ) : (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Escribile al bot por WhatsApp o Telegram:{' '}
              <span className="font-mono bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-800 rounded px-1.5 py-0.5 text-xs text-gray-700 dark:text-gray-200">
                "tengo el campo La Esperanza en Pergamino"
              </span>
            </p>
          )}
        </div>
      ) : (
        <>
          <OverviewTabs active={tab} onChange={setTab} showAgronomic={showAgronomic} showLivestock={showLivestock} />

          {/* The field filter lives here, with the content it filters — not in
              the sidebar, which is hidden on mobile. */}
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <FieldChips fields={fields} value={fieldId} onChange={setFieldId} />

            <div className="flex items-center gap-2 shrink-0">
              <CampaignPicker
                campaigns={data?.campaigns ?? []}
                value={season}
                currentLabel={data?.campaign.label ?? ''}
                onChange={setSeason}
              />
              <div
                className="inline-flex rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden bg-white dark:bg-gray-800 text-xs font-semibold"
                title="Moneda mostrada en el detalle por lote y por categoría"
              >
                {(['ARS', 'USD'] as const).map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCurrency(c)}
                    aria-pressed={c === currency}
                    className={`px-2.5 py-1.5 min-h-[36px] transition-colors ${
                      c === currency
                        ? 'bg-campo-600 text-white'
                        : 'text-gray-500 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <button
                onClick={refresh}
                disabled={loading}
                className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-800 border border-gray-200 bg-white rounded-md px-3 py-1.5 min-h-[36px] transition-colors hover:bg-gray-50 disabled:opacity-50 dark:text-gray-300 dark:hover:text-white dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
                title="Volver a pedir los datos"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                Actualizar
              </button>
            </div>
          </div>

          {tab === 'resumen' && (
            <OverviewSummaryView
              fieldId={fieldId}
              season={season}
              onRecentItemClick={onRecentItemClick}
              onSeeAllActivities={onGoToActivities}
              onGoToFields={onGoToFields}
              onOpenReviewRef={onOpenReviewRef}
            />
          )}
          {tab === 'agronomico' && showAgronomic && <OverviewAgronomicView fieldId={fieldId} />}
          {tab === 'ganadero' && showLivestock && <OverviewLivestockView fieldId={fieldId} />}
        </>
      )}
    </div>
  );
}
