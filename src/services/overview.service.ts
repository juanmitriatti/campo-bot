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
import { campaignRange, type CampaignRange } from '../utils/campaign-range.js';
import { getTodayISO } from '../utils/date.js';

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

export interface OverviewPayload {
  campaign: CampaignRange;
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
export async function resolveFieldIds(userId: number, fieldId: number | null): Promise<number[]> {
  if (fieldId != null) return [fieldId];
  const { rows } = await pool.query(
    `SELECT id FROM fields WHERE user_id = $1 AND deleted_at IS NULL`,
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
  const accessible = `SELECT field_id FROM field_members WHERE user_id = $1`;
  const includeUnassigned = opts.includeUnassigned;
  const p = [userId, range.from, range.to, fieldIds, includeUnassigned];

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
  const eventScope = `d.user_id = $1
        AND d.deleted_at IS NULL
        AND d.event_date BETWEEN $2::date AND $3::date
        AND (
          COALESCE(pl.field_id, fl.field_id) = ANY($4::int[])
          OR ($5::boolean AND d.plot_id IS NULL AND d.corral_id IS NULL)
        )`;

  const expensesQ = pool.query(
    `SELECT COALESCE(currency, 'ARS') AS currency,
            SUM(amount)::numeric AS total,
            COUNT(*)::int AS n,
            MIN(expense_date)::text AS first_date,
            MAX(expense_date)::text AS last_date
       FROM expenses e
      WHERE ${moneyScope('e', 'expense_date')}
      GROUP BY 1`,
    p,
  );

  const incomesQ = pool.query(
    `SELECT COALESCE(currency, 'ARS') AS currency,
            SUM(amount)::numeric AS total,
            COUNT(*)::int AS n,
            MIN(income_date)::text AS first_date,
            MAX(income_date)::text AS last_date
       FROM incomes i
      WHERE ${moneyScope('i', 'income_date')}
      GROUP BY 1`,
    p,
  );

  const categoriesQ = pool.query(
    `SELECT COALESCE(NULLIF(TRIM(e.category), ''), 'Sin categoría') AS category,
            COALESCE(e.currency, 'ARS') AS currency,
            SUM(e.amount)::numeric AS total
       FROM expenses e
      WHERE ${moneyScope('e', 'expense_date')}
      GROUP BY 1, 2
      ORDER BY 3 DESC`,
    p,
  );

  // What was sold: by product (grain) when the row has one, else by category.
  // kg and price only over rows that carried a real weight unit.
  const incomeProductsQ = pool.query(
    `SELECT COALESCE(NULLIF(TRIM(i.product), ''), NULLIF(TRIM(i.category), ''), 'Sin detalle') AS name,
            COALESCE(i.currency, 'ARS') AS currency,
            SUM(i.amount)::numeric AS total,
            COUNT(*)::int AS n,
            SUM(CASE WHEN i.quantity > 0 AND ${kgFactor('i.unit')} IS NOT NULL
                     THEN i.quantity * ${kgFactor('i.unit')} END)::numeric AS kg,
            SUM(CASE WHEN i.quantity > 0 AND ${kgFactor('i.unit')} IS NOT NULL
                     THEN i.amount END)::numeric AS amount_with_kg
       FROM incomes i
      WHERE ${moneyScope('i', 'income_date')}
      GROUP BY 1, 2
      ORDER BY 3 DESC`,
    p,
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
    p,
  );

  // The crop shown on a lote card is the one that OVERLAPS the campaign window
  // (active first, then the latest started), not the one on the lote today.
  const plotsQ = pool.query(
    `SELECT pl.id, pl.name, pl.area_hectares, f.id AS field_id, f.name AS field_name,
            pc.crop, pc.start_date::text AS crop_start, pc.harvested_at::text AS harvested_at,
            pc.end_date::text AS crop_end, pc.sowed_hectares
       FROM plots pl
       JOIN fields f ON f.id = pl.field_id
       LEFT JOIN LATERAL (
         SELECT c.crop, c.start_date, c.harvested_at, c.end_date, c.sowed_hectares
           FROM plot_crops c
          WHERE c.plot_id = pl.id
            AND c.start_date <= $2::date
            AND (c.end_date IS NULL OR c.end_date >= $1::date)
          ORDER BY (c.end_date IS NULL) DESC, c.start_date DESC NULLS LAST
          LIMIT 1
       ) pc ON true
      WHERE f.id = ANY($3::int[])
        AND pl.deleted_at IS NULL
        AND f.deleted_at IS NULL
      ORDER BY f.name, pl.name`,
    [range.from, range.to, fieldIds],
  );

  const plotSpendQ = pool.query(
    `SELECT e.plot_id, COALESCE(e.currency, 'ARS') AS currency, SUM(e.amount)::numeric AS total
       FROM expenses e
      WHERE ${moneyScope('e', 'expense_date')}
        AND e.plot_id IS NOT NULL
      GROUP BY 1, 2`,
    p,
  );

  // Income per plot, so a lote card can show a RESULT and not just a cost.
  // Same window as everything else on the screen.
  const plotIncomeQ = pool.query(
    `SELECT i.plot_id, COALESCE(i.currency, 'ARS') AS currency, SUM(i.amount)::numeric AS total
       FROM incomes i
      WHERE ${moneyScope('i', 'income_date')}
        AND i.plot_id IS NOT NULL
      GROUP BY 1, 2`,
    p,
  );

  // Harvested kg per lote in the campaign. The event's own quantity wins; a
  // harvest dictated truck by truck has none, so fall back to the sum of its
  // loads, then to the campaign's recorded yield.
  const plotHarvestQ = pool.query(
    `SELECT d.plot_id,
            SUM(COALESCE(
              d.quantity * COALESCE(${kgFactor('d.unit')}, 1),
              (SELECT SUM(hl.weight_kg) FROM harvest_loads hl WHERE hl.domain_event_id = d.id),
              pc.yield_kg
            ))::numeric AS kg
       FROM domain_events d
       JOIN plots pl ON pl.id = d.plot_id
       LEFT JOIN plot_crops pc ON pc.id = d.plot_crop_id
      WHERE d.user_id = $1
        AND d.deleted_at IS NULL
        AND d.event_type = 'harvest'
        AND d.event_date BETWEEN $2::date AND $3::date
        AND pl.field_id = ANY($4::int[])
      GROUP BY d.plot_id`,
    [userId, range.from, range.to, fieldIds],
  );

  const plotLastQ = pool.query(
    `SELECT DISTINCT ON (d.plot_id)
            d.plot_id, d.event_type, d.event_date::text AS event_date,
            d.crop, d.product, d.quantity, d.unit
       FROM domain_events d
       JOIN plots pl ON pl.id = d.plot_id
      WHERE d.user_id = $1
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
    p,
  );

  // Budgets are per user and per calendar month (that is what `set_budget`
  // stores), in pesos. Spent = this month's ARS expenses, all fields.
  const today = getTodayISO();
  const monthStart = today.slice(0, 7) + '-01';
  const budgetsQ = pool.query(
    `SELECT b.category, b.monthly_limit::numeric AS monthly_limit,
            COALESCE((
              SELECT SUM(e.amount) FROM expenses e
               WHERE e.user_id = $1 AND e.deleted_at IS NULL
                 AND COALESCE(e.currency, 'ARS') = 'ARS'
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
      WHERE lg.user_id = $1 AND lg.deleted_at IS NULL
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
      WHERE d.user_id = $1 AND d.deleted_at IS NULL
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
         WHERE s.user_id = $1 AND s.deleted_at IS NULL
           AND s.scouting_date BETWEEN $2::date AND $3::date
           AND COALESCE(s.field_id, sp.field_id) = ANY($4::int[]))::int AS scoutings,
       (SELECT COUNT(*) FROM harvest_loads hl
          JOIN domain_events d ON d.id = hl.domain_event_id
          JOIN plots dp ON dp.id = d.plot_id
         WHERE d.user_id = $1 AND d.deleted_at IS NULL AND d.event_type = 'harvest'
           AND d.event_date BETWEEN $2::date AND $3::date
           AND dp.field_id = ANY($4::int[]))::int AS harvests,
       (SELECT COUNT(*) FROM stock_items WHERE user_id = $1 AND deleted_at IS NULL)::int AS stock,
       (SELECT COUNT(*) FROM stock_items
         WHERE user_id = $1 AND deleted_at IS NULL
           AND min_stock IS NOT NULL AND current_quantity <= min_stock)::int AS stock_alerts,
       (SELECT COUNT(*) FROM documents WHERE user_id = $1 AND deleted_at IS NULL)::int AS documents,
       (SELECT COUNT(*) FROM task_reminders
         WHERE user_id = $1 AND status IN ('pending', 'sent'))::int AS reminders`,
    [userId, range.from, range.to, fieldIds],
  );

  const [
    expenses, incomes, categories, incomeProducts, rain, prevRain, activities,
    plots, plotSpend, plotIncome, plotHarvest, plotLast, feed, budgets,
    reminders, livestock, lastWeighing, counts,
  ] = await Promise.all([
    expensesQ, incomesQ, categoriesQ, incomeProductsQ, rainQ, prevRainQ, activitiesQ,
    plotsQ, plotSpendQ, plotIncomeQ, plotHarvestQ, plotLastQ, feedQ, budgetsQ,
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

  for (const r of expenses.rows) {
    const side = sideOf(r.currency);
    side.expense += Number(r.total);
    side.expenseCount += Number(r.n);
    stretch(r.first_date, r.last_date);
  }
  for (const r of incomes.rows) {
    const side = sideOf(r.currency);
    side.income += Number(r.total);
    side.incomeCount += Number(r.n);
    stretch(r.first_date, r.last_date);
  }
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
  for (const r of plotSpend.rows) {
    const id = Number(r.plot_id);
    const cur = spendByPlot.get(id) ?? { ARS: 0, USD: 0 };
    cur[curKey(r.currency)] += Number(r.total);
    spendByPlot.set(id, cur);
  }

  const incomeByPlot = new Map<number, { ARS: number; USD: number }>();
  for (const r of plotIncome.rows) {
    const id = Number(r.plot_id);
    const cur = incomeByPlot.get(id) ?? { ARS: 0, USD: 0 };
    cur[curKey(r.currency)] += Number(r.total);
    incomeByPlot.set(id, cur);
  }

  const harvestByPlot = new Map<number, number>();
  for (const r of plotHarvest.rows) {
    if (r.kg != null) harvestByPlot.set(Number(r.plot_id), Number(r.kg));
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
    const sown = r.sowed_hectares == null ? null : Number(r.sowed_hectares);
    const yieldBase = sown && sown > 0 ? sown : area;
    return {
      id,
      name: String(r.name),
      fieldId: Number(r.field_id),
      fieldName: String(r.field_name),
      areaHectares: area,
      crop: displayCrop(r.crop as string | null),
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

  // Margin per crop = the lote cards regrouped by the crop they carry in the
  // campaign. A lote that ran two crops in the window (trigo → soja de 2da) is
  // attributed whole to the one shown on its card; the cards and this table
  // therefore always agree with each other.
  const cropMargins = { ARS: buildCropMargins(plotRows, 'ARS'), USD: buildCropMargins(plotRows, 'USD') };

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
    counts: {
      plots: plotRows.length,
      activities: Number(activities.rows[0]?.n ?? 0),
      scoutings: Number(c.scoutings ?? 0),
      harvests: Number(c.harvests ?? 0),
      expenses: money.ARS.expenseCount + money.USD.expenseCount,
      incomes: money.ARS.incomeCount + money.USD.incomeCount,
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

function buildCropMargins(plots: PlotRow[], currency: 'ARS' | 'USD'): CropMarginRow[] {
  const byCrop = new Map<string | null, CropMarginRow>();
  for (const p of plots) {
    const key = p.crop;
    const row = byCrop.get(key) ?? { crop: key, hectares: 0, plots: 0, income: 0, expense: 0, result: 0 };
    row.plots += 1;
    row.hectares += p.areaHectares ?? 0;
    row.income += currency === 'ARS' ? p.incomeARS : p.incomeUSD;
    row.expense += currency === 'ARS' ? p.spendARS : p.spendUSD;
    row.result = row.income - row.expense;
    byCrop.set(key, row);
  }
  return Array.from(byCrop.values())
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
