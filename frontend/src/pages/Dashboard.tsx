import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import ObservationTable from '../components/ObservationTable';

export default function Dashboard() {
  const { user, plan, features } = useAuth();

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Profile card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Mi perfil</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Nombre</p>
              <p className="text-sm font-medium text-gray-800 mt-0.5">{user.name || '-'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Email</p>
              <p className="text-sm font-medium text-gray-800 mt-0.5">{user.email || '-'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Plan</p>
              <p className="text-sm font-medium text-gray-800 mt-0.5">
                {plan?.display_name || 'Sin plan'}
              </p>
            </div>
          </div>

          {features.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Funcionalidades</p>
              <div className="flex flex-wrap gap-1.5">
                {features.map(f => (
                  <span key={f} className="text-xs bg-campo-100 text-campo-700 px-2 py-0.5 rounded">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Observations */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-800">Mis observaciones</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Observaciones agronómicas registradas por WhatsApp
            </p>
          </div>
          <ObservationTable />
        </div>
      </main>
    </div>
  );
}
