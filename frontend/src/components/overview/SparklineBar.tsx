interface SparklineBarProps {
  current: number;
  previous: number;
  color: string; // tailwind bg class e.g. "bg-red-400"
}

export default function SparklineBar({ current, previous, color }: SparklineBarProps) {
  const max = Math.max(current, previous, 1);
  const currentPct = (current / max) * 100;
  const prevPct = (previous / max) * 100;

  return (
    <div className="flex items-end gap-1 h-6">
      <div
        className="w-3 bg-gray-200 rounded-sm"
        style={{ height: `${prevPct}%`, minHeight: 2 }}
        title={`Mes anterior: ${previous}`}
      />
      <div
        className={`w-3 ${color} rounded-sm`}
        style={{ height: `${currentPct}%`, minHeight: 2 }}
        title={`Este mes: ${current}`}
      />
    </div>
  );
}
