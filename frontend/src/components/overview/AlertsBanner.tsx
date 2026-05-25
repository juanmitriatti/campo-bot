import { useEffect, useState } from 'react';
import { AlertTriangle, Beef, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface AlertsBannerProps {
  stockAlerts?: number;
  livestockTotal?: number;
  onStockClick?: () => void;
  onLivestockClick?: () => void;
  /** Auto-dismiss timeout in ms. Set to 0 to disable. Default 15000. */
  autoDismissMs?: number;
}

const DISMISS_KEY = 'campo:alertsBannerDismissedUntil';
const DISMISS_HOURS = 24;

function isDismissedPersisted(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = localStorage.getItem(DISMISS_KEY);
  if (!raw) return false;
  const until = parseInt(raw, 10);
  if (isNaN(until)) return false;
  return Date.now() < until;
}

export default function AlertsBanner({
  stockAlerts,
  livestockTotal,
  onStockClick,
  onLivestockClick,
  autoDismissMs = 15_000,
}: AlertsBannerProps) {
  const [dismissed, setDismissed] = useState<boolean>(isDismissedPersisted);

  // Reset + start a fresh dismiss timer whenever the underlying numbers change.
  // (e.g. user switches field and the dashboard reloads → re-show the banner
  // unless the user explicitly closed it today.)
  useEffect(() => {
    if (isDismissedPersisted()) {
      setDismissed(true);
      return;
    }
    setDismissed(false);
    if (!autoDismissMs) return;
    const id = window.setTimeout(() => setDismissed(true), autoDismissMs);
    return () => window.clearTimeout(id);
  }, [stockAlerts, livestockTotal, autoDismissMs]);

  if (dismissed) return null;

  const items: { Icon: LucideIcon; text: string; color: string; onClick?: () => void }[] = [];

  if (stockAlerts != null && stockAlerts > 0) {
    items.push({
      Icon: AlertTriangle,
      text: `${stockAlerts} producto${stockAlerts > 1 ? 's' : ''} con stock bajo`,
      color: 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/40',
      onClick: onStockClick,
    });
  }

  if (livestockTotal != null && livestockTotal > 0) {
    items.push({
      Icon: Beef,
      text: `${new Intl.NumberFormat('es-AR').format(livestockTotal)} animales en total`,
      color: 'text-campo-700 dark:text-campo-300 bg-campo-50 dark:bg-campo-900/30 border-campo-200 dark:border-campo-800 hover:bg-campo-100 dark:hover:bg-campo-900/40',
      onClick: onLivestockClick,
    });
  }

  if (!items.length) return null;

  const dismissForToday = (e: React.MouseEvent) => {
    e.stopPropagation();
    const until = Date.now() + DISMISS_HOURS * 60 * 60 * 1000;
    localStorage.setItem(DISMISS_KEY, String(until));
    setDismissed(true);
  };

  // Render a single compact strip that holds all items + one shared dismiss X.
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex-1 flex flex-col gap-2 min-w-0">
        {items.map((item, i) => {
          const Icon = item.Icon;
          const baseClass = `flex items-center gap-2.5 px-4 py-3 rounded-lg border text-sm transition-colors ${item.color}`;
          if (item.onClick) {
            return (
              <button
                key={i}
                type="button"
                onClick={item.onClick}
                className={`${baseClass} w-full text-left cursor-pointer`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="font-medium truncate">{item.text}</span>
                <span className="ml-auto text-xs opacity-70 shrink-0">Ver →</span>
              </button>
            );
          }
          return (
            <div key={i} className={baseClass}>
              <Icon className="w-4 h-4 shrink-0" />
              <span className="font-medium">{item.text}</span>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={dismissForToday}
        title="Ocultar por 24 horas"
        aria-label="Ocultar alertas por 24 horas"
        className="shrink-0 p-2 rounded-md text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
