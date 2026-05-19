import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface RainfallData {
  date: string;
  label: string;
  mm: number;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 shadow-lg text-sm">
      <p className="font-semibold text-gray-700 dark:text-gray-200 mb-1">{label}</p>
      <p className="text-blue-600">{payload[0].value} mm</p>
    </div>
  );
};

export default function RainfallChart({ data }: { data: RainfallData[] }) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Lluvias - Últimos 30 días</h3>
        <p className="text-sm text-gray-400 dark:text-gray-300 py-8 text-center">Sin registros de lluvia</p>
      </div>
    );
  }

  const totalMm = data.reduce((sum, d) => sum + d.mm, 0);
  const maxMm = Math.max(...data.map(d => d.mm));

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Lluvias - Últimos 30 días</h3>
        <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-1 rounded-full">
          {totalMm.toFixed(1)} mm total
        </span>
      </div>
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="colorRain" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.4} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11 }}
            interval={data.length > 15 ? Math.floor(data.length / 8) : 0}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            width={40}
            domain={[0, Math.ceil(maxMm * 1.1)]}
            tickFormatter={(v: number) => `${v}`}
            label={{ value: 'mm', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: '#9ca3af' } }}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey="mm" fill="url(#colorRain)" radius={[3, 3, 0, 0]} maxBarSize={20} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
