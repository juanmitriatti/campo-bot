/**
 * TabHeader — título + explicación de una línea + hint opcional con ejemplo
 * copiable. Patrón sistémico: TODO tab del dashboard de usuario arranca con
 * esto (feedback Jul 2026: "Campos no tiene ninguna explicación de qué es").
 */
export default function TabHeader({ title, description, botHint }: {
  title: string;
  description: string;
  botHint?: string;
}) {
  return (
    <div className="mb-4">
      <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">{title}</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
      {botHint && (
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-1.5">
          💬 Pedile al bot:{' '}
          <span className="font-mono text-campo-700 dark:text-campo-400">"{botHint}"</span>
        </p>
      )}
    </div>
  );
}
