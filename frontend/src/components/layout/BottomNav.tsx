import { BOTTOM_TABS, MORE_TAB, sheetGroups, visible, type DashboardView } from './nav-model';

interface BottomNavProps {
  active: DashboardView;
  onChange: (view: DashboardView) => void;
  features: string[];
  moreOpen: boolean;
  onOpenMore: () => void;
}

/**
 * Four destinations, not thirteen.
 *
 * The previous bar rendered every nav item in `justify-around` on a 56px bar:
 * on a 390px phone that is ~30px per tab, below the 44px minimum touch target,
 * with 7px labels. Everything else moved into the "Más" sheet.
 */
export default function BottomNav({ active, onChange, features, moreOpen, onOpenMore }: BottomNavProps) {
  const tabs = BOTTOM_TABS.filter(t => visible(t, features));
  // Whatever is on screen but not one of the tabs still needs to light something
  // up — otherwise the bar looks like nothing is selected.
  const inSheet = sheetGroups(features).some(g => g.items.some(i => i.key === active));

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 shadow-lg z-50 pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-stretch">
        {tabs.map(tab => {
          const Icon = tab.Icon;
          const isActive = !moreOpen && active === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => onChange(tab.key)}
              aria-current={isActive ? 'page' : undefined}
              className={`flex-1 flex flex-col items-center justify-center gap-1 min-h-[56px] transition-colors ${
                isActive ? 'text-campo-700 dark:text-campo-400' : 'text-gray-400 dark:text-gray-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10.5px] font-semibold leading-none">{tab.label}</span>
            </button>
          );
        })}
        <button
          onClick={onOpenMore}
          aria-expanded={moreOpen}
          className={`flex-1 flex flex-col items-center justify-center gap-1 min-h-[56px] transition-colors ${
            moreOpen || inSheet ? 'text-campo-700 dark:text-campo-400' : 'text-gray-400 dark:text-gray-400'
          }`}
        >
          <MORE_TAB.Icon className="w-5 h-5" />
          <span className="text-[10.5px] font-semibold leading-none">{MORE_TAB.label}</span>
        </button>
      </div>
    </nav>
  );
}
