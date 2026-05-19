import { useEffect, useState, useMemo } from 'react';
import { apiRequest } from '../api/client';
import { useSortableTable } from '../hooks/useSortableTable';

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

interface PlotOption { id: number; name: string }
interface FieldOption { id: number; name: string; plots: PlotOption[] }
interface FiltersResponse { fields: FieldOption[] }

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
  const [page, setPage] = useState(1);
  const limit = 15;

  const [fields, setFields] = useState<FieldOption[]>([]);
  const [filterFieldId, setFilterFieldId] = useState('');
  const [filterPlotId, setFilterPlotId] = useState('');
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

  // Load campos/lotes for filter dropdowns
  useEffect(() => {
    apiRequest<FiltersResponse>('/observations/filters')
      .then(r => {
        setFields(r.fields);
        if (r.fields.length === 1) setFilterFieldId(String(r.fields[0].id));
      })
      .catch(() => {});
  }, []);

  // Auto-pick the only plot when there's just one
  useEffect(() => {
    const allPlots = fields.flatMap(f => f.plots);
    const candidatePlots = filterFieldId
      ? fields.find(f => String(f.id) === filterFieldId)?.plots ?? []
      : allPlots;
    if (candidatePlots.length === 1 && !filterPlotId) {
      setFilterPlotId(String(candidatePlots[0].id));
    }
  }, [fields, filterFieldId, filterPlotId]);

  const availablePlots = filterFieldId
    ? fields.find(f => String(f.id) === filterFieldId)?.plots ?? []
    : fields.flatMap(f => f.plots);

  const filtered = useMemo(() => {
    return scoutings.filter(s => {
      if (filterFieldId && String(s.fieldId) !== filterFieldId) return false;
      if (filterPlotId && String(s.plotId) !== filterPlotId) return false;
      if (filterDateFrom && s.scoutingDate.slice(0, 10) < filterDateFrom) return false;
      if (filterDateTo && s.scoutingDate.slice(0, 10) > filterDateTo) return false;
      if (filterMinSeverity && (s.pestSeverity == null || s.pestSeverity < parseInt(filterMinSeverity, 10))) return false;
      if (filterStage && (s.stageCode || '').toLowerCase() !== filterStage.toLowerCase()) return false;
      return true;
    });
  }, [scoutings, filterFieldId, filterPlotId, filterDateFrom, filterDateTo, filterMinSeverity, filterStage]);

  const clearFilters = () => {
    setFilterFieldId(fields.length === 1 ? String(fields[0].id) : '');
    setFilterPlotId('');
    setFilterDateFrom('');
    setFilterDateTo('');
    setFilterMinSeverity('');
    setFilterStage('');
  };

  // Reset to first page whenever filters or sort criteria change
  useEffect(() => {
    setPage(1);
  }, [filterFieldId, filterPlotId, filterDateFrom, filterDateTo, filterMinSeverity, filterStage]);

  const { sorted: sortedScoutings, toggleSort, arrow } = useSortableTable<Scouting, 'date' | 'plot' | 'crop' | 'stage' | 'weed' | 'pest' | 'density' | 'emergence' | 'moisture'>(filtered, {
    getValue: (row, key) => {
      switch (key) {
        case 'date': return row.scoutingDate;
        case 'plot': return (row.plotName || '').toLowerCase();
        case 'crop': return (row.crop || '').toLowerCase();
        case 'stage': return (row.stageCode || '').toLowerCase();
        case 'weed': return row.weedCoveragePct == null ? null : Number(row.weedCoveragePct);
        case 'pest': return row.pestSeverity == null ? null : Number(row.pestSeverity);
        case 'density': return row.plantDensityM2 == null ? null : Number(row.plantDensityM2);
        case 'emergence': return row.emergencePct == null ? null : Number(row.emergencePct);
        case 'moisture': return row.soilMoisture == null ? null : Number(row.soilMoisture);
      }
    },
    initial: { key: 'date', direction: 'desc' },
  });

  const totalPages = Math.max(1, Math.ceil(sortedScoutings.length / limit));
  const pageScoutings = sortedScoutings.slice((page - 1) * limit, page * limit);

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
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Monitoreos del cultivo</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">Datos estructurados — fenología, malezas, plagas, densidad, emergencia, humedad</span>
      </div>

      {aggregates && aggregates.total > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3">
            <div className="text-xs text-gray-500 dark:text-gray-400">Total filtrados</div>
            <div className="text-lg font-semibold">{aggregates.total}</div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3">
            <div className="text-xs text-gray-500 dark:text-gray-400">Cobertura malezas (prom)</div>
            <div className="text-lg font-semibold">{aggregates.avgWeed != null ? `${aggregates.avgWeed}%` : '—'}</div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3">
            <div className="text-xs text-gray-500 dark:text-gray-400">Plaga más severa</div>
            <div className={`text-lg font-semibold ${severityColor(aggregates.maxSev)}`}>
              {aggregates.maxSev != null ? `${aggregates.maxSevSpecies || '—'} (${SEV_LABELS[aggregates.maxSev]})` : '—'}
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3">
            <div className="text-xs text-gray-500 dark:text-gray-400">Densidad prom (pl/m²)</div>
            <div className="text-lg font-semibold">{aggregates.avgDensity != null ? aggregates.avgDensity : '—'}</div>
          </div>
        </div>
      )}

      <div className="flex gap-2 flex-wrap mb-4">
        <select value={filterFieldId} onChange={e => { setFilterFieldId(e.target.value); setFilterPlotId(''); }}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded text-sm min-w-[140px]">
          {fields.length !== 1 && <option value="">Todos los campos</option>}
          {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <select value={filterPlotId} onChange={e => setFilterPlotId(e.target.value)}
          disabled={!filterFieldId && fields.length > 1}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded text-sm min-w-[120px] disabled:bg-gray-100 dark:disabled:bg-gray-700">
          {availablePlots.length !== 1 && <option value="">Todos los lotes</option>}
          {availablePlots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded text-sm" />
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
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded text-sm w-24" />
        <button onClick={clearFilters} className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
          Limpiar
        </button>
      </div>

      {loading && <div className="text-sm text-gray-500 dark:text-gray-400">Cargando monitoreos…</div>}

      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded p-3 mb-3">{error}</div>
      )}

      {!loading && filtered.length === 0 && !error && (
        <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 rounded p-6 text-center border border-dashed border-gray-300 dark:border-gray-600">
          No hay monitoreos. Pedile al bot:<br />
          <span className="font-mono text-gray-700 dark:text-gray-200">"soja V3 con 15% de rama negra y presencia leve de chinche"</span>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th onClick={() => toggleSort('date')} className="py-2 pr-3 cursor-pointer select-none hover:text-gray-700">Fecha{arrow('date')}</th>
                <th onClick={() => toggleSort('plot')} className="py-2 pr-3 cursor-pointer select-none hover:text-gray-700">Lote{arrow('plot')}</th>
                <th onClick={() => toggleSort('crop')} className="py-2 pr-3 hidden md:table-cell cursor-pointer select-none hover:text-gray-700">Cultivo{arrow('crop')}</th>
                <th onClick={() => toggleSort('stage')} className="py-2 pr-3 cursor-pointer select-none hover:text-gray-700">Estadio{arrow('stage')}</th>
                <th onClick={() => toggleSort('weed')} className="py-2 pr-3 cursor-pointer select-none hover:text-gray-700">Malezas{arrow('weed')}</th>
                <th onClick={() => toggleSort('pest')} className="py-2 pr-3 cursor-pointer select-none hover:text-gray-700">Plaga{arrow('pest')}</th>
                <th onClick={() => toggleSort('density')} className="py-2 pr-3 hidden md:table-cell cursor-pointer select-none hover:text-gray-700">Densidad{arrow('density')}</th>
                <th onClick={() => toggleSort('emergence')} className="py-2 pr-3 hidden lg:table-cell cursor-pointer select-none hover:text-gray-700">Emerg.{arrow('emergence')}</th>
                <th onClick={() => toggleSort('moisture')} className="py-2 pr-3 hidden lg:table-cell cursor-pointer select-none hover:text-gray-700">Humedad{arrow('moisture')}</th>
              </tr>
            </thead>
            <tbody>
              {pageScoutings.map(s => (
                <tr key={s.id} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 align-top">
                  <td className="py-2 pr-3 text-gray-600 dark:text-gray-300 whitespace-nowrap">{fmtDate(s.scoutingDate)}</td>
                  <td className="py-2 pr-3 text-gray-800 dark:text-gray-100">
                    <div className="font-medium">{s.plotName || '—'}</div>
                    {s.fieldName && <div className="text-xs text-gray-400 dark:text-gray-500">{s.fieldName}</div>}
                  </td>
                  <td className="py-2 pr-3 text-gray-600 hidden md:table-cell">{s.crop || '—'}</td>
                  <td className="py-2 pr-3 font-mono text-gray-800 dark:text-gray-100">{s.stageCode || '—'}</td>
                  <td className="py-2 pr-3 text-gray-700 dark:text-gray-200">
                    {s.weedCoveragePct != null ? <span>{s.weedCoveragePct}%</span> : '—'}
                    {s.weedSpecies && s.weedSpecies.length > 0 && (
                      <div className="text-xs text-gray-400 dark:text-gray-500">{s.weedSpecies.join(', ')}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {s.pestSpecies ? (
                      <>
                        <div className={severityColor(s.pestSeverity)}>{s.pestSpecies}</div>
                        {s.pestSeverity != null && (
                          <div className="text-xs text-gray-500 dark:text-gray-400">{SEV_LABELS[s.pestSeverity]} ({s.pestSeverity}/5){s.pestAffectedPct != null ? ` · ${s.pestAffectedPct}%` : ''}</div>
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

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {sortedScoutings.length} monitoreos en total
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:text-gray-200 dark:bg-gray-800 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Anterior
                </button>
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:text-gray-200 dark:bg-gray-800 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
