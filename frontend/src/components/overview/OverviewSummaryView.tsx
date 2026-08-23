import { useMemo } from 'react';
import { useCurrency } from '../../context/CurrencyContext';
import { useOverviewData } from '../../hooks/useOverviewData';
import { useReviewFindings, type Finding } from '../../hooks/useReviewFindings';
import CampaignResult from './CampaignResult';
import ReviewPanel from './ReviewPanel';
import RainfallMonths from './RainfallMonths';
import PlotCards from './PlotCards';
import CategoryRanking from './CategoryRanking';
import CampaignFeed from './CampaignFeed';
import FieldMap from './FieldMap';
import SectionErrorBoundary from '../SectionErrorBoundary';

interface Props {
  fieldId: number | null;
  season: number | null;
  onRecentItemClick?: (type: 'expense' | 'income' | 'activity', id: number) => void;
  onSeeAllActivities?: () => void;
  onGoToFields?: () => void;
  onOpenReviewRef?: (ref: NonNullable<Finding['ref']>) => void;
}

export default function OverviewSummaryView({
  fieldId, season, onRecentItemClick, onSeeAllActivities, onGoToFields, onOpenReviewRef,
}: Props) {
  const { currency } = useCurrency();
  const { data, loading, error, refresh } = useOverviewData(fieldId, season);
  const review = useReviewFindings(fieldId, season);

  // Which plots / rows a finding points at, so the warning also shows up where
  // the user is looking rather than only inside the review card.
  const flaggedPlots = useMemo(() => {
    const s = new Set<number>();
    for (const f of review.findings) if (f.ref?.type === 'plot') s.add(f.ref.id);
    return s;
  }, [review.findings]);

  const flaggedRows = useMemo(() => {
    const s = new Set<string>();
    for (const f of review.findings) {
      if (f.ref?.type === 'activity') s.add(`activity:${f.ref.id}`);
      if (f.ref?.type === 'expense') s.add(`expense:${f.ref.id}`);
    }
    return s;
  }, [review.findings]);

  if (loading && !data) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-300 text-sm">
        {error}
        <button onClick={refresh} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  if (!data) return null;

  const topCategory = {
    ARS: data.categories.ARS[0] ?? null,
    USD: data.categories.USD[0] ?? null,
  };

  return (
    <div className="space-y-4">
      <CampaignResult
        money={data.money}
        topCategory={topCategory}
        observed={data.observed}
        campaignLabel={data.campaign.label}
      />

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3">
          <ReviewPanel
            findings={review.findings}
            hiddenCount={review.hiddenCount}
            loading={review.loading}
            onDismiss={review.dismiss}
            onRestoreAll={review.restoreAll}
            onOpen={ref => onOpenReviewRef?.(ref)}
          />
        </div>
        <div className="lg:col-span-2">
          <RainfallMonths
            total={data.rainfall.total}
            count={data.rainfall.count}
            months={data.rainfall.months}
          />
        </div>
      </div>

      <PlotCards
        plots={data.plots}
        currency={currency}
        flagged={flaggedPlots}
        onOpenPlot={onGoToFields ? () => onGoToFields() : undefined}
      />

      <div className="grid grid-cols-1 lg:grid-cols-9 gap-4">
        <div className="lg:col-span-5">
          <CategoryRanking rows={data.categories[currency]} currency={currency} />
        </div>
        <div className="lg:col-span-4">
          <CampaignFeed
            items={data.feed}
            activityCount={data.activities.count}
            flagged={flaggedRows}
            onItemClick={onRecentItemClick}
            onSeeAll={onSeeAllActivities}
          />
        </div>
      </div>

      <SectionErrorBoundary label="el mapa de campos">
        <FieldMap />
      </SectionErrorBoundary>
    </div>
  );
}
