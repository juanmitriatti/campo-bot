interface Activity {
  id: number;
  event_type: string;
  event_date: string;
  crop: string | null;
  product: string | null;
  product_type: string | null;
  quantity: number | null;
  unit: string | null;
  implement: string | null;
  notes: string | null;
  pregnant_count: number | null;
  open_count: number | null;
  uncertain_count: number | null;
  created_at: string;
  plot_id: number | null;
  plot_name: string | null;
  field_name: string | null;
  user_name: string | null;
  edited_by_name: string | null;
}

import { Wind, FlaskConical, Sprout, Tractor, Wheat, Droplet, Stethoscope } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ACTIVITY_TYPE_LABELS: Record<string, { label: string; Icon: LucideIcon }> = {
  spraying: { label: 'Fumigacion', Icon: Wind },
  fertilization: { label: 'Fertilizacion', Icon: FlaskConical },
  planting: { label: 'Siembra', Icon: Sprout },
  tillage: { label: 'Labranza', Icon: Tractor },
  harvest: { label: 'Cosecha', Icon: Wheat },
  irrigation: { label: 'Riego', Icon: Droplet },
  tacto: { label: 'Tacto', Icon: Stethoscope },
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

function getDetail(a: Activity): string {
  if (a.event_type === 'tacto') {
    const parts: string[] = [];
    if (a.pregnant_count != null) parts.push(`${a.pregnant_count} prenadas`);
    if (a.open_count != null && a.open_count > 0) parts.push(`${a.open_count} vacias`);
    return parts.join(' - ') || '-';
  }
  const parts: string[] = [];
  if (a.product) parts.push(a.product);
  if (a.quantity != null && a.unit) parts.push(`${a.quantity} ${a.unit}`);
  if (a.implement) parts.push(a.implement);
  if (a.notes) parts.push(a.notes);
  return parts.join(' - ') || '-';
}

interface Props {
  activity: Activity;
  onEdit: (a: Activity) => void;
}

export default function ActivityCard({ activity, onEdit }: Props) {
  const info = ACTIVITY_TYPE_LABELS[activity.event_type];
  const Icon = info?.Icon;
  const typeLabel = info?.label ?? activity.event_type;
  const location = [activity.field_name, activity.plot_name].filter(Boolean).join(', ');

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1 text-xs bg-campo-100 text-campo-800 px-1.5 py-0.5 rounded">
              {Icon && <Icon className="w-3.5 h-3.5" />}
              {typeLabel}
            </span>
            {activity.crop && (
              <span className="text-xs text-gray-500 dark:text-gray-300">{activity.crop}</span>
            )}
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300 truncate">{getDetail(activity)}</p>
          <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-400 dark:text-gray-300">
            <span>{formatDate(activity.event_date)}</span>
            {location && <><span>·</span><span className="truncate">{location}</span></>}
          </div>
        </div>
        <button
          onClick={() => onEdit(activity)}
          className="text-campo-600 hover:text-campo-800 text-xs font-medium ml-2 shrink-0"
        >
          Editar
        </button>
      </div>
    </div>
  );
}
