import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client';

interface Report {
  id: number;
  fieldId: number;
  plotId: number | null;
  fieldName: string | null;
  plotName: string | null;
  weekNumber: number;
  year: number;
  createdAt: string;
}

interface ListResponse {
  reports: Report[];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function scopeLabel(r: Report): string {
  const field = r.fieldName || `Campo #${r.fieldId}`;
  if (r.plotName) return `${field} › ${r.plotName}`;
  if (r.plotId) return `${field} › Lote #${r.plotId}`;
  return field;
}

function periodLabel(r: Report): string {
  return `Semana ${r.weekNumber} — ${r.year}`;
}

export default function ReportTable() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await apiRequest<ListResponse>('/reports');
        if (!cancelled) setReports(res.reports);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error al cargar reportes');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDownload = async (report: Report) => {
    setDownloading(report.id);
    setError(null);
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch(`/api/auth/reports/${report.id}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const maybeJson = await res.json().catch(() => null);
        throw new Error(maybeJson?.error || `Error ${res.status} al descargar`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reporte-${scopeLabel(report).replace(/[^\w-]+/g, '-')}-W${report.weekNumber}-${report.year}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al descargar reporte');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Reportes agronómicos</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">PDFs generados desde el bot (se conservan 30 días)</span>
      </div>

      {loading && <div className="text-sm text-gray-500 dark:text-gray-400">Cargando reportes…</div>}

      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-3 mb-3">
          {error}
        </div>
      )}

      {!loading && reports.length === 0 && !error && (
        <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 rounded-md p-6 text-center border border-dashed border-gray-300 dark:border-gray-600">
          Todavía no tenés reportes generados. Pedile al bot:
          <br />
          <span className="font-mono text-gray-700 dark:text-gray-200">"reporte agro del campo X"</span> o
          <span className="font-mono text-gray-700"> "reporte agro del lote A1"</span>
        </div>
      )}

      {!loading && reports.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 pr-3">Alcance</th>
                <th className="py-2 pr-3">Período</th>
                <th className="py-2 pr-3 hidden md:table-cell">Generado</th>
                <th className="py-2 pr-3 text-right">PDF</th>
              </tr>
            </thead>
            <tbody>
              {reports.map(r => (
                <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700">
                  <td className="py-2 pr-3 text-gray-800 dark:text-gray-100">{scopeLabel(r)}</td>
                  <td className="py-2 pr-3 text-gray-600 dark:text-gray-300">{periodLabel(r)}</td>
                  <td className="py-2 pr-3 text-gray-500 dark:text-gray-400 hidden md:table-cell">{formatDate(r.createdAt)}</td>
                  <td className="py-2 pr-3 text-right">
                    <button
                      onClick={() => handleDownload(r)}
                      disabled={downloading === r.id}
                      className="text-campo-600 hover:text-campo-800 text-xs font-medium disabled:opacity-50"
                    >
                      {downloading === r.id ? 'Descargando…' : 'Descargar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
