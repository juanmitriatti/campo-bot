import { useEffect, useState, useCallback, type FormEvent } from 'react';
import { useSortableTable } from '../hooks/useSortableTable';
import { apiRequest, ApiError } from '../api/client';
import TabHeader from './TabHeader';
import HarvestCampaignsSummary from './HarvestCampaignsSummary';

interface QualityMetrics {
  oil_pct?: number;
  protein_pct?: number;
  gluten_pct?: number;
  test_weight_kg_hl?: number;
}

interface HarvestLoad {
  id: number;
  driverName: string;
  weightKg: number;
  netWeightKg: number | null;
  mermaPct: number | null;
  grossWeightKg: number | null;
  tareKg: number | null;
  acopioWeightKg: number | null;
  cartaPorte: string | null;
  ctg: string | null;
  destination: string | null;
  destinatario: string | null;
  truckPlate: string | null;
  notes: string | null;
  humidityPct: number | null;
  qualityMetrics: QualityMetrics | null;
  eventDate: string;
  crop: string | null;
  plotId: number | null;
  plotName: string | null;
  fieldName: string | null;
}

interface PaginatedResponse {
  data: HarvestLoad[];
  total: number;
  page: number;
  totalPages: number;
}

interface PlotOption { id: number; name: string }
interface FieldOption { id: number; name: string; plots: PlotOption[] }

