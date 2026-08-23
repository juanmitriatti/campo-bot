import { useState } from 'react';
import { AlertTriangle, Info, ChevronDown, RotateCcw } from 'lucide-react';
import type { Finding } from '../../hooks/useReviewFindings';

interface Props {
  findings: Finding[];
  hiddenCount: number;
  loading: boolean;
  onDismiss: (key: string) => void;
  onRestoreAll: () => void;
  onOpen: (ref: NonNullable<Finding['ref']>) => void;
}

/**
 * "Para revisar" — the card that assumes the bot got something wrong.
 *
 * Everything in campo-bot is dictated to a chat and parsed by an LLM, so the
 * dangerous failure is not a missing record but a plausible-looking wrong one.
 * The rules behind this live in services/review-findings.service.ts and are all
 * deterministic contradictions, never guesses.
 */
export default function ReviewPanel({ findings, hiddenCount, loading, onDismiss, onRestoreAll, onOpen }: Props) {
  const [open, setOpen] = useState<string | null>(findings[0]?.key ?? null);

  if (loading) {
    return (
      <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
        <div className="h-4 w-32 bg-gray-100 dark:bg-gray-700 rounded animate-pulse" />
      </section>
    );
  }

  const warnCount = findings.filter(f => f.severity === 'warn').length;

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-500 shrink-0" />
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Para revisar</h2>
        {findings.length > 0 && (
          <span className={`font-mono text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
            warnCount > 0
              ? 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800'
              : 'text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 border-gray-200 dark:border-gray-700'
          }`}>
            {findings.length}
          </span>
        )}
      </div>

      {findings.length === 0 ? (
        <div className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed mt-2">
          <p>No encontré nada raro en lo que cargaste esta campaña.</p>
          {hiddenCount > 0 && (
            <button
              onClick={onRestoreAll}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-campo-700 dark:text-campo-400 hover:underline"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Volver a mostrar {hiddenCount} {hiddenCount === 1 ? 'aviso oculto' : 'avisos ocultos'}
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed mb-3">
            Cosas que el bot pudo haber entendido mal. Corregirlas acá evita que se arrastren al reporte.
          </p>
          <div className="flex flex-col gap-2">
            {findings.map(f => {
              const isOpen = open === f.key;
              const warn = f.severity === 'warn';
              const Icon = warn ? AlertTriangle : Info;
              return (
                <div
                  key={f.key}
                  className={`rounded-lg border ${
                    warn
                      ? 'border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-900/20'
                      : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : f.key)}
                    aria-expanded={isOpen}
                    className="w-full flex items-start gap-2.5 text-left p-3 min-h-[44px]"
                  >
                    <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                      warn ? 'text-amber-600 dark:text-amber-500' : 'text-gray-400 dark:text-gray-500'
                    }`} />
                    <span className="flex-1 text-[13px] font-semibold text-gray-900 dark:text-gray-100 leading-snug">
                      {f.title}
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {isOpen && (
                    <div className="px-3 pb-3 pl-[34px]">
                      <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed text-pretty">{f.body}</p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2.5">
                        {f.ref && (
                          <button
                            onClick={() => onOpen(f.ref!)}
                            className={`text-xs font-semibold min-h-[32px] ${
                              warn ? 'text-amber-700 dark:text-amber-400' : 'text-campo-700 dark:text-campo-400'
                            } hover:underline`}
                          >
                            {f.action} →
                          </button>
                        )}
                        <button
                          onClick={() => onDismiss(f.key)}
                          className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 min-h-[32px]"
                        >
                          Está bien así
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {hiddenCount > 0 && (
            <button
              onClick={onRestoreAll}
              className="mt-3 inline-flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Ver {hiddenCount} {hiddenCount === 1 ? 'aviso oculto' : 'avisos ocultos'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
