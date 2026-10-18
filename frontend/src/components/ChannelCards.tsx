import { useEffect, useState } from 'react';
import { apiRequest, ApiError } from '../api/client';
import { useBrand } from '../hooks/useBrand';
import BotContactLink from './BotContactLink';
import { QRCodeSVG } from 'qrcode.react';

export interface VerificationStatus {
  whatsapp_verified: boolean;
  telegram_verified: boolean;
  phone_number: string | null;
  telegram_id: string | null;
}

type WaStep = 'idle' | 'enter-phone' | 'enter-code' | 'send-to-bot' | 'success';

/** Respuesta de POST /verify/whatsapp/start (ver StartWhatsAppResult en el backend). */
interface StartWhatsAppResponse {
  expires_at: string;
  ttl_minutes: number;
  /** inbound: el usuario le manda el código AL bot (el bot no puede escribirle
   *  a quien nunca le habló — ventana de 24 h de Meta). outbound: lo recibe. */
  mode: 'inbound' | 'outbound';
  wa_link?: string;
  wa_text?: string;
  code?: string;
}

const WA_POLL_MS = 3000;

/**
 * Las tarjetas de vinculación de WhatsApp y Telegram. Viven en Mi cuenta y,
 * mientras el usuario no tiene ningún canal, también arriba del Resumen: el bot
 * solo funciona por chat y el primer paso no puede quedar escondido en un menú.
 * `onStatusChange` avisa cada vez que cambia el estado (vinculó o desvinculó).
 */
