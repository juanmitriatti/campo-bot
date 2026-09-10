import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client';
import { onMutation } from '../api/mutations';

/**
 * Paridad chat ↔ dashboard de la cosecha comercial (Sep 2026). El bot guarda
 * rinde esperado, avance en hectáreas, fechas de inicio/fin, saldo por acopio
 * y retiros (migración 120) y la pestaña Cosechas solo listaba camiones: el
 * productor lo cargaba por WhatsApp y no lo veía en la web. Lee
 * /harvest-summary con los mismos filtros de campo/lote que la tabla.
 */

interface HarvestCampaign {
  plotCropId: number;
  crop: string;
  seasonLabel: string;
  state: 'active' | 'harvested' | 'closed';
  fieldId: number;
  fieldName: string;
  plotId: number;
  plotName: string;
  areaHectares: number | null;
  sowedHectares: number | null;
  harvestedHectares: number | null;
  progressPct: number | null;
  expectedYieldKgPerHa: number | null;
  yieldKg: number | null;
  yieldKgPerHa: number | null;
  deviationPct: number | null;
  harvestStartedAt: string | null;
  harvestEndedAt: string | null;
  harvestDays: number | null;
  loads: number;
  grossKg: number | null;
  netKg: number | null;
  yieldNotes: string | null;
}

interface GrainBalanceRow {
  destinatario: string;
  crop: string | null;
  deliveredKg: number;
  deliveredGrossKg: number;
  loads: number;
  soldKg: number;
  withdrawnKg: number;
  balanceKg: number;
  lastDelivery: string | null;
}

interface Withdrawal {
  id: number;
  date: string;
  crop: string | null;
  destinatario: string | null;
  quantityKg: number | null;
  notes: string | null;
}

interface Summary {
  campaign: { seasonYear: number; label: string; from: string; to: string };
  campaigns: HarvestCampaign[];
  grainBalance: GrainBalanceRow[];
  withdrawals: Withdrawal[];
}

const nf = new Intl.NumberFormat('es-AR');
const tn = (kg: number | null | undefined) => (kg == null ? '—' : `${nf.format(Math.round(kg / 100) / 10)} tn`);
const kgHa = (v: number | null | undefined) => (v == null ? '—' : `${nf.format(Math.round(v))} kg/ha`);
const ha = (v: number | null | undefined) => (v == null ? '—' : `${nf.format(v)} ha`);
const day = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) : '—');

