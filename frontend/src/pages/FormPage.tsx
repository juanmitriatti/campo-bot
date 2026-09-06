// frontend/src/pages/FormPage.tsx
// Formulario estructurado abierto desde el bot como Telegram Mini App o link.
// Sin sesión de dashboard: el token de la URL es la autenticación.
// Render 100% genérico desde la FormDefinition del GET: cualquier formulario
// nuevo del registro (src/forms/form-definitions.ts) se dibuja sin tocar esto.
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

interface FormOption { id: string; title: string }

interface FormFieldDef {
  key: string;
  label: string;
  type: 'select' | 'date' | 'number' | 'text' | 'group';
  required: boolean;
  optionsSource?: string;
  options?: FormOption[];
  allowOther?: boolean;
  min?: number;
  max?: number;
  noFuture?: boolean;
  fields?: FormFieldDef[];
  maxItems?: number;
  help?: string;
}

interface PlotOption { id: number; name: string; fieldName: string; activeCrop: string | null }

interface FormSpec {
  action: string;
  title: string;
  fields: FormFieldDef[];
  prefill: Record<string, unknown>;
  initialValues?: Record<string, unknown>;
  options: { plots: PlotOption[]; crops: string[]; lists?: Record<string, FormOption[]> };
}

declare global {
  interface Window { Telegram?: { WebApp?: { ready: () => void; close: () => void; expand: () => void } } }
}

const OTHER = '__other__';
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
const inputCls = 'w-full rounded-lg border-gray-300 border p-3 bg-white';

