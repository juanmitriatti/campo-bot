import { useEffect, useState } from 'react';
import { apiRequest } from '../../api/client';

interface VerifyStatus { email: string | null; emailVerified: boolean }

export default function EmailVerifyBanner() {
  const [status, setStatus] = useState<VerifyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);

  useEffect(() => {
    apiRequest<VerifyStatus>('/verify-email/status')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (!status || !status.email || status.emailVerified) return null;

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

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <div className="flex items-center gap-2">
        <span>📧</span>
        <span>
          <strong>Verificá tu email</strong> — te mandamos un link a <span className="font-mono">{status.email}</span>.
          {sentAt ? ' Reenviamos un email nuevo, revisá tu bandeja.' : ' Si no llegó, podemos reenviarlo.'}
        </span>
      </div>
      <button
        onClick={resend}
        disabled={busy}
        className="text-sm font-medium underline hover:no-underline disabled:opacity-50"
      >
        {busy ? 'Reenviando…' : 'Reenviar'}
      </button>
    </div>
  );
}
