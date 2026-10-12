/**
 * Payload for the redesigned "Resumen" screen.
 *
 * Why a separate endpoint from the old `/dashboard`: the old Resumen answered
 * "cómo viene ESTE MES" (current vs previous month). The redesign answers "cómo
 * cerró LA CAMPAÑA", which is a different window (see utils/campaign-range.ts),
 * a different grain (per-plot, per-category ranking) and a different currency
 * story (ARS and USD side by side, never one collapsed into the other — a real
 * account is negative in pesos and positive in dollars at the same time).
 *
 * Scoping rules, because every one of them once produced a wrong number:
 * - Money rows without field AND without plot (grain sold "a Cargill", a fuel
 *   ticket dictated before any lote existed) are REAL money. They belong to
 *   "Todos los campos" (`includeUnassigned`), never to a single field. The old
 *   `COALESCE(field, plot.field) = ANY(...)` silently dropped them: a user with
 *   10 grain sales and no lote on them saw a campaign result that was missing
 *   all of its income.
 * - Events without plot follow the same rule; events in a corral resolve to the
 *   feedlot's field so hacienda work is not attributed to every field at once.
 * - The lote's crop is the one OVERLAPPING the selected campaign, not whatever
 *   is on the lote today — a 24/25 card must not say "sembrado el 18 jul 2026".
 * - `counts.livestock` is HEAD, not groups. The banner reads it as animals.
 */
import { pool } from '../config/db.js';
import { accessibleFieldsSql } from '../domain/shared/accessible-fields.js';
import { campaignRange, type CampaignRange } from '../utils/campaign-range.js';
import { getTodayISO } from '../utils/date.js';
import { harvestCampaignsCte } from '../utils/harvest-campaign-kg.js';
import { campaignMoneyCtes } from '../domain/plots/campaign-money.js';
import { getFxSource, usdEquivalentSql, FX_SOURCE_LABEL } from './fx-rate.service.js';

export interface MoneySide {
  income: number;
  expense: number;
  result: number;
  incomeCount: number;
  expenseCount: number;
}

export interface CategoryRow {
  category: string;
  total: number;
}

/** One line of "qué vendí": product (or category when there is none). */
export interface IncomeProductRow {
  name: string;
  total: number;
  count: number;
  /** Kilograms sold, when the rows carried a weight unit; null otherwise. */
  kg: number | null;
  /** Average price per tonne, computed only over rows that had a quantity. */
  pricePerTn: number | null;
}

export interface PlotRow {
  id: number;
  name: string;
  fieldId: number;
  fieldName: string;
  areaHectares: number | null;
  crop: string | null;
  cropState: string | null;
  spendARS: number;
  spendUSD: number;
  incomeARS: number;
  incomeUSD: number;
  /** Total harvested in the campaign (kg), from the harvest events. */
  harvestKg: number | null;
  /** harvestKg / area, when the lote has a declared area. */
  yieldKgPerHa: number | null;
  lastActivity: string | null;
}

/** Money grouped by the crop the lote carries in the campaign. */
export interface CropMarginRow {
  /** "Soja", "Soja 2da", "Trigo"; null = plata del lote sin campaña. */
  crop: string | null;
  hectares: number;
  plots: number;
  income: number;
  expense: number;
  result: number;
}

export interface BudgetRow {
  category: string;
  limit: number;
  spent: number;
  /** FIN-22: el gastado se suma solo en esta moneda. */
  currency: 'ARS' | 'USD';
}

export interface ReminderRow {
  id: number;
  description: string;
  dueDate: string;
  where: string | null;
  overdue: boolean;
}

export interface LivestockSummary {
  total: number;
  byCategory: Array<{ category: string; count: number }>;
  lastWeighing: { date: string; category: string | null; kg: number } | null;
}

export interface FeedRow {
  type: 'expense' | 'income' | 'activity';
  id: number;
  date: string;
  kind: string;
  detail: string;
  where: string | null;
}

/**
 * Per-section record counts for the navigation badges.
 *
 * These exist so the sidebar can say what has data BEFORE you click: with the
 * old flat list, Monitoreos/Stock/Documentos at zero took exactly as much room
 * and attention as Gastos with 26 rows. Campaign-scoped where the notion of a
 * campaign applies; a live total where it does not (stock on hand, livestock,
 * pending reminders).
 */
export interface OverviewCounts {
  plots: number;
  activities: number;
  scoutings: number;
  /** Individual truck loads in the campaign — the Cosechas tab lists trucks. */
  harvests: number;
  expenses: number;
  incomes: number;
  stock: number;
  /** Items at or below their minimum — drives the low-stock banner. */
  stockAlerts: number;
  /** HEAD of cattle (sum of group counts), scoped to the selected fields. */
  livestock: number;
  documents: number;
  reminders: number;
}

export interface RainfallMonth {
  month: string;
  label: string;
  mm: number;
}

/** Todo pasado a dólares al dólar de la fecha de cada movimiento. */
export interface MoneyUSDEq {
  income: number;
  expense: number;
  result: number;
  /** Movimientos en pesos sin cotización para su fecha (no entran). */
  missing: number;
  /** "dólar mayorista (A3500)" — cuál se usó. */
  source: string;
}

export interface OverviewPayload {
  campaign: CampaignRange;
  moneyUSDEq: MoneyUSDEq;
  cropMarginsUSDEq: CropMarginRow[];
  counts: OverviewCounts;
  observed: { from: string | null; to: string | null };
  money: { ARS: MoneySide; USD: MoneySide };
  categories: { ARS: CategoryRow[]; USD: CategoryRow[] };
  incomeProducts: { ARS: IncomeProductRow[]; USD: IncomeProductRow[] };
  cropMargins: { ARS: CropMarginRow[]; USD: CropMarginRow[] };
  budgets: { month: string; rows: BudgetRow[] };
  reminders: { overdue: number; upcoming: number; rows: ReminderRow[] };
  livestock: LivestockSummary;
  rainfall: {
    total: number;
    count: number;
    months: RainfallMonth[];
    /** Same months, one campaign earlier — the comparison the chart lacked. */
    prevTotal: number;
    prevMonths: RainfallMonth[];
    prevLabel: string;
  };
  activities: { count: number };
  plots: PlotRow[];
  feed: FeedRow[];
}

