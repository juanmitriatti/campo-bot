import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'No pudimos procesar el pedido.');
      }
      setSubmitted(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <a href="/" className="inline-block"><h1 className="text-3xl font-bold text-campo-700">Campo Bot</h1></a>
          <p className="text-gray-500 mt-1">Recuperá tu contraseña</p>
        </div>

        {submitted ? (
          <div className="bg-white rounded-lg shadow-md p-6 space-y-4 text-sm text-gray-700">
            <p>
              Si <span className="font-medium">{email}</span> está registrado, te mandamos un email con un link para resetear tu contraseña.
            </p>
            <p className="text-gray-500">Revisá también la carpeta de spam.</p>
            <Link to="/login" className="block text-center text-campo-600 hover:text-campo-700 font-medium">
              Volver al login
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-md p-6 space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-3 py-2">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                placeholder="tu@email.com"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-campo-600 hover:bg-campo-700 text-white font-medium py-2.5 rounded-md text-sm disabled:opacity-50"
            >
              {loading ? 'Enviando…' : 'Enviarme el link'}
            </button>
            <p className="text-center text-xs text-gray-500">
              <Link to="/login" className="text-campo-600 hover:text-campo-700">
                Volver al login
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
