import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import ObservationTable from '../components/ObservationTable';
import ActivityTable from '../components/ActivityTable';
import ExpenseTable from '../components/ExpenseTable';
import IncomeTable from '../components/IncomeTable';

type Tab = 'observations' | 'activities' | 'expenses' | 'incomes';

const TABS: { key: Tab; label: string }[] = [
  { key: 'observations', label: 'Observaciones' },
  { key: 'activities', label: 'Actividades' },
  { key: 'expenses', label: 'Gastos' },
  { key: 'incomes', label: 'Ingresos' },
];

export default function Dashboard() {
  const { user, plan, features } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('observations');

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

        {/* Tabs */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex gap-6">
              {TABS.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`pb-2 text-sm font-semibold border-b-2 transition-colors ${
                    activeTab === tab.key
                      ? 'border-campo-600 text-campo-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          {activeTab === 'observations' && <ObservationTable />}
          {activeTab === 'activities' && <ActivityTable />}
          {activeTab === 'expenses' && <ExpenseTable />}
          {activeTab === 'incomes' && <IncomeTable />}
        </div>
      </main>
    </div>
  );
}