const EVENT_LABEL: Record<string, string> = {
  planting: 'Siembra',
  spraying: 'Pulverización',
  fertilization: 'Fertilización',
  tillage: 'Laboreo',
  irrigation: 'Riego',
  harvest: 'Cosecha',
  health_event: 'Sanidad animal',
  repro_event: 'Reproducción',
  weighing: 'Pesaje',
  tacto: 'Tacto',
  observation: 'Observación',
};

export function eventLabel(eventType: string | null): string {
  if (!eventType) return 'Actividad';
  return EVENT_LABEL[eventType] ?? eventType;
}

/** Human tail for an activity: " · soja · Clorpirifos 1 lt/ha" */
function eventDetail(row: {
  crop?: string | null;
  product?: string | null;
  quantity?: unknown;
  unit?: string | null;
}): string {
  const bits: string[] = [];
  if (row.crop) bits.push(String(row.crop).toLowerCase());
  if (row.product) bits.push(String(row.product));
  if (row.quantity != null && String(row.quantity) !== '') {
    const q = Number(row.quantity);
    const qty = isNaN(q) ? String(row.quantity) : new Intl.NumberFormat('es-AR').format(q);
    bits.push(row.unit ? `${qty} ${row.unit}` : qty);
  }
  return bits.length ? ' · ' + bits.join(' · ') : '';
}

function emptySide(): MoneySide {
  return { income: 0, expense: 0, result: 0, incomeCount: 0, expenseCount: 0 };
}

/**
 * Resolve which field ids the request covers. `null` fieldId means "all of the
 * user's own fields".
 */
/**
 * Oldest dated record the user has (expense, income, event, rain), or null.
 * Feeds the campaign picker: it lists from the current campaign back to this
 * date, so a new user sees one campaign and a 2023 user sees four.
 */
