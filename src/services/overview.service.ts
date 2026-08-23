/**
 * Payload for the redesigned "Resumen" screen.
 *
 * Why a new endpoint instead of extending `/dashboard`: the old Resumen answered
 * "cómo viene ESTE MES" (current vs previous month). The redesign answers "cómo
 * cerró LA CAMPAÑA", which is a different window (see utils/campaign-range.ts),
 * a different grain (per-plot, per-category ranking) and a different currency
 * story (ARS and USD side by side, never one collapsed into the other — a real
 * account is negative in pesos and positive in dollars at the same time).
 *
 * `/dashboard` stays as-is: other callers still use it.
 */
import { pool } from '../config/db.js';
import type { CampaignRange } from '../utils/campaign-range.js';

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
  lastActivity: string | null;
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
  harvests: number;
  expenses: number;
  incomes: number;
  stock: number;
  /** Items at or below their minimum — drives the low-stock banner. */
  stockAlerts: number;
  livestock: number;
  documents: number;
  reminders: number;
}

export interface OverviewPayload {
  campaign: CampaignRange;
  counts: OverviewCounts;
  observed: { from: string | null; to: string | null };
  money: { ARS: MoneySide; USD: MoneySide };
  categories: { ARS: CategoryRow[]; USD: CategoryRow[] };
  rainfall: { total: number; count: number; months: Array<{ month: string; label: string; mm: number }> };
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
 * user's own fields". Mirrors the resolution `/dashboard` does so both screens
 * agree on what "todos los campos" contains.
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

export async function getOverview(
  userId: number,
  fieldIds: number[],
  range: CampaignRange,
): Promise<OverviewPayload> {
  const accessible = `SELECT field_id FROM field_members WHERE user_id = $1`;
  const p = [userId, range.from, range.to, fieldIds];

  const expensesQ = pool.query(
    `SELECT COALESCE(currency, 'ARS') AS currency,
            SUM(amount)::numeric AS total,
            COUNT(*)::int AS n,
            MIN(expense_date)::text AS first_date,
            MAX(expense_date)::text AS last_date
       FROM expenses e
      WHERE (e.user_id = $1 OR e.field_id IN (${accessible}))
        AND e.deleted_at IS NULL
        AND e.expense_date BETWEEN $2::date AND $3::date
        AND COALESCE(e.field_id, (SELECT field_id FROM plots WHERE id = e.plot_id)) = ANY($4::int[])
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
      WHERE (i.user_id = $1 OR i.field_id IN (${accessible}))
        AND i.deleted_at IS NULL
        AND i.income_date BETWEEN $2::date AND $3::date
        AND COALESCE(i.field_id, (SELECT field_id FROM plots WHERE id = i.plot_id)) = ANY($4::int[])
      GROUP BY 1`,
    p,
  );

  const categoriesQ = pool.query(
    `SELECT COALESCE(NULLIF(TRIM(e.category), ''), 'Sin categoría') AS category,
            COALESCE(e.currency, 'ARS') AS currency,
            SUM(e.amount)::numeric AS total
       FROM expenses e
      WHERE (e.user_id = $1 OR e.field_id IN (${accessible}))
        AND e.deleted_at IS NULL
        AND e.expense_date BETWEEN $2::date AND $3::date
        AND COALESCE(e.field_id, (SELECT field_id FROM plots WHERE id = e.plot_id)) = ANY($4::int[])
      GROUP BY 1, 2
      ORDER BY 3 DESC`,
    p,
  );

  // Every month of the campaign window, so a month with no rain reads as a
  // visible gap instead of vanishing from the axis.
  const rainQ = pool.query(
    `WITH months AS (
       SELECT generate_series($2::date, $3::date, '1 month')::date AS m
     )
     SELECT to_char(months.m, 'YYYY-MM') AS month,
            COALESCE((
              SELECT SUM(r.millimeters) FROM rainfall r
               WHERE r.user_id = $1
                 AND r.field_id = ANY($4::int[])
                 AND r.rainfall_date >= months.m
                 AND r.rainfall_date < months.m + interval '1 month'
            ), 0)::numeric AS mm,
            COALESCE((
              SELECT COUNT(*) FROM rainfall r
               WHERE r.user_id = $1
                 AND r.field_id = ANY($4::int[])
                 AND r.rainfall_date >= months.m
                 AND r.rainfall_date < months.m + interval '1 month'
            ), 0)::int AS n
       FROM months
      ORDER BY months.m`,
    p,
  );

  const activitiesQ = pool.query(
    `SELECT COUNT(*)::int AS n
       FROM domain_events d
       LEFT JOIN plots pl ON pl.id = d.plot_id
      WHERE d.user_id = $1
        AND d.deleted_at IS NULL
        AND d.event_date BETWEEN $2::date AND $3::date
        AND (d.plot_id IS NULL OR pl.field_id = ANY($4::int[]))`,
    p,
  );

  const plotsQ = pool.query(
    `SELECT pl.id, pl.name, pl.area_hectares, f.id AS field_id, f.name AS field_name,
            pc.crop, pc.start_date::text AS crop_start, pc.harvested_at::text AS harvested_at,
            pc.end_date::text AS crop_end
       FROM plots pl
       JOIN fields f ON f.id = pl.field_id
       LEFT JOIN LATERAL (
         SELECT c.crop, c.start_date, c.harvested_at, c.end_date
           FROM plot_crops c
          WHERE c.plot_id = pl.id
          ORDER BY (c.end_date IS NULL) DESC, c.start_date DESC NULLS LAST
          LIMIT 1
       ) pc ON true
      WHERE f.id = ANY($1::int[])
        AND pl.deleted_at IS NULL
        AND f.deleted_at IS NULL
      ORDER BY f.name, pl.name`,
    [fieldIds],
  );

  const plotSpendQ = pool.query(
    `SELECT e.plot_id, COALESCE(e.currency, 'ARS') AS currency, SUM(e.amount)::numeric AS total
       FROM expenses e
      WHERE (e.user_id = $1 OR e.field_id IN (${accessible}))
        AND e.deleted_at IS NULL
        AND e.plot_id IS NOT NULL
        AND e.expense_date BETWEEN $2::date AND $3::date
        AND COALESCE(e.field_id, (SELECT field_id FROM plots WHERE id = e.plot_id)) = ANY($4::int[])
      GROUP BY 1, 2`,
    p,
  );

  // Income per plot, so a lote card can show a RESULT and not just a cost.
  // Same window as everything else on the screen — the old per-plot
  // profitability chart was scoped to the current month while the rest of the
  // Resumen spoke about the campaign, which made the two silently disagree.
  const plotIncomeQ = pool.query(
    `SELECT i.plot_id, COALESCE(i.currency, 'ARS') AS currency, SUM(i.amount)::numeric AS total
       FROM incomes i
      WHERE (i.user_id = $1 OR i.field_id IN (${accessible}))
        AND i.deleted_at IS NULL
        AND i.plot_id IS NOT NULL
        AND i.income_date BETWEEN $2::date AND $3::date
        AND COALESCE(i.field_id, (SELECT field_id FROM plots WHERE id = i.plot_id)) = ANY($4::int[])
      GROUP BY 1, 2`,
    p,
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
    p,
  );

  const feedQ = pool.query(
    `(SELECT 'activity' AS type, d.id, d.event_date::text AS date, d.event_type AS kind,
             d.crop, d.product, d.quantity, d.unit,
             NULL::numeric AS amount, NULL::text AS currency, NULL::text AS description,
             f.name AS field_name, pl.name AS plot_name, d.created_at
        FROM domain_events d
        LEFT JOIN plots pl ON pl.id = d.plot_id
        LEFT JOIN fields f ON f.id = pl.field_id
       WHERE d.user_id = $1 AND d.deleted_at IS NULL
         AND d.event_date BETWEEN $2::date AND $3::date
         AND (d.plot_id IS NULL OR pl.field_id = ANY($4::int[])))
     UNION ALL
     (SELECT 'expense', e.id, e.expense_date::text, COALESCE(e.category, 'Gasto'),
             NULL, e.product, e.quantity, e.unit,
             e.amount, COALESCE(e.currency, 'ARS'), e.description,
             f.name, pl.name, e.created_at
        FROM expenses e
        LEFT JOIN plots pl ON pl.id = e.plot_id
        LEFT JOIN fields f ON f.id = COALESCE(e.field_id, pl.field_id)
       WHERE (e.user_id = $1 OR e.field_id IN (${accessible})) AND e.deleted_at IS NULL
         AND e.expense_date BETWEEN $2::date AND $3::date
         AND COALESCE(e.field_id, pl.field_id) = ANY($4::int[]))
     UNION ALL
     (SELECT 'income', i.id, i.income_date::text, COALESCE(i.category, 'Ingreso'),
             NULL, i.product, i.quantity, i.unit,
             i.amount, COALESCE(i.currency, 'ARS'), i.description,
             f.name, pl.name, i.created_at
        FROM incomes i
        LEFT JOIN plots pl ON pl.id = i.plot_id
        LEFT JOIN fields f ON f.id = COALESCE(i.field_id, pl.field_id)
       WHERE (i.user_id = $1 OR i.field_id IN (${accessible})) AND i.deleted_at IS NULL
         AND i.income_date BETWEEN $2::date AND $3::date
         AND COALESCE(i.field_id, pl.field_id) = ANY($4::int[]))
     ORDER BY date DESC, created_at DESC
     LIMIT 10`,
    p,
  );

  // Nav badges. Scoutings/harvests are campaign-scoped like the rest of the
  // screen; stock, livestock, documents and reminders are "what you have right
  // now", which is what those sections show.
  const countsQ = pool.query(
    `SELECT
       (SELECT COUNT(*) FROM crop_scoutings s
          LEFT JOIN plots sp ON sp.id = s.plot_id
         WHERE s.user_id = $1 AND s.deleted_at IS NULL
           AND s.scouting_date BETWEEN $2::date AND $3::date
           AND COALESCE(s.field_id, sp.field_id) = ANY($4::int[]))::int AS scoutings,
       (SELECT COUNT(*) FROM domain_events d
          JOIN plots dp ON dp.id = d.plot_id
         WHERE d.user_id = $1 AND d.deleted_at IS NULL AND d.event_type = 'harvest'
           AND d.event_date BETWEEN $2::date AND $3::date
           AND dp.field_id = ANY($4::int[]))::int AS harvests,
       (SELECT COUNT(*) FROM stock_items WHERE user_id = $1 AND deleted_at IS NULL)::int AS stock,
       (SELECT COUNT(*) FROM stock_items
         WHERE user_id = $1 AND deleted_at IS NULL
           AND min_stock IS NOT NULL AND current_quantity <= min_stock)::int AS stock_alerts,
       (SELECT COUNT(*) FROM livestock_groups WHERE user_id = $1 AND deleted_at IS NULL)::int AS livestock,
       (SELECT COUNT(*) FROM documents WHERE user_id = $1 AND deleted_at IS NULL)::int AS documents,
       (SELECT COUNT(*) FROM task_reminders WHERE user_id = $1 AND status = 'pending')::int AS reminders`,
    p,
  );

  const [expenses, incomes, categories, rain, activities, plots, plotSpend, plotIncome, plotLast, feed, counts] =
    await Promise.all([
      expensesQ, incomesQ, categoriesQ, rainQ, activitiesQ, plotsQ, plotSpendQ, plotIncomeQ, plotLastQ, feedQ, countsQ,
    ]);

  const money: { ARS: MoneySide; USD: MoneySide } = { ARS: emptySide(), USD: emptySide() };
  let obsFrom: string | null = null;
  let obsTo: string | null = null;
  const stretch = (first: string | null, last: string | null) => {
    if (first && (!obsFrom || first < obsFrom)) obsFrom = first;
    if (last && (!obsTo || last > obsTo)) obsTo = last;
  };

  for (const r of expenses.rows) {
    const side = money[r.currency === 'USD' ? 'USD' : 'ARS'];
    side.expense = Number(r.total);
    side.expenseCount = Number(r.n);
    stretch(r.first_date, r.last_date);
  }
  for (const r of incomes.rows) {
    const side = money[r.currency === 'USD' ? 'USD' : 'ARS'];
    side.income = Number(r.total);
    side.incomeCount = Number(r.n);
    stretch(r.first_date, r.last_date);
  }
  money.ARS.result = money.ARS.income - money.ARS.expense;
  money.USD.result = money.USD.income - money.USD.expense;

  const cats: { ARS: CategoryRow[]; USD: CategoryRow[] } = { ARS: [], USD: [] };
  for (const r of categories.rows) {
    cats[r.currency === 'USD' ? 'USD' : 'ARS'].push({
      category: r.category,
      total: Number(r.total),
    });
  }

  const spendByPlot = new Map<number, { ARS: number; USD: number }>();
  for (const r of plotSpend.rows) {
    const id = Number(r.plot_id);
    const cur = spendByPlot.get(id) ?? { ARS: 0, USD: 0 };
    cur[r.currency === 'USD' ? 'USD' : 'ARS'] = Number(r.total);
    spendByPlot.set(id, cur);
  }

  const incomeByPlot = new Map<number, { ARS: number; USD: number }>();
  for (const r of plotIncome.rows) {
    const id = Number(r.plot_id);
    const cur = incomeByPlot.get(id) ?? { ARS: 0, USD: 0 };
    cur[r.currency === 'USD' ? 'USD' : 'ARS'] = Number(r.total);
    incomeByPlot.set(id, cur);
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
    return {
      id,
      name: String(r.name),
      fieldId: Number(r.field_id),
      fieldName: String(r.field_name),
      areaHectares: r.area_hectares == null ? null : Number(r.area_hectares),
      crop: displayCrop(r.crop as string | null),
      cropState: cropState(r),
      spendARS: spend.ARS,
      spendUSD: spend.USD,
      incomeARS: income.ARS,
      incomeUSD: income.USD,
      lastActivity: lastByPlot.get(id) ?? null,
    };
  });

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
    const cur = (r.currency as string) === 'USD' ? 'USD ' : '$';
    const money = cur + new Intl.NumberFormat('es-AR').format(Math.round(Math.abs(amount)));
    const desc = r.description ? ` · ${r.description}` : '';
    return {
      type, id: Number(r.id), date: String(r.date),
      kind: (type === 'expense' ? 'Gasto' : 'Ingreso') + ' · ' + String(r.kind),
      detail: ` · ${money}${desc}`,
      where,
    };
  });

  // Month labels are built here, not by `to_char(..., 'TMMon')`: that follows the
  // server's lc_time, which is not Spanish on every deployment (a C-locale
  // cluster returns "dec"/"jan"). One list, always es-AR.
  const months = rain.rows.map((r: Record<string, unknown>) => {
    const month = String(r.month);
    const idx = parseInt(month.slice(5, 7), 10) - 1;
    return { month, label: MONTH_SHORT[idx] ?? month, mm: Number(r.mm) };
  });

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
      livestock: Number(c.livestock ?? 0),
      documents: Number(c.documents ?? 0),
      reminders: Number(c.reminders ?? 0),
    },
    observed: { from: obsFrom, to: obsTo },
    money,
    categories: cats,
    rainfall: {
      total: months.reduce((s: number, m: { mm: number }) => s + m.mm, 0),
      count: rain.rows.reduce((s: number, r: Record<string, unknown>) => s + Number(r.n), 0),
      months,
    },
    activities: { count: Number(activities.rows[0]?.n ?? 0) },
    plots: plotRows,
    feed: feedRows,
  };
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

const MONTH_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "2026-03-18" → "18 mar". Parsed as plain Y-M-D, never through Date's TZ shift. */
export function formatDayMonth(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${parseInt(m[3], 10)} ${MONTH_SHORT[parseInt(m[2], 10) - 1]}`;
}
