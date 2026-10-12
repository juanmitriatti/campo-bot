import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { QrCode } from 'lucide-react';

/**
 * "Escribile al bot" en Mi cuenta: un usuario que ya vinculó su WhatsApp o
 * Telegram pero no tiene agendado el contacto del bot no tenía cómo volver a
 * encontrarlo. Link directo + QR (para abrirlo en el celular desde la compu).
 * Los datos salen de /api/brand (useBrand): sin número/usuario configurado no
 * se muestra nada.
 */
interface Props {
  href: string;
  /** Texto del botón, ej. "Escribirle al bot por WhatsApp". */
  label: string;
  /** Cómo se ve el contacto, ej. "+5491178199790" o "@MiAgroBot". */
  handle: string;
  className: string;
}

export default function BotContactLink({ href, label, handle, className }: Props) {
  const [showQr, setShowQr] = useState(false);
  return (
    <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-block px-4 py-2 text-white rounded-md text-sm font-medium ${className}`}
        >
          {label}
        </a>
        <button
          type="button"
          onClick={() => setShowQr(v => !v)}
          aria-expanded={showQr}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <QrCode className="w-4 h-4" />
          {showQr ? 'Ocultar QR' : 'Ver QR'}
        </button>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-300">
        Contacto del bot: <span className="font-mono">{handle}</span>. Agendalo para encontrarlo rápido.
      </p>
      {showQr && (
        <div className="inline-block p-3 bg-white rounded-md border border-gray-200">
          {/* Fondo blanco siempre: un QR invertido en modo oscuro no lo leen todas las cámaras. */}
          <QRCodeSVG value={href} size={160} marginSize={1} />
          <p className="mt-1 text-[11px] text-gray-500 text-center">Escaneálo con la cámara del celular</p>
        </div>
      )}
    </div>
  );
}
