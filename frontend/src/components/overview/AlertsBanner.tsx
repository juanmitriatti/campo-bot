import { AlertTriangle, Beef } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface AlertsBannerProps {
  stockAlerts?: number;
  livestockTotal?: number;
}

export default function AlertsBanner({ stockAlerts, livestockTotal }: AlertsBannerProps) {
  const items: { Icon: LucideIcon; text: string; color: string }[] = [];

  if (stockAlerts != null && stockAlerts > 0) {
    items.push({
      Icon: AlertTriangle,
      text: `${stockAlerts} producto${stockAlerts > 1 ? 's' : ''} con stock bajo`,
      color: 'text-amber-700 bg-amber-50 border-amber-200',
    });
  }

  if (livestockTotal != null && livestockTotal > 0) {
    items.push({
      Icon: Beef,
      text: `${new Intl.NumberFormat('es-AR').format(livestockTotal)} animales en total`,
      color: 'text-campo-700 bg-campo-50 border-campo-200',
    });
  }

  if (!items.length) return null;

  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const Icon = item.Icon;
        return (
          <div key={i} className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border text-sm ${item.color}`}>
            <Icon className="w-4 h-4 shrink-0" />
            <span className="font-medium">{item.text}</span>
          </div>
        );
      })}
    </div>
  );
}
