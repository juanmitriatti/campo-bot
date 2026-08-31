/**
 * Trazabilidad individual del rodeo: cuántas de las cabezas declaradas tienen
 * caravana vigente.
 *
 * Vive en la Vista ganadera porque es donde el productor mira el rodeo. Tener
 * las pantallas de animales solo en Recursos → Hacienda dejaba la capa
 * individual invisible para quien no supiera que existe.
 *
 * Con 0 identificados NO es un error: el modelo por grupos es el principal y la
 * mayoría trabaja así. Por eso el estado vacío explica para qué sirve y cómo
 * empezar, en vez de mostrar un cero rojo.
 */
import { Tag } from 'lucide-react';

export default function IndividualizationCard({ total, identified }: { total: number; identified: number }) {
  const pct = total > 0 ? Math.round((identified / total) * 100) : 0;
  const none = identified === 0;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-md bg-teal-50 dark:bg-teal-900/30">
            <Tag className="w-4 h-4 text-teal-600 dark:text-teal-400" />
          </span>
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">Trazabilidad individual</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">Animales con caravana electrónica</p>
          </div>
        </div>
        {!none && (
          <p className="text-sm text-gray-600 dark:text-gray-300 tabular-nums">
            <span className="text-xl font-semibold text-gray-900 dark:text-gray-50">{identified}</span>
            <span className="text-gray-400"> / {total}</span>
            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">({pct}%)</span>
          </p>
        )}
      </div>

      {none ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400 max-w-2xl">
          Todavía no cargaste ningún animal con caravana — y no hace falta: podés
          seguir manejando el rodeo por grupos. La identificación individual sirve
          para seguir un animal puntual: su historial, sus pesadas, su sanidad.
          Probá desde el bot con{' '}
          <em className="text-gray-600 dark:text-gray-300">
            «dar de alta una vaca con caravana 032 01 0000000101 en el lote …»
          </em>
          , o importá las lecturas del lector en <strong>Hacienda → Importar</strong>.
        </p>
      ) : (
        <>
          <div className="mt-3 h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
            <div
              className="h-full rounded-full bg-teal-500 dark:bg-teal-400"
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {identified < total
              ? `Quedan ${total - identified} cabezas sin identificar. Un rodeo parcialmente individualizado es un estado válido: los grupos siguen funcionando igual.`
              : 'Todo el rodeo declarado tiene caravana.'}
          </p>
        </>
      )}
    </div>
  );
}
