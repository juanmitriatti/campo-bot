import { useState } from 'react';
import LivestockTable from './LivestockTable';
import LivestockHistoryPanel from './LivestockHistoryPanel';

type SubTab = 'groups' | 'history';

export default function LivestockTab() {
  const [subTab, setSubTab] = useState<SubTab>('groups');

  return (
    <div>
      <div className="px-6 pt-4 pb-2 flex gap-4 text-sm border-b border-gray-100">
        <button
          onClick={() => setSubTab('groups')}
          className={`pb-2 font-medium border-b-2 transition-colors ${
            subTab === 'groups'
              ? 'border-campo-600 text-campo-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Grupos
        </button>
        <button
          onClick={() => setSubTab('history')}
          className={`pb-2 font-medium border-b-2 transition-colors ${
            subTab === 'history'
              ? 'border-campo-600 text-campo-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Historial
        </button>
      </div>
      {subTab === 'groups' && <LivestockTable />}
      {subTab === 'history' && <LivestockHistoryPanel />}
    </div>
  );
}
