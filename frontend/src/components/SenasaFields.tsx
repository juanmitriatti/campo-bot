/**
 * Datos sanitarios del establecimiento: RENSPA, CUIG y titular.
 *
 * Los movimientos y las declaraciones ganaderas en Argentina se hacen contra el
 * establecimiento, identificado por su RENSPA. Las columnas existían en la base
 * desde la migración 116, pero sin esta pantalla nadie podía llenarlas — un dato
 * que no se puede cargar no es una función.
 *
 * NO se valida el formato a propósito: la máscara exacta de RENSPA y CUIG no
 * está publicada en fuente oficial primaria, y rechazar el número real de un
 * productor por una máscara inventada es peor que no validar. Ver
 * docs/ganaderia/senasa.md. El CII de la caravana sí se valida, porque su
 * estructura sí está en el texto de la Res. SENASA 530/2025.
 */
import { useState } from 'react';
import { apiRequest } from '../api/client';

interface FieldLike {
  id: number;
  renspa?: string | null;
  cuig?: string | null;
  senasa_titular?: string | null;
}

export default function SenasaFields({ field, onSaved }: { field: FieldLike; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [renspa, setRenspa] = useState(field.renspa ?? '');
  const [cuig, setCuig] = useState(field.cuig ?? '');
  const [titular, setTitular] = useState(field.senasa_titular ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargado = !!(field.renspa || field.cuig || field.senasa_titular);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/fields/${field.id}`, {
        method: 'PATCH',
        body: { renspa: renspa.trim(), cuig: cuig.trim(), senasa_titular: titular.trim() },
      });
      setOpen(false);
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'No pude guardar');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <p className="text-xs mt-1 flex items-center gap-1.5 flex-wrap">
        {cargado ? (
          <span className="inline-flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
            🏛️ {field.renspa ? <>RENSPA <span className="font-mono">{field.renspa}</span></> : 'sin RENSPA'}
            {field.cuig && <> · CUIG <span className="font-mono">{field.cuig}</span></>}
          </span>
        ) : (
          <span className="text-gray-400 dark:text-gray-500">🏛️ Sin datos de SENASA</span>
        )}
        <button
          onClick={() => setOpen(true)}
          className="text-campo-700 dark:text-campo-400 hover:underline"
          title="RENSPA, CUIG y titular sanitario"
        >
          {cargado ? 'editar' : 'agregar RENSPA / CUIG'}
        </button>
      </p>
    );
  }

  const input = 'w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-2 py-1.5 text-xs focus:ring-2 focus:ring-campo-500 outline-none';

  return (
    <div className="mt-2 max-w-md space-y-2 border-l-2 border-campo-200 dark:border-campo-800 pl-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Datos del establecimiento ante SENASA. Se guardan tal cual los escribas.
      </p>
      <div className="space-y-1.5">
        <label className="block">
          <span className="text-xs text-gray-500 dark:text-gray-400">RENSPA</span>
          <input value={renspa} onChange={e => setRenspa(e.target.value)} className={input} placeholder="Nº de RENSPA del establecimiento" autoFocus />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500 dark:text-gray-400">CUIG</span>
          <input value={cuig} onChange={e => setCuig(e.target.value)} className={input} placeholder="Clave Única de Identificación Ganadera" />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500 dark:text-gray-400">Titular sanitario</span>
          <input value={titular} onChange={e => setTitular(e.target.value)} className={input} placeholder="Responsable sanitario del establecimiento" />
        </label>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button onClick={() => void save()} disabled={saving} className="text-xs bg-campo-600 text-white rounded-md px-3 py-1 disabled:opacity-50 hover:bg-campo-700">
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
        <button onClick={() => setOpen(false)} className="text-xs text-gray-500 dark:text-gray-400">Cancelar</button>
      </div>
    </div>
  );
}
