/**
 * data-analysis-context.service.ts — el JSON de datos que ve el modelo en el
 * tab "Análisis de datos".
 *
 * Reglas que lo gobiernan:
 * - Mismo alcance que el Resumen: `getOverview` (resumen de plata, lotes,
 *   lluvia, hacienda) + listas crudas acotadas de los lotes elegidos +
 *   `campaignStats` por lote con cultivo. Los predicados de scope son los de
 *   overview.service.ts (dueño o field_members; lo sin ubicación entra solo
 *   con "Todos los campos").
 * - DETERMINÍSTICO: mismo alcance → mismos bytes. Claves en orden fijo,
 *   números redondeados, `ORDER BY fecha DESC, id DESC`, nada de `new Date()`.
 *   Es lo que hace que el bloque cacheado del prompt pegue en la repregunta.
 * - Nada se descarta en silencio: cada lista lleva `COUNT(*) OVER()` y todo
 *   recorte (por filas o por presupuesto de chars) queda en `truncation[]` y
 *   en un log `[data-analysis] TRUNCATE`.
 */

import { pool } from '../config/db.js';
import { getOverview, type OverviewPayload, type PlotRow } from './overview.service.js';
import { CampaignStatsService, type CampaignStats } from '../domain/agronomy/campaign-stats.service.js';
import type { CampaignRange } from '../utils/campaign-range.js';
import type { UserId } from '../types/index.js';

export interface AnalysisScope {
  userId: number;
  fieldIds: number[];
  /** null = todos los lotes de esos campos. */
  plotIds: number[] | null;
  includeUnassigned: boolean;
  range: CampaignRange;
}

export interface AnalysisLimits {
  maxRowsPerList: number;
  maxChars: number;
}

export interface TruncationNote {
  list: string;
  kept: number;
  total: number;
}

/** Fila posicional; los nombres de columna van UNA vez en `meta.columns`. */
export type CompactRow = Array<string | number | null>;

export type ListKey = 'expenses' | 'incomes' | 'events' | 'harvestLoads' | 'rainfall' | 'stock' | 'livestockGroups';

export interface AnalysisContext {
  meta: {
    campaign: string;
    from: string;
    to: string;
    scope: 'all_fields' | 'field' | 'plots';
    fields: Array<{ id: number; name: string }>;
    plots: Array<{ id: number; name: string; field: string; ha: number | null; crop: string | null }>;
    columns: Record<ListKey, string[]>;
    notes: string[];
  };
  summary: {
    counts: OverviewPayload['counts'];
    money: OverviewPayload['money'];
    categories: OverviewPayload['categories'];
    incomeProducts: OverviewPayload['incomeProducts'];
    cropMargins: OverviewPayload['cropMargins'];
    budgets: OverviewPayload['budgets'];
    livestock: OverviewPayload['livestock'];
    rainfall: OverviewPayload['rainfall'];
  };
  plots: PlotRow[];
  campaignStats: CampaignStatsCompact[];
  expenses: CompactRow[];
  incomes: CompactRow[];
  events: CompactRow[];
  harvestLoads: CompactRow[];
  rainfall: CompactRow[];
  stock: CompactRow[];
  livestockGroups: CompactRow[];
  truncation: TruncationNote[];
}

/** CampaignStats sin las listas crudas (ya viajan aparte, acotadas). */
export type CampaignStatsCompact = Omit<CampaignStats, 'activities' | 'yield' | 'observations'> & {
  activities: Omit<CampaignStats['activities'], 'list'>;
  yield: Omit<CampaignStats['yield'], 'loads'>;
  observations: Omit<CampaignStats['observations'], 'list'>;
};

