import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Storage key used by Dashboard to show a one-shot welcome toast on first
// arrival after registering.
const POST_REGISTER_FLAG = 'campo:postRegisterToast';

export default function Register() {
  const [name, setName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // Toggle that flips after the first failed submit. While `false`, we don't
  // show an inline error for short passwords (user is still typing). After a
  // failed submit, we show the hint live until the input is valid.
  const [showPasswordError, setShowPasswordError] = useState(false);
  const { register, error, clearError } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    if (password.length < 8) {
      setShowPasswordError(true);
      return;
    }

    setLoading(true);
    try {
      // Sin selector de plan (Jul 2026): todos arrancan con el trial completo
      // (el backend ignora plan_id — elegir Enterprise gratis era un agujero).
      await register(name, email, password, undefined, lastName || undefined);
      // Drop a one-shot flag so the dashboard can show the welcome toast.
      try { sessionStorage.setItem(POST_REGISTER_FLAG, email); } catch { /* SSR */ }
      navigate('/dashboard');
    } catch {
      // Error already set in context
    } finally {
      setLoading(false);
    }
  };

  // The backend returns "Ya existe una cuenta con este email" verbatim — when
  // we see that exact text we render a recovery link inside the error box.
  const isDuplicateEmailError = !!error && /ya existe.*cuenta.*email/i.test(error);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <a href="/" className="inline-block">
            <h1 className="text-3xl font-bold text-campo-700">Campo Bot</h1>
          </a>
          <p className="text-gray-500 mt-1">Creá tu cuenta</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-md p-6 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-3 py-2">
              <p>{error}</p>
              {isDuplicateEmailError && (
                <p className="mt-1.5 text-xs">
                  <Link to="/login" className="font-medium underline hover:no-underline">Iniciá sesión</Link>
                  {' o '}
                  <Link to="/forgot-password" className="font-medium underline hover:no-underline">recuperá tu contraseña</Link>.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                Nombre
              </label>
              <input
                id="name"
                type="text"
                required
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                placeholder="Juan"
              />
            </div>
            <div>
              <label htmlFor="lastName" className="block text-sm font-medium text-gray-700 mb-1">
                Apellido <span className="text-gray-400 font-normal">(opcional)</span>
              </label>
              <input
                id="lastName"
                type="text"
                value={lastName}
                onChange={e => setLastName(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                placeholder="Pérez"
              />
            </div>
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
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

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Contraseña
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                value={password}
                onChange={e => {
                  setPassword(e.target.value);
                  if (showPasswordError && e.target.value.length >= 8) setShowPasswordError(false);
                }}
                className={`w-full border rounded-md px-3 py-2 pr-16 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none ${
                  showPasswordError ? 'border-red-400' : 'border-gray-300'
                }`}
                placeholder="Mínimo 8 caracteres"
                aria-invalid={showPasswordError}
                aria-describedby={showPasswordError ? 'password-error' : undefined}
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                className="absolute inset-y-0 right-2 text-xs text-gray-500 hover:text-gray-700 px-1"
                aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              >
                {showPassword ? 'Ocultar' : 'Ver'}
              </button>
            </div>
            {showPasswordError && (
              <p id="password-error" className="mt-1 text-xs text-red-600">La contraseña tiene que tener al menos 8 caracteres.</p>
            )}
          </div>

          <div className="bg-campo-50 border border-campo-200 rounded-md px-3 py-2.5 text-sm text-campo-800">
            🎁 <span className="font-semibold">14 días gratis con todas las funciones</span> — agronomía, hacienda, stock, audios e IA. Sin tarjeta. Después elegís el plan que te quede cómodo.
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-campo-600 hover:bg-campo-700 text-white font-medium py-2.5 rounded-md text-sm disabled:opacity-50 transition-colors"
          >
            {loading ? 'Creando cuenta...' : 'Crear cuenta'}
          </button>

          <p className="text-center text-sm text-gray-500">
            ¿Ya tenés cuenta?{' '}
            <Link to="/login" className="text-campo-600 hover:text-campo-700 font-medium">
              Iniciá sesión
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