export default function ChannelCards({ onStatusChange }: { onStatusChange?: (s: VerificationStatus) => void } = {}) {
  const [status, setStatusState] = useState<VerificationStatus | null>(null);
  const setStatus = (s: VerificationStatus) => { setStatusState(s); onStatusChange?.(s); };

  // WhatsApp flow state
  const [waStep, setWaStep] = useState<WaStep>('idle');
  const [waPhone, setWaPhone] = useState('');
  const [waCode, setWaCode] = useState('');
  const [waExpiresAt, setWaExpiresAt] = useState<string | null>(null);
  const [waInbound, setWaInbound] = useState<{ link: string; text: string; code: string } | null>(null);
  const [waBusy, setWaBusy] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);

  // Telegram flow state
  const [tgLink, setTgLink] = useState<string | null>(null);
  const [tgBusy, setTgBusy] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);

  const brand = useBrand();
  const waBotNumber = brand.whatsapp_bot_number ?? '';
  const tgBotUser = brand.telegram_bot_username ?? '';

  const refreshStatus = async () => {
    try {
      const s = await apiRequest<VerificationStatus>('/verify/status');
      setStatus(s);
    } catch {
      // ignore
    }
  };

  useEffect(() => { void refreshStatus(); }, []);

  // Esperando que el usuario le mande el código al bot: el webhook vincula el
  // número y acá solo nos enteramos consultando el estado.
  useEffect(() => {
    if (waStep !== 'send-to-bot') return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const s = await apiRequest<VerificationStatus>('/verify/status');
        if (!alive || !s.whatsapp_verified) return;
        setStatus(s);
        setWaInbound(null);
        setWaStep('success');
        setTimeout(() => setWaStep('idle'), 4000);
      } catch { /* reintenta en el próximo tick */ }
    }, WA_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [waStep]);

  // ---------- WhatsApp ----------
  // Sin número (el default): el servidor da un código que vincula el WhatsApp
  // desde el que se mande. Si no hay número de bot configurado contesta
  // PHONE_REQUIRED y se pide el número (camino del código saliente).
  const startWhatsApp = async (withPhone: boolean) => {
    setWaError(null);
    if (withPhone && !waPhone.trim()) {
      setWaError('Ingresá tu número de WhatsApp.');
      return;
    }
    setWaBusy(true);
    try {
      const r = await apiRequest<StartWhatsAppResponse>(
        '/verify/whatsapp/start',
        { method: 'POST', body: withPhone ? { phone: waPhone.trim() } : {} },
      );
      setWaExpiresAt(r.expires_at);
      if (r.mode === 'inbound' && r.wa_link && r.wa_text && r.code) {
        setWaInbound({ link: r.wa_link, text: r.wa_text, code: r.code });
        setWaStep('send-to-bot');
      } else {
        setWaInbound(null);
        setWaStep('enter-code');
      }
    } catch (err) {
      if (!withPhone && err instanceof ApiError && err.code === 'PHONE_REQUIRED') {
        setWaStep('enter-phone');
        return;
      }
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

  return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
      {/* WhatsApp card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-[#25D366] flex items-center justify-center shrink-0">
              <svg viewBox="0 0 24 24" fill="white" className="w-6 h-6" aria-hidden="true">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">WhatsApp</h3>
              {status?.whatsapp_verified ? (
                <p className="text-sm text-green-700 mt-1">
                  ✅ Vinculado — <span className="font-mono">{status.phone_number}</span>
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">No vinculado</p>
              )}
            </div>
          </div>
          {status?.whatsapp_verified && (
            <div className="flex gap-3 items-center">
              <button
                onClick={() => { setWaStep('enter-phone'); setWaPhone(''); setWaError(null); }}
                disabled={waBusy}
                className="text-xs text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white disabled:opacity-50"
                title="Si perdiste acceso a este WhatsApp, vinculá un número nuevo"
              >
                Cambiar número
              </button>
              <button
                onClick={unlinkWhatsApp}
                disabled={waBusy}
                className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Desvincular
              </button>
            </div>
          )}
        </div>

        {!status?.whatsapp_verified && waStep === 'idle' && (
          <button
            onClick={() => startWhatsApp(false)}
            disabled={waBusy}
            className="mt-4 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {waBusy ? 'Generando…' : 'Vincular WhatsApp'}
          </button>
        )}

        {waStep === 'enter-phone' && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
              Tu número de WhatsApp
            </label>
            <input
              type="tel"
              value={waPhone}
              onChange={e => setWaPhone(e.target.value)}
              placeholder="+54 9 11 1234 5678"
              className="w-full max-w-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
              disabled={waBusy}
            />
            <p className="text-xs text-gray-500 dark:text-gray-300">
              Te vamos a dar un código para que le mandes al bot desde este número.
            </p>
            {waError && <p className="text-xs text-red-600">{waError}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => startWhatsApp(true)}
                disabled={waBusy}
                className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {waBusy ? 'Generando…' : 'Continuar'}
              </button>
              <button
                onClick={() => { setWaStep('idle'); setWaError(null); }}
                disabled={waBusy}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {waStep === 'enter-code' && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
              Pegá el código que te llegó por WhatsApp
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={waCode}
              onChange={e => setWaCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="w-32 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-lg tracking-widest text-center font-mono focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
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
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cambiar número
              </button>
            </div>
          </div>
        )}

        {waStep === 'send-to-bot' && waInbound && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-gray-700 dark:text-gray-200">
              Mandale este mensaje al bot{' '}
              {waPhone.trim()
                ? <span className="font-semibold">desde el WhatsApp {waPhone.trim()}</span>
                : <>desde el WhatsApp que querés vincular</>}:
            </p>
            <p className="inline-block px-3 py-2 rounded-md bg-gray-100 dark:bg-gray-700 font-mono text-lg tracking-wide text-gray-900 dark:text-gray-100">
              {waInbound.text}
            </p>
            <div>
              <a
                href={waInbound.link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700"
              >
                Abrir WhatsApp y enviar
              </a>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-300">
              Se abre el chat con el bot con el mensaje ya escrito: solo tocá enviar.
            </p>
            <div className="inline-block p-3 bg-white rounded-md border border-gray-200">
              {/* Desde la compu: se escanea con el celular y abre el chat con el mensaje escrito. */}
              <QRCodeSVG value={waInbound.link} size={160} marginSize={1} />
              <p className="mt-1 text-[11px] text-gray-500 text-center">¿Estás en la compu? Escaneálo con el celular</p>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-300 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Esperando tu mensaje… esta pantalla se actualiza sola.
              {waExpiresAt && (
                <> El código vence a las {new Date(waExpiresAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}.</>
              )}
            </p>
            <button
              onClick={() => { setWaStep('idle'); setWaInbound(null); setWaError(null); }}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancelar
            </button>
          </div>
        )}

        {status?.whatsapp_verified && waBotNumber && waStep === 'idle' && (
          <BotContactLink
            href={`https://wa.me/${waBotNumber}?text=${encodeURIComponent('Hola')}`}
            label="Escribirle al bot por WhatsApp"
            handle={`+${waBotNumber}`}
            className="bg-green-600 hover:bg-green-700"
          />
        )}

        {waStep === 'success' && (
          <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-md">
            <p className="text-sm text-green-800 dark:text-green-300">✅ ¡Listo! Ya podés escribirle al bot por WhatsApp.</p>
          </div>
        )}
      </div>

      {/* Telegram card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-[#229ED9] flex items-center justify-center shrink-0">
              <svg viewBox="0 0 24 24" fill="white" className="w-6 h-6" aria-hidden="true">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">Telegram</h3>
              {status?.telegram_verified ? (
                <p className="text-sm text-green-700 mt-1">
                  ✅ Vinculado — <span className="font-mono">{status.telegram_id}</span>
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">No vinculado</p>
              )}
            </div>
          </div>
          {status?.telegram_verified && (
            <div className="flex gap-3 items-center">
              <button
                onClick={startTelegram}
                disabled={tgBusy}
                className="text-xs text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white disabled:opacity-50"
                title="Si perdiste acceso a este Telegram, generá un link nuevo"
              >
                Vincular otra cuenta
              </button>
              <button
                onClick={unlinkTelegram}
                disabled={tgBusy}
                className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Desvincular
              </button>
            </div>
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
                <p className="text-xs text-gray-500 dark:text-gray-300">
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

        {status?.telegram_verified && tgBotUser && (
          <BotContactLink
            href={`https://t.me/${tgBotUser}`}
            label="Escribirle al bot por Telegram"
            handle={`@${tgBotUser}`}
            className="bg-blue-500 hover:bg-blue-600"
          />
        )}
      </div>
      </div>
  );
}