export class ScopeError extends Error {
  readonly status = 400;
  readonly code = 'PLOT_NOT_IN_SCOPE';
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

/** Orden fijo de sacrificio cuando el JSON excede el presupuesto. */
export const SACRIFICE_ORDER: ListKey[] = ['events', 'expenses', 'incomes', 'rainfall', 'harvestLoads', 'stock', 'livestockGroups'];
const MIN_ROWS = 20;
const MAX_CAMPAIGN_STATS = 12;

const COLUMNS: Record<ListKey, string[]> = {
  expenses: ['fecha', 'monto', 'moneda', 'categoria', 'descripcion', 'lote', 'producto', 'cantidad', 'unidad'],
  incomes: ['fecha', 'monto', 'moneda', 'categoria', 'descripcion', 'lote', 'producto', 'cantidad', 'unidad', 'precio_unitario'],
  events: ['fecha', 'tipo', 'lote_o_corral', 'cultivo', 'producto', 'cantidad', 'unidad', 'categoria_animal', 'animales', 'notas'],
  harvestLoads: ['fecha', 'lote', 'chofer', 'kg', 'destino', 'humedad_pct'],
  rainfall: ['fecha', 'campo', 'lote', 'mm'],
  stock: ['insumo', 'categoria', 'cantidad', 'unidad', 'minimo', 'deposito'],
  livestockGroups: ['categoria', 'raza', 'cabezas', 'peso_prom_kg', 'ubicacion'],
};

const r2 = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const s = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * Los lotes pedidos tienen que ser de los campos del alcance y del usuario.
 * Un id ajeno no se ignora: es 400, porque el usuario (o su cliente) cree que
 * está analizando algo que no está.
 */
export async function resolvePlotIds(userId: number, fieldIds: number[], plotIds: number[]): Promise<number[]> {
  const wanted = [...new Set(plotIds.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0))];
  if (wanted.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT p.id FROM plots p
       JOIN fields f ON f.id = p.field_id
      WHERE p.id = ANY($1::int[]) AND p.deleted_at IS NULL AND f.deleted_at IS NULL
        AND p.field_id = ANY($2::int[])
        AND (f.user_id = $3 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $3))`,
    [wanted, fieldIds, userId],
  );
  const ok = new Set(rows.map((r: { id: number }) => Number(r.id)));
  const missing = wanted.filter((p) => !ok.has(p));
  if (missing.length > 0) {
    console.log(`[data-analysis] plot_ids fuera de alcance user=${userId}: ${missing.join(',')}`);
    throw new ScopeError(`Los lotes ${missing.join(', ')} no pertenecen a los campos elegidos.`);
  }
  return wanted;
}

interface RawList { rows: CompactRow[]; total: number }

async function rawList(sql: string, params: unknown[], map: (r: Record<string, unknown>) => CompactRow): Promise<RawList> {
  const { rows } = await pool.query(sql, params);
  const total = rows.length > 0 ? Number(rows[0]._total) : 0;
  return { rows: rows.map(map), total };
}

async function loadRawLists(scope: AnalysisScope, limit: number): Promise<Record<ListKey, RawList>> {
  const { userId, fieldIds, plotIds, includeUnassigned, range } = scope;
  const accessible = `SELECT field_id FROM field_members WHERE user_id = $1`;
  // $1 user, $2 from, $3 to, $4 fieldIds, $5 includeUnassigned, $6 plotIds (o NULL), $7 limit
  const p = [userId, range.from, range.to, fieldIds, includeUnassigned, plotIds, limit];

  const moneyScope = (t: string, dateCol: string) =>
    `(${t}.user_id = $1 OR ${t}.field_id IN (${accessible}))
     AND ${t}.deleted_at IS NULL
     AND ${t}.${dateCol} BETWEEN $2::date AND $3::date
     AND (
       COALESCE(${t}.field_id, (SELECT field_id FROM plots WHERE id = ${t}.plot_id)) = ANY($4::int[])
       OR ($5::boolean AND ${t}.field_id IS NULL AND ${t}.plot_id IS NULL)
     )
     AND ($6::int[] IS NULL OR ${t}.plot_id = ANY($6::int[]))`;

  const expenses = rawList(
    `SELECT e.expense_date::text AS fecha, e.amount, e.currency, e.category, e.description,
            p.name AS plot, e.product, e.quantity, e.unit, COUNT(*) OVER() AS _total
       FROM expenses e LEFT JOIN plots p ON p.id = e.plot_id
      WHERE ${moneyScope('e', 'expense_date')}
      ORDER BY e.expense_date DESC, e.id DESC LIMIT $7`,
    p,
    (r) => [s(r.fecha), r2(r.amount), s(r.currency) ?? 'ARS', s(r.category), s(r.description), s(r.plot), s(r.product), r2(r.quantity), s(r.unit)],
  );

  const incomes = rawList(
    `SELECT i.income_date::text AS fecha, i.amount, i.currency, i.category, i.description,
            p.name AS plot, i.product, i.quantity, i.unit, i.unit_price, COUNT(*) OVER() AS _total
       FROM incomes i LEFT JOIN plots p ON p.id = i.plot_id
      WHERE ${moneyScope('i', 'income_date')}
      ORDER BY i.income_date DESC, i.id DESC LIMIT $7`,
    p,
    (r) => [s(r.fecha), r2(r.amount), s(r.currency) ?? 'ARS', s(r.category), s(r.description), s(r.plot), s(r.product), r2(r.quantity), s(r.unit), r2(r.unit_price)],
  );

  const eventScope = `d.user_id = $1
        AND d.deleted_at IS NULL
        AND d.event_date BETWEEN $2::date AND $3::date
        AND (
          COALESCE(pl.field_id, fl.field_id) = ANY($4::int[])
          OR ($5::boolean AND d.plot_id IS NULL AND d.corral_id IS NULL)
        )
        AND ($6::int[] IS NULL OR d.plot_id = ANY($6::int[]))`;
  const eventJoins = `LEFT JOIN plots pl ON pl.id = d.plot_id
       LEFT JOIN corrals cr ON cr.id = d.corral_id
       LEFT JOIN feedlots fl ON fl.id = cr.feedlot_id`;

  const events = rawList(
    `SELECT d.event_date::text AS fecha, d.event_type, COALESCE(pl.name, 'corral ' || cr.name) AS donde,
            d.crop, d.product, d.quantity, d.unit, d.animal_category, d.animals_affected, d.notes, COUNT(*) OVER() AS _total
       FROM domain_events d ${eventJoins}
      WHERE ${eventScope}
      ORDER BY d.event_date DESC, d.id DESC LIMIT $7`,
    p,
    (r) => [s(r.fecha), s(r.event_type), s(r.donde), s(r.crop), s(r.product), r2(r.quantity), s(r.unit), s(r.animal_category), r2(r.animals_affected), s(r.notes)?.slice(0, 120) ?? null],
  );

  const harvestLoads = rawList(
    `SELECT d.event_date::text AS fecha, pl.name AS plot, hl.driver_name, hl.weight_kg,
            COALESCE(hl.destinatario, hl.destination) AS destino, hl.humidity_pct, COUNT(*) OVER() AS _total
       FROM harvest_loads hl JOIN domain_events d ON d.id = hl.domain_event_id ${eventJoins}
      WHERE ${eventScope}
      ORDER BY d.event_date DESC, hl.id DESC LIMIT $7`,
    p,
    (r) => [s(r.fecha), s(r.plot), s(r.driver_name), r2(r.weight_kg), s(r.destino), r2(r.humidity_pct)],
  );

  // La lluvia es dato de campo: con lotes elegidos se conserva la del campo
  // (plot_id NULL) además de la que tenga lote.
  const rainfall = rawList(
    `SELECT r.rainfall_date::text AS fecha, f.name AS field, p.name AS plot, r.millimeters, COUNT(*) OVER() AS _total
       FROM rainfall r LEFT JOIN fields f ON f.id = r.field_id LEFT JOIN plots p ON p.id = r.plot_id
      WHERE r.user_id = $1
        AND r.rainfall_date BETWEEN $2::date AND $3::date
        AND (r.field_id = ANY($4::int[]) OR ($5::boolean AND r.field_id IS NULL))
        AND ($6::int[] IS NULL OR r.plot_id IS NULL OR r.plot_id = ANY($6::int[]))
      ORDER BY r.rainfall_date DESC, r.id DESC LIMIT $7`,
    p,
    (r) => [s(r.fecha), s(r.field), s(r.plot), r2(r.millimeters)],
  );

  // Estado actual (no tiene campaña): insumos en depósitos de los campos del
  // alcance. Params propios: Postgres no infiere el tipo de un $n sin usar.
  const stock = rawList(
    `SELECT si.name, si.category, si.current_quantity, si.unit, si.min_stock, w.name AS warehouse, COUNT(*) OVER() AS _total
       FROM stock_items si LEFT JOIN warehouses w ON w.id = si.warehouse_id
      WHERE si.user_id = $1 AND si.deleted_at IS NULL
        AND (w.field_id = ANY($2::int[]) OR w.field_id IS NULL OR w.id IS NULL)
      ORDER BY si.name ASC, si.id ASC LIMIT $3`,
    [userId, fieldIds, limit],
    (r) => [s(r.name), s(r.category), r2(r.current_quantity), s(r.unit), r2(r.min_stock), s(r.warehouse)],
  );

  const livestockGroups = rawList(
    `SELECT lg.category::text AS category, lg.breed, lg.count, lg.avg_weight_kg,
            COALESCE(p.name, 'corral ' || c.name, f.name) AS donde, COUNT(*) OVER() AS _total
       FROM livestock_groups lg
       LEFT JOIN plots p ON p.id = lg.plot_id
       LEFT JOIN corrals c ON c.id = lg.corral_id
       LEFT JOIN feedlots fl ON fl.id = c.feedlot_id
       LEFT JOIN fields f ON f.id = COALESCE(lg.field_id, p.field_id, fl.field_id)
      WHERE lg.user_id = $1 AND lg.deleted_at IS NULL AND lg.count > 0
        AND COALESCE(lg.field_id, p.field_id, fl.field_id) = ANY($2::int[])
        AND ($3::int[] IS NULL OR lg.plot_id = ANY($3::int[]))
      ORDER BY lg.count DESC, lg.id ASC LIMIT $4`,
    [userId, fieldIds, plotIds, limit],
    (r) => [s(r.category), s(r.breed), r2(r.count), r2(r.avg_weight_kg), s(r.donde)],
  );

  const [ex, inc, ev, hl, rf, st, lg] = await Promise.all([expenses, incomes, events, harvestLoads, rainfall, stock, livestockGroups]);
  return { expenses: ex, incomes: inc, events: ev, harvestLoads: hl, rainfall: rf, stock: st, livestockGroups: lg };
}

function compactStats(st: CampaignStats): CampaignStatsCompact {
  const { activities, yield: y, observations, ...rest } = st;
  const { list: _a, ...activitiesRest } = activities;
  const { loads: _l, ...yieldRest } = y;
  const { list: _o, ...obsRest } = observations;
  return { ...rest, activities: activitiesRest, yield: yieldRest, observations: obsRest };
}

let statsService: CampaignStatsService | null = null;

async function loadCampaignStats(scope: AnalysisScope, plots: PlotRow[]): Promise<CampaignStatsCompact[]> {
  const withCrop = plots.filter((p) => p.crop).slice(0, MAX_CAMPAIGN_STATS);
  if (withCrop.length === 0) return [];
  if (!statsService) statsService = new CampaignStatsService();
  const svc = statsService;
  const out: CampaignStatsCompact[] = [];
  const results = await Promise.all(withCrop.map(async (p) => {
    try {
      const r = await svc.getCampaignStats(scope.userId as unknown as UserId, p.name, p.fieldName, null, String(scope.range.seasonYear));
      return typeof r === 'string' ? null : r;
    } catch (e) {
      console.log(`[data-analysis] campaignStats falló para lote ${p.name}: ${(e as Error).message}`);
      return null;
    }
  }));
  for (const r of results) if (r) out.push(compactStats(r));
  return out;
}

/**
 * Recorta hasta entrar en `maxChars`, en orden fijo, a la mitad por paso, sin
 * bajar de MIN_ROWS por lista. Cada corte queda en `truncation` y en el log.
 * Exportado para testearlo sin DB.
 */
export function shrinkToBudget(
  context: AnalysisContext,
  maxChars: number,
  totals: Partial<Record<ListKey, number>> = {},
  userId: number | string = '?',
): { context: AnalysisContext; json: string } {
  let json = JSON.stringify(context);
  let guard = 0;
  while (json.length > maxChars && guard++ < 60) {
    let cut = false;
    for (const key of SACRIFICE_ORDER) {
      const rows = context[key];
      if (rows.length <= MIN_ROWS) continue;
      const kept = Math.max(MIN_ROWS, Math.floor(rows.length / 2));
      context[key] = rows.slice(0, kept);
      const total = totals[key] ?? rows.length;
      const note = context.truncation.find((t) => t.list === key);
      if (note) note.kept = kept; else context.truncation.push({ list: key, kept, total });
      console.log(`[data-analysis] TRUNCATE user=${userId} list=${key} kept=${kept}/${total} (presupuesto ${maxChars} chars)`);
      cut = true;
      break;
    }
    if (!cut && context.campaignStats.length > 1) {
      const kept = Math.floor(context.campaignStats.length / 2);
      context.campaignStats = context.campaignStats.slice(0, kept);
      console.log(`[data-analysis] TRUNCATE user=${userId} list=campaignStats kept=${kept}`);
      cut = true;
    }
    if (!cut) {
      console.log(`[data-analysis] TRUNCATE user=${userId}: no queda nada que recortar, JSON=${json.length} chars > ${maxChars}`);
      break;
    }
    json = JSON.stringify(context);
  }
  return { context, json };
}

export async function buildAnalysisContext(
  scope: AnalysisScope,
  limits: AnalysisLimits,
): Promise<{ context: AnalysisContext; json: string }> {
  const [overview, lists] = await Promise.all([
    getOverview(scope.userId, scope.fieldIds, scope.range, { includeUnassigned: scope.includeUnassigned }),
    loadRawLists(scope, Math.max(1, limits.maxRowsPerList)),
  ]);

  const plotFilter = scope.plotIds ? new Set(scope.plotIds) : null;
  const plots = (plotFilter ? overview.plots.filter((p) => plotFilter.has(p.id)) : overview.plots)
    .slice()
    .sort((a, b) => a.id - b.id);
  const campaignStats = await loadCampaignStats(scope, plots);

  const fieldRows = await pool.query(
    `SELECT id, name FROM fields WHERE id = ANY($1::int[]) ORDER BY id`,
    [scope.fieldIds],
  );

  const scopeKind: AnalysisContext['meta']['scope'] = scope.plotIds ? 'plots' : scope.fieldIds.length === 1 ? 'field' : 'all_fields';
  const notes: string[] = [];
  if (scopeKind === 'plots') {
    notes.push('El bloque summary es del/los campo(s) completo(s); las listas crudas (expenses, incomes, events, harvestLoads) y plots están acotadas a los lotes elegidos.');
  }
  if (!scope.includeUnassigned) {
    notes.push('Los gastos/ingresos sin campo ni lote asignado NO están incluidos (solo entran con "Todos los campos").');
  }
  notes.push('stock y livestockGroups son estado ACTUAL, no de la campaña.');

  const truncation: TruncationNote[] = [];
  const totals: Partial<Record<ListKey, number>> = {};
  const take = (key: ListKey): CompactRow[] => {
    const l = lists[key];
    totals[key] = l.total;
    if (l.total > l.rows.length) {
      truncation.push({ list: key, kept: l.rows.length, total: l.total });
      console.log(`[data-analysis] TRUNCATE user=${scope.userId} list=${key} kept=${l.rows.length}/${l.total} (tope ${limits.maxRowsPerList} filas)`);
    }
    return l.rows;
  };

  const context: AnalysisContext = {
    meta: {
      campaign: scope.range.label,
      from: scope.range.from,
      to: scope.range.to,
      scope: scopeKind,
      fields: fieldRows.rows.map((r: { id: number; name: string }) => ({ id: Number(r.id), name: r.name })),
      plots: plots.map((p) => ({ id: p.id, name: p.name, field: p.fieldName, ha: r2(p.areaHectares), crop: p.crop })),
      columns: COLUMNS,
      notes,
    },
    summary: {
      counts: overview.counts,
      money: overview.money,
      categories: overview.categories,
      incomeProducts: overview.incomeProducts,
      cropMargins: overview.cropMargins,
      budgets: overview.budgets,
      livestock: overview.livestock,
      rainfall: overview.rainfall,
    },
    plots,
    campaignStats,
    expenses: take('expenses'),
    incomes: take('incomes'),
    events: take('events'),
    harvestLoads: take('harvestLoads'),
    rainfall: take('rainfall'),
    stock: take('stock'),
    livestockGroups: take('livestockGroups'),
    truncation,
  };

  const out = shrinkToBudget(context, Math.max(2000, limits.maxChars), totals, scope.userId);
  console.log(`[data-analysis] context user=${scope.userId} campaign=${scope.range.label} fields=${scope.fieldIds.length} plots=${plots.length} chars=${out.json.length} truncated=${out.context.truncation.length}`);
  return out;
}
