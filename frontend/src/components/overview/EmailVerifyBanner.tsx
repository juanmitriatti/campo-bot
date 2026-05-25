import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiRequest } from '../../api/client';

interface VerifyStatus { email: string | null; emailVerified: boolean }

const DISMISS_KEY = 'campo:emailVerifyDismissedUntil';
const DISMISS_DAYS = 14;

function isDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = localStorage.getItem(DISMISS_KEY);
  if (!raw) return false;
  const until = parseInt(raw, 10);
  if (isNaN(until)) return false;
  return Date.now() < until;
}

export default function EmailVerifyBanner() {
  const [status, setStatus] = useState<VerifyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(isDismissed);

  useEffect(() => {
    apiRequest<VerifyStatus>('/verify-email/status')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (!status || !status.email || status.emailVerified || dismissed) return null;

  const resend = async () => {
    setBusy(true);
    try {
      await apiRequest('/resend-verification', { method: 'POST' });
      setSentAt(Date.now());
    } catch {
      // no-op; user can retry
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    const until = Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000;
    localStorage.setItem(DISMISS_KEY, String(until));
    setDismissed(true);
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-300">
      <div className="flex items-center gap-2 min-w-0">
        <span>📧</span>
        <span className="truncate">
          <strong>Verificá tu email</strong> — te mandamos un link a <span className="font-mono">{status.email}</span>.
          {sentAt ? ' Reenviamos un email nuevo, revisá tu bandeja.' : ' Si no llegó, podemos reenviarlo.'}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={resend}
          disabled={busy}
          className="text-sm font-medium underline hover:no-underline disabled:opacity-50"
        >
          {busy ? 'Reenviando…' : 'Reenviar'}
        </button>
        <button
          onClick={dismiss}
          aria-label="Ocultar por 14 días"
          title="Ocultar por 14 días"
          className="text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
