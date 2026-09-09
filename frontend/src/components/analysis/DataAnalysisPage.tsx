import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Send } from 'lucide-react';
import TabHeader from '../TabHeader';
import FieldChips from '../overview/FieldChips';
import CampaignPicker from '../overview/CampaignPicker';
import PlotChips from './PlotChips';
import AnalysisThread, { type ThreadTurn } from './AnalysisThread';
import { useFieldsTree } from '../../hooks/useFieldsTree';
import { useSelectedField } from '../../hooks/useSelectedField';
import { useSelectedCampaign } from '../../hooks/useSelectedCampaign';
import { useOverviewData } from '../../hooks/useOverviewData';
import { ApiError } from '../../api/client';
import { fetchAiQuota, postAnalysis, type AiQuota } from '../../api/dataAnalysis';

const SUGGESTIONS = [
  '¿Qué categoría de gasto creció más esta campaña?',
  'Comparame el margen por lote',
  '¿Cuánto llovió por mes y cómo se relaciona con el rinde?',
  '¿Qué lote tiene el peor resultado por hectárea y por qué?',
  'Resumime los ingresos por producto con precio promedio',
  '¿Qué gastos no tienen lote asignado?',
];

const MAX_QUESTION = 1000;
const MAX_HISTORY_ITEMS = 12; // 6 repreguntas × (pregunta + respuesta)

type Status = 'idle' | 'loading' | 'error' | 'quota';

const card = 'bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4';

/**
 * Análisis de datos: alcance (campo, lotes, campaña) → pregunta → hilo con
 * respuestas en markdown. El hilo vive acá (estado React), no se guarda: cada
 * repregunta viaja con las anteriores como `history`.
 */
