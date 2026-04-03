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

export default function Register() {
  const [name, setName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selectedPlan, setSelectedPlan] = useState<number | undefined>(undefined);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [loading, setLoading] = useState(false);
  const { register, error, clearError } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    apiRequest<PlanOption[]>('/plans')
      .then(data => setPlans(data))
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    if (password.length < 8) return;

    setLoading(true);
    try {
      await register(name, email, password, selectedPlan, lastName || undefined);
      navigate('/dashboard');
    } catch {
      // Error already set in context
    } finally {
      setLoading(false);
    }
  };

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
              {error}
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
                Apellido
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
              onChange={e => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
              placeholder="Mínimo 8 caracteres"
            />
          </div>

          {/* Plan selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Plan</label>
            <div className="space-y-2">
              {plans.map(plan => (
                <label
                  key={plan.id}
                  className={`flex items-start gap-3 p-3 border rounded-md cursor-pointer transition-colors ${
                    selectedPlan === (plan.name === 'free' ? undefined : plan.id) ||
                    (selectedPlan === undefined && plan.name === 'free')
                      ? 'border-campo-500 bg-campo-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="plan"
                    checked={
                      selectedPlan === (plan.name === 'free' ? undefined : plan.id) ||
                      (selectedPlan === undefined && plan.name === 'free')
                    }
                    onChange={() => setSelectedPlan(plan.name === 'free' ? undefined : plan.id)}
                    className="mt-0.5 accent-campo-600"
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-800">{plan.display_name}</p>
                    <p className="text-xs text-gray-500">{PLAN_DESCRIPTIONS[plan.name] || ''}</p>
                  </div>
                </label>
              ))}
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
