import { useEffect, useState, useCallback, useMemo } from 'react';
import { apiRequest } from '../api/client';

interface ExtractedData {
  vendor?: string;
  total_amount?: number;
  currency?: string;
  date?: string;
  invoice_number?: string;
}

interface DocumentRow {
  id: number;
  document_type: string;
  original_filename: string | null;
  mime_type: string;
  file_size_bytes: number;
  processing_status: 'pending' | 'processed' | 'error';
  processing_error: string | null;
  extracted_data: ExtractedData | null;
  linked_expense_id: number | null;
  source_channel: string;
  created_at: string;
}

interface PaginatedResponse {
  data: DocumentRow[];
  total: number;
  page: number;
  totalPages: number;
}

interface FiltersResponse {
  documentTypes: string[];
}

const TYPE_LABELS: Record<string, { label: string; emoji: string; color: string }> = {
  factura: { label: 'Factura', emoji: '🧾', color: 'bg-blue-100 text-blue-800' },
  remito: { label: 'Remito', emoji: '📄', color: 'bg-amber-100 text-amber-800' },
  ticket: { label: 'Ticket', emoji: '🧮', color: 'bg-purple-100 text-purple-800' },
  recibo: { label: 'Recibo', emoji: '🧾', color: 'bg-green-100 text-green-800' },
  otro: { label: 'Otro', emoji: '📎', color: 'bg-gray-100 text-gray-700' },
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: 'Procesando…', color: 'text-gray-500' },
  processed: { label: 'Procesado', color: 'text-green-700' },
  error: { label: 'Error', color: 'text-red-700' },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatAmount(amount: number, currency = 'ARS'): string {
  if (currency === 'USD') return `US$${amount.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
  return `$${amount.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
}

export default function DocumentsTable() {
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [types, setTypes] = useState<string[]>([]);
  const [filterType, setFilterType] = useState('');
  const [filterDesde, setFilterDesde] = useState('');
  const [filterHasta, setFilterHasta] = useState('');

  const limit = 20;

  useEffect(() => {
    apiRequest<FiltersResponse>('/documents/filters')
      .then(r => setTypes(r.documentTypes))
      .catch(() => {});
  }, []);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (filterType) params.set('documentType', filterType);
      if (filterDesde) params.set('desde', filterDesde);
      if (filterHasta) params.set('hasta', filterHasta);
      const result = await apiRequest<PaginatedResponse>(`/documents?${params}`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar documentos');
    } finally {
      setLoading(false);
    }
  }, [page, filterType, filterDesde, filterHasta]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const hasFilters = !!(filterType || filterDesde || filterHasta);
  const clearFilters = () => { setFilterType(''); setFilterDesde(''); setFilterHasta(''); setPage(1); };

  const stats = useMemo(() => {
    if (!data?.data?.length) return null;
    const processed = data.data.filter(d => d.processing_status === 'processed').length;
    const totalAmount = data.data.reduce((acc, d) => {
      const amt = d.extracted_data?.total_amount;
      return acc + (typeof amt === 'number' && d.extracted_data?.currency !== 'USD' ? amt : 0);
    }, 0);
    return { processed, totalAmount };
  }, [data]);

  const downloadFile = async (id: number, filename: string | null) => {
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch(`/api/auth/documents/${id}/file`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `documento-${id}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`No pude descargar el archivo: ${(err as Error).message}`);
    }
  };

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-gray-800">Documentos</h2>
        <span className="text-xs text-gray-400">Facturas, remitos, tickets — extraídos por IA desde tus chats</span>
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Mostrados</div>
            <div className="text-lg font-semibold">{data?.total ?? 0}</div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Procesados (pág.)</div>
            <div className="text-lg font-semibold">{stats.processed} / {data?.data.length}</div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Total ARS (pág.)</div>
            <div className="text-lg font-semibold">{formatAmount(stats.totalAmount)}</div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-gray-50 border border-gray-200 rounded mb-4 text-sm">
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Tipo</label>
          <select
            value={filterType}
            onChange={e => { setFilterType(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todos</option>
            {types.map(t => (
              <option key={t} value={t}>{TYPE_LABELS[t]?.label || t}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Desde</label>
          <input type="date" value={filterDesde}
            onChange={e => { setFilterDesde(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Hasta</label>
          <input type="date" value={filterHasta}
            onChange={e => { setFilterHasta(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
        </div>
        {hasFilters && (
          <button onClick={clearFilters}
            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline py-1.5">
            Limpiar
          </button>
        )}
      </div>

      {loading && !data && <div className="text-sm text-gray-500">Cargando documentos…</div>}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3 mb-3">
          {error} <button onClick={fetchDocs} className="ml-2 underline">Reintentar</button>
        </div>
      )}

      {!loading && data && data.data.length === 0 && !error && (
        <div className="text-sm text-gray-500 bg-gray-50 rounded p-6 text-center border border-dashed border-gray-300">
          No hay documentos. Mandale al bot una <strong>foto o PDF</strong> de una factura/remito por WhatsApp y aparece acá.
        </div>
      )}

      {data && data.data.length > 0 && (
        <div className="overflow-x-auto bg-white rounded-lg shadow-sm border border-gray-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Fecha</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Tipo</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Proveedor</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Monto</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">N° / Fecha doc</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Archivo</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Estado</th>
                <th className="px-4 py-3 w-24" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.data.map(d => {
                const t = TYPE_LABELS[d.document_type] || TYPE_LABELS.otro;
                const status = STATUS_LABELS[d.processing_status] || { label: d.processing_status, color: 'text-gray-500' };
                const ex = d.extracted_data;
                return (
                  <tr key={d.id} className="hover:bg-gray-50 transition-colors align-top">
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{formatDate(d.created_at)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block text-xs px-2 py-0.5 rounded ${t.color}`}>
                        {t.emoji} {t.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-800">
                      {ex?.vendor || <span className="text-gray-300">—</span>}
                      {d.linked_expense_id != null && (
                        <span className="block text-xs text-campo-600 mt-1">🔗 Vinculado a gasto #{d.linked_expense_id}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-gray-800">
                      {typeof ex?.total_amount === 'number'
                        ? formatAmount(ex.total_amount, ex.currency)
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell">
                      {ex?.invoice_number && <div>#{ex.invoice_number}</div>}
                      {ex?.date && <div className="text-gray-400">{ex.date}</div>}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs hidden lg:table-cell whitespace-nowrap">
                      <div className="truncate max-w-[180px]" title={d.original_filename || ''}>
                        {d.original_filename || `documento-${d.id}`}
                      </div>
                      <div className="text-gray-400">{formatBytes(d.file_size_bytes)} · {d.source_channel}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs ${status.color}`}>{status.label}</span>
                      {d.processing_error && (
                        <div className="text-xs text-red-500 truncate max-w-[160px]" title={d.processing_error}>
                          {d.processing_error}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <button
                        onClick={() => downloadFile(d.id, d.original_filename)}
                        className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline"
                      >
                        Descargar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <p className="text-sm text-gray-500">{data.total} documentos en total</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Anterior
                </button>
                <span className="text-sm text-gray-600">{page} / {data.totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                  disabled={page >= data.totalPages}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
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
