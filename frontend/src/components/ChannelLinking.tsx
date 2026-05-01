import { useEffect, useState } from 'react';
import { apiRequest, ApiError } from '../api/client';

interface VerificationStatus {
  whatsapp_verified: boolean;
  telegram_verified: boolean;
  phone_number: string | null;
  telegram_id: string | null;
}

type WaStep = 'idle' | 'enter-phone' | 'enter-code' | 'success';

export default function ChannelLinking() {
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // WhatsApp flow state
  const [waStep, setWaStep] = useState<WaStep>('idle');
  const [waPhone, setWaPhone] = useState('');
  const [waCode, setWaCode] = useState('');
  const [waExpiresAt, setWaExpiresAt] = useState<string | null>(null);
  const [waBusy, setWaBusy] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);

  // Telegram flow state
  const [tgLink, setTgLink] = useState<string | null>(null);
  const [tgBusy, setTgBusy] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);

  const refreshStatus = async () => {
    try {
      const s = await apiRequest<VerificationStatus>('/verify/status');
      setStatus(s);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshStatus().finally(() => setLoading(false));
  }, []);

  // ---------- WhatsApp ----------
  const startWhatsApp = async () => {
    setWaError(null);
    if (!waPhone.trim()) {
      setWaError('Ingresá tu número de WhatsApp.');
      return;
    }
    setWaBusy(true);
    try {
      const r = await apiRequest<{ expires_at: string; ttl_minutes: number }>(
        '/verify/whatsapp/start',
        { method: 'POST', body: { phone: waPhone.trim() } },
      );
      setWaExpiresAt(r.expires_at);
      setWaStep('enter-code');
    } catch (err) {
      setWaError(err instanceof ApiError ? err.message : 'No pude iniciar la verificación.');
    } finally {
      setWaBusy(false);
    }
  };

  const confirmWhatsApp = async () => {
    setWaError(null);
    if (!/^\d{6}$/.test(waCode.trim())) {
      setWaError('El código tiene que ser de 6 dígitos.');
      return;
    }
    setWaBusy(true);
    try {
      const s = await apiRequest<VerificationStatus>(
        '/verify/whatsapp/confirm',
        { method: 'POST', body: { code: waCode.trim() } },
      );
      setStatus(s);
      setWaStep('success');
      setWaCode('');
      setTimeout(() => setWaStep('idle'), 2500);
    } catch (err) {
      setWaError(err instanceof ApiError ? err.message : 'No pude confirmar el código.');
    } finally {
      setWaBusy(false);
    }
  };

  const unlinkWhatsApp = async () => {
    if (!confirm('¿Seguro que querés desvincular WhatsApp? Vas a tener que verificar de nuevo si querés volver a usar el bot.')) return;
    setWaBusy(true);
    try {
      const s = await apiRequest<VerificationStatus>('/verify/whatsapp', { method: 'DELETE' });
      setStatus(s);
      setWaStep('idle');
      setWaPhone('');
    } catch (err) {
      setWaError(err instanceof ApiError ? err.message : 'No pude desvincular.');
    } finally {
      setWaBusy(false);
    }
  };

  // ---------- Telegram ----------
  const startTelegram = async () => {
    setTgError(null);
    setTgBusy(true);
    try {
      const r = await apiRequest<{ deep_link: string; expires_at: string }>(
        '/verify/telegram/start',
        { method: 'POST' },
      );
      setTgLink(r.deep_link);
    } catch (err) {
      setTgError(err instanceof ApiError ? err.message : 'No pude generar el link.');
    } finally {
      setTgBusy(false);
    }
  };

  const unlinkTelegram = async () => {
    if (!confirm('¿Seguro que querés desvincular Telegram?')) return;
    setTgBusy(true);
    try {
      const s = await apiRequest<VerificationStatus>('/verify/telegram', { method: 'DELETE' });
      setStatus(s);
      setTgLink(null);
    } catch (err) {
      setTgError(err instanceof ApiError ? err.message : 'No pude desvincular.');
    } finally {
      setTgBusy(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-gray-500">Cargando…</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-800">Mi cuenta</h2>
        <p className="text-sm text-gray-500 mt-1">
          Vinculá tu WhatsApp y/o Telegram para usar el bot desde tus chats.
        </p>
      </div>

      {/* WhatsApp card */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="text-3xl">💬</div>
            <div>
              <h3 className="font-semibold text-gray-800">WhatsApp</h3>
              {status?.whatsapp_verified ? (
                <p className="text-sm text-green-700 mt-1">
                  ✅ Vinculado — <span className="font-mono">{status.phone_number}</span>
                </p>
              ) : (
                <p className="text-sm text-gray-500 mt-1">No vinculado</p>
              )}
            </div>
          </div>
          {status?.whatsapp_verified && (
            <button
              onClick={unlinkWhatsApp}
              disabled={waBusy}
              className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
            >
              Desvincular
            </button>
          )}
        </div>

        {!status?.whatsapp_verified && waStep === 'idle' && (
          <button
            onClick={() => setWaStep('enter-phone')}
            className="mt-4 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700"
          >
            Vincular WhatsApp
          </button>
        )}

        {waStep === 'enter-phone' && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-medium text-gray-700">
              Tu número de WhatsApp
            </label>
            <input
              type="tel"
              value={waPhone}
              onChange={e => setWaPhone(e.target.value)}
              placeholder="+54 9 11 1234 5678"
              className="w-full max-w-xs border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
              disabled={waBusy}
            />
            <p className="text-xs text-gray-500">
              Te vamos a mandar un código de 6 dígitos a este número.
            </p>
            {waError && <p className="text-xs text-red-600">{waError}</p>}
            <div className="flex gap-2">
              <button
                onClick={startWhatsApp}
                disabled={waBusy}
                className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {waBusy ? 'Enviando…' : 'Enviar código'}
              </button>
              <button
                onClick={() => { setWaStep('idle'); setWaError(null); }}
                disabled={waBusy}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {waStep === 'enter-code' && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-medium text-gray-700">
              Pegá el código que te llegó por WhatsApp
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={waCode}
              onChange={e => setWaCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="w-32 border border-gray-300 rounded-md px-3 py-2 text-lg tracking-widest text-center font-mono focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
              disabled={waBusy}
            />
            {waExpiresAt && (
              <p className="text-xs text-gray-500">
                El código vence el {new Date(waExpiresAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}.
              </p>
            )}
            {waError && <p className="text-xs text-red-600">{waError}</p>}
            <div className="flex gap-2">
              <button
                onClick={confirmWhatsApp}
                disabled={waBusy}
                className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {waBusy ? 'Verificando…' : 'Confirmar'}
              </button>
              <button
                onClick={() => { setWaStep('enter-phone'); setWaCode(''); setWaError(null); }}
                disabled={waBusy}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                Cambiar número
              </button>
            </div>
          </div>
        )}

        {waStep === 'success' && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-md">
            <p className="text-sm text-green-800">✅ ¡Listo! Ya podés escribirle al bot por WhatsApp.</p>
          </div>
        )}
      </div>

      {/* Telegram card */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="text-3xl">✈️</div>
            <div>
              <h3 className="font-semibold text-gray-800">Telegram</h3>
              {status?.telegram_verified ? (
                <p className="text-sm text-green-700 mt-1">
                  ✅ Vinculado — <span className="font-mono">{status.telegram_id}</span>
                </p>
              ) : (
                <p className="text-sm text-gray-500 mt-1">No vinculado</p>
              )}
            </div>
          </div>
          {status?.telegram_verified && (
            <button
              onClick={unlinkTelegram}
              disabled={tgBusy}
              className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
            >
              Desvincular
            </button>
          )}
        </div>

        {!status?.telegram_verified && (
          <div className="mt-4 space-y-3">
            {!tgLink ? (
              <button
                onClick={startTelegram}
                disabled={tgBusy}
                className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
              >
                {tgBusy ? 'Generando…' : 'Generar link de vinculación'}
              </button>
            ) : (
              <div className="space-y-2">
                <a
                  href={tgLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600"
                >
                  Abrir Telegram y vincular
                </a>
                <p className="text-xs text-gray-500">
                  Tocá el botón. Se abre Telegram, tocás "Iniciar" y la cuenta queda vinculada automáticamente.
                </p>
                <button
                  onClick={refreshStatus}
                  className="text-xs text-campo-600 hover:underline"
                >
                  Ya vinculé, refrescar estado
                </button>
              </div>
            )}
            {tgError && <p className="text-xs text-red-600">{tgError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
