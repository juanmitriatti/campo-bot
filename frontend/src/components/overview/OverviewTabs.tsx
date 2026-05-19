import type { OverviewTab } from '../../hooks/useOverviewTab';

interface TabSpec {
  key: OverviewTab;
  label: string;
}

interface Props {
  active: OverviewTab;
  onChange: (tab: OverviewTab) => void;
  showAgronomic: boolean;
  showLivestock: boolean;
}

export default function OverviewTabs({ active, onChange, showAgronomic, showLivestock }: Props) {
  const tabs: TabSpec[] = [{ key: 'resumen', label: 'Resumen' }];
  if (showAgronomic) tabs.push({ key: 'agronomico', label: 'Agronómico' });
  if (showLivestock) tabs.push({ key: 'ganadero', label: 'Ganadero' });

  return (
    <div className="flex items-center gap-1 border-b border-gray-200 dark:border-gray-700">
      {tabs.map(t => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'px-3 py-2 text-sm font-medium transition-colors -mb-px',
              isActive
                ? 'border-b-2 border-campo-600 text-campo-700 dark:text-campo-400'
                : 'border-b-2 border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100',
            ].join(' ')}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
