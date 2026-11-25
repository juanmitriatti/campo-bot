import { useChannelSetup } from '../context/ChannelSetupContext';

/**
 * TabHeader — título + explicación de una línea + hint opcional con ejemplo
 * copiable. Patrón sistémico: TODO tab del dashboard de usuario arranca con
 * esto (feedback Jul 2026: "Campos no tiene ninguna explicación de qué es").
 *
 * Sin WhatsApp/Telegram vinculado, el hint viene con el botón para vincular:
 * "Pedile al bot" solo, a alguien que todavía no puede hablarle, lo dejaba
 * buscando cómo cargar en la web.
 */
export default function TabHeader({ title, description, botHint }: {
  title: string;
  description: string;
  botHint?: string;
}) {
  const { needsChannel, goToAccount } = useChannelSetup();
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
      {botHint && needsChannel && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-amber-900 dark:text-amber-200">
          <span>Para hablarle al bot, primero conectá tu WhatsApp o Telegram.</span>
          <button
            type="button"
            onClick={goToAccount}
            className="px-3 py-1 rounded-md bg-campo-600 hover:bg-campo-700 text-white font-medium transition-colors"
          >
            Conectar WhatsApp
          </button>
        </div>
      )}
    </div>
  );
}
