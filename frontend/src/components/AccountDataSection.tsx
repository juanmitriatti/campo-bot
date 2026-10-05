import { useState } from 'react';
import { apiRequest, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';

/**
 * Exportar y borrar la cuenta desde "Mi cuenta" (DSH-12). Los endpoints
 * (`GET /me/export`, `DELETE /me`) existían pero ninguna pantalla los usaba, y
 * el paywall de prueba vencida manda a Mi cuenta justamente para esto.
 */
export default function AccountDataSection() {
  const { logout } = useAuth();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmStep, setConfirmStep] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const download = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/auth/me/export', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error('No pude preparar la descarga. Probá de nuevo en un rato.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `campo-bot-mis-datos-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'No pude preparar la descarga.');
    } finally {
      setDownloading(false);
    }
  };

  const deleteAccount = async () => {
    if (!confirmStep) { setConfirmStep(true); return; }
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiRequest('/me', { method: 'DELETE', body: { password } });
      logout();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'No pude borrar la cuenta.');
      setConfirmStep(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5 space-y-5">
      <div>
        <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Tus datos</h3>
        <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">
          Descargá todo lo que cargaste (gastos, ingresos, actividades, lluvias, hacienda) en planillas CSV dentro de un ZIP.
        </p>
        <button
          type="button"
          onClick={download}
          disabled={downloading}
          className="mt-3 px-4 py-2 border border-campo-600 text-campo-700 dark:text-campo-400 rounded-md text-sm font-medium hover:bg-campo-50 dark:hover:bg-campo-900/30 disabled:opacity-50"
        >
          {downloading ? 'Preparando…' : 'Descargar mis datos'}
        </button>
        {downloadError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{downloadError}</p>}
      </div>

      <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
        <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Borrar la cuenta</h3>
        <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">
          Se borran tus datos personales y se corta cualquier cobro. Te conviene descargar tus datos antes.
        </p>
        {!deleteOpen ? (
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="mt-3 px-4 py-2 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 rounded-md text-sm font-medium hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            Borrar mi cuenta
          </button>
        ) : (
          <div className="mt-3 space-y-2 max-w-sm">
            <label htmlFor="delete-account-password" className="block text-xs font-medium text-gray-600 dark:text-gray-300">Contraseña actual</label>
            <input
              id="delete-account-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => { setPassword(e.target.value); setConfirmStep(false); }}
              disabled={deleting}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
            />
            {confirmStep && (
              <p className="text-xs text-red-700 dark:text-red-400">¿Seguro? Esto no se puede deshacer. Tocá de nuevo para confirmar.</p>
            )}
            {deleteError && <p className="text-xs text-red-600 dark:text-red-400">{deleteError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={deleteAccount}
                disabled={deleting || !password}
                className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Borrando…' : confirmStep ? 'Sí, borrar todo' : 'Borrar mi cuenta'}
              </button>
              <button
                type="button"
                onClick={() => { setDeleteOpen(false); setPassword(''); setConfirmStep(false); setDeleteError(null); }}
                disabled={deleting}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
