import { useState } from 'react';
import LivestockTable from './LivestockTable';
import LivestockHistoryPanel from './LivestockHistoryPanel';
import FeedlotPanel from './FeedlotPanel';
import LivestockEventsPanel from './LivestockEventsPanel';

type SubTab = 'groups' | 'history' | 'health' | 'repro' | 'weighing' | 'feedlot';

const TABS: { key: SubTab; label: string }[] = [
  { key: 'groups', label: 'Grupos' },
  { key: 'history', label: 'Historial' },
  { key: 'health', label: 'Sanidad' },
  { key: 'repro', label: 'Reproducción' },
  { key: 'weighing', label: 'Pesaje' },
  { key: 'feedlot', label: 'Feedlot' },
];

export default function LivestockTab() {
  const [subTab, setSubTab] = useState<SubTab>('groups');

  return (
    <div>
      <div className="px-6 pt-4 pb-2 flex gap-4 text-sm border-b border-gray-100 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            className={`pb-2 font-medium border-b-2 transition-colors whitespace-nowrap ${
              subTab === t.key
                ? 'border-campo-600 text-campo-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {subTab === 'groups' && <LivestockTable />}
      {subTab === 'history' && <LivestockHistoryPanel />}
      {subTab === 'health' && (
        <LivestockEventsPanel
          type="health_event"
          title="Sanidad — vacunaciones, desparasitaciones, tratamientos"
          emptyHint='No hay eventos sanitarios. Pedile al bot: "vacuné 80 vacas con aftosa".'
        />
      )}
      {subTab === 'repro' && (
        <LivestockEventsPanel
          type="repro_event"
          title="Reproducción — servicios, destetes, inseminaciones"
          emptyHint='No hay eventos reproductivos. Pedile al bot: "eché el toro con 50 vacas" o "desteté 40 terneros".'
        />
      )}
      {subTab === 'weighing' && (
        <LivestockEventsPanel
          type="weighing"
          title="Pesaje — peso promedio y GDPV"
          emptyHint='No hay pesajes. Pedile al bot: "pesé los novillos, 380 kg promedio".'
        />
      )}
      {subTab === 'feedlot' && <FeedlotPanel />}
    </div>
  );
}
