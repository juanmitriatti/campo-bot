import { useState, useEffect, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api/client';

interface PlanOption {
  id: number;
  name: string;
  display_name: string;
  price_ars: number;
}

const PLAN_DESCRIPTIONS: Record<string, string> = {
  free: 'Gastos, ingresos y campos',
  pro: '+ Presupuestos, lluvias, clima, CSV',
  pro_plus: '+ Agronomía, IA, audio',
  enterprise: 'Todo + Campos compartidos',
};

// Storage key used by Dashboard to show a one-shot welcome toast on first
// arrival after registering.
const POST_REGISTER_FLAG = 'campo:postRegisterToast';

export default function Register() {
  const [name, setName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selectedPlan, setSelectedPlan] = useState<number | null>(null);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [loading, setLoading] = useState(false);
  // Toggle that flips after the first failed submit. While `false`, we don't
  // show an inline error for short passwords (user is still typing). After a
  // failed submit, we show the hint live until the input is valid.
  const [showPasswordError, setShowPasswordError] = useState(false);
  const { register, error, clearError } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    apiRequest<PlanOption[]>('/plans')
      .then(data => {
        setPlans(data);
        // Pick the free plan as the default selection so the radios always
        // show one option highlighted (previously the default was `undefined`
        // and we leaned on string comparisons to fake it).
        const freePlan = data.find(p => p.name === 'free');
        if (freePlan) setSelectedPlan(freePlan.id);
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    if (password.length < 8) {
      setShowPasswordError(true);
      return;
    }

    setLoading(true);
    try {
      await register(name, email, password, selectedPlan ?? undefined, lastName || undefined);
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
          <h1 className="text-3xl font-bold text-campo-700">Campo Bot</h1>
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
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={e => {
                setPassword(e.target.value);
                if (showPasswordError && e.target.value.length >= 8) setShowPasswordError(false);
              }}
              className={`w-full border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none ${
                showPasswordError ? 'border-red-400' : 'border-gray-300'
              }`}
              placeholder="Mínimo 8 caracteres"
              aria-invalid={showPasswordError}
              aria-describedby={showPasswordError ? 'password-error' : undefined}
            />
            {showPasswordError && (
              <p id="password-error" className="mt-1 text-xs text-red-600">La contraseña tiene que tener al menos 8 caracteres.</p>
            )}
          </div>

          {/* Plan selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Plan</label>
            <div className="space-y-2">
              {plans.map(plan => {
                const isSelected = selectedPlan === plan.id;
                return (
                  <label
                    key={plan.id}
                    className={`flex items-start gap-3 p-3 border rounded-md cursor-pointer transition-colors ${
                      isSelected ? 'border-campo-500 bg-campo-50' : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="plan"
                      checked={isSelected}
                      onChange={() => setSelectedPlan(plan.id)}
                      className="mt-0.5 accent-campo-600"
                    />
                    <div>
                      <p className="text-sm font-medium text-gray-800">{plan.display_name}</p>
                      <p className="text-xs text-gray-500">{PLAN_DESCRIPTIONS[plan.name] || ''}</p>
                    </div>
                  </label>
                );
              })}
            </div>
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
