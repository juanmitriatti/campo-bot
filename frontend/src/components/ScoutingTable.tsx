import { useEffect, useState, useMemo } from 'react';
import { apiRequest } from '../api/client';

interface Scouting {
  id: number;
  plotId: number;
  fieldId: number | null;
  scoutingDate: string;
  stageCode: string | null;
  weedCoveragePct: number | null;
  weedSpecies: string[] | null;
  pestSpecies: string | null;
  pestSeverity: number | null;
  pestAffectedPct: number | null;
  soilMoisture: number | null;
  emergencePct: number | null;
  plantDensityM2: number | null;
  notes: string | null;
  createdAt: string;
  plotName: string | null;
  fieldName: string | null;
  crop: string | null;
}

interface ListResponse { scoutings: Scouting[] }

const SEV_LABELS = ['', 'ausente', 'leve', 'moderada', 'alta', 'severa'];
const MOIST_LABELS = ['', 'seco', 'algo seco', 'normal', 'húmedo', 'saturado'];

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function severityColor(sev: number | null): string {
  if (sev == null) return 'text-gray-400';
  if (sev >= 4) return 'text-red-600 font-semibold';
  if (sev === 3) return 'text-orange-600';
  return 'text-gray-600';
}

export default function ScoutingTable() {
  const [scoutings, setScoutings] = useState<Scouting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterField, setFilterField] = useState('');
  const [filterPlot, setFilterPlot] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [filterMinSeverity, setFilterMinSeverity] = useState('');
  const [filterStage, setFilterStage] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await apiRequest<ListResponse>('/scoutings?limit=200');
        if (!cancelled) setScoutings(res.scoutings);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error al cargar monitoreos');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    return scoutings.filter(s => {
      if (filterField && !(s.fieldName || '').toLowerCase().includes(filterField.toLowerCase())) return false;
      if (filterPlot && !(s.plotName || '').toLowerCase().includes(filterPlot.toLowerCase())) return false;
      if (filterDateFrom && s.scoutingDate.slice(0, 10) < filterDateFrom) return false;
      if (filterDateTo && s.scoutingDate.slice(0, 10) > filterDateTo) return false;
      if (filterMinSeverity && (s.pestSeverity == null || s.pestSeverity < parseInt(filterMinSeverity, 10))) return false;
      if (filterStage && (s.stageCode || '').toLowerCase() !== filterStage.toLowerCase()) return false;
      return true;
    });
  }, [scoutings, filterField, filterPlot, filterDateFrom, filterDateTo, filterMinSeverity, filterStage]);

  const clearFilters = () => {
    setFilterField('');
    setFilterPlot('');
    setFilterDateFrom('');
    setFilterDateTo('');
    setFilterMinSeverity('');
    setFilterStage('');
  };

  const aggregates = useMemo(() => {
    if (filtered.length === 0) return null;
    const weeds = filtered.filter(s => s.weedCoveragePct != null);
    const avgWeed = weeds.length ? weeds.reduce((a, s) => a + (s.weedCoveragePct || 0), 0) / weeds.length : null;
    let maxSev: number | null = null;
    let maxSevSpecies: string | null = null;
    for (const s of filtered) {
      if (s.pestSeverity != null && (maxSev == null || s.pestSeverity > maxSev)) {
        maxSev = s.pestSeverity;
        maxSevSpecies = s.pestSpecies;
      }
    }
    const densities = filtered.filter(s => s.plantDensityM2 != null);
    const avgDensity = densities.length ? densities.reduce((a, s) => a + (s.plantDensityM2 || 0), 0) / densities.length : null;
    return {
      total: filtered.length,
      avgWeed: avgWeed != null ? Math.round(avgWeed * 10) / 10 : null,
      maxSev,
      maxSevSpecies,
      avgDensity: avgDensity != null ? Math.round(avgDensity * 10) / 10 : null,
    };
  }, [filtered]);

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-gray-800">Monitoreos del cultivo</h2>
        <span className="text-xs text-gray-400">Datos estructurados — fenología, malezas, plagas, densidad, emergencia, humedad</span>
      </div>

      {aggregates && aggregates.total > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Total filtrados</div>
            <div className="text-lg font-semibold">{aggregates.total}</div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Cobertura malezas (prom)</div>
            <div className="text-lg font-semibold">{aggregates.avgWeed != null ? `${aggregates.avgWeed}%` : '—'}</div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Plaga más severa</div>
            <div className={`text-lg font-semibold ${severityColor(aggregates.maxSev)}`}>
              {aggregates.maxSev != null ? `${aggregates.maxSevSpecies || '—'} (${SEV_LABELS[aggregates.maxSev]})` : '—'}
            </div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Densidad prom (pl/m²)</div>
            <div className="text-lg font-semibold">{aggregates.avgDensity != null ? aggregates.avgDensity : '—'}</div>
          </div>
        </div>
      )}

      <div className="flex gap-2 flex-wrap mb-4">
        <input type="text" value={filterField} onChange={e => setFilterField(e.target.value)} placeholder="Campo"
          className="px-3 py-2 border border-gray-300 rounded text-sm min-w-[120px] flex-1" />
        <input type="text" value={filterPlot} onChange={e => setFilterPlot(e.target.value)} placeholder="Lote"
          className="px-3 py-2 border border-gray-300 rounded text-sm min-w-[120px] flex-1" />
        <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm" />
        <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm" />
        <select value={filterMinSeverity} onChange={e => setFilterMinSeverity(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm">
          <option value="">Severidad mín</option>
          <option value="2">≥ leve</option>
          <option value="3">≥ moderada</option>
          <option value="4">≥ alta</option>
          <option value="5">solo severa</option>
        </select>
        <input type="text" value={filterStage} onChange={e => setFilterStage(e.target.value)} placeholder="Estadio"
          className="px-3 py-2 border border-gray-300 rounded text-sm w-24" />
        <button onClick={clearFilters} className="px-3 py-2 border border-gray-300 rounded text-sm text-gray-600 hover:bg-gray-50">
          Limpiar
        </button>
      </div>

      {loading && <div className="text-sm text-gray-500">Cargando monitoreos…</div>}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3 mb-3">{error}</div>
      )}

      {!loading && filtered.length === 0 && !error && (
        <div className="text-sm text-gray-500 bg-gray-50 rounded p-6 text-center border border-dashed border-gray-300">
          No hay monitoreos. Pedile al bot:<br />
          <span className="font-mono text-gray-700">"soja V3 con 15% de rama negra y presencia leve de chinche"</span>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3">Fecha</th>
                <th className="py-2 pr-3">Lote</th>
                <th className="py-2 pr-3 hidden md:table-cell">Cultivo</th>
                <th className="py-2 pr-3">Estadio</th>
                <th className="py-2 pr-3">Malezas</th>
                <th className="py-2 pr-3">Plaga</th>
                <th className="py-2 pr-3 hidden md:table-cell">Densidad</th>
                <th className="py-2 pr-3 hidden lg:table-cell">Emerg.</th>
                <th className="py-2 pr-3 hidden lg:table-cell">Humedad</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50 align-top">
                  <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">{fmtDate(s.scoutingDate)}</td>
                  <td className="py-2 pr-3 text-gray-800">
                    <div className="font-medium">{s.plotName || '—'}</div>
                    {s.fieldName && <div className="text-xs text-gray-400">{s.fieldName}</div>}
                  </td>
                  <td className="py-2 pr-3 text-gray-600 hidden md:table-cell">{s.crop || '—'}</td>
                  <td className="py-2 pr-3 font-mono text-gray-800">{s.stageCode || '—'}</td>
                  <td className="py-2 pr-3 text-gray-700">
                    {s.weedCoveragePct != null ? <span>{s.weedCoveragePct}%</span> : '—'}
                    {s.weedSpecies && s.weedSpecies.length > 0 && (
                      <div className="text-xs text-gray-400">{s.weedSpecies.join(', ')}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {s.pestSpecies ? (
                      <>
                        <div className={severityColor(s.pestSeverity)}>{s.pestSpecies}</div>
                        {s.pestSeverity != null && (
                          <div className="text-xs text-gray-500">{SEV_LABELS[s.pestSeverity]} ({s.pestSeverity}/5){s.pestAffectedPct != null ? ` · ${s.pestAffectedPct}%` : ''}</div>
                        )}
                      </>
                    ) : '—'}
                  </td>
                  <td className="py-2 pr-3 text-gray-700 hidden md:table-cell">{s.plantDensityM2 != null ? `${s.plantDensityM2}` : '—'}</td>
                  <td className="py-2 pr-3 text-gray-700 hidden lg:table-cell">{s.emergencePct != null ? `${s.emergencePct}%` : '—'}</td>
                  <td className="py-2 pr-3 text-gray-700 hidden lg:table-cell">{s.soilMoisture != null ? MOIST_LABELS[s.soilMoisture] : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
