import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';

interface Feedlot {
  id: number;
  field_id: number;
  name: string;
  capacity: number | null;
  notes: string | null;
  field_name: string;
  corral_count: number;
}

interface Corral {
  id: number;
  feedlot_id: number;
  name: string;
  capacity: number | null;
  notes: string | null;
}

export default function FeedlotPanel() {
  const [feedlots, setFeedlots] = useState<Feedlot[]>([]);
  const [corrals, setCorrals] = useState<Record<number, Corral[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFeedlot, setExpandedFeedlot] = useState<number | null>(null);
  const [loadingCorrals, setLoadingCorrals] = useState<number | null>(null);

  const fetchFeedlots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<{ items: Feedlot[] }>('/feedlots');
      setFeedlots(result.items);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar feedlots');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeedlots();
  }, [fetchFeedlots]);

  const fetchCorrals = async (feedlotId: number) => {
    if (corrals[feedlotId]) return;
    setLoadingCorrals(feedlotId);
    try {
      const result = await apiRequest<{ items: Corral[] }>(`/feedlots/${feedlotId}/corrals`);
      setCorrals(prev => ({ ...prev, [feedlotId]: result.items }));
    } catch {
      // ignore
    } finally {
      setLoadingCorrals(null);
    }
  };

  const toggleFeedlot = (id: number) => {
    if (expandedFeedlot === id) {
      setExpandedFeedlot(null);
    } else {
      setExpandedFeedlot(id);
      fetchCorrals(id);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700 text-sm">
        {error}
        <button onClick={fetchFeedlots} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  if (feedlots.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p className="text-lg">No tenés feedlots registrados</p>
        <p className="text-sm mt-1">Creá un feedlot por WhatsApp o Telegram con "crear feedlot en campo X"</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-200">
      {feedlots.map(feedlot => (
        <div key={feedlot.id}>
          <button
            onClick={() => toggleFeedlot(feedlot.id)}
            className="w-full flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition-colors text-left"
          >
            <div>
              <p className="font-medium text-gray-800">
                🏗️ {feedlot.name}
              </p>
              <p className="text-sm text-gray-500">
                {feedlot.field_name}
                {feedlot.capacity != null && ` · Cap: ${feedlot.capacity}`}
                {' · '}{feedlot.corral_count} {feedlot.corral_count === 1 ? 'corral' : 'corrales'}
              </p>
            </div>
            <svg
              className={`w-5 h-5 text-gray-400 transition-transform ${expandedFeedlot === feedlot.id ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {expandedFeedlot === feedlot.id && (
            <div className="px-4 pb-4">
              {loadingCorrals === feedlot.id ? (
                <div className="flex justify-center py-4">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-campo-600" />
                </div>
              ) : (corrals[feedlot.id]?.length || 0) === 0 ? (
                <p className="text-sm text-gray-400 py-2 pl-2">Sin corrales. Creá uno con "crear corral X"</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-3 py-2 font-medium text-gray-600">Corral</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">Capacidad</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600 hidden sm:table-cell">Notas</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {corrals[feedlot.id]?.map(corral => (
                      <tr key={corral.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-800">🔲 {corral.name}</td>
                        <td className="px-3 py-2 text-right text-gray-600">
                          {corral.capacity != null ? corral.capacity : <span className="text-gray-300">-</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-500 hidden sm:table-cell">
                          {corral.notes || <span className="text-gray-300">-</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