export default function DataAnalysisPage() {
  const { fields, loading: fieldsLoading, error: fieldsError } = useFieldsTree();
  const [fieldId, setFieldId] = useSelectedField();
  const [season, setSeason] = useSelectedCampaign();
  const { data: overview } = useOverviewData(fieldId, season);

  const [plotIds, setPlotIds] = useState<number[] | null>(null);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<ThreadTurn[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<AiQuota | null>(null);
  const [scopeChanged, setScopeChanged] = useState(false);
  const lastQuestion = useRef<string | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);

  const selectedField = useMemo(() => fields.find(f => f.id === fieldId) ?? null, [fields, fieldId]);
  const plots = selectedField?.plots ?? [];

  // Alcance del hilo abierto: si cambia, el hilo deja de tener sentido.
  const scopeKey = `${fieldId ?? 'all'}|${plotIds ? plotIds.join(',') : 'all'}|${season ?? 'current'}`;
  const threadScope = useRef<string | null>(null);
  useEffect(() => {
    if (turns.length > 0 && threadScope.current && threadScope.current !== scopeKey) {
      setTurns([]);
      setScopeChanged(true);
      threadScope.current = null;
    }
  }, [scopeKey, turns.length]);

  // Cambiar de campo invalida los lotes elegidos.
  useEffect(() => { setPlotIds(null); }, [fieldId]);

  useEffect(() => {
    fetchAiQuota().then(r => setQuota(r.quota)).catch(() => { /* el pie es informativo */ });
  }, []);

  useEffect(() => {
    if (status === 'loading' || turns.length > 0) threadEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns.length, status]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || status === 'loading') return;
    lastQuestion.current = q;
    setScopeChanged(false);
    setError(null);
    setStatus('loading');
    const history = turns.slice(-MAX_HISTORY_ITEMS).map(t => ({ role: t.role, content: t.content }));
    setTurns(prev => [...prev, { role: 'user', content: q }]);
    setQuestion('');
    try {
      const res = await postAnalysis({
        field_id: fieldId ?? 'all',
        plot_ids: fieldId != null && plotIds ? plotIds : undefined,
        season,
        question: q,
        history,
      });
      threadScope.current = scopeKey;
      setTurns(prev => [...prev, { role: 'assistant', content: res.answer, truncated: res.truncated }]);
      setQuota(res.quota);
      setStatus('idle');
    } catch (err: unknown) {
      // La pregunta que falló se saca del hilo: "Reintentar" la vuelve a mandar.
      setTurns(prev => (prev.length > 0 && prev[prev.length - 1].role === 'user' ? prev.slice(0, -1) : prev));
      if (err instanceof ApiError && err.status === 429) {
        setError(err.message);
        setStatus('quota');
        fetchAiQuota().then(r => setQuota(r.quota)).catch(() => {});
        return;
      }
      setError(err instanceof Error ? err.message : 'No pude correr el análisis.');
      setStatus('error');
    }
  };

  const reset = () => {
    setTurns([]);
    setError(null);
    setStatus('idle');
    setScopeChanged(false);
    threadScope.current = null;
    lastQuestion.current = null;
  };

  const canSend = question.trim().length > 0 && status !== 'loading';
  const scopeLabel = fieldId == null
    ? 'Todos los campos'
    : `${selectedField?.name ?? 'Campo'}${plotIds ? ` · ${plotIds.length} lote${plotIds.length === 1 ? '' : 's'}` : ' · todos los lotes'}`;

  return (
    <div className="space-y-4">
      <TabHeader
        title="Análisis de datos"
        description="Preguntale a la IA sobre tus números de la campaña: gastos, ingresos, actividades, cosechas, lluvias, hacienda y stock. Solo usa lo que cargaste."
      />

      {/* Alcance */}
      <section className={card}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Qué analizar</h3>
        {fieldsError && <p className="text-sm text-red-600 dark:text-red-400 mb-2">{fieldsError}</p>}
        {!fieldsLoading && fields.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Todavía no tenés campos cargados. Creá el primero desde <strong>Campos y lotes</strong> o decile al bot <span className="font-mono">agregar campo La Esperanza</span>.
          </p>
        ) : (
          <div className="space-y-3">
            <FieldChips fields={fields.map(f => ({ id: f.id, name: f.name }))} value={fieldId} onChange={setFieldId} />
            <PlotChips plots={plots} value={plotIds} onChange={setPlotIds} disabled={fieldId == null} />
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CampaignPicker
                campaigns={overview?.campaigns ?? []}
                value={season}
                currentLabel={overview?.campaign.label ?? ''}
                onChange={setSeason}
              />
              <span className="text-xs text-gray-500 dark:text-gray-400">{scopeLabel}</span>
            </div>
          </div>
        )}
      </section>

      {/* Consulta */}
      <section className={card}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Tu pregunta</h3>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-1 min-h-[44px] px-2 text-sm text-gray-600 dark:text-gray-300 hover:text-campo-700 dark:hover:text-campo-400"
            >
              <RotateCcw className="w-4 h-4" aria-hidden="true" /> Nueva consulta
            </button>
          )}
        </div>
        <form
          onSubmit={e => { e.preventDefault(); void send(question); }}
          className="space-y-2"
        >
          <textarea
            value={question}
            onChange={e => setQuestion(e.target.value.slice(0, MAX_QUESTION))}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) { e.preventDefault(); void send(question); } }}
            rows={3}
            maxLength={MAX_QUESTION}
            placeholder={turns.length > 0 ? 'Repreguntá sobre este análisis…' : '¿Qué querés saber de tus datos?'}
            disabled={status === 'loading'}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-campo-500 focus:ring-1 focus:ring-campo-500 disabled:opacity-60"
          />
          {turns.length === 0 && (
            <div className="flex flex-wrap gap-2 pb-1" aria-label="Sugerencias">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  disabled={status === 'loading' || fields.length === 0}
                  className="min-h-[44px] px-3 rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-xs text-gray-700 dark:text-gray-200 text-left hover:border-campo-500 disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-gray-400">{question.length}/{MAX_QUESTION}</span>
            <button
              type="submit"
              disabled={!canSend || fields.length === 0}
              className="inline-flex items-center gap-2 min-h-[44px] px-4 rounded-md bg-campo-600 text-white text-sm font-medium disabled:opacity-50"
            >
              <Send className="w-4 h-4" aria-hidden="true" /> Analizar
            </button>
          </div>
        </form>
      </section>

      {scopeChanged && (
        <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2">
          Cambiaste el alcance, así que empezamos una consulta nueva.
        </p>
      )}

      {/* Hilo */}
      <AnalysisThread turns={turns} loading={status === 'loading'} />

      {status === 'error' && error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-3 text-sm text-red-700 dark:text-red-300 flex items-center justify-between gap-3 flex-wrap">
          <span>{error}</span>
          {lastQuestion.current && (
            <button type="button" onClick={() => void send(lastQuestion.current!)} className="min-h-[44px] px-3 rounded-md border border-red-300 dark:border-red-700 text-sm">
              Reintentar
            </button>
          )}
        </div>
      )}
      {status === 'quota' && error && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md p-3 text-sm text-amber-800 dark:text-amber-200">
          {error}
        </div>
      )}

      <div ref={threadEnd} />

      {quota && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Consultas de IA hoy: <strong>{quota.used}</strong> de {quota.limit} (compartidas con el bot).
        </p>
      )}
    </div>
  );
}
