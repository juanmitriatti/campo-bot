import { useEffect } from 'react';
import { useSelectedField } from '../../hooks/useSelectedField';
import { useSelectedCampaign } from '../../hooks/useSelectedCampaign';
import { useOverviewData } from '../../hooks/useOverviewData';
import { sheetGroups, type DashboardView, type NavItem } from './nav-model';

interface Props {
  open: boolean;
  active: DashboardView;
  features: string[];
  onSelect: (view: DashboardView) => void;
  onClose: () => void;
}

/**
 * The mobile "Más" sheet — everything the four-tab bar doesn't show, grouped
 * exactly like the sidebar so the two navigations teach the same map.
 */
export default function MoreSheet({ open, active, features, onSelect, onClose }: Props) {
  const [fieldId] = useSelectedField();
  const [season] = useSelectedCampaign();
  const { data } = useOverviewData(fieldId, season);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Don't let the page behind scroll while the sheet is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const counts = data?.counts;
  const groups = sheetGroups(features);

  const badge = (item: NavItem) => (item.count && counts ? String(counts[item.count]) : null);

  return (
    <div className="md:hidden fixed inset-0 z-[60] flex items-end" role="dialog" aria-modal="true" aria-label="Más secciones">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        className="absolute inset-0 bg-gray-900/50"
      />
      <div className="relative w-full max-h-[80vh] overflow-y-auto bg-white dark:bg-gray-800 rounded-t-2xl px-4 pt-2 pb-8 shadow-2xl">
        <div className="w-9 h-1 rounded-full bg-gray-200 dark:bg-gray-600 mx-auto mb-3" />
        <div className="flex items-center justify-between gap-3 mb-1">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Todo lo demás</h2>
          <button
            onClick={onClose}
            className="text-sm font-semibold text-campo-700 dark:text-campo-400 min-h-[44px] px-2"
          >
            Cerrar
          </button>
        </div>

        {groups.map(group => (
          <div key={group.id} className="mt-3">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400 dark:text-gray-500 mb-1">
              {group.label}
            </p>
            {group.items.map(item => {
              const Icon = item.Icon;
              const value = badge(item);
              const isActive = active === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => { onSelect(item.key); onClose(); }}
                  className={`flex items-center gap-3 w-full min-h-[52px] px-1 border-b border-gray-100 dark:border-gray-700 text-left ${
                    isActive ? 'text-campo-700 dark:text-campo-400 font-semibold' : 'text-gray-700 dark:text-gray-200'
                  }`}
                >
                  <Icon className="w-[18px] h-[18px] shrink-0 text-gray-400 dark:text-gray-500" />
                  <span className="flex-1 text-sm">{item.label}</span>
                  {value !== null && (
                    <span className={`font-mono text-[11px] tabular-nums ${
                      value === '0' ? 'text-gray-300 dark:text-gray-600' : 'text-gray-400 dark:text-gray-500'
                    }`}>
                      {value}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