interface ReconcileEntry { romaneo: { date?: string | null; plate?: string | null; driver?: string | null; kg: number; ref?: string | null }; loadId: number; driver: string; date: string; plot: string | null; ourKg: number; theirKg: number; diffKg: number; diffPct: number }
interface ReconcileResult {
  matched: ReconcileEntry[];
  differing: ReconcileEntry[];
  missingInBot: Array<{ date?: string | null; plate?: string | null; driver?: string | null; kg: number; ref?: string | null }>;
  missingInRomaneo: Array<{ loadId: number; driver: string; date: string; plot: string | null; kg: number; plate: string | null }>;
  totals: { romaneoKg: number; botKg: number; matchedKg: number };
  applied: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function formatKg(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} tn`;
  return `${kg.toLocaleString('es-AR')} kg`;
}

const kgFull = (kg: number) => `${Math.round(kg).toLocaleString('es-AR')} kg`;

function describeQuality(q: QualityMetrics | null): string {
  if (!q) return '';
  const parts: string[] = [];
  if (q.oil_pct != null) parts.push(`aceite ${q.oil_pct}%`);
  if (q.protein_pct != null) parts.push(`prot ${q.protein_pct}%`);
  if (q.gluten_pct != null) parts.push(`gluten ${q.gluten_pct}%`);
  if (q.test_weight_kg_hl != null) parts.push(`PH ${q.test_weight_kg_hl} kg/hl`);
  return parts.join(' · ');
}

const inputCls = 'border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm';

/** Modal de edición de una carga: kilos, humedad, destino, patente, CTG, carta de porte, peso en destino. */
function LoadEditModal({ load, onClose, onSaved }: { load: HarvestLoad; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    driverName: load.driverName,
    weightKg: String(load.weightKg),
    humidityPct: load.humidityPct != null ? String(load.humidityPct) : '',
    destinatario: load.destinatario ?? '',
    truckPlate: load.truckPlate ?? '',
    ctg: load.ctg ?? '',
    cartaPorte: load.cartaPorte ?? '',
    acopioWeightKg: load.acopioWeightKg != null ? String(load.acopioWeightKg) : '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiRequest(`/harvest-loads/${load.id}`, {
        method: 'PATCH',
        body: {
          driverName: form.driverName,
          weightKg: form.weightKg,
          humidityPct: form.humidityPct === '' ? null : form.humidityPct,
          destinatario: form.destinatario,
          truckPlate: form.truckPlate,
          ctg: form.ctg,
          cartaPorte: form.cartaPorte,
          acopioWeightKg: form.acopioWeightKg === '' ? null : form.acopioWeightKg,
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar.');
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: keyof typeof form, type = 'text', extra: Record<string, unknown> = {}) => (
    <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-300">
      {label}
      <input type={type} value={form[key]} onChange={set(key)} className={inputCls} {...extra} />
    </label>
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="w-full max-w-lg bg-white dark:bg-gray-800 rounded-lg shadow-xl p-5 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Corregir camión</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">{formatDate(load.eventDate)} · {load.plotName ?? '—'}{load.crop ? ` · ${load.crop}` : ''}</p>
        </div>
        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          {field('Chofer', 'driverName', 'text', { required: true })}
          {field('Kilos (bruto)', 'weightKg', 'number', { min: 1, step: 1, required: true })}
          {field('Humedad %', 'humidityPct', 'number', { min: 0, max: 50, step: 0.1 })}
          {field('Destinatario / acopio', 'destinatario')}
          {field('Patente', 'truckPlate')}
          {field('CTG', 'ctg')}
          {field('Carta de porte', 'cartaPorte')}
          {field('Kg que pesó el acopio', 'acopioWeightKg', 'number', { min: 0, step: 1 })}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">El neto comercial se recalcula solo con la humedad y la base del cultivo.</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md dark:text-gray-200">Cancelar</button>
          <button type="submit" disabled={saving} className="px-3 py-1.5 text-sm bg-campo-600 hover:bg-campo-700 text-white rounded-md disabled:opacity-50">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </div>
  );
}

/** Conciliación contra el romaneo del acopio: pegar filas, ver qué cierra y qué no. */
function ReconcilePanel({ onApplied }: { onApplied: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReconcileResult | null>(null);

  const run = async (apply: boolean) => {
    setBusy(true); setError(null);
    try {
      const r = await apiRequest<ReconcileResult>('/harvest-loads/reconcile', { method: 'POST', body: { text, apply } });
      setResult(r);
      if (apply) onApplied();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo conciliar.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm text-campo-700 dark:text-campo-300 hover:underline">
        Conciliar con el romaneo del acopio
      </button>
    );
  }

  const Row = ({ e }: { e: ReconcileEntry }) => (
    <tr className="border-t border-gray-100 dark:border-gray-700">
      <td className="px-2 py-1 whitespace-nowrap">{formatDate(e.date)}</td>
      <td className="px-2 py-1">{e.driver}{e.plot ? <span className="text-gray-400"> · {e.plot}</span> : null}</td>
      <td className="px-2 py-1 text-right tabular-nums">{kgFull(e.ourKg)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{kgFull(e.theirKg)}</td>
      <td className={`px-2 py-1 text-right tabular-nums ${Math.abs(e.diffPct) > 1 ? 'text-amber-700 dark:text-amber-300 font-medium' : 'text-gray-500'}`}>{e.diffKg > 0 ? '+' : ''}{kgFull(e.diffKg)} ({e.diffPct > 0 ? '+' : ''}{e.diffPct}%)</td>
    </tr>
  );

  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-white dark:bg-gray-800 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Conciliar con el romaneo</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 max-w-prose">Pegá las filas del romaneo, una por línea: fecha, patente o chofer, y kilos. Ej: <span className="font-mono">12/04 AB123CD 30.580</span> o <span className="font-mono">Pérez 30580</span>. Se cruzan por patente o chofer y fecha (± 1 día).</p>
        </div>
        <button onClick={() => { setOpen(false); setResult(null); }} className="text-xs text-gray-500 hover:underline">Cerrar</button>
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={5} placeholder={'12/04/2026 AB123CD 30.580\n12/04/2026 Pérez 29.940'} className={`${inputCls} w-full font-mono`} />
      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
      <div className="flex gap-2">
        <button onClick={() => run(false)} disabled={busy || !text.trim()} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md dark:text-gray-200 disabled:opacity-50">{busy ? 'Comparando…' : 'Comparar'}</button>
        <button onClick={() => run(true)} disabled={busy || !text.trim()} className="px-3 py-1.5 text-sm bg-campo-600 hover:bg-campo-700 text-white rounded-md disabled:opacity-50">Comparar y guardar pesos del acopio</button>
      </div>
      {result && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-4 text-xs text-gray-600 dark:text-gray-300">
            <span>Romaneo: <strong className="tabular-nums">{kgFull(result.totals.romaneoKg)}</strong></span>
            <span>Bot: <strong className="tabular-nums">{kgFull(result.totals.botKg)}</strong></span>
            <span className="text-green-700 dark:text-green-300">Cierran: {result.matched.length}</span>
            <span className="text-amber-700 dark:text-amber-300">Difieren: {result.differing.length}</span>
            <span className="text-red-700 dark:text-red-300">Faltan en el bot: {result.missingInBot.length}</span>
            <span className="text-red-700 dark:text-red-300">Faltan en el romaneo: {result.missingInRomaneo.length}</span>
            {result.applied > 0 && <span>Pesos guardados: {result.applied}</span>}
          </div>
          {(result.differing.length > 0 || result.matched.length > 0) && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-gray-500"><th className="px-2 py-1">Fecha</th><th className="px-2 py-1">Camión</th><th className="px-2 py-1 text-right">Bot</th><th className="px-2 py-1 text-right">Acopio</th><th className="px-2 py-1 text-right">Diferencia</th></tr></thead>
                <tbody>
                  {result.differing.map(e => <Row key={`d${e.loadId}`} e={e} />)}
                  {result.matched.map(e => <Row key={`m${e.loadId}`} e={e} />)}
                </tbody>
              </table>
            </div>
          )}
          {result.missingInBot.length > 0 && (
            <div>
              <p className="font-medium text-red-700 dark:text-red-300">En el romaneo pero no en el bot</p>
              <ul className="list-disc pl-5 text-xs text-gray-700 dark:text-gray-300">
                {result.missingInBot.map((r, i) => <li key={i}>{r.ref ?? `${r.date ?? ''} ${r.plate ?? r.driver ?? ''} ${kgFull(r.kg)}`}</li>)}
              </ul>
            </div>
          )}
          {result.missingInRomaneo.length > 0 && (
            <div>
              <p className="font-medium text-red-700 dark:text-red-300">En el bot pero no en el romaneo</p>
              <ul className="list-disc pl-5 text-xs text-gray-700 dark:text-gray-300">
                {result.missingInRomaneo.map(r => <li key={r.loadId}>{formatDate(r.date)} · {r.driver}{r.plate ? ` (${r.plate})` : ''}{r.plot ? ` · ${r.plot}` : ''} · {kgFull(r.kg)}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function HarvestLoadsTable() {
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<HarvestLoad | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HarvestLoad | null>(null);

  const [fields, setFields] = useState<FieldOption[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [driver, setDriver] = useState('');
  const [destinatario, setDestinatario] = useState('');
  const [cropFilter, setCropFilter] = useState('');
  const [humMin, setHumMin] = useState('');
  const [humMax, setHumMax] = useState('');

  const limit = 50;

  useEffect(() => {
    apiRequest<{ fields: FieldOption[] }>('/observations/filters')
      .then(r => {
        setFields(r.fields);
        if (r.fields.length === 1) setFieldId(String(r.fields[0].id));
      })
      .catch(() => {});
  }, []);

  // Auto-pick the only plot if there's just one (within active field)
  useEffect(() => {
    const allPlots = fields.flatMap(f => f.plots);
    const candidatePlots = fieldId
      ? fields.find(f => f.id === Number(fieldId))?.plots ?? []
      : allPlots;
    if (candidatePlots.length === 1 && !plotId) {
      setPlotId(String(candidatePlots[0].id));
    }
  }, [fields, fieldId, plotId]);

  const fetchLoads = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (fieldId) params.set('fieldId', fieldId);
      if (plotId) params.set('plotId', plotId);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (driver) params.set('driver', driver);
      if (destinatario) params.set('destinatario', destinatario);
      if (cropFilter) params.set('crop', cropFilter);
      if (humMin) params.set('humidityMin', humMin);
      if (humMax) params.set('humidityMax', humMax);
      const result = await apiRequest<PaginatedResponse>(`/harvest-loads?${params}`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar cosechas');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, dateFrom, dateTo, driver, destinatario, cropFilter, humMin, humMax]);

  useEffect(() => { fetchLoads(); }, [fetchLoads]);

  const hasFilters = !!(fieldId || plotId || dateFrom || dateTo || driver || destinatario || cropFilter || humMin || humMax);
  const clearFilters = () => {
    setFieldId(fields.length === 1 ? String(fields[0].id) : '');
    setPlotId(''); setDateFrom(''); setDateTo('');
    setDriver(''); setDestinatario('');
    setCropFilter(''); setHumMin(''); setHumMax('');
    setPage(1);
  };

  const availablePlots = fieldId ? fields.find(f => f.id === Number(fieldId))?.plots ?? [] : [];

  const deleteLoad = async (l: HarvestLoad) => {
    try {
      await apiRequest(`/harvest-loads/${l.id}`, { method: 'DELETE' });
      setConfirmDelete(null);
      fetchLoads();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo borrar la carga.');
      setConfirmDelete(null);
    }
  };

  // Client-side filter (cultivo, humedad range) + sort
  const filteredLoads = (data?.data ?? []).filter(l => {
    if (cropFilter && (l.crop || '').toLowerCase() !== cropFilter.toLowerCase()) return false;
    if (humMin && (l.humidityPct == null || l.humidityPct < Number(humMin))) return false;
    if (humMax && (l.humidityPct == null || l.humidityPct > Number(humMax))) return false;
    return true;
  });
  const cropsAvailable = [...new Set((data?.data ?? []).map(l => l.crop).filter(Boolean) as string[])];
  const pageGross = filteredLoads.reduce((s, l) => s + Number(l.weightKg), 0);
  const pageNet = filteredLoads.reduce((s, l) => s + Number(l.netWeightKg ?? l.weightKg), 0);

  const { sorted: sortedLoads, toggleSort, arrow } = useSortableTable<typeof filteredLoads[0], 'date' | 'plot' | 'crop' | 'driver' | 'weight' | 'net' | 'humidity' | 'destinatario' | 'truck'>(filteredLoads, {
    getValue: (row, key) => {
      switch (key) {
        case 'date': return row.eventDate;
        case 'plot': return (row.plotName || '').toLowerCase();
        case 'crop': return (row.crop || '').toLowerCase();
        case 'driver': return (row.driverName || '').toLowerCase();
        case 'weight': return Number(row.weightKg);
        case 'net': return Number(row.netWeightKg ?? row.weightKg);
        case 'humidity': return row.humidityPct == null ? null : Number(row.humidityPct);
        case 'destinatario': return (row.destinatario || '').toLowerCase();
        case 'truck': return (row.truckPlate || '').toLowerCase();
      }
    },
    initial: { key: 'date', direction: 'desc' },
  });

  const th = (label: string, key: Parameters<typeof toggleSort>[0], cls = '') => (
    <th onClick={() => toggleSort(key)} className={`px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700 ${cls}`}>{label}{arrow(key)}</th>
  );

  return (
    <div className="p-4 md:p-6">
      <TabHeader
        title="Cosechas"
        description="Cada camión que salió: chofer, kilos brutos y netos, humedad, destino, CTG."
        botHint="cosechamos el lote 3: Ramírez 28.500 kg a Cargill al 15%"
      />

      <HarvestCampaignsSummary fieldId={fieldId} plotId={plotId} />

      <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded mb-4 text-sm">
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Desde</label>
          <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} className={inputCls} />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Hasta</label>
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} className={inputCls} />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Campo</label>
          <select value={fieldId} onChange={e => { setFieldId(e.target.value); setPlotId(''); setPage(1); }} className={inputCls}>
            {fields.length !== 1 && <option value="">Todos</option>}
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Lote</label>
          <select value={plotId} onChange={e => { setPlotId(e.target.value); setPage(1); }} disabled={!fieldId} className={`${inputCls} disabled:opacity-40`}>
            {availablePlots.length !== 1 && <option value="">Todos</option>}
            {availablePlots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Chofer</label>
          <input type="text" value={driver} onChange={e => { setDriver(e.target.value); setPage(1); }} placeholder="Nombre" className={`${inputCls} w-32`} />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Destinatario</label>
          <input type="text" value={destinatario} onChange={e => { setDestinatario(e.target.value); setPage(1); }} placeholder="Acopio / Cargill…" className={`${inputCls} w-40`} />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Cultivo</label>
          <select value={cropFilter} onChange={e => setCropFilter(e.target.value)} className={inputCls}>
            <option value="">Todos</option>
            {cropsAvailable.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Humedad mín %</label>
          <input type="number" step="0.1" value={humMin} onChange={e => setHumMin(e.target.value)} placeholder="0" className={`${inputCls} w-20`} />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Humedad máx %</label>
          <input type="number" step="0.1" value={humMax} onChange={e => setHumMax(e.target.value)} placeholder="∞" className={`${inputCls} w-20`} />
        </div>
        {hasFilters && (
          <button onClick={clearFilters} className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline py-1.5">
            Limpiar
          </button>
        )}
      </div>

      <div className="mb-4">
        <ReconcilePanel onApplied={fetchLoads} />
      </div>

      {loading && !data && <div className="text-sm text-gray-500 dark:text-gray-300">Cargando cosechas…</div>}

      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded p-3 mb-3">
          {error} <button onClick={fetchLoads} className="ml-2 underline">Reintentar</button>
        </div>
      )}

      {!loading && data && data.data.length === 0 && !error && (
        <div className="text-sm text-gray-500 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 rounded p-6 text-center border border-dashed border-gray-300 dark:border-gray-600">
          No hay cargas de cosecha. Pedile al bot:<br />
          <span className="font-mono text-gray-700 dark:text-gray-200">"coseché lote norte: Juan 28000kg al 14% hum, Pedro 31000kg para Cargill"</span>
        </div>
      )}

      {data && data.data.length > 0 && (
        <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 text-left">
                {th('Fecha', 'date')}
                {th('Lote / Cultivo', 'plot')}
                {th('Chofer', 'driver')}
                {th('Bruto', 'weight', 'text-right')}
                {th('Neto', 'net', 'text-right')}
                {th('Hum.', 'humidity', 'text-right hidden md:table-cell')}
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden lg:table-cell">Calidad</th>
                {th('Destinatario', 'destinatario', 'hidden md:table-cell')}
                {th('Camión', 'truck', 'hidden lg:table-cell')}
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden lg:table-cell">CTG / CP</th>
                <th className="px-2 py-3"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {sortedLoads.map(l => {
                const net = l.netWeightKg ?? l.weightKg;
                const acopioDiff = l.acopioWeightKg != null ? l.acopioWeightKg - l.weightKg : null;
                return (
                  <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors align-top">
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-300 text-sm whitespace-nowrap">{formatDate(l.eventDate)}</td>
                    <td className="px-4 py-3 text-gray-800 dark:text-gray-100">
                      <div className="font-medium">{l.plotName || <span className="text-gray-300 dark:text-gray-600">—</span>}</div>
                      <div className="text-xs text-gray-400 dark:text-gray-300">
                        {l.fieldName && <span>{l.fieldName}</span>}
                        {l.crop && <span> · {l.crop}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-200">{l.driverName}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-gray-700 dark:text-gray-200 tabular-nums">
                      {formatKg(l.weightKg)}
                      {acopioDiff != null && Math.abs(acopioDiff) / l.weightKg > 0.015 && (
                        <div className="text-[11px] text-amber-700 dark:text-amber-300" title="Diferencia contra el peso del acopio">acopio {kgFull(l.acopioWeightKg!)} ({acopioDiff > 0 ? '+' : ''}{Math.round(acopioDiff).toLocaleString('es-AR')})</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-gray-800 dark:text-gray-100 tabular-nums">
                      {formatKg(net)}
                      {l.mermaPct != null && l.mermaPct > 0 && <div className="text-[11px] text-gray-400 dark:text-gray-500">merma {l.mermaPct.toLocaleString('es-AR')}%</div>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-300 hidden md:table-cell tabular-nums">
                      {l.humidityPct != null ? `${l.humidityPct}%` : <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs hidden lg:table-cell">
                      {describeQuality(l.qualityMetrics) || <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 hidden md:table-cell">
                      {l.destinatario ? (
                        <>
                          {l.destinatario}
                          {l.destination && l.destination !== l.destinatario && (
                            <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">· {l.destination.replace(/_/g, ' ')}</span>
                          )}
                        </>
                      ) : l.destination ? (
                        <span className="text-gray-500 dark:text-gray-400">{l.destination.replace(/_/g, ' ')}</span>
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-300 text-sm hidden lg:table-cell">
                      {l.truckPlate || <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-300 text-xs hidden lg:table-cell font-mono">
                      {l.ctg || l.cartaPorte ? (<>{l.ctg && <div>CTG {l.ctg}</div>}{l.cartaPorte && <div>CP {l.cartaPorte}</div>}</>) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                    <td className="px-2 py-3 whitespace-nowrap text-right">
                      <button onClick={() => setEditing(l)} className="text-xs text-campo-700 dark:text-campo-300 hover:underline mr-2">Corregir</button>
                      <button onClick={() => setConfirmDelete(l)} className="text-xs text-red-600 dark:text-red-400 hover:underline">Borrar</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-300">
                <td className="px-4 py-2" colSpan={3}>{filteredLoads.length} camión{filteredLoads.length === 1 ? '' : 'es'} en esta página</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatKg(pageGross)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">{formatKg(pageNet)}</td>
                <td colSpan={6}></td>
              </tr>
            </tfoot>
          </table>

          {data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
              <p className="text-sm text-gray-500">{data.total} cargas en total</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:text-gray-200 dark:bg-gray-800 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40">
                  Anterior
                </button>
                <span className="text-sm text-gray-600 dark:text-gray-300">{page} / {data.totalPages}</span>
                <button onClick={() => setPage(p => Math.min(data.totalPages, p + 1))} disabled={page >= data.totalPages}
                  className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:text-gray-200 dark:bg-gray-800 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40">
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {editing && <LoadEditModal load={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); fetchLoads(); }} />}

      {confirmDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm bg-white dark:bg-gray-800 rounded-lg shadow-xl p-5 space-y-4">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Borrar el camión de {confirmDelete.driverName}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-300">{formatDate(confirmDelete.eventDate)} · {kgFull(confirmDelete.weightKg)}{confirmDelete.destinatario ? ` → ${confirmDelete.destinatario}` : ''}. El rinde de la campaña se recalcula.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md dark:text-gray-200">Cancelar</button>
              <button onClick={() => deleteLoad(confirmDelete)} className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded-md">Borrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
