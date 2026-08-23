import { Calendar } from 'lucide-react';
import type { CampaignRef } from '../../hooks/useOverviewData';

interface Props {
  campaigns: CampaignRef[];
  /** null = the current campaign, resolved server-side. */
  value: number | null;
  currentLabel: string;
  onChange: (seasonYear: number | null) => void;
}

/**
 * Campaign selector. The list comes from the server so the frontend never has
 * to know where a campaign starts — that definition lives in
 * utils/campaign-range.ts and is shared with the agronomic reports.
 */
export default function CampaignPicker({ campaigns, value, currentLabel, onChange }: Props) {
  if (campaigns.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        <Calendar className="w-3.5 h-3.5" />
        Campaña {currentLabel}
      </span>
    );
  }

  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
      <Calendar className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">Campaña</span>
      <select
        value={value ?? campaigns[0].seasonYear}
        onChange={e => {
          const n = parseInt(e.target.value, 10);
          onChange(n === campaigns[0].seasonYear ? null : n);
        }}
        className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 min-h-[36px] text-xs font-medium text-gray-700 dark:text-gray-200 focus:outline-none focus:border-campo-500 focus:ring-1 focus:ring-campo-500"
      >
        {campaigns.map(c => (
          <option key={c.seasonYear} value={c.seasonYear}>
            Campaña {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}