const STATE_LABEL: Record<HarvestCampaign['state'], string> = {
  active: 'Sembrada',
  harvested: 'Cosechada · abierta',
  closed: 'Cerrada',
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function CampaignCard({ c }: { c: HarvestCampaign }) {
  const total = (c.sowedHectares && c.sowedHectares > 0 ? c.sowedHectares : c.areaHectares) ?? null;
  const partial = c.harvestedHectares != null && total != null && c.harvestedHectares < total;
  const dev = c.deviationPct;
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-white dark:bg-gray-800 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {c.plotName} <span className="font-normal text-gray-500 dark:text-gray-400">· {c.fieldName}</span>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{cap(c.crop)} · {c.seasonLabel}</div>
        </div>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 whitespace-nowrap">
          {STATE_LABEL[c.state]}
        </span>
      </div>

      {c.harvestedHectares != null && total != null && (
        <div>
          <div className="flex justify-between text-xs text-gray-600 dark:text-gray-300">
            <span>Avance</span>
            <span>{ha(c.harvestedHectares)} de {ha(total)}{c.progressPct != null ? ` (${c.progressPct}%)` : ''}</span>
          </div>
          <div className="h-1.5 mt-1 rounded bg-gray-100 dark:bg-gray-700 overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, c.progressPct ?? 0)}%` }} />
          </div>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-gray-500 dark:text-gray-400">Rinde</dt>
        <dd className="text-gray-900 dark:text-gray-100 text-right">
          {c.yieldKg != null ? `${tn(c.yieldKg)} · ${kgHa(c.yieldKgPerHa)}${partial ? ' (parcial)' : ''}` : 'sin rinde'}
        </dd>
        <dt className="text-gray-500 dark:text-gray-400">Esperado</dt>
        <dd className="text-gray-900 dark:text-gray-100 text-right">
          {c.expectedYieldKgPerHa != null ? kgHa(c.expectedYieldKgPerHa) : '—'}
          {dev != null && (
            <span className={`ml-1 ${dev >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
              {dev >= 0 ? '+' : ''}{dev}%
            </span>
          )}
        </dd>
        <dt className="text-gray-500 dark:text-gray-400">Cosecha</dt>
        <dd className="text-gray-900 dark:text-gray-100 text-right">
          {c.harvestStartedAt
            ? `${day(c.harvestStartedAt)}${c.harvestEndedAt && c.harvestEndedAt !== c.harvestStartedAt ? ` → ${day(c.harvestEndedAt)}` : ''}${c.harvestDays && c.harvestDays > 1 ? ` · ${c.harvestDays} días` : ''}`
            : 'todavía no'}
        </dd>
        <dt className="text-gray-500 dark:text-gray-400">Camiones</dt>
        <dd className="text-gray-900 dark:text-gray-100 text-right">
          {c.loads > 0 ? `${c.loads} · ${tn(c.grossKg)} brutos → ${tn(c.netKg)} netos` : '—'}
        </dd>
      </dl>
    </div>
  );
}

export default function HarvestCampaignsSummary({ fieldId, plotId }: { fieldId: string; plotId: string }) {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Todo write (chat via test-bot no, pero PATCH/DELETE de cargas sí) refresca.
  useEffect(() => onMutation(() => setTick(t => t + 1)), []);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams();
    if (fieldId) params.set('fieldId', fieldId);
    if (plotId) params.set('plotId', plotId);
    apiRequest<Summary>(`/harvest-summary?${params}`)
      .then(r => { if (alive) { setData(r); setError(null); } })
      .catch(err => { if (alive) setError(err instanceof Error ? err.message : 'Error al cargar el resumen de cosecha'); });
    return () => { alive = false; };
  }, [fieldId, plotId, tick]);

  if (error) {
    return <p className="text-xs text-red-600 dark:text-red-400 mb-4">{error}</p>;
  }
  if (!data) return null;

  const campaigns = data.campaigns.filter(c => c.harvestStartedAt || c.expectedYieldKgPerHa != null || c.yieldKg != null);
  const balance = data.grainBalance;
  const withdrawals = data.withdrawals;
  if (campaigns.length === 0 && balance.length === 0 && withdrawals.length === 0) return null;

  return (
    <div className="space-y-4 mb-6">
      {campaigns.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Campañas · {data.campaign.label}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {campaigns.map(c => <CampaignCard key={c.plotCropId} c={c} />)}
          </div>
        </section>
      )}

      {balance.length > 0 && (
        <section className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-white dark:bg-gray-800">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Saldo en el acopio</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Entregado neto − vendido − retirado. Todas las campañas.</p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400">
                  <th className="py-1 pr-3 font-medium">Acopio</th>
                  <th className="py-1 pr-3 font-medium">Grano</th>
                  <th className="py-1 pr-3 font-medium text-right">Entregado</th>
                  <th className="py-1 pr-3 font-medium text-right">Vendido</th>
                  <th className="py-1 pr-3 font-medium text-right">Retirado</th>
                  <th className="py-1 pr-3 font-medium text-right">Saldo</th>
                  <th className="py-1 font-medium text-right">Última entrega</th>
                </tr>
              </thead>
              <tbody>
                {balance.map(b => (
                  <tr key={`${b.destinatario}-${b.crop ?? ''}`} className="border-t border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100">
                    <td className="py-1 pr-3">{b.destinatario}</td>
                    <td className="py-1 pr-3">{b.crop ? cap(b.crop) : '—'}</td>
                    <td className="py-1 pr-3 text-right">{tn(b.deliveredKg)} <span className="text-gray-400">({b.loads})</span></td>
                    <td className="py-1 pr-3 text-right">{b.soldKg > 0 ? `−${tn(b.soldKg)}` : '—'}</td>
                    <td className="py-1 pr-3 text-right">{b.withdrawnKg > 0 ? `−${tn(b.withdrawnKg)}` : '—'}</td>
                    <td className={`py-1 pr-3 text-right font-semibold ${b.balanceKg < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{tn(b.balanceKg)}</td>
                    <td className="py-1 text-right">{day(b.lastDelivery)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {withdrawals.length > 0 && (
        <section className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-white dark:bg-gray-800">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Retiros de grano</h3>
          <ul className="text-xs space-y-1 text-gray-900 dark:text-gray-100">
            {withdrawals.map(w => (
              <li key={w.id} className="flex justify-between gap-3">
                <span>{day(w.date)} · {w.crop ? cap(w.crop) : 'grano'} de {w.destinatario ?? '—'}{w.notes ? <span className="text-gray-500 dark:text-gray-400"> · {w.notes}</span> : null}</span>
                <span className="whitespace-nowrap">{tn(w.quantityKg)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
