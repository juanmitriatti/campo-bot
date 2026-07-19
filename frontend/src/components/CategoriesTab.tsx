import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useCategories, type CategoryKind } from '../hooks/useCategories';
import TabHeader from './TabHeader';

const KIND_LABELS: Record<CategoryKind, string> = { expense: 'Gastos', income: 'Ingresos' };

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-AR');
}

function CategoriesTable({ kind }: { kind: CategoryKind }) {
  const { data, duplicates, loading, error, create, rename, remove, merge } = useCategories(kind);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [similarMatch, setSimilarMatch] = useState<{ id: number; name: string; proposedName: string } | null>(null);
  const [mergingId, setMergingId] = useState<number | null>(null);
  const [dismissedPairs, setDismissedPairs] = useState<Set<string>>(new Set());

  const onMerge = async (dropId: number, keepId: number) => {
    setMergingId(dropId);
    try { await merge(dropId, keepId); }
    catch (e) { setFeedback(e instanceof Error ? e.message : 'Error'); }
    finally { setMergingId(null); }
  };

  const onKeepSeparate = (dropId: number, keepId: number) => {
    setDismissedPairs(prev => new Set(prev).add(`${dropId}-${keepId}`));
  };

  const visibleDuplicates = duplicates.filter(p => !dismissedPairs.has(`${p.drop.id}-${p.keep.id}`));

  if (loading) return <p className="text-sm text-gray-500 dark:text-gray-300 p-4">Cargando…</p>;
  if (error) return <p className="text-sm text-red-700 dark:text-red-300 p-4">{error}</p>;

  const onCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const r = await create(name);
      if (r.created) {
        setNewName(''); setShowCreate(false); setFeedback(null);
      } else if ('similar' in r) {
        setSimilarMatch({ id: r.similar.id, name: r.similar.name, proposedName: r.proposedName });
      }
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : 'Error');
    }
  };

  const onUseExisting = () => {
    // The existing category is already in the catalog, nothing to create
    setSimilarMatch(null);
    setNewName(''); setShowCreate(false); setFeedback(null);
  };

  const onCreateAnyway = async () => {
    if (!similarMatch) return;
    try {
      const r = await create(similarMatch.proposedName, { confirmAsNew: true });
      if (r.created) {
        setSimilarMatch(null); setNewName(''); setShowCreate(false); setFeedback(null);
      }
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : 'Error');
    }
  };

  const onRename = async (id: number) => {
    try { await rename(id, editingName); setEditingId(null); setFeedback(null); }
    catch (e) { setFeedback(e instanceof Error ? e.message : 'Error'); }
  };

  const onDelete = async (id: number, usageInTx: number) => {
    if (usageInTx > 0) {
      const confirmed = window.confirm(`Esta categoría se usó en ${usageInTx} movimientos. ¿Eliminar igual? Los registros existentes conservan el nombre.`);
      if (!confirmed) return;
    }
    try { await remove(id); }
    catch (e) { setFeedback(e instanceof Error ? e.message : 'Error'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{KIND_LABELS[kind]}</h3>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 text-xs text-white bg-campo-600 hover:bg-campo-700 rounded-md px-3 py-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Nueva categoría
        </button>
      </div>

      {visibleDuplicates.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-300">💡 Posibles duplicados ({visibleDuplicates.length})</p>
          {visibleDuplicates.map(p => {
            const key = `${p.drop.id}-${p.keep.id}`;
            const isMerging = mergingId === p.drop.id;
            return (
              <div key={key} className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md p-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="flex-1 min-w-[200px] text-amber-800 dark:text-amber-200">
                  <strong>{p.keep.name}</strong> ({p.keep.usageCount} usos) ≈ <strong>{p.drop.name}</strong> ({p.drop.usageCount} usos)
                </span>
                <button
                  onClick={() => onMerge(p.drop.id, p.keep.id)}
                  disabled={isMerging}
                  className="bg-campo-600 text-white rounded-md px-2.5 py-1 disabled:opacity-50 hover:bg-campo-700"
                  title={`Reasigna los ${p.drop.usageCount} movimientos de "${p.drop.name}" a "${p.keep.name}" y elimina "${p.drop.name}"`}
                >
                  {isMerging ? 'Fusionando…' : `Fusionar en "${p.keep.name}"`}
                </button>
                <button
                  onClick={() => onKeepSeparate(p.drop.id, p.keep.id)}
                  className="text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white"
                >
                  Mantener separadas
                </button>
              </div>
            );
          })}
        </div>
      )}

      {feedback && <p className="text-xs text-red-700 dark:text-red-300">{feedback}</p>}

      {showCreate && !similarMatch && (
        <div className="flex gap-2 items-center bg-gray-50 dark:bg-gray-900 p-3 rounded-md">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Nombre de la categoría"
            className="flex-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5"
            autoFocus
          />
          <button onClick={onCreate} disabled={!newName.trim()} className="text-xs bg-campo-600 text-white rounded-md px-3 py-1.5 disabled:opacity-50">Crear</button>
          <button onClick={() => { setShowCreate(false); setNewName(''); }} className="text-xs text-gray-600 dark:text-gray-300">Cancelar</button>
        </div>
      )}

      {similarMatch && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md p-3 space-y-2">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Ya tenés una categoría parecida: <strong>{similarMatch.name}</strong>.
            ¿Querés usarla o crear <strong>{similarMatch.proposedName}</strong> como nueva?
          </p>
          <div className="flex gap-2 flex-wrap">
            <button onClick={onUseExisting} className="text-xs bg-campo-600 text-white rounded-md px-3 py-1.5">
              Usar "{similarMatch.name}"
            </button>
            <button onClick={onCreateAnyway} className="text-xs border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 text-gray-700 dark:text-gray-200">
              Crear "{similarMatch.proposedName}" igual
            </button>
            <button onClick={() => setSimilarMatch(null)} className="text-xs text-gray-500 dark:text-gray-400">
              Cancelar
            </button>
          </div>
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500 dark:text-gray-300 text-left border-b border-gray-200 dark:border-gray-700">
          <tr>
            <th className="py-2">Categoría</th>
            <th className="py-2 text-right">Usos</th>
            <th className="py-2">Último uso</th>
            <th className="py-2 text-right">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {data.map(c => (
            <tr key={c.id} className="border-b border-gray-100 dark:border-gray-800">
              <td className="py-2">
                {editingId === c.id ? (
                  <input
                    value={editingName}
                    onChange={e => setEditingName(e.target.value)}
                    className="text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1"
                    autoFocus
                  />
                ) : (
                  <span className="text-gray-800 dark:text-gray-100">{c.name}</span>
                )}
              </td>
              <td className="py-2 text-right text-gray-600 dark:text-gray-300">{c.usageCount}</td>
              <td className="py-2 text-gray-500 dark:text-gray-300">{fmtDate(c.lastUsedAt)}</td>
              <td className="py-2 text-right">
                {editingId === c.id ? (
                  <>
                    <button onClick={() => onRename(c.id)} className="text-xs text-campo-700 dark:text-campo-400 mr-2">Guardar</button>
                    <button onClick={() => setEditingId(null)} className="text-xs text-gray-500 dark:text-gray-300">Cancelar</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { setEditingId(c.id); setEditingName(c.name); }} className="text-gray-500 hover:text-gray-700 dark:text-gray-300 dark:hover:text-white mr-3" title="Renombrar">
                      <Pencil className="w-4 h-4 inline" />
                    </button>
                    <button onClick={() => onDelete(c.id, c.usageCount)} className="text-gray-500 hover:text-red-600 dark:text-gray-300 dark:hover:text-red-400" title="Eliminar">
                      <Trash2 className="w-4 h-4 inline" />
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {data.length === 0 && (
            <tr><td colSpan={4} className="py-6 text-center text-gray-400 dark:text-gray-300">Sin categorías</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function CategoriesTab() {
  const [kind, setKind] = useState<CategoryKind>('expense');
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 space-y-4">
      <TabHeader
        title="Categorías"
        description="Con esto se clasifican tus gastos e ingresos en los reportes. El bot las crea solo cuando registrás — acá podés renombrar, borrar o unir duplicadas (ej: 'Gasoil' y 'gas oil')."
      />
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {(['expense', 'income'] as const).map(k => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`px-3 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
              kind === k
                ? 'border-campo-600 text-campo-700 dark:text-campo-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-300 dark:hover:text-white'
            }`}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <CategoriesTable kind={kind} />
    </div>
  );
}
