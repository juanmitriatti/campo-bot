import { Sparkles, User } from 'lucide-react';
import Markdown from './Markdown';
import { LIST_LABELS, type TruncationNote } from '../../api/dataAnalysis';

export interface ThreadTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Solo en respuestas: listas que el servidor recortó para entrar en el presupuesto. */
  truncated?: TruncationNote[];
}

interface Props {
  turns: ThreadTurn[];
  loading: boolean;
}

function truncationLine(notes: TruncationNote[]): string {
  return notes
    .map(n => `${n.kept} de ${n.total} ${LIST_LABELS[n.list] ?? n.list}`)
    .join(' · ');
}

/**
 * Hilo pregunta/respuesta. El usuario en texto plano; la IA en markdown.
 * La nota de recorte va pegada a la respuesta que la sufrió: el usuario tiene
 * que saber sobre qué filas se razonó.
 */
export default function AnalysisThread({ turns, loading }: Props) {
  if (turns.length === 0 && !loading) return null;
  return (
    <div className="space-y-3" aria-live="polite">
      {turns.map((t, i) => t.role === 'user' ? (
        <div key={i} className="flex gap-2 justify-end">
          <div className="max-w-[92%] md:max-w-[80%] rounded-2xl rounded-br-sm bg-campo-600 text-white px-4 py-2.5 text-sm whitespace-pre-wrap">
            {t.content}
          </div>
          <span className="shrink-0 w-7 h-7 rounded-full bg-campo-100 dark:bg-campo-900/40 text-campo-700 dark:text-campo-300 flex items-center justify-center mt-0.5" aria-hidden="true">
            <User className="w-4 h-4" />
          </span>
        </div>
      ) : (
        <div key={i} className="flex gap-2">
          <span className="shrink-0 w-7 h-7 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 flex items-center justify-center mt-0.5" aria-hidden="true">
            <Sparkles className="w-4 h-4" />
          </span>
          <div className="max-w-[92%] md:max-w-[85%] rounded-2xl rounded-bl-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-4 py-3">
            <Markdown text={t.content} />
            {t.truncated && t.truncated.length > 0 && (
              <p className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
                Se analizaron las últimas {truncationLine(t.truncated)}. Acotá el alcance (menos lotes) para ver todo.
              </p>
            )}
          </div>
        </div>
      ))}
      {loading && (
        <div className="flex gap-2 items-center">
          <span className="shrink-0 w-7 h-7 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 flex items-center justify-center" aria-hidden="true">
            <Sparkles className="w-4 h-4" />
          </span>
          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-campo-600" />
            Analizando tus datos… puede tardar hasta un minuto.
          </div>
        </div>
      )}
    </div>
  );
}
