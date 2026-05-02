import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

type Status = 'pending' | 'success' | 'error' | 'no-token';

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<Status>('pending');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setStatus('no-token');
      return;
    }
    (async () => {
      try {
        const res = await fetch('/api/auth/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || 'Token inválido o vencido.');
        }
        setStatus('success');
      } catch (err) {
        setErrorMsg((err as Error).message);
        setStatus('error');
      }
    })();
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-campo-700">Campo Bot</h1>
        </div>
        <div className="bg-white rounded-lg shadow-md p-6 text-sm text-gray-700 space-y-3 text-center">
          {status === 'pending' && <p>Verificando tu email…</p>}
          {status === 'success' && (
            <>
              <p className="text-green-700 text-lg">✅ Email verificado</p>
              <p>Tu cuenta queda activa. Ya podés ingresar.</p>
              <Link to="/login" className="block text-campo-600 hover:text-campo-700 font-medium">
                Ir al login
              </Link>
            </>
          )}
          {status === 'error' && (
            <>
              <p className="text-red-700">No pude verificar tu email.</p>
              {errorMsg && <p className="text-xs text-gray-500">{errorMsg}</p>}
              <p className="text-gray-500">Volvé a entrar a la app y pedí un link nuevo desde Mi cuenta.</p>
              <Link to="/login" className="block text-campo-600 hover:text-campo-700 font-medium">
                Volver al login
              </Link>
            </>
          )}
          {status === 'no-token' && (
            <>
              <p className="text-red-700">El link no es válido.</p>
              <Link to="/login" className="block text-campo-600 hover:text-campo-700 font-medium">
                Ir al login
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