export async function earliestDataDate(userId: number): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT LEAST(
       (SELECT MIN(expense_date) FROM expenses WHERE user_id = $1 AND deleted_at IS NULL),
       (SELECT MIN(income_date) FROM incomes WHERE user_id = $1 AND deleted_at IS NULL),
       (SELECT MIN(event_date) FROM domain_events WHERE user_id = $1 AND deleted_at IS NULL),
       (SELECT MIN(rainfall_date) FROM rainfall WHERE user_id = $1)
     )::text AS earliest`,
    [userId],
  );
  return rows[0]?.earliest ?? null;
}

export async function resolveFieldIds(userId: number, fieldId: number | null): Promise<number[]> {
  if (fieldId != null) {
    // Se VALIDA el acceso en vez de confiar en el id que mandó el cliente.
    // Antes se devolvía `[fieldId]` a ciegas: con el scoping por campo del
    // resto de la query, pedir `?field_id=` de un campo ajeno mostraba sus
    // números. Sin acceso, se responde como si el campo no existiera.
    const { rows } = await pool.query(
      `SELECT 1 FROM (${accessibleFieldsSql(1)}) AS acc(id) WHERE acc.id = $2 LIMIT 1`,
      [userId, fieldId],
    );
    return rows.length > 0 ? [fieldId] : [-1];
  }
  // "Todos los campos" incluye los COMPARTIDOS. Miraba solo `user_id`, así que
  // un campo que te compartieron quedaba fuera del Resumen entero.
  const { rows } = await pool.query(
    `SELECT id FROM (${accessibleFieldsSql(1)}) AS acc(id)`,
    [userId],
  );
  const ids = rows.map((r: { id: number }) => Number(r.id));
  // -1 keeps the `= ANY($n)` filters valid (and matching nothing) for a user
  // with no fields, instead of producing invalid SQL.
  return ids.length ? ids : [-1];
}

/**
 * kg per unit for the weight units the bot stores. Anything else (bolsas,
 * lt, an empty unit) is NOT a weight and must not be summed as kilograms —
 * "100 toneladas" saved without a unit would otherwise become 100 kg and a
 * price per tonne a thousand times too high.
 */
const KG_FACTOR_SQL = `CASE LOWER(TRIM(COALESCE(%col%, '')))
  WHEN 'kg' THEN 1 WHEN 'kgs' THEN 1 WHEN 'kilo' THEN 1 WHEN 'kilos' THEN 1
  WHEN 'tn' THEN 1000 WHEN 't' THEN 1000 WHEN 'ton' THEN 1000
  WHEN 'tonelada' THEN 1000 WHEN 'toneladas' THEN 1000
  WHEN 'qq' THEN 100 WHEN 'quintal' THEN 100 WHEN 'quintales' THEN 100
  ELSE NULL END`;
const kgFactor = (col: string) => KG_FACTOR_SQL.replace('%col%', col);

export interface OverviewOptions {
  /**
   * Rows with no field and no plot join the totals. True for "Todos los
   * campos", false for a single field (they belong to no field in particular).
   */
  includeUnassigned: boolean;
}

export async function getOverview(
  userId: number,
  fieldIds: number[],
  range: CampaignRange,
  opts: OverviewOptions = { includeUnassigned: false },
): Promise<OverviewPayload> {
  // Fuente ÚNICA (invariante 3). Antes era `SELECT field_id FROM field_members`
  // a secas: sin la pata del dueño, un campo propio SIN fila en `field_members`
  // no entraba. Esa fila la crea `getOrCreateField` como efecto colateral, así
  // que el Resumen dependía de que ese insert hubiera corrido alguna vez.
  const accessible = accessibleFieldsSql(1);
  const includeUnassigned = opts.includeUnassigned;
  const fxSource = await getFxSource();
  const p = [userId, range.from, range.to, fieldIds, includeUnassigned, range.seasonYear, fxSource];
  // Postgres rechaza un parámetro que la query no usa: cada una recibe los suyos.
  const p5 = p.slice(0, 5);
  const p6 = p.slice(0, 6);

  // Location predicate for money rows: the row's field (direct or via lote) is
  // in scope, or it has no location at all and we are looking at everything.
  const moneyScope = (t: string, dateCol: string) =>
    `(${t}.user_id = $1 OR ${t}.field_id IN (${accessible}))
     AND ${t}.deleted_at IS NULL
     AND ${t}.${dateCol} BETWEEN $2::date AND $3::date
     AND (
       COALESCE(${t}.field_id, (SELECT field_id FROM plots WHERE id = ${t}.plot_id)) = ANY($4::int[])
       OR ($5::boolean AND ${t}.field_id IS NULL AND ${t}.plot_id IS NULL)
     )`;

  // Same idea for events: lote → field, corral → feedlot → field, or nothing.
  const eventJoins = `LEFT JOIN plots pl ON pl.id = d.plot_id
       LEFT JOIN corrals cr ON cr.id = d.corral_id
       LEFT JOIN feedlots fl ON fl.id = cr.feedlot_id`;
  // La pata de acceso era `d.user_id = $1` a secas: en un campo COMPARTIDO cada
  // socio veía únicamente los eventos que había cargado él, y toda la actividad
  // agronómica del otro (siembras, cosechas, labores) era invisible en el
  // Resumen. Ahora entra lo que está en un campo accesible; el `user_id` queda
  // solo para las filas SIN ubicación, que no cuelgan de ningún campo.
  const eventScope = `(
          COALESCE(pl.field_id, fl.field_id) IN (${accessible})
          OR d.user_id = $1
        )
        AND d.deleted_at IS NULL
        AND d.event_date BETWEEN $2::date AND $3::date
        AND (
          COALESCE(pl.field_id, fl.field_id) = ANY($4::int[])
          OR ($5::boolean AND d.plot_id IS NULL AND d.corral_id IS NULL)
        )`;

  // LA PLATA DE LA CAMPAÑA (análisis de cosecha, 12 oct 2026). Antes era "lo
  // fechado entre el 1 sep y el 31 ago". Ahora: lo que campaign-money.ts
  // atribuye a una campaña de ESTE año agrícola (season_year) en los campos
  // elegidos —barbecho previo, venta del grano guardado aunque sea de otro
  // ejercicio, la parte de lo cargado a nivel campo, y el trigo sembrado en
  // junio, que ya no cae en la campaña anterior— más lo que no pertenece a
  // ninguna campaña y está fechado en la ventana (estructura, hacienda).
  // Una fila repartida entra con su peso (`w`).
  const seasonMoneyCtes = `${campaignMoneyCtes('$1')},
    attr AS (
      SELECT m.kind, m.row_id,
             SUM(m.share) FILTER (WHERE c.season_year = $6 AND c.field_id = ANY($4::int[])) AS w
        FROM campaign_money m
        JOIN campaigns c ON c.id = m.plot_crop_id
       WHERE ${foldCategory('m.category')} <> 'hacienda'
       GROUP BY m.kind, m.row_id
    ),
    season_money AS (
      SELECT 'expense'::text AS kind, e.id AS row_id, e.plot_id, COALESCE(a.w, 1)::numeric AS w,
             (e.amount * COALESCE(a.w, 1))::numeric AS amount, COALESCE(e.currency, 'ARS') AS currency,
             e.expense_date AS money_date, e.category, e.product, e.quantity, e.unit,
             (a.row_id IS NOT NULL) AS attributed
        FROM expenses e
        LEFT JOIN attr a ON a.kind = 'expense' AND a.row_id = e.id
       WHERE (e.user_id = $1 OR COALESCE(e.field_id, (SELECT field_id FROM plots WHERE id = e.plot_id)) IN (${accessible}))
         AND e.deleted_at IS NULL
         AND ((a.row_id IS NOT NULL AND a.w > 0)
              OR (a.row_id IS NULL AND ${moneyScope('e', 'expense_date')}))
      UNION ALL
      SELECT 'income'::text, i.id, i.plot_id, COALESCE(a.w, 1)::numeric,
             (i.amount * COALESCE(a.w, 1))::numeric, COALESCE(i.currency, 'ARS'),
             i.income_date, i.category, i.product, i.quantity, i.unit,
             (a.row_id IS NOT NULL)
        FROM incomes i
        LEFT JOIN attr a ON a.kind = 'income' AND a.row_id = i.id
       WHERE (i.user_id = $1 OR COALESCE(i.field_id, (SELECT field_id FROM plots WHERE id = i.plot_id)) IN (${accessible}))
         AND i.deleted_at IS NULL
         AND ((a.row_id IS NOT NULL AND a.w > 0)
              OR (a.row_id IS NULL AND ${moneyScope('i', 'income_date')}))
    )`;

  // Totales por moneda + el equivalente en dólares (cada peso al dólar de su
  // fecha) en la misma pasada.
  const usdEq = usdEquivalentSql('amount', 'currency', 'money_date', '$7');
  const moneyQ = pool.query(
    `WITH ${seasonMoneyCtes}
     SELECT kind, currency,
            SUM(amount)::numeric AS total,
            COUNT(*)::int AS n,
            MIN(money_date)::text AS first_date,
            MAX(money_date)::text AS last_date,
            COALESCE(SUM(${usdEq}), 0)::numeric AS usd_eq,
            COUNT(*) FILTER (WHERE currency <> 'USD' AND ${usdEq} IS NULL)::int AS fx_missing
       FROM season_money
      GROUP BY 1, 2`,
    p,
  );

  const categoriesQ = pool.query(
    `WITH ${seasonMoneyCtes}
     SELECT COALESCE(NULLIF(TRIM(category), ''), 'Sin categoría') AS category,
            currency,
            SUM(amount)::numeric AS total
       FROM season_money
      WHERE kind = 'expense'
      GROUP BY 1, 2
      ORDER BY 3 DESC`,
    p6,
  );

  // What was sold: by product (grain) when the row has one, else by category.
  // kg and price only over rows that carried a real weight unit.
  const incomeProductsQ = pool.query(
    `WITH ${seasonMoneyCtes}
     SELECT COALESCE(NULLIF(TRIM(product), ''), NULLIF(TRIM(category), ''), 'Sin detalle') AS name,
            currency,
            SUM(amount)::numeric AS total,
            COUNT(*)::int AS n,
            SUM(CASE WHEN quantity > 0 AND ${kgFactor('unit')} IS NOT NULL
                     THEN quantity * w * ${kgFactor('unit')} END)::numeric AS kg,
            SUM(CASE WHEN quantity > 0 AND ${kgFactor('unit')} IS NOT NULL
                     THEN amount END)::numeric AS amount_with_kg
       FROM season_money
      WHERE kind = 'income'
      GROUP BY 1, 2
      ORDER BY 3 DESC`,
    p6,
  );


  // Every month of a campaign window, so a month with no rain reads as a
  // visible gap instead of vanishing from the axis. Shared-field members see
  // the same rain the owner sees (same rule as expenses).
  const rainSql = `WITH months AS (
       SELECT generate_series($2::date, $3::date, '1 month')::date AS m
     )
     SELECT to_char(months.m, 'YYYY-MM') AS month,
            COALESCE((
              SELECT SUM(r.millimeters) FROM rainfall r
               WHERE (r.user_id = $1 OR r.field_id IN (${accessible}))
                 AND r.field_id = ANY($4::int[])
                 AND r.rainfall_date >= months.m
                 AND r.rainfall_date < months.m + interval '1 month'
            ), 0)::numeric AS mm,
            COALESCE((
              SELECT COUNT(*) FROM rainfall r
               WHERE (r.user_id = $1 OR r.field_id IN (${accessible}))
                 AND r.field_id = ANY($4::int[])
                 AND r.rainfall_date >= months.m
                 AND r.rainfall_date < months.m + interval '1 month'
            ), 0)::int AS n
       FROM months
      ORDER BY months.m`;
  const rainQ = pool.query(rainSql, [userId, range.from, range.to, fieldIds]);
  const prevRange = campaignRange(range.seasonYear - 1);
  const prevRainQ = pool.query(rainSql, [userId, prevRange.from, prevRange.to, fieldIds]);

  const activitiesQ = pool.query(
    `SELECT COUNT(*)::int AS n
       FROM domain_events d
       ${eventJoins}
      WHERE ${eventScope}`,
    p5,
  );

  // The crop shown on a lote card is the one of THIS campaign (season_year),
  // the latest sown first; with trigo + soja de 2da both are named. Without a
  // campaign of the season, the one overlapping the window, as before.
  const plotsQ = pool.query(
    `SELECT pl.id, pl.name, pl.area_hectares, f.id AS field_id, f.name AS field_name,
            pc.crop, pc.start_date::text AS crop_start, pc.harvested_at::text AS harvested_at,
            pc.end_date::text AS crop_end, pc.sowed_hectares, seq.label AS crop_sequence
       FROM plots pl
       JOIN fields f ON f.id = pl.field_id
       LEFT JOIN LATERAL (
         SELECT c.crop, c.start_date, c.harvested_at, c.end_date, c.sowed_hectares
           FROM plot_crops c
          WHERE c.plot_id = pl.id
            AND (c.season_year = $4
                 OR (c.start_date <= $2::date AND (c.end_date IS NULL OR c.end_date >= $1::date)))
          ORDER BY (c.season_year = $4) DESC, c.start_date DESC NULLS LAST, c.id DESC
          LIMIT 1
       ) pc ON true
       LEFT JOIN LATERAL (
         SELECT string_agg(c.crop || CASE WHEN c.crop_order = 2 THEN ' 2da' ELSE '' END, ' → '
                           ORDER BY c.start_date, c.id) AS label,
                COUNT(*) AS n
           FROM plot_crops c
          WHERE c.plot_id = pl.id AND c.season_year = $4
       ) seq ON seq.n > 1
      WHERE f.id = ANY($3::int[])
        AND pl.deleted_at IS NULL
        AND f.deleted_at IS NULL
      ORDER BY f.name, pl.name`,
    [range.from, range.to, fieldIds, range.seasonYear],
  );

  // Plata por lote y por cultivo: lo atribuido a cada campaña de la temporada
  // (en el lote de esa campaña, aunque la fila fuera de nivel campo o una venta
  // sin lote) más lo del lote que no es de ninguna campaña. Una sola query
  // para las tarjetas y el margen por cultivo: no pueden contradecirse.
  const campaignMoneyRowsQ = pool.query(
    `WITH ${seasonMoneyCtes},
     attributed AS (
       SELECT m.kind, c.plot_id, c.id AS plot_crop_id,
              c.crop || CASE WHEN c.crop_order = 2 THEN ' 2da' ELSE '' END AS crop_label,
              c.ha, m.currency, m.amount, m.money_date
         FROM campaign_money m
         JOIN campaigns c ON c.id = m.plot_crop_id
        WHERE c.season_year = $6 AND c.field_id = ANY($4::int[])
          AND ${foldCategory('m.category')} <> 'hacienda'
     ),
     loose AS (
       SELECT sm.kind, sm.plot_id, NULL::int AS plot_crop_id, NULL::text AS crop_label,
              NULL::numeric AS ha, sm.currency, sm.amount, sm.money_date
         FROM season_money sm
        WHERE NOT sm.attributed AND sm.plot_id IS NOT NULL
     )
     SELECT kind, plot_id, plot_crop_id, crop_label, ha, currency,
            SUM(amount)::numeric AS total,
            SUM(${usdEquivalentSql('amount', 'currency', 'money_date', '$7')})::numeric AS usd_eq
       FROM (SELECT * FROM attributed UNION ALL SELECT * FROM loose) x
      GROUP BY 1, 2, 3, 4, 5, 6`,
    p,
  );

  // Harvested kg per lote in the campaign, aggregated PER CAMPAIGN (plot_crops)
  // and never per event: a two-day harvest (declared yield on day 1 + trucks on
  // day 2) used to be summed twice (P0-2, QA sep 2026). Single source:
  // harvestCampaignsCte.
  const plotHarvestQ = pool.query(
    `WITH ${harvestCampaignsCte({ user: '$1', from: '$2', to: '$3', fieldIds: '$4' })}
     SELECT plot_id, SUM(kg)::numeric AS kg, SUM(ha)::numeric AS ha
       FROM harvest_campaigns
      GROUP BY plot_id`,
    [userId, range.from, range.to, fieldIds],
  );

  const plotLastQ = pool.query(
    `SELECT DISTINCT ON (d.plot_id)
            d.plot_id, d.event_type, d.event_date::text AS event_date,
            d.crop, d.product, d.quantity, d.unit
       FROM domain_events d
       JOIN plots pl ON pl.id = d.plot_id
      WHERE pl.field_id IN (${accessible})
        AND d.deleted_at IS NULL
        AND pl.field_id = ANY($4::int[])
        AND d.event_date BETWEEN $2::date AND $3::date
      ORDER BY d.plot_id, d.event_date DESC, d.created_at DESC`,
    [userId, range.from, range.to, fieldIds],
  );

  const feedQ = pool.query(
    `(SELECT 'activity' AS type, d.id, d.event_date::text AS date, d.event_type AS kind,
             d.crop, d.product, d.quantity, d.unit,
             NULL::numeric AS amount, NULL::text AS currency, NULL::text AS description,
             COALESCE(f.name, ff.name) AS field_name, pl.name AS plot_name, d.created_at
        FROM domain_events d
        ${eventJoins}
        LEFT JOIN fields f ON f.id = pl.field_id
        LEFT JOIN fields ff ON ff.id = fl.field_id
       WHERE ${eventScope})
     UNION ALL
     (SELECT 'expense', e.id, e.expense_date::text, COALESCE(e.category, 'Gasto'),
             NULL, e.product, e.quantity, e.unit,
             e.amount, COALESCE(e.currency, 'ARS'), e.description,
             f.name, pl.name, e.created_at
        FROM expenses e
        LEFT JOIN plots pl ON pl.id = e.plot_id
        LEFT JOIN fields f ON f.id = COALESCE(e.field_id, pl.field_id)
       WHERE ${moneyScope('e', 'expense_date')})
     UNION ALL
     (SELECT 'income', i.id, i.income_date::text, COALESCE(i.category, 'Ingreso'),
             NULL, i.product, i.quantity, i.unit,
             i.amount, COALESCE(i.currency, 'ARS'), i.description,
             f.name, pl.name, i.created_at
        FROM incomes i
        LEFT JOIN plots pl ON pl.id = i.plot_id
        LEFT JOIN fields f ON f.id = COALESCE(i.field_id, pl.field_id)
       WHERE ${moneyScope('i', 'income_date')})
     ORDER BY date DESC, created_at DESC
     LIMIT 10`,
    p5,
  );

  // Budgets are per user and per calendar month (that is what `set_budget`
  // stores), in pesos. Spent = this month's ARS expenses, all fields.
  const today = getTodayISO();
  const monthStart = today.slice(0, 7) + '-01';
  const budgetsQ = pool.query(
    `SELECT b.category, b.monthly_limit::numeric AS monthly_limit, b.currency,
            COALESCE((
              SELECT SUM(e.amount) FROM expenses e
               WHERE e.user_id = $1 AND e.deleted_at IS NULL
                 AND COALESCE(e.currency, 'ARS') = b.currency
                 AND e.expense_date >= $2::date
                 AND LOWER(TRIM(e.category)) = LOWER(TRIM(b.category))
            ), 0)::numeric AS spent
       FROM budgets b
      WHERE b.user_id = $1
      ORDER BY b.monthly_limit DESC`,
    [userId, monthStart],
  );

  // Pending tasks: overdue first, then the next 7 days. `sent` means the bot
  // already reminded the user — the task is still open until they mark it.
  const remindersQ = pool.query(
    `SELECT r.id, r.description, r.due_date::text AS due_date,
            f.name AS field_name, pl.name AS plot_name,
            (r.due_date < $2::date) AS overdue
       FROM task_reminders r
       LEFT JOIN fields f ON f.id = r.field_id
       LEFT JOIN plots pl ON pl.id = r.plot_id
      WHERE r.user_id = $1
        AND r.status IN ('pending', 'sent')
        AND r.due_date <= ($2::date + interval '7 days')
      ORDER BY r.due_date ASC, r.id ASC`,
    [userId, today],
  );

  const livestockQ = pool.query(
    `SELECT lg.category::text AS category, SUM(lg.count)::int AS n
       FROM livestock_groups lg
      WHERE lg.field_id IN (${accessible}) AND lg.deleted_at IS NULL
        AND lg.field_id = ANY($2::int[])
        AND lg.count > 0
      GROUP BY 1
      ORDER BY 2 DESC`,
    [userId, fieldIds],
  );

  const lastWeighingQ = pool.query(
    `SELECT d.event_date::text AS event_date, d.animal_category, d.quantity::numeric AS kg
       FROM domain_events d
       ${eventJoins}
      WHERE (COALESCE(pl.field_id, fl.field_id) IN (${accessible}) OR d.user_id = $1)
        AND d.deleted_at IS NULL
        AND d.event_type = 'weighing' AND d.quantity IS NOT NULL
        AND (COALESCE(pl.field_id, fl.field_id) = ANY($2::int[])
             OR ($3::boolean AND d.plot_id IS NULL AND d.corral_id IS NULL))
      ORDER BY d.event_date DESC, d.created_at DESC
      LIMIT 1`,
    [userId, fieldIds, includeUnassigned],
  );

  // Nav badges. Scoutings/harvests are campaign-scoped like the rest of the
  // screen; stock, documents and reminders are "what you have right now".
  const countsQ = pool.query(
    `SELECT
       (SELECT COUNT(*) FROM crop_scoutings s
          LEFT JOIN plots sp ON sp.id = s.plot_id
         WHERE COALESCE(s.field_id, sp.field_id) IN (${accessible}) AND s.deleted_at IS NULL
           AND s.scouting_date BETWEEN $2::date AND $3::date
           AND COALESCE(s.field_id, sp.field_id) = ANY($4::int[]))::int AS scoutings,
       (SELECT COUNT(*) FROM harvest_loads hl
          JOIN domain_events d ON d.id = hl.domain_event_id
          JOIN plots dp ON dp.id = d.plot_id
         WHERE dp.field_id IN (${accessible}) AND d.deleted_at IS NULL AND d.event_type = 'harvest'
           AND d.event_date BETWEEN $2::date AND $3::date
           AND dp.field_id = ANY($4::int[]))::int AS harvests,
       (SELECT COUNT(*) FROM stock_items WHERE user_id = $1 AND deleted_at IS NULL)::int AS stock,
       (SELECT COUNT(*) FROM stock_items
         WHERE user_id = $1 AND deleted_at IS NULL
           AND min_stock IS NOT NULL AND current_quantity <= min_stock)::int AS stock_alerts,
       (SELECT COUNT(*) FROM documents WHERE user_id = $1 AND deleted_at IS NULL)::int AS documents,
       (SELECT COUNT(*) FROM task_reminders
         WHERE user_id = $1 AND status IN ('pending', 'sent'))::int AS reminders,
       -- Gastos/Ingresos: filas fechadas en la ventana, porque las tablas
       -- filtran así (badge = tabla), aunque la plata del Resumen sea por campaña.
       (SELECT COUNT(*) FROM expenses e WHERE ${moneyScope('e', 'expense_date')})::int AS expenses,
       (SELECT COUNT(*) FROM incomes i WHERE ${moneyScope('i', 'income_date')})::int AS incomes`,
    p5,
  );

  const [
    moneyRows, categories, incomeProducts, rain, prevRain, activities,
    plots, campaignMoneyRows, plotHarvest, plotLast, feed, budgets,
    reminders, livestock, lastWeighing, counts,
  ] = await Promise.all([
    moneyQ, categoriesQ, incomeProductsQ, rainQ, prevRainQ, activitiesQ,
    plotsQ, campaignMoneyRowsQ, plotHarvestQ, plotLastQ, feedQ, budgetsQ,
    remindersQ, livestockQ, lastWeighingQ, countsQ,
  ]);


  const money: { ARS: MoneySide; USD: MoneySide } = { ARS: emptySide(), USD: emptySide() };
  let obsFrom: string | null = null;
  let obsTo: string | null = null;
  const stretch = (first: string | null, last: string | null) => {
    if (first && (!obsFrom || first < obsFrom)) obsFrom = first;
    if (last && (!obsTo || last > obsTo)) obsTo = last;
  };

  const sideOf = (currency: unknown) => money[String(currency).toUpperCase() === 'USD' ? 'USD' : 'ARS'];
  const curKey = (currency: unknown): 'ARS' | 'USD' => (String(currency).toUpperCase() === 'USD' ? 'USD' : 'ARS');

  for (const r of moneyRows.rows) {
    const side = sideOf(r.currency);
    if (r.kind === 'expense') {
      side.expense += Number(r.total);
      side.expenseCount += Number(r.n);
    } else {
      side.income += Number(r.total);
      side.incomeCount += Number(r.n);
    }
    stretch(r.first_date, r.last_date);
  }
  const moneyUSDEq: MoneyUSDEq = { income: 0, expense: 0, result: 0, missing: 0, source: FX_SOURCE_LABEL[fxSource] };
  for (const r of moneyRows.rows) {
    if (r.kind === 'expense') moneyUSDEq.expense += Number(r.usd_eq); else moneyUSDEq.income += Number(r.usd_eq);
    moneyUSDEq.missing += Number(r.fx_missing);
  }
  moneyUSDEq.result = moneyUSDEq.income - moneyUSDEq.expense;
  money.ARS.result = money.ARS.income - money.ARS.expense;
  money.USD.result = money.USD.income - money.USD.expense;

  const cats: { ARS: CategoryRow[]; USD: CategoryRow[] } = { ARS: [], USD: [] };
  for (const r of categories.rows) {
    cats[curKey(r.currency)].push({ category: r.category, total: Number(r.total) });
  }

  const products: { ARS: IncomeProductRow[]; USD: IncomeProductRow[] } = { ARS: [], USD: [] };
  for (const r of incomeProducts.rows) {
    const kg = r.kg == null ? null : Number(r.kg);
    const amountWithKg = r.amount_with_kg == null ? 0 : Number(r.amount_with_kg);
    products[curKey(r.currency)].push({
      name: String(r.name),
      total: Number(r.total),
      count: Number(r.n),
      kg,
      pricePerTn: kg && kg > 0 ? amountWithKg / (kg / 1000) : null,
    });
  }

  const spendByPlot = new Map<number, { ARS: number; USD: number }>();
  const incomeByPlot = new Map<number, { ARS: number; USD: number }>();
  for (const r of campaignMoneyRows.rows) {
    const id = Number(r.plot_id);
    const map = r.kind === 'expense' ? spendByPlot : incomeByPlot;
    const cur = map.get(id) ?? { ARS: 0, USD: 0 };
    cur[curKey(r.currency)] += Number(r.total);
    map.set(id, cur);
  }

  const harvestByPlot = new Map<number, number>();
  const harvestHaByPlot = new Map<number, number>();
  for (const r of plotHarvest.rows) {
    if (r.kg != null) harvestByPlot.set(Number(r.plot_id), Number(r.kg));
    if (r.ha != null) harvestHaByPlot.set(Number(r.plot_id), Number(r.ha));
  }

  const lastByPlot = new Map<number, string>();
  for (const r of plotLast.rows) {
    lastByPlot.set(
      Number(r.plot_id),
      eventLabel(r.event_type) + eventDetail(r) + ' · ' + formatDayMonth(r.event_date),
    );
  }

  const plotRows: PlotRow[] = plots.rows.map((r: Record<string, unknown>) => {
    const id = Number(r.id);
    const spend = spendByPlot.get(id) ?? { ARS: 0, USD: 0 };
    const income = incomeByPlot.get(id) ?? { ARS: 0, USD: 0 };
    const area = r.area_hectares == null ? null : Number(r.area_hectares);
    const harvestKg = harvestByPlot.get(id) ?? null;
    // Yield over the sown area when the campaign recorded a partial sowing.
    // La base del kg/ha sale de harvestCampaignsCte (la misma que el chat): con
    // avance parcial divide por lo cosechado. Antes el Resumen dividía por lo
    // sembrado y daba 1.680 kg/ha donde el chat decía 4.200 (DSH-5).
    const sown = r.sowed_hectares == null ? null : Number(r.sowed_hectares);
    const yieldBase = harvestHaByPlot.get(id) ?? (sown && sown > 0 ? sown : area);
    return {
      id,
      name: String(r.name),
      fieldId: Number(r.field_id),
      fieldName: String(r.field_name),
      areaHectares: area,
      crop: (r.crop_sequence as string | null) ? displaySequence(String(r.crop_sequence)) : displayCrop(r.crop as string | null),
      cropState: cropState(r),
      spendARS: spend.ARS,
      spendUSD: spend.USD,
      incomeARS: income.ARS,
      incomeUSD: income.USD,
      harvestKg,
      yieldKgPerHa: harvestKg != null && yieldBase && yieldBase > 0 ? harvestKg / yieldBase : null,
      lastActivity: lastByPlot.get(id) ?? null,
    };
  });

  // Margin per crop = la plata de cada CAMPAÑA agrupada por su cultivo ("Soja",
  // "Soja 2da", "Trigo"): un lote con trigo + soja de 2da aporta a las dos
  // filas con lo de cada una. Lo del lote sin campaña va a "Sin campaña".
  // Misma query que las tarjetas: suman lo mismo.
  const cropMargins = {
    ARS: buildCropMargins(campaignMoneyRows.rows, 'ARS'),
    USD: buildCropMargins(campaignMoneyRows.rows, 'USD'),
  };
  const cropMarginsUSDEq = buildCropMargins(campaignMoneyRows.rows, 'USD_EQ');

  const feedRows: FeedRow[] = feed.rows.map((r: Record<string, unknown>) => {
    const type = r.type as FeedRow['type'];
    const where = [r.field_name, r.plot_name].filter(Boolean).join(' / ') || null;
    if (type === 'activity') {
      return {
        type, id: Number(r.id), date: String(r.date),
        kind: eventLabel(r.kind as string),
        detail: eventDetail(r as never),
        where,
      };
    }
    const amount = Number(r.amount ?? 0);
    const cur = curKey(r.currency) === 'USD' ? 'USD ' : '$';
    const moneyText = cur + new Intl.NumberFormat('es-AR').format(Math.round(Math.abs(amount)));
    const desc = r.description ? ` · ${r.description}` : '';
    return {
      type, id: Number(r.id), date: String(r.date),
      kind: (type === 'expense' ? 'Gasto' : 'Ingreso') + ' · ' + String(r.kind),
      detail: ` · ${moneyText}${desc}`,
      where,
    };
  });

  const months = rain.rows.map(toRainMonth);
  const prevMonths = prevRain.rows.map(toRainMonth);

  const budgetRows: BudgetRow[] = budgets.rows.map((r: Record<string, unknown>) => ({
    category: String(r.category),
    limit: Number(r.monthly_limit),
    currency: r.currency === 'USD' ? 'USD' : 'ARS',
    spent: Number(r.spent),
  }));

  const reminderRows: ReminderRow[] = reminders.rows.map((r: Record<string, unknown>) => ({
    id: Number(r.id),
    description: String(r.description),
    dueDate: String(r.due_date),
    where: [r.field_name, r.plot_name].filter(Boolean).join(' / ') || null,
    overdue: Boolean(r.overdue),
  }));

  const byCategory = livestock.rows.map((r: Record<string, unknown>) => ({
    category: String(r.category),
    count: Number(r.n),
  }));
  const head = byCategory.reduce((s, r) => s + r.count, 0);
  const lw = lastWeighing.rows[0];

  const c = counts.rows[0] ?? {};
  return {
    campaign: range,
    moneyUSDEq,
    cropMarginsUSDEq,
    counts: {
      plots: plotRows.length,
      activities: Number(activities.rows[0]?.n ?? 0),
      scoutings: Number(c.scoutings ?? 0),
      harvests: Number(c.harvests ?? 0),
      expenses: Number(c.expenses ?? 0),
      incomes: Number(c.incomes ?? 0),
      stock: Number(c.stock ?? 0),
      stockAlerts: Number(c.stock_alerts ?? 0),
      livestock: head,
      documents: Number(c.documents ?? 0),
      reminders: Number(c.reminders ?? 0),
    },
    observed: { from: obsFrom, to: obsTo },
    money,
    categories: cats,
    incomeProducts: products,
    cropMargins,
    budgets: { month: monthStart.slice(0, 7), rows: budgetRows },
    reminders: {
      overdue: reminderRows.filter(r => r.overdue).length,
      upcoming: reminderRows.filter(r => !r.overdue).length,
      rows: reminderRows.slice(0, 6),
    },
    livestock: {
      total: head,
      byCategory,
      lastWeighing: lw
        ? { date: String(lw.event_date), category: lw.animal_category ? String(lw.animal_category) : null, kg: Number(lw.kg) }
        : null,
    },
    rainfall: {
      total: months.reduce((s, m) => s + m.mm, 0),
      count: rain.rows.reduce((s: number, r: Record<string, unknown>) => s + Number(r.n), 0),
      months,
      prevTotal: prevMonths.reduce((s, m) => s + m.mm, 0),
      prevMonths,
      prevLabel: prevRange.label,
    },
    activities: { count: Number(activities.rows[0]?.n ?? 0) },
    plots: plotRows,
    feed: feedRows,
  };
}

/**
 * Filas de `campaignMoneyRowsQ` → margen por cultivo. `USD_EQ` suma todo
 * (pesos al dólar de su fecha); ARS/USD solo lo de esa moneda. Hectáreas y
 * lotes cuentan cada campaña una vez.
 */
function buildCropMargins(rows: Array<Record<string, unknown>>, currency: 'ARS' | 'USD' | 'USD_EQ'): CropMarginRow[] {
  const byCrop = new Map<string | null, CropMarginRow & { _campaigns: Set<string> }>();
  for (const r of rows) {
    const cur = String(r.currency).toUpperCase() === 'USD' ? 'USD' : 'ARS';
    if (currency !== 'USD_EQ' && cur !== currency) continue;
    const amount = currency === 'USD_EQ' ? (r.usd_eq == null ? 0 : Number(r.usd_eq)) : Number(r.total);
    const key = r.crop_label ? displaySequence(String(r.crop_label)) : null;
    const row = byCrop.get(key) ?? { crop: key, hectares: 0, plots: 0, income: 0, expense: 0, result: 0, _campaigns: new Set<string>() };
    const campaignKey = r.plot_crop_id != null ? `c${r.plot_crop_id}` : `p${r.plot_id}`;
    if (!row._campaigns.has(campaignKey)) {
      row._campaigns.add(campaignKey);
      row.plots += 1;
      row.hectares += r.ha == null ? 0 : Number(r.ha);
    }
    if (r.kind === 'expense') row.expense += amount; else row.income += amount;
    row.result = row.income - row.expense;
    byCrop.set(key, row);
  }
  return Array.from(byCrop.values())
    .map(({ _campaigns, ...r }) => r)
    .filter(r => r.income > 0 || r.expense > 0)
    .sort((a, b) => (b.income + b.expense) - (a.income + a.expense));
}

function toRainMonth(r: Record<string, unknown>): RainfallMonth {
  const month = String(r.month);
  return { month, label: monthLabel(month), mm: Number(r.mm) };
}

function cropState(r: Record<string, unknown>): string | null {
  if (!r.crop) return null;
  if (r.harvested_at) return `cosechado el ${formatDayMonth(String(r.harvested_at))}`;
  if (r.crop_start) return `sembrado el ${formatDayMonth(String(r.crop_start))}`;
  return null;
}

/**
 * Crop names arrive with whatever casing the agent produced — the same account
 * holds both "Maíz" and "maíz". Normalising for DISPLAY only (the stored value
 * is left alone) keeps a plot list from looking like two different crops.
 */
/** "trigo → soja 2da" → "Trigo → Soja 2da". */
function displaySequence(seq: string): string {
  return seq.split(' → ').map(c => displayCrop(c) ?? c).join(' → ');
}

/** Categoría sin acentos ni mayúsculas (SQL), para excluir "Hacienda". */
function foldCategory(col: string): string {
  return `translate(lower(trim(COALESCE(${col}, ''))), 'áéíóú', 'aeiou')`;
}

export function displayCrop(crop: string | null): string | null {
  if (!crop) return null;
  const t = crop.trim();
  if (!t) return null;
  return t.charAt(0).toLocaleUpperCase('es-AR') + t.slice(1).toLocaleLowerCase('es-AR');
}

export const MONTH_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * "2026-03" → "mar". Built here, never with `to_char(..., 'Mon')`: that format
 * is English no matter what (only `TMMon` localises, and lc_time is C on the
 * deployment anyway), so the charts read "Jan/Apr/Aug/Dec" to a Spanish user.
 */
export function monthLabel(yyyyMm: string): string {
  const idx = parseInt(yyyyMm.slice(5, 7), 10) - 1;
  return MONTH_SHORT[idx] ?? yyyyMm;
}

/** "2026-03-18" → "18 mar". Parsed as plain Y-M-D, never through Date's TZ shift. */
export function formatDayMonth(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${parseInt(m[3], 10)} ${MONTH_SHORT[parseInt(m[2], 10) - 1]}`;
}