export default function FormPage() {
  const { token } = useParams<{ token: string }>();
  const [spec, setSpec] = useState<FormSpec | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [others, setOthers] = useState<Record<string, string>>({});
  const [loads, setLoads] = useState<Array<Record<string, string>>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;

  useEffect(() => {
    tg?.ready();
    tg?.expand();
  }, [tg]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/forms/${token}`);
        const body = await res.json();
        if (!res.ok) { setLoadError(body.error ?? 'No se pudo cargar el formulario.'); return; }
        setSpec(body);
        // El prellenado lo resuelve el SERVER (form-prefill.ts), la misma
        // función que hornea el Flow de WhatsApp. El fallback cubre un backend
        // viejo que todavía no mande initialValues.
        const initial: Record<string, unknown> = body.initialValues ?? { event_date: todayISO() };
        const seededOthers: Record<string, string> = {};
        const seededValues: Record<string, unknown> = { ...initial };
        for (const k of Object.keys(initial)) {
          // `<key>_other` prellenado (ej. categoría que dijo y no está en su lista).
          if (k.endsWith('_other') && typeof initial[k] === 'string' && initial[k]) {
            const base = k.slice(0, -'_other'.length);
            seededOthers[base] = initial[k] as string;
            seededValues[base] = OTHER;
            delete seededValues[k];
          }
        }
        setOthers(seededOthers);
        setValues(seededValues);
      } catch {
        setLoadError('No se pudo cargar el formulario. Revisá tu conexión.');
      }
    })();
  }, [token]);

  const selectedPlot = useMemo(
    () => spec?.options.plots.find(p => p.id === Number(values.plot_id)) ?? null,
    [spec, values.plot_id],
  );

  const set = (key: string, v: unknown) => setValues(prev => ({ ...prev, [key]: v }));

  function optionsFor(f: FormFieldDef): FormOption[] {
    if (f.options) return f.options;
    if (f.optionsSource) return spec?.options.lists?.[f.optionsSource] ?? [];
    return [];
  }

  async function handleSubmit() {
    if (!spec) return;
    setSubmitting(true);
    setSubmitError(null);
    const payload: Record<string, unknown> = { ...values };
    for (const f of spec.fields) {
      if (f.type === 'select' && f.allowOther && payload[f.key] === OTHER) {
        payload[f.key] = (others[f.key] ?? '').trim();
      }
      if (f.type === 'number' && typeof payload[f.key] === 'string') {
        payload[f.key] = payload[f.key] === '' ? undefined : Number(payload[f.key]);
      }
    }
    const cleanLoads = loads
      .filter(l => l.driver_name?.trim() || l.weight_kg?.trim())
      .map(l => ({
        driver_name: l.driver_name?.trim(),
        weight_kg: l.weight_kg ? Number(l.weight_kg) : undefined,
        destinatario: l.destinatario?.trim() || undefined,
        humidity_pct: l.humidity_pct ? Number(l.humidity_pct) : undefined,
      }));
    if (cleanLoads.length > 0) payload.loads = cleanLoads;
    try {
      const res = await fetch(`/api/forms/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) { setSubmitError(body.error ?? 'No se pudo registrar.'); return; }
      setSuccessMsg(body.message ?? '✅ Registrado.');
      if (tg) setTimeout(() => tg.close(), 1800);
    } catch {
      setSubmitError('Falló el envío. Probá de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return (
    <Shell><p className="text-center text-gray-600 mt-10 px-6">{loadError}</p></Shell>
  );
  if (!spec) return <Shell><p className="text-center text-gray-400 mt-10">Cargando…</p></Shell>;
  if (successMsg) return (
    <Shell>
      <div className="mt-10 px-6 text-center whitespace-pre-line">
        <p className="text-4xl mb-4">✅</p>
        <p className="text-gray-800">{successMsg}</p>
        {tg && <p className="text-gray-400 text-sm mt-6">Cerrando…</p>}
      </div>
    </Shell>
  );

  return (
    <Shell>
      <h1 className="text-xl font-semibold text-gray-800 px-4 pt-5 pb-3">{spec.title}</h1>
      <form className="px-4 pb-8 space-y-4" onSubmit={e => { e.preventDefault(); void handleSubmit(); }}>
        {spec.fields.map(f => {
          if (f.type === 'group') return (
            <LoadsEditor key={f.key} def={f} loads={loads} setLoads={setLoads} />
          );
          return (
            <div key={f.key}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {f.label}{f.required && <span className="text-red-500"> *</span>}
              </label>
              {f.type === 'select' && (
                <>
                  <select required={f.required} value={String(values[f.key] ?? '')}
                    onChange={e => set(f.key, e.target.value)}
                    className={inputCls}>
                    <option value="" disabled={f.required}>{f.required ? 'Elegí una opción…' : '— Sin especificar —'}</option>
                    {optionsFor(f).map(o => <option key={o.id} value={o.id}>{o.title}</option>)}
                    {f.allowOther && <option value={OTHER}>Otro…</option>}
                  </select>
                  {f.allowOther && values[f.key] === OTHER && (
                    <input type="text" value={others[f.key] ?? ''}
                      onChange={e => setOthers(prev => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder={`¿Cuál? (${f.label.toLowerCase()})`} required
                      className="mt-2 w-full rounded-lg border-gray-300 border p-3" />
                  )}
                </>
              )}
              {f.type === 'date' && (
                <input type="date" required={f.required}
                  max={f.noFuture ? todayISO() : undefined}
                  value={String(values[f.key] ?? '')}
                  onChange={e => set(f.key, e.target.value)}
                  className={inputCls} />
              )}
              {f.type === 'number' && (
                <input type="number" inputMode="decimal" required={f.required}
                  min={f.min} max={f.max} step="any"
                  value={values[f.key] === undefined || values[f.key] === null ? '' : String(values[f.key])}
                  onChange={e => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))}
                  className="w-full rounded-lg border-gray-300 border p-3" />
              )}
              {f.type === 'text' && (
                <input type="text" required={f.required}
                  value={String(values[f.key] ?? '')}
                  onChange={e => set(f.key, e.target.value)}
                  className="w-full rounded-lg border-gray-300 border p-3" />
              )}
              {f.help && <p className="text-xs text-gray-400 mt-1">{f.help}</p>}
            </div>
          );
        })}
        {spec.action === 'harvest_crop' && selectedPlot?.activeCrop && (
          <p className="text-sm text-gray-500">Cultivo a cosechar: <b>{selectedPlot.activeCrop}</b></p>
        )}
        {submitError && (
          <p className="text-sm text-red-600 whitespace-pre-line bg-red-50 rounded-lg p-3">{submitError}</p>
        )}
        <button type="submit" disabled={submitting}
          className="w-full rounded-xl bg-green-700 text-white font-semibold p-4 disabled:opacity-50">
          {submitting ? 'Enviando…' : 'Registrar'}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-gray-50 max-w-md mx-auto">{children}</div>;
}

function LoadsEditor({ def, loads, setLoads }: {
  def: FormFieldDef;
  loads: Array<Record<string, string>>;
  setLoads: (l: Array<Record<string, string>>) => void;
}) {
  const update = (i: number, key: string, v: string) => {
    const next = loads.map((l, idx) => (idx === i ? { ...l, [key]: v } : l));
    setLoads(next);
  };
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{def.label}</label>
      {loads.map((l, i) => (
        <div key={i} className="rounded-lg border border-gray-200 p-3 mb-2 space-y-2 bg-white">
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-400">Carga {i + 1}</span>
            <button type="button" className="text-xs text-red-500"
              onClick={() => setLoads(loads.filter((_, idx) => idx !== i))}>Quitar</button>
          </div>
          <input type="text" placeholder="Chofer *" value={l.driver_name ?? ''}
            onChange={e => update(i, 'driver_name', e.target.value)}
            className="w-full rounded border-gray-300 border p-2 text-sm" />
          <input type="number" inputMode="numeric" placeholder="Peso (kg) *" value={l.weight_kg ?? ''}
            onChange={e => update(i, 'weight_kg', e.target.value)}
            className="w-full rounded border-gray-300 border p-2 text-sm" />
          <input type="text" placeholder="Destinatario (opcional)" value={l.destinatario ?? ''}
            onChange={e => update(i, 'destinatario', e.target.value)}
            className="w-full rounded border-gray-300 border p-2 text-sm" />
          <input type="number" inputMode="decimal" placeholder="Humedad % (opcional)" value={l.humidity_pct ?? ''}
            onChange={e => update(i, 'humidity_pct', e.target.value)}
            className="w-full rounded border-gray-300 border p-2 text-sm" />
        </div>
      ))}
      {(!def.maxItems || loads.length < def.maxItems) && (
        <button type="button" onClick={() => setLoads([...loads, {}])}
          className="text-sm text-green-700 font-medium">+ Agregar carga</button>
      )}
    </div>
  );
}
