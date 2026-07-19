interface Observation {
  id: number;
  observation_text: string;
  category: string;
  source: string;
  created_at: string;
  updated_at: string | null;
  plot_name: string | null;
  field_name: string | null;
  user_name: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  sanidad: 'Sanidad', malezas: 'Malezas', nutricion: 'Nutricion',
  fenologia: 'Fenologia', clima: 'Clima', general: 'General',
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

interface Props {
  observation: Observation;
  onEdit: (o: Observation) => void;
}

export default function ObservationCard({ observation, onEdit }: Props) {
  const location = [observation.field_name, observation.plot_name].filter(Boolean).join(', ');

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs bg-campo-100 dark:bg-campo-900/30 text-campo-800 dark:text-campo-300 px-1.5 py-0.5 rounded">
              {CATEGORY_LABELS[observation.category] || observation.category}
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-300">{formatDate(observation.created_at)}</span>
          </div>
          <p className="text-base text-gray-700 dark:text-gray-200">{observation.observation_text}</p>
          {location && (
            <p className="text-sm text-gray-400 dark:text-gray-300 mt-1.5 truncate">{location}</p>
          )}
        </div>
        <button
          onClick={() => onEdit(observation)}
          className="text-campo-600 hover:text-campo-800 text-xs font-medium ml-2 shrink-0"
        >
          Editar
        </button>
      </div>
    </div>
  );
}
