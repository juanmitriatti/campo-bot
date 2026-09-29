import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { joinField } from '../api/sharing';

/**
 * Invitación a un campo que llegó por el link de registro
 * (`/register?invite=CODIGO`, armado en src/domain/sharing/invite-link.ts).
 *
 * La invitación está atada a un teléfono y una cuenta creada por la web no
 * tiene ninguno hasta que vincula WhatsApp. Por eso el código se guarda al
 * entrar a /register (o /login) y se canjea recién cuando el dashboard ve el
 * WhatsApp vinculado. localStorage y no sessionStorage: la verificación del
 * email o el OTP pueden terminar en otra pestaña.
 */
const KEY = 'campo:pendingInvite';
const CODE_RE = /^[A-Za-z0-9]{6}$/;

export function savePendingInviteFromUrl(search: string): string | null {
  const code = new URLSearchParams(search).get('invite')?.trim().toUpperCase() ?? '';
  if (!CODE_RE.test(code)) return null;
  try { localStorage.setItem(KEY, code); } catch { /* storage bloqueado */ }
  return code;
}

function readPendingInvite(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

function clearPendingInvite(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export interface PendingInviteNotice {
  kind: 'joined' | 'waiting' | 'error';
  text: string;
}

/**
 * `whatsappVerified`: null mientras no se sabe. Con false deja el aviso de
 * "vinculá tu WhatsApp"; con true canjea el código una sola vez.
 */
export function usePendingInvite(whatsappVerified: boolean | null) {
  const [notice, setNotice] = useState<PendingInviteNotice | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    const code = readPendingInvite();
    if (!code || whatsappVerified == null) return;
    if (!whatsappVerified) {
      setNotice({ kind: 'waiting', text: 'Te invitaron a un campo. Vinculá tu WhatsApp y entrás automáticamente.' });
      return;
    }
    if (attempted.current) return;
    attempted.current = true;
    joinField(code)
      .then((r) => {
        clearPendingInvite();
        setNotice({ kind: 'joined', text: `Ahora tenés acceso al campo ${r.fieldName}.` });
      })
      .catch((err: unknown) => {
        // NEEDS_PHONE con WhatsApp "verificado" = carrera con el status; se
        // reintenta en la próxima carga. Cualquier otro rechazo es definitivo
        // (usado, vencido, cancelado, otro número): se muestra y se descarta.
        if (err instanceof ApiError && err.code === 'NEEDS_PHONE') {
          attempted.current = false;
          setNotice({ kind: 'waiting', text: err.message });
          return;
        }
        clearPendingInvite();
        setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'No pude aceptar la invitación.' });
      });
  }, [whatsappVerified]);

  return { notice, dismiss: () => setNotice(null) };
}
