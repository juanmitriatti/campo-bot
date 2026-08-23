import { useState } from 'react';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { useSelectedField } from '../../hooks/useSelectedField';
import { useSelectedCampaign } from '../../hooks/useSelectedCampaign';
import { useOverviewData } from '../../hooks/useOverviewData';
import { Bell, BellOff, BookOpen, ChevronRight } from 'lucide-react';
import { PRIMARY, GROUPS, FOOTER, visible, type DashboardView, type NavItem } from './nav-model';

export type { DashboardView } from './nav-model';

interface SidebarProps {
  active: DashboardView;
  onChange: (view: DashboardView) => void;
  features: string[];
}

export default function Sidebar({ active, onChange, features }: SidebarProps) {
  const { subscribed, loading, subscribe, unsubscribe } = usePushNotifications();
  const [fieldId] = useSelectedField();
  const [season] = useSelectedCampaign();
  // Shared with the Resumen — no extra request (see useOverviewData).
  const { data } = useOverviewData(fieldId, season);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const counts = data?.counts;
  const badge = (item: NavItem): string | null => {
    if (!item.count || !counts) return null;
    return String(counts[item.count]);
  };

  const renderItem = (item: NavItem) => {
    const Icon = item.Icon;
    const isActive = active === item.key;
    const value = badge(item);
    return (
      <button
        key={item.key}
        onClick={() => onChange(item.key)}
        aria-current={isActive ? 'page' : undefined}
        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left w-full ${
          isActive
            ? 'bg-campo-50 text-campo-700 dark:bg-campo-900/30 dark:text-campo-400 font-semibold'
            : 'text-gray-600 hover:bg-gray-50 hover:text-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white font-medium'
        }`}
      >
        <Icon className="w-[18px] h-[18px] shrink-0" />
        <span className="flex-1 truncate">{item.label}</span>
        {value !== null && (
          <span className={`font-mono text-[11px] tabular-nums ${
            value === '0' ? 'text-gray-300 dark:text-gray-600' : 'text-gray-400 dark:text-gray-500'
          }`}>
            {value}
          </span>
        )}
      </button>
    );
  };

  return (
    <aside className="hidden md:flex flex-col w-56 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 min-h-[calc(100vh-3.5rem)]">
      <nav className="flex flex-col gap-0.5 p-3">
        {renderItem(PRIMARY)}

        {GROUPS.map(group => {
          const items = group.items.filter(i => visible(i, features));
          if (items.length === 0) return null;
          const isCollapsed = collapsed[group.id];
          return (
            <div key={group.id} className="mt-3">
              <button
                type="button"
                onClick={() => setCollapsed(c => ({ ...c, [group.id]: !c[group.id] }))}
                aria-expanded={!isCollapsed}
                className="flex items-center gap-1.5 w-full px-3 pb-1 text-[10px] uppercase tracking-wider font-semibold text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <ChevronRight className={`w-3 h-3 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
                <span>{group.label}</span>
              </button>
              {!isCollapsed && (
                <div className="flex flex-col gap-0.5">{items.map(renderItem)}</div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="mt-auto p-3 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-0.5">
        {FOOTER.filter(i => visible(i, features)).map(renderItem)}
        <a
          href="/guia"
          target="_blank"
          rel="noopener"
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Todo lo que le podés decir al bot"
        >
          <BookOpen className="w-[18px] h-[18px] shrink-0" />
          <span>Guía de uso</span>
        </a>
        <button
          onClick={subscribed ? unsubscribe : subscribe}
          disabled={loading}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 text-left"
          title={subscribed ? 'Desactivar notificaciones' : 'Activar notificaciones'}
        >
          {subscribed ? <Bell className="w-[18px] h-[18px] shrink-0" /> : <BellOff className="w-[18px] h-[18px] shrink-0" />}
          <span className="truncate">{subscribed ? 'Notificaciones activas' : 'Activar notificaciones'}</span>
        </button>
      </div>
    </aside>
  );
}
