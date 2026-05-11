import type { LucideIcon } from 'lucide-react';

interface KpiCardProps {
  label: string;
  value: string;
  delta?: number | null; // percentage change vs prev period
  tint: string; // bg color class e.g. "bg-red-50"
  Icon: LucideIcon;
  iconColor?: string; // tailwind text-color class, e.g. "text-red-500"
}

export default function KpiCard({ label, value, delta, tint, Icon, iconColor = 'text-gray-500' }: KpiCardProps) {
  const deltaColor = delta != null && delta >= 0 ? 'text-green-600' : 'text-red-600';
  const deltaSign = delta != null && delta >= 0 ? '+' : '';

  return (
    <div className={`${tint} rounded-xl border border-gray-100 p-5 shadow-sm`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-gray-600">{label}</span>
        <Icon className={`w-5 h-5 ${iconColor}`} />
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {delta != null && isFinite(delta) && (
        <p className={`text-xs mt-1 ${deltaColor}`}>
          {deltaSign}{Math.round(delta)}% vs mes anterior
        </p>
      )}
    </div>
  );
}
