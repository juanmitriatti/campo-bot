import { FinancialService } from './financial.service.js';
import { CategoryRepository } from './category.repository.js';
import { CategoryService } from './category.service.js';
import { generateCSV } from '../../utils/csv.js';
import { recordAlert } from '../../services/alert.service.js';
import { getActivityLabel } from '../agronomy/activity.service.js';
import { getSetting } from '../../services/settings.service.js';
import { localidadLookup } from '../../services/localidad-lookup.service.js';
import { formatLocation } from '../../middleware/pending-field-city-handler.js';
import { queryPlotHistory, updateConversationState } from '../../services/expenses.js';
import { PlotDiscoveryService } from '../plots/plot-discovery.service.js';
import { FieldSharingService } from '../sharing/field-sharing.service.js';
import { formatPlotListGrouped } from '../../middleware/flows/field-step-helpers.js';
import { logError } from '../../services/error-logger.js';
import type {
  UserId,
  User,
  UserSettings,
  ParsedExpense,
  ParsedIncome,
  ParsedCommand,
  CategoryTotal,
  PendingTransaction,
  HandlerResponse,
  PlotInfoData,
  FlowState,
} from '../../types/index.js';

// --- Formatting helpers ---

import { splitPool, interpolate } from '../../utils/template.js';

const DEFAULT_EXPENSE_CONFIRMATIONS = ['✅ Listo, gasto registrado', '✅ Anotado', '✅ Gasto guardado', '✅ Registrado'];
const DEFAULT_INCOME_CONFIRMATIONS = ['💰 Listo, ingreso registrado', '💰 Anotado', '💰 Ingreso guardado', '💰 Registrado'];

async function getConfirmationPool(type: 'expense' | 'income'): Promise<string[]> {
  const key = type === 'expense' ? 'EXPENSE_CONFIRMATIONS_MESSAGE' : 'INCOME_CONFIRMATIONS_MESSAGE';
  const defaults = type === 'expense' ? DEFAULT_EXPENSE_CONFIRMATIONS : DEFAULT_INCOME_CONFIRMATIONS;
  try {
    const raw = await getSetting(key);
    if (!raw) return defaults;
    const pool = splitPool(raw);
    return pool.length > 0 ? pool : defaults;
  } catch {
    return defaults;
  }
}

function pickRandom(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

const MESES_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function currentMonthLabel(): string {
  const now = new Date();
  return `${MESES_ES[now.getMonth()]} ${now.getFullYear()}`;
}

function currentWeekLabel(): string {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `semana ${weekNum}, ${now.getFullYear()}`;
}

function buildLocationLabel(fieldName: string | null, plotName: string | null): string {
  const plotLabel = plotName
    ? (plotName.toLowerCase().startsWith('lote') ? plotName : `Lote ${plotName}`)
    : null;
  if (plotLabel && fieldName) return `${plotLabel} (${fieldName})`;
  if (plotLabel) return plotLabel;
  if (fieldName) return fieldName;
  return '';
}

function formatEventDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const dateIso = d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  if (dateIso === todayStr) return null;
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' });
}

async function buildExpenseConfirmation(data: ParsedExpense, fieldName: string | null, plotName: string | null = null): Promise<string> {
  const pool = await getConfirmationPool('expense');
  const currency = data.currency === 'USD' ? 'USD' : '';
  let msg = `${pickRandom(pool)}\n${data.category}\n$${Number(data.amount).toLocaleString('es-AR')} ${currency}`.trim();
  const loc = buildLocationLabel(fieldName, plotName);
  if (loc) msg += `\n\ud83d\udccd ${loc}`;
  const dateLabel = formatEventDate(data.expenseDate);
  if (dateLabel) msg += `\n\ud83d\udcc5 ${dateLabel}`;
  return msg;
}

async function buildIncomeConfirmation(data: ParsedIncome | Record<string, unknown>, fieldName: string | null, plotName: string | null = null): Promise<string> {
  const pool = await getConfirmationPool('income');
  const currency = (data.currency as string) === 'USD' ? 'USD' : '';
  let msg = `${pickRandom(pool)}\n${data.category}\n$${Number(data.amount).toLocaleString('es-AR')} ${currency}`.trim();
  if (data.quantity && data.unit) {
    msg += `\n${data.quantity} ${data.unit}`;
    if (data.unit_price) msg += ` a $${Number(data.unit_price).toLocaleString('es-AR')}`;
  }
  const loc = buildLocationLabel(fieldName, plotName);
  if (loc) msg += `\n\ud83d\udccd ${loc}`;
  const dateLabel = formatEventDate((data as any).incomeDate);
  if (dateLabel) msg += `\n\ud83d\udcc5 ${dateLabel}`;
  return msg;
}

function buildPendingMessage(type: 'expense' | 'income', data: ParsedExpense | ParsedIncome, fieldName: string | null, plotName: string | null = null): string {
  const emoji = type === 'income' ? '\ud83d\udcb0' : '\ud83d\udcb8';
  const label = type === 'income' ? 'ingreso' : 'gasto';
  const currency = data.currency === 'USD' ? ' USD' : '';
  let msg = `${emoji} \u00bfConfirmo ${label}?\n\n`;
  msg += `Categor\u00eda: *${data.category}*\n`;
  msg += `Monto: *$${Number(data.amount).toLocaleString('es-AR')}${currency}*\n`;
  if ('quantity' in data && data.quantity && data.unit) {
    msg += `Detalle: ${data.quantity} ${data.unit}`;
    if (data.unit_price) msg += ` a $${Number(data.unit_price).toLocaleString('es-AR')}`;
    msg += '\n';
  }
  const loc = buildLocationLabel(fieldName, plotName);
  if (loc) msg += `Ubicación: ${loc}\n`;
  return msg;
}

function formatResult(ingresos: number, gastos: number, label: string): string {
  const resultado = ingresos - gastos;
  const margen = ingresos > 0 ? Math.round((resultado / ingresos) * 100) : 0;
  let msg = `\ud83d\udcc8 ${label}\n\n`;
  msg += `Ingresos: $${ingresos.toLocaleString('es-AR')}\n`;
  msg += `Gastos: $${gastos.toLocaleString('es-AR')}\n`;
  msg += `Resultado: $${resultado.toLocaleString('es-AR')}\n`;
  if (ingresos > 0) msg += `Margen: ${margen}%`;
  return msg;
}

function formatReportRows(rows: CategoryTotal[]): { lines: string; total: number } {
  let total = 0;
  let lines = '';
  rows.forEach((r) => {
    const monto = Number(r.total);
    total += monto;
    lines += `${r.category}: $${monto.toLocaleString('es-AR')}\n`;
  });
  return { lines, total };
}

function buildNoFieldsBlockResponse(actionLabel: string): HandlerResponse {
  return {
    messages: [`Para registrar ${actionLabel} primero necesitás crear un campo.\n\n📍 Escribí *agregar campo [nombre]*\nEj: *agregar campo La Esperanza*`],
    interactive: {
      type: 'buttons',
      body: `Necesitás un campo para registrar ${actionLabel}.`,
      buttons: [
        { id: 'cmd_agregar_campo', title: 'Crear Campo' },
      ],
    },
  };
}

function buildNoPlotsBlockResponse(actionLabel: string, fieldName?: string): HandlerResponse {
  const fieldHint = fieldName ? ` en campo ${fieldName}` : '';
  return {
    messages: [`Para registrar ${actionLabel} primero necesitás crear un lote.\n\n📍 Escribí *agregar lote [nombre]${fieldHint}*\nEj: *agregar lote norte${fieldHint}*`],
    interactive: {
      type: 'buttons',
      body: `Necesitás un lote para registrar ${actionLabel}.`,
      buttons: [
        { id: 'cmd_agregar_lote', title: 'Crear Lote' },
      ],
    },
  };
}

// --- Category pending payload helpers ---

export function encodePendingExpensePayload(p: { data: ParsedExpense; fieldId: number | null; plotId: number | null }): string {
  const json = JSON.stringify({
    a: p.data.amount,
    c: p.data.currency,
    d: p.data.description,
    f: p.fieldId,
    p: p.plotId,
    ed: p.data.expenseDate ?? null,
    et: p.data.expenseType ?? null,
    pr: p.data.product ?? null,
    q: p.data.quantity ?? null,
    u: p.data.unit ?? null,
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodePendingExpensePayload(b64: string): { data: ParsedExpense; fieldId: number | null; plotId: number | null } {
  const o = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  return {
    fieldId: o.f ?? null,
    plotId: o.p ?? null,
    data: {
      type: 'expense',
      amount: o.a,
      currency: o.c,
      description: o.d,
      category: '',
      expenseDate: o.ed ?? null,
      expenseType: o.et ?? null,
      product: o.pr ?? null,
      quantity: o.q ?? null,
      unit: o.u ?? null,
    },
  };
}

export function encodePendingIncomePayload(p: { data: ParsedIncome; fieldId: number | null; plotId: number | null }): string {
  const json = JSON.stringify({
    a: p.data.amount,
    c: p.data.currency,
    d: p.data.description,
    f: p.fieldId,
    p: p.plotId,
    id: p.data.incomeDate ?? null,
    q: p.data.quantity ?? null,
    u: p.data.unit ?? null,
    up: p.data.unit_price ?? null,
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodePendingIncomePayload(b64: string): { data: ParsedIncome; fieldId: number | null; plotId: number | null } {
  const o = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  return {
    fieldId: o.f ?? null,
    plotId: o.p ?? null,
    data: {
      type: 'income',
      amount: o.a,
      currency: o.c,
      description: o.d,
      category: '',
      incomeDate: o.id ?? null,
      quantity: o.q ?? null,
      unit: o.u ?? null,
      unit_price: o.up ?? null,
    },
  };
}

// --- Handler ---

export class FinancialHandler {
  private sharingService: FieldSharingService;
  private plotDiscovery = new PlotDiscoveryService();
  private readonly categoryService = new CategoryService(new CategoryRepository());

  constructor(private service: FinancialService, sharingService?: FieldSharingService) {
    this.sharingService = sharingService ?? new FieldSharingService();
  }

  private formatPlotInfo(info: PlotInfoData): string {
    // New layout: AGRO first (cultivo + actividades + observaciones + lluvia)
    // → financial summary one-liner → PDF report hint. Empty agro sections
    // render explicit "ninguno/ninguna" so the user can see at a glance that
    // the data isn't there yet (instead of inferring from absence).
    const meta: string[] = [];
    if (info.area_hectares) meta.push(`${info.area_hectares} ha`);
    if (info.soil_type) meta.push(info.soil_type);
    let msg = `📍 *Lote ${info.name}* — campo ${info.field_name}${meta.length ? ` · ${meta.join(' · ')}` : ''}\n`;

    msg += `\n🌱 *Cultivo activo:* ${info.activeCrop ? `${info.activeCrop.crop} (${info.activeCrop.season_year})` : 'ninguno'}\n`;

    msg += `📋 *Actividades recientes:* `;
    if (info.recentActivities && info.recentActivities.length > 0) {
      msg += `\n`;
      for (const a of info.recentActivities) {
        const date = new Date(a.event_date);
        const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        const { emoji, label } = getActivityLabel(a.event_type);
        const detail = a.product || a.crop || label;
        msg += `  • ${emoji} ${label} — ${detail} (${dateStr})\n`;
      }
    } else {
      msg += `ninguna\n`;
    }

    const obs = (info as any).observations;
    msg += `🔍 *Observaciones recientes:* `;
    if (obs && obs.length > 0) {
      msg += `\n`;
      for (const o of obs) {
        const date = new Date(o.created_at);
        const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        msg += `  • ${o.observation_text} (${dateStr})\n`;
      }
    } else {
      msg += `ninguna\n`;
    }

    msg += `🌧️ *Lluvia (mes):* ${info.rainfall.count > 0 ? `${info.rainfall.total} mm (${info.rainfall.count} reg.)` : '0 mm'}\n`;

    // Financial — one-liner summary
    const resultado = info.incomes.total - info.expenses.total;
    msg += `\n💰 *Resumen mes:* gastos $${info.expenses.total.toLocaleString('es-AR')} (${info.expenses.count}) · ingresos $${info.incomes.total.toLocaleString('es-AR')} (${info.incomes.count}) · resultado $${resultado.toLocaleString('es-AR')}\n`;

    // PDF report hint — works on every channel without new callback infra
    msg += `\n📊 *Reportes en PDF:* pedí _"reporte agro lote ${info.name}"_ o _"reporte financiero lote ${info.name}"_`;

    return msg.trimEnd();
  }

  // --- Unified financial report dispatcher ---

  private async handleFinancialReport(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    // Lazy import — used only for inherit + saving state
    const { pool } = await import('../../config/db.js');
    const { queryMovements } = await import('../../services/expenses.js');

    // ── 1. Inherit prior filters when the agent flags follow-up refinement ──
    if (cmd.inherit) {
      const { rows } = await pool.query(
        `SELECT last_finance_query FROM conversation_state WHERE user_id = $1`,
        [userId],
      );
      const prev = rows[0]?.last_finance_query;
      if (prev && typeof prev === 'object') {
        // Merge: prev fills in any missing param, new wins on conflicts.
        for (const [k, v] of Object.entries(prev)) {
          if (cmd[k] == null) cmd[k] = v as never;
        }
      }
    }

    // ── 2. Legacy shortcuts (preserve existing behavior) ──
    const fieldName = cmd.fieldName as string | null;
    const plotName = cmd.plotName as string | null;
    const period = cmd.period as string | null;
    const reportType = (cmd.reportType as string) || (cmd.type as string) || 'both';

    if (period === 'week' && !fieldName && !plotName && !cmd.category && !cmd.amount_min && !cmd.amount_max) {
      return this.handleCommand({ command: 'weekly_report' }, userId, {} as any, {} as any);
    }

    // Sanity check: if plotName provided but doesn't exist for this user, surface a helpful
    // message instead of silently returning empty results (avoids hiding typos).
    if (plotName) {
      const plotCheck = await pool.query(
        `SELECT p.name, f.name AS field_name FROM plots p
         JOIN fields f ON p.field_id = f.id
         WHERE LOWER(p.name) = LOWER($2) AND (f.user_id = $1 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $1))
         LIMIT 1`,
        [userId, plotName],
      );
      if (plotCheck.rows.length === 0) {
        const all = await pool.query(
          `SELECT p.name FROM plots p JOIN fields f ON p.field_id = f.id
           WHERE f.user_id = $1 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $1)
           ORDER BY p.name LIMIT 20`,
          [userId],
        );
        const names = all.rows.map(r => r.name).join(', ') || '(no tenés lotes cargados)';
        return { messages: [`No tengo registrado un lote llamado "${plotName}". Tus lotes son: ${names}`], suggestionKey: 'report_shown' };
      }
    }
    if (fieldName) {
      const fieldCheck = await pool.query(
        `SELECT id FROM fields WHERE LOWER(name) = LOWER($2) AND (user_id = $1 OR id IN (SELECT field_id FROM field_members WHERE user_id = $1)) LIMIT 1`,
        [userId, fieldName],
      );
      if (fieldCheck.rows.length === 0) {
        const all = await pool.query(
          `SELECT name FROM fields WHERE user_id = $1 OR id IN (SELECT field_id FROM field_members WHERE user_id = $1) ORDER BY name LIMIT 20`,
          [userId],
        );
        const names = all.rows.map(r => r.name).join(', ') || '(no tenés campos cargados)';
        return { messages: [`No tengo registrado un campo llamado "${fieldName}". Tus campos son: ${names}`], suggestionKey: 'report_shown' };
      }
    }

    // ── 3. Resolve date range ──
    const nowAR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    let desde: string | null = (cmd.desde as string) || null;
    let hasta: string | null = (cmd.hasta as string) || null;
    let rangeLabel = '';
    let isAll = false;
    if (period === 'all') {
      desde = '2000-01-01';
      hasta = todayISO;
      isAll = true;
      rangeLabel = 'Todo el historial';
    } else if (period === 'year') {
      desde = `${nowAR.getFullYear()}-01-01`;
      hasta = todayISO;
      rangeLabel = `Año ${nowAR.getFullYear()}`;
    } else if (cmd.days) {
      const d = new Date();
      d.setDate(d.getDate() - (cmd.days as number));
      desde = d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
      hasta = todayISO;
      rangeLabel = `últimos ${cmd.days} días`;
    } else if (!desde && !hasta) {
      // Period defaulting policy:
      // - Volume views default to 'all' (no one means "tn este mes" when they just say "total de soja")
      // - Analytical views (max, top_categories, top_locations, balance, last, compare, volume) default to 'all'
      // - Queries with other narrowing filters (plot/field/category/amount/description) default to 'all' too —
      //   defaulting to mes-actual silently truncates the answer (e.g. "ver gastos del lote A1" should be historical)
      // - Pure "mostrame gastos/ingresos" without filters defaults to mes actual (the common "what's happening this month" case)
      const analyticalViews = new Set(['max', 'top_categories', 'top_locations', 'balance', 'volume', 'last', 'compare']);
      const hasNarrowing = !!(fieldName || plotName || cmd.category || (cmd.categories as string[] | undefined)?.length || cmd.amount_min != null || cmd.amount_max != null || cmd.description_search || cmd.currency || (cmd.exclude_categories as string[] | undefined)?.length);
      const shouldDefaultAll = (cmd.view && analyticalViews.has(cmd.view as string)) || hasNarrowing;
      if (shouldDefaultAll) {
        desde = '2000-01-01';
        hasta = todayISO;
        isAll = true;
        rangeLabel = 'Todo el historial';
      } else {
        desde = `${nowAR.getFullYear()}-${String(nowAR.getMonth() + 1).padStart(2, '0')}-01`;
        hasta = todayISO;
        rangeLabel = nowAR.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
      }
    } else {
      rangeLabel = `${desde || '...'} — ${hasta || todayISO}`;
    }

    // Date range guard — if user-supplied desde > hasta, fail loudly (the agent should
    // re-ask). Skip when desde defaulted (period absent and no desde provided).
    if (desde && hasta && desde > hasta) {
      return { messages: [`El rango de fechas es inválido: ${desde} es posterior a ${hasta}. Decime qué período querés ver.`], suggestionKey: 'report_shown' };
    }

    // ── 4. Build the unified filter object ──
    const filters = {
      fieldName, plotName,
      desde, hasta,
      category: cmd.category as string | null,
      categories: (cmd.categories as string[]) || [],
      excludeCategories: (cmd.exclude_categories as string[]) || [],
      currency: cmd.currency as string | null,
      amountMin: cmd.amount_min as number | null,
      amountMax: cmd.amount_max as number | null,
      descriptionSearch: cmd.description_search as string | null,
      type: (reportType === 'expenses' || reportType === 'incomes') ? reportType : 'both' as const,
      sortBy: (cmd.sort_by as 'date' | 'amount') || 'date',
      sortDesc: cmd.sort_desc != null ? !!cmd.sort_desc : true,
      groupBy: (cmd.group_by as 'category' | 'plot' | 'field' | 'month') || 'category',
      limit: 200,
    };

    // ── 5. Determine view ──
    const hasNarrowingFilter = !!(filters.category || filters.categories.length > 0 || filters.descriptionSearch
      || filters.amountMin != null || filters.amountMax != null
      || filters.currency || filters.excludeCategories.length > 0);
    let view = (cmd.view as string) || (hasNarrowingFilter ? 'detail' : 'aggregate');
    if (cmd.compare_desde || cmd.compare_hasta || cmd.compare_category) view = 'compare';
    if (cmd.top_n && !cmd.view) view = 'max';

    // ── 6. Compare view: fetch both halves ──
    if (view === 'compare') {
      const a = await queryMovements(userId, filters);
      const filtersB = { ...filters };
      if (cmd.compare_desde) filtersB.desde = cmd.compare_desde as string;
      if (cmd.compare_hasta) filtersB.hasta = cmd.compare_hasta as string;
      if (cmd.compare_category) filtersB.category = cmd.compare_category as string;
      const b = await queryMovements(userId, filtersB);
      await this.saveFinanceQuery(userId, cmd);
      return renderCompare(a, b, {
        labelA: filters.category || rangeLabel,
        labelB: (cmd.compare_category as string) || `${cmd.compare_desde || ''} — ${cmd.compare_hasta || ''}`,
        type: filters.type,
      });
    }

    // ── 7. Single fetch ──
    // For balance + top_locations + volume we may need both sides regardless of `type`.
    const fetchFilters = (view === 'balance' || view === 'top_locations')
      ? { ...filters, type: 'both' as const }
      : filters;
    const rows = await queryMovements(userId, fetchFilters);
    await this.saveFinanceQuery(userId, cmd);

    const scope = buildScopeLabel(filters);
    const ctx = { rangeLabel: isAll ? 'Todo el historial' : rangeLabel, scope, isAll, filters };

    switch (view) {
      case 'detail':         return renderDetail(rows, ctx);
      case 'top_categories': return renderTopCategories(rows, ctx);
      case 'top_locations':  return renderTopLocations(rows, ctx);
      case 'max':            return renderMax(rows, ctx, (cmd.top_n as number) || 1);
      case 'balance':        return renderBalance(rows, ctx);
      case 'volume':         return renderVolume(rows, ctx);
      case 'last':           return renderLast(rows, ctx, (cmd.top_n as number) || 5);
      case 'aggregate':
      default:               return renderAggregate(rows, ctx);
    }
  }

  private async saveFinanceQuery(userId: UserId, cmd: ParsedCommand): Promise<void> {
    try {
      const { pool } = await import('../../config/db.js');
      // Strip transient fields (inherit, command) before persisting
      const persistable: Record<string, unknown> = {};
      const KEEP = ['fieldName', 'plotName', 'period', 'desde', 'hasta', 'days',
        'category', 'categories', 'exclude_categories', 'currency', 'amount_min', 'amount_max',
        'description_search', 'type', 'reportType', 'view', 'sort_by', 'sort_desc', 'top_n', 'group_by'];
      for (const k of KEEP) {
        if (cmd[k] !== undefined && cmd[k] !== null) persistable[k] = cmd[k];
      }
      await pool.query(
        `INSERT INTO conversation_state (user_id, last_finance_query, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_finance_query = $2::jsonb, updated_at = NOW()`,
        [userId, JSON.stringify(persistable)],
      );
    } catch { /* non-fatal */ }
  }

  private async buildActivitiesSection(userId: UserId, plotName: string | null, activityFilter: string | null): Promise<string | null> {
    try {
      // Resolve plotName to plotId if provided
      let plotId: number | null = null;
      if (plotName) {
        const plots = await this.service.findPlotByNameAcrossFields(userId, plotName);
        if (plots.length > 0) plotId = plots[0].id;
      }
      const activities = await queryPlotHistory(userId, { plotId, activityFilter, limit: 5 });
      if (!activities || activities.length === 0) return null;

      let section = '📋 *Actividades recientes:*\n';
      for (const a of activities) {
        const date = new Date(a.event_date);
        const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        const { emoji, label } = getActivityLabel(a.event_type);
        const detail = a.product || a.crop || label;
        section += `• ${emoji} ${label} — ${detail} (${dateStr})\n`;
      }
      return section.trimEnd();
    } catch {
      return null;
    }
  }

  // --- Expense flow ---

  async handleExpense(
    userId: UserId,
    data: ParsedExpense,
    text: string,
    settings: UserSettings,
    user: User,
    fieldName?: string | null,
    plotName?: string | null,
  ): Promise<HandlerResponse> {
    // Block if user has no fields
    const userFields = await this.service.getUserFields(userId);
    if (userFields.length === 0) {
      return buildNoFieldsBlockResponse('un gasto');
    }

    // Block if user has no plots at all
    const allUserPlots = await this.service.findAllUserPlots(userId);
    if (allUserPlots.length === 0) {
      return buildNoPlotsBlockResponse('un gasto', userFields[0]?.name);
    }

    const resolution = await this.service.resolveField(userId, fieldName, plotName);
    let { fieldId, fieldName: resFieldName, plotId, plotName: resPlotName } = resolution;

    // Field-level expenses: when the category is a corporate-overhead one
    // (sueldos, arrendamiento, etc.) AND the user didn't explicitly say a
    // plot, drop the auto-resolved plot. Otherwise "sueldos $300k" gets
    // silently assigned to the user's only lote, which is data corruption
    // (the QA "Pedro despistado" persona caught it).
    const FIELD_LEVEL_CATEGORIES = new Set([
      'sueldos', 'arrendamiento', 'alquiler', 'servicios', 'impuestos',
      'contabilidad', 'administración', 'administracion', 'gastos generales',
    ]);
    const isFieldLevelExpense = !plotName && FIELD_LEVEL_CATEGORIES.has((data.category || '').toLowerCase());
    if (isFieldLevelExpense && plotId) {
      plotId = null;
      resPlotName = null;
    }

    // If the referenced field/plot doesn't exist, redirect to flow for plot selection
    if (resolution.notFound) {
      const label = resolution.notFound.type === 'field' ? 'campo' : 'lote';
      const name = resolution.notFound.name;
      const currency = data.currency === 'USD' ? 'USD' : 'ARS';
      return {
        messages: [`\u26a0\ufe0f No encontré el ${label} *${name}*.\n\n\ud83d\udcb8 *${data.category}* \u2014 $${data.amount.toLocaleString('es-AR')}${currency === 'USD' ? ' USD' : ''}\n\n\u00bfEn qu\u00e9 lote lo registramos?`],
        sideEffects: {
          startFlow: {
            state: 'expense_flow' as FlowState,
            data: {
              amount: { amount: data.amount, currency },
              category: data.category,
              description: data.description || text,
              ...(data.expenseDate ? { expenseDate: data.expenseDate } : {}),
              ...(data.expenseType ? { expenseType: data.expenseType } : {}),
              ...(data.product ? { product: data.product } : {}),
              ...(data.quantity ? { quantity: data.quantity } : {}),
              ...(data.unit ? { unit: data.unit } : {}),
            },
          },
        },
      };
    }

    // Hybrid plot assignment: try to auto-assign plot
    if (!plotId) {
      if (resolution.needPlotSelection) {
        // 2+ plots in field → redirect to expense flow at plot step
        const currency = data.currency === 'USD' ? 'USD' : 'ARS';
        return {
          messages: [`\ud83d\udcb8 *${data.category}* \u2014 $${data.amount.toLocaleString('es-AR')}${currency === 'USD' ? ' USD' : ''}\n\n\u00bfEn qu\u00e9 lote lo registramos?`],
          sideEffects: {
            startFlow: {
              state: 'expense_flow' as FlowState,
              data: {
                amount: { amount: data.amount, currency },
                category: data.category,
                description: data.description || text,
                ...(data.expenseDate ? { expenseDate: data.expenseDate } : {}),
                ...(data.expenseType ? { expenseType: data.expenseType } : {}),
                ...(data.product ? { product: data.product } : {}),
                ...(data.quantity ? { quantity: data.quantity } : {}),
                ...(data.unit ? { unit: data.unit } : {}),
              },
            },
          },
        };
      }
      if (resolution.needPlotCreation) {
        // Field exists but 0 plots → block, tell user to create a plot
        return buildNoPlotsBlockResponse('un gasto', resFieldName ?? undefined);
      }
      // No field resolved at all — check if user has a single plot globally
      if (!fieldId) {
        if (allUserPlots.length === 1) {
          const singlePlot = allUserPlots[0];
          const field = await this.service.getFieldByName(userId, singlePlot.field_name);
          if (field) {
            fieldId = field.id;
            resFieldName = field.name;
            plotId = singlePlot.id;
            resPlotName = singlePlot.name;
          }
        }
      }
    }

    // Conversational memory: inherit field/plot from recent financial message
    if (!fieldId && !plotId) {
      const recentCtx = await this.service.getRecentFinancialContext(userId);
      if (recentCtx && recentCtx.plotId) {
        fieldId = recentCtx.fieldId;
        resFieldName = recentCtx.fieldName;
        plotId = recentCtx.plotId;
        resPlotName = recentCtx.plotName;
      }
    }

    // No plot resolved → redirect to expense flow so user picks one. EXCEPT
    // when this is a field-level expense (sueldos/arrendamiento/etc.) and
    // we already have a field — then save at field level (plot_id NULL)
    // without forcing the user through plot selection.
    if (!plotId && !(isFieldLevelExpense && fieldId)) {
      const currency = data.currency === 'USD' ? 'USD' : 'ARS';
      return {
        messages: [],
        sideEffects: {
          startFlow: {
            state: 'expense_flow' as FlowState,
            data: {
              amount: { amount: data.amount, currency },
              category: data.category,
              description: data.description || text,
              ...(data.expenseDate ? { expenseDate: data.expenseDate } : {}),
              ...(data.expenseType ? { expenseType: data.expenseType } : {}),
              ...(data.product ? { product: data.product } : {}),
              ...(data.quantity ? { quantity: data.quantity } : {}),
              ...(data.unit ? { unit: data.unit } : {}),
            },
          },
        },
      };
    }

    // --- Category resolution ---
    const rawExpenseCategory = (data as ParsedExpense & { category_match?: string }).category_match === 'new'
      ? data.category
      : data.category ?? null;
    const expenseCategoryIntent = (data as ParsedExpense & { category_match?: string }).category_match === 'new'
      ? 'new' as const
      : (data as ParsedExpense & { category_match?: string }).category_match === 'exact'
        ? 'exact' as const
        : 'unknown' as const;

    // When the agent claims it's a new category, first check for a similar existing one
    if (expenseCategoryIntent === 'new' && rawExpenseCategory && rawExpenseCategory.trim()) {
      const similar = await this.categoryService.findSimilar(userId as number, 'expense', rawExpenseCategory);
      if (similar) {
        const payload = encodePendingExpensePayload({ data, fieldId: fieldId ?? null, plotId: plotId ?? null });
        return {
          messages: [],
          interactive: {
            type: 'buttons' as const,
            body: `Ya tenés una categoría parecida: *${similar.name}*.\n¿Usás esa o creás *${rawExpenseCategory.trim()}* como nueva?`,
            buttons: [
              { id: `cat_sim_use_exp_${payload}_${similar.id}`, title: `Usar ${similar.name}` },
              { id: `cat_sim_new_exp_${payload}_${encodeURIComponent(rawExpenseCategory.trim())}`, title: `Crear ${rawExpenseCategory.trim()}` },
              { id: 'cat_sim_cancel', title: 'Cancelar' },
            ],
          },
        };
      }
    }

    const expenseCatMatch = await this.categoryService.match(
      userId as number, 'expense', rawExpenseCategory, expenseCategoryIntent,
    );

    if (expenseCatMatch.kind === 'needs-confirmation') {
      const payload = encodePendingExpensePayload({ data, fieldId: fieldId ?? null, plotId: plotId ?? null });
      const buttons = expenseCatMatch.suggestions.map(c => ({
        id: `cat_pick_exp_${payload}_${c.id}`,
        title: c.name,
      }));
      buttons.push({ id: `cat_new_exp_${payload}`, title: '+ Otra' });
      return {
        messages: [],
        interactive: {
          type: 'buttons' as const,
          body: `¿En qué categoría va este gasto de $${Number(data.amount).toLocaleString('es-AR')}?`,
          buttons,
        },
      };
    }

    data.category = expenseCatMatch.category.name;
    const matchedExpenseCategoryId = expenseCatMatch.category.id;

    if (settings.confirm_before_save) {
      const pendingMsg = buildPendingMessage('expense', data, resFieldName, resPlotName);
      return {
        messages: [],
        interactive: {
          type: 'buttons' as const,
          body: pendingMsg,
          buttons: [
            { id: 'confirm_pending', title: 'Confirmar' },
            { id: 'cancel_pending', title: 'Cancelar' },
          ],
        },
        sideEffects: {
          setPending: { type: 'expense', data, fieldId, fieldName: resFieldName, plotId, plotName: resPlotName, timestamp: Date.now() },
        },
      };
    }

    const saved = await this.service.saveExpense(userId, data, fieldId, plotId);
    this.categoryService.bump(matchedExpenseCategoryId).catch(() => {});
    const messages = [await buildExpenseConfirmation(data, resFieldName, resPlotName)];

    if (settings.budget_alerts) {
      const alert = await this.service.checkBudgetAlert(userId, data.category, user.name);
      if (alert) {
        messages.push(alert);
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const alertType = alert.startsWith('\u{1F534}') ? 'budget_100' : 'budget_80';
        recordAlert(userId, alertType, alert, {
          dedupKey: `${data.category}_${monthKey}`,
          payload: { category: data.category },
        }).catch(() => {});
      }
    }

    // Suggest stock entry for insumo expenses
    if (data.expenseType === 'insumo' && data.product && data.quantity && data.unit && fieldId) {
      try {
        const { StockPurchaseService } = await import('../stock/stock-purchase.service.js');
        const purchaseService = new StockPurchaseService();
        const suggestion = await purchaseService.suggestStockEntry(
          userId, saved.id, data.product, data.quantity, data.unit, fieldId,
        );
        if (suggestion) {
          messages.push(
            `\n📦 ¿Querés cargar *${data.quantity}${data.unit} de ${data.product}* al stock del Depósito ${suggestion.warehouseName}?`
          );
          return {
            messages,
            interactive: {
              type: 'buttons' as const,
              body: messages.join('\n'),
              buttons: [
                { id: `stock_entry_yes_${saved.id}`, title: 'Sí, cargar' },
                { id: `stock_entry_no_${saved.id}`, title: 'No' },
              ],
            },
            sideEffects: {
              setPendingStockEntry: suggestion,
            },
            suggestionKey: 'expense_saved',
          };
        }
      } catch (stockErr) {
        console.error('[financial] Stock suggestion failed after expense save:', stockErr);
        logError('financial', 'STOCK_SUGGEST_EXPENSE', stockErr as Error, { userId });
      }
    }

    return { messages, suggestionKey: 'expense_saved' };
  }

  // --- Income flow ---

  async handleIncome(
    userId: UserId,
    data: ParsedIncome,
    text: string,
    settings: UserSettings,
    fieldName?: string | null,
    plotName?: string | null,
  ): Promise<HandlerResponse> {
    // Block if user has no fields
    const userFields = await this.service.getUserFields(userId);
    if (userFields.length === 0) {
      return buildNoFieldsBlockResponse('un ingreso');
    }

    // Block if user has no plots at all
    const allUserPlots = await this.service.findAllUserPlots(userId);
    if (allUserPlots.length === 0) {
      return buildNoPlotsBlockResponse('un ingreso', userFields[0]?.name);
    }

    const resolution = await this.service.resolveField(userId, fieldName, plotName);
    let { fieldId, fieldName: resFieldName, plotId, plotName: resPlotName } = resolution;

    // If the referenced field/plot doesn't exist, redirect to flow for plot selection
    if (resolution.notFound) {
      const label = resolution.notFound.type === 'field' ? 'campo' : 'lote';
      const name = resolution.notFound.name;
      const currency = data.currency === 'USD' ? 'USD' : 'ARS';
      return {
        messages: [`\u26a0\ufe0f No encontré el ${label} *${name}*.\n\n\ud83d\udcb0 *${data.category}* \u2014 $${data.amount.toLocaleString('es-AR')}${currency === 'USD' ? ' USD' : ''}\n\n\u00bfEn qu\u00e9 lote lo registramos?`],
        sideEffects: {
          startFlow: {
            state: 'income_flow' as FlowState,
            data: {
              amount: { amount: data.amount, currency },
              category: data.category,
              description: data.description || text,
              quantity: data.quantity ?? null,
              unit: data.unit ?? null,
              unit_price: data.unit_price ?? null,
              ...(data.incomeDate ? { incomeDate: data.incomeDate } : {}),
            },
          },
        },
      };
    }

    // Hybrid plot assignment: try to auto-assign plot
    if (!plotId) {
      if (resolution.needPlotSelection) {
        // 2+ plots in field → redirect to income flow at plot step
        const currency = data.currency === 'USD' ? 'USD' : 'ARS';
        return {
          messages: [`\ud83d\udcb0 *${data.category}* \u2014 $${data.amount.toLocaleString('es-AR')}${currency === 'USD' ? ' USD' : ''}\n\n\u00bfEn qu\u00e9 lote lo registramos?`],
          sideEffects: {
            startFlow: {
              state: 'income_flow' as FlowState,
              data: {
                amount: { amount: data.amount, currency },
                category: data.category,
                description: data.description || text,
                quantity: data.quantity ?? null,
                unit: data.unit ?? null,
                unit_price: data.unit_price ?? null,
                ...(data.incomeDate ? { incomeDate: data.incomeDate } : {}),
              },
            },
          },
        };
      }
      if (resolution.needPlotCreation) {
        // Field exists but 0 plots → block, tell user to create a plot
        return buildNoPlotsBlockResponse('un ingreso', resFieldName ?? undefined);
      }
      if (!fieldId) {
        if (allUserPlots.length === 1) {
          const singlePlot = allUserPlots[0];
          const field = await this.service.getFieldByName(userId, singlePlot.field_name);
          if (field) {
            fieldId = field.id;
            resFieldName = field.name;
            plotId = singlePlot.id;
            resPlotName = singlePlot.name;
          }
        }
      }
    }

    // Conversational memory: inherit field/plot from recent financial message
    if (!fieldId && !plotId) {
      const recentCtx = await this.service.getRecentFinancialContext(userId);
      if (recentCtx && recentCtx.plotId) {
        fieldId = recentCtx.fieldId;
        resFieldName = recentCtx.fieldName;
        plotId = recentCtx.plotId;
        resPlotName = recentCtx.plotName;
      }
    }

    // No plot resolved → redirect to income flow so user picks one
    if (!plotId) {
      const currency = data.currency === 'USD' ? 'USD' : 'ARS';
      return {
        messages: [],
        sideEffects: {
          startFlow: {
            state: 'income_flow' as FlowState,
            data: {
              amount: { amount: data.amount, currency },
              category: data.category,
              description: data.description || text,
              quantity: data.quantity ?? null,
              unit: data.unit ?? null,
              unit_price: data.unit_price ?? null,
              ...(data.incomeDate ? { incomeDate: data.incomeDate } : {}),
            },
          },
        },
      };
    }

    // --- Category resolution ---
    const rawIncomeCategory = (data as ParsedIncome & { category_match?: string }).category_match === 'new'
      ? data.category
      : data.category ?? null;
    const incomeCategoryIntent = (data as ParsedIncome & { category_match?: string }).category_match === 'new'
      ? 'new' as const
      : (data as ParsedIncome & { category_match?: string }).category_match === 'exact'
        ? 'exact' as const
        : 'unknown' as const;

    // When the agent claims it's a new category, first check for a similar existing one
    if (incomeCategoryIntent === 'new' && rawIncomeCategory && rawIncomeCategory.trim()) {
      const similar = await this.categoryService.findSimilar(userId as number, 'income', rawIncomeCategory);
      if (similar) {
        const payload = encodePendingIncomePayload({ data, fieldId: fieldId ?? null, plotId: plotId ?? null });
        return {
          messages: [],
          interactive: {
            type: 'buttons' as const,
            body: `Ya tenés una categoría parecida: *${similar.name}*.\n¿Usás esa o creás *${rawIncomeCategory.trim()}* como nueva?`,
            buttons: [
              { id: `cat_sim_use_inc_${payload}_${similar.id}`, title: `Usar ${similar.name}` },
              { id: `cat_sim_new_inc_${payload}_${encodeURIComponent(rawIncomeCategory.trim())}`, title: `Crear ${rawIncomeCategory.trim()}` },
              { id: 'cat_sim_cancel', title: 'Cancelar' },
            ],
          },
        };
      }
    }

    const incomeCatMatch = await this.categoryService.match(
      userId as number, 'income', rawIncomeCategory, incomeCategoryIntent,
    );

    if (incomeCatMatch.kind === 'needs-confirmation') {
      const payload = encodePendingIncomePayload({ data, fieldId: fieldId ?? null, plotId: plotId ?? null });
      const buttons = incomeCatMatch.suggestions.map(c => ({
        id: `cat_pick_inc_${payload}_${c.id}`,
        title: c.name,
      }));
      buttons.push({ id: `cat_new_inc_${payload}`, title: '+ Otra' });
      return {
        messages: [],
        interactive: {
          type: 'buttons' as const,
          body: `¿En qué categoría va este ingreso de $${Number(data.amount).toLocaleString('es-AR')}?`,
          buttons,
        },
      };
    }

    data.category = incomeCatMatch.category.name;
    const matchedIncomeCategoryId = incomeCatMatch.category.id;

    if (settings.confirm_before_save) {
      const pendingMsg = buildPendingMessage('income', data, resFieldName, resPlotName);
      return {
        messages: [],
        interactive: {
          type: 'buttons' as const,
          body: pendingMsg,
          buttons: [
            { id: 'confirm_pending', title: 'Confirmar' },
            { id: 'cancel_pending', title: 'Cancelar' },
          ],
        },
        sideEffects: {
          setPending: { type: 'income', data, fieldId, fieldName: resFieldName, plotId, plotName: resPlotName, timestamp: Date.now() },
        },
      };
    }

    const savedIncome = await this.service.saveIncome(userId, data, fieldId, plotId);
    this.categoryService.bump(matchedIncomeCategoryId).catch(() => {});
    const messages = [await buildIncomeConfirmation(data, resFieldName, resPlotName)];
    const { ingresos, gastos } = await this.service.getMonthlyResult(userId);
    if (gastos > 0) {
      messages.push(formatResult(ingresos, gastos, 'Resultado del mes hasta ahora'));
    }

    // Grain sale → suggest stock deduction
    const GRAIN_CATEGORIES = new Set(['soja', 'maíz', 'trigo', 'girasol', 'sorgo', 'cebada']);
    const category = (data.category || '').toLowerCase();
    if (GRAIN_CATEGORIES.has(category) && data.quantity && data.unit && fieldId) {
      try {
        const { FeatureGate } = await import('../billing/feature-gate.js');
        const fg = new FeatureGate();
        const hasStock = await fg.hasFeature(userId, 'stock');
        if (hasStock) {
          const { StockService } = await import('../stock/stock.service.js');
          const stockService = new StockService();
          const stockItem = await stockService.findProduct(userId, data.category);
          if (stockItem && stockItem.current_quantity > 0) {
            const qty = data.quantity;
            const unit = data.unit;
            messages.push(`\n📦 Tenés *${stockItem.current_quantity}${stockItem.unit}* de *${stockItem.name}* en stock.\n¿Descontar *${qty}${unit}*?`);
            return {
              messages,
              interactive: {
                type: 'buttons',
                body: `Descontar ${qty}${unit} de ${data.category} del stock?`,
                buttons: [
                  { id: `stock_grain_sale_yes_${savedIncome?.id || 0}`, title: 'Sí, descontar' },
                  { id: `stock_grain_sale_no_${savedIncome?.id || 0}`, title: 'No' },
                ],
              },
              sideEffects: {
                setPendingStockDeduction: {
                  type: 'grain_sale',
                  stockItemId: stockItem.id,
                  product: stockItem.name,
                  totalQuantity: qty,
                  unit,
                  fieldId,
                  warehouseName: stockItem.warehouse_name || 'Principal',
                  currentStock: stockItem.current_quantity,
                },
              },
              suggestionKey: 'income_saved',
            };
          }
        }
      } catch (stockErr) { console.error('[financial] Stock deduction suggestion failed:', stockErr); logError('financial', 'STOCK_DEDUCTION_SUGGEST', stockErr as Error, { userId }); }
    }

    return { messages, suggestionKey: 'income_saved' };
  }

  // --- Confirm pending ---

  async handleConfirm(
    userId: UserId,
    pending: PendingTransaction,
    settings: UserSettings,
    user: User
  ): Promise<HandlerResponse> {
    if (pending.type === 'income') {
      const incomeData = pending.data as ParsedIncome;
      const savedIncome = await this.service.saveIncome(userId, incomeData, pending.fieldId, pending.plotId);
      const messages = [await buildIncomeConfirmation(incomeData, pending.fieldName, pending.plotName)];
      const { ingresos, gastos } = await this.service.getMonthlyResult(userId);
      if (gastos > 0) {
        messages.push(formatResult(ingresos, gastos, 'Resultado del mes hasta ahora'));
      }

      // Grain sale → suggest stock deduction (mirror of the handleIncome path so the
      // prompt also surfaces when the income goes through pending→confirm).
      const GRAIN_CATEGORIES = new Set(['soja', 'maíz', 'trigo', 'girasol', 'sorgo', 'cebada']);
      const category = (incomeData.category || '').toLowerCase();
      if (GRAIN_CATEGORIES.has(category) && incomeData.quantity && incomeData.unit && pending.fieldId) {
        try {
          const { FeatureGate } = await import('../billing/feature-gate.js');
          const fg = new FeatureGate();
          if (await fg.hasFeature(userId, 'stock')) {
            const { StockService } = await import('../stock/stock.service.js');
            const stockService = new StockService();
            const stockItem = await stockService.findProduct(userId, incomeData.category);
            if (stockItem && stockItem.current_quantity > 0) {
              const qty = incomeData.quantity;
              const unit = incomeData.unit;
              messages.push(`\n📦 Tenés *${stockItem.current_quantity}${stockItem.unit}* de *${stockItem.name}* en stock.\n¿Descontar *${qty}${unit}*?`);
              return {
                messages,
                interactive: {
                  type: 'buttons',
                  body: `Descontar ${qty}${unit} de ${incomeData.category} del stock?`,
                  buttons: [
                    { id: `stock_grain_sale_yes_${savedIncome?.id || 0}`, title: 'Sí, descontar' },
                    { id: `stock_grain_sale_no_${savedIncome?.id || 0}`, title: 'No' },
                  ],
                },
                sideEffects: {
                  setPendingStockDeduction: {
                    type: 'grain_sale',
                    stockItemId: stockItem.id,
                    product: stockItem.name,
                    totalQuantity: qty,
                    unit,
                    fieldId: pending.fieldId,
                    warehouseName: stockItem.warehouse_name || 'Principal',
                    currentStock: stockItem.current_quantity,
                  },
                },
              };
            }
          }
        } catch (stockErr) { console.error('[financial] Stock deduction suggestion (confirm) failed:', stockErr); logError('financial', 'STOCK_DEDUCTION_SUGGEST_CONFIRM', stockErr as Error, { userId }); }
      }

      return { messages, suggestionKey: 'income_saved' };
    } else {
      const expenseData = pending.data as ParsedExpense;
      const saved = await this.service.saveExpense(userId, expenseData, pending.fieldId, pending.plotId);
      const messages = [await buildExpenseConfirmation(expenseData, pending.fieldName, pending.plotName)];
      if (settings.budget_alerts) {
        const alert = await this.service.checkBudgetAlert(userId, expenseData.category, user.name);
        if (alert) {
          messages.push(alert);
          const now = new Date();
          const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          const alertType = alert.startsWith('\u{1F534}') ? 'budget_100' : 'budget_80';
          recordAlert(userId, alertType, alert, {
            dedupKey: `${expenseData.category}_${monthKey}`,
            payload: { category: expenseData.category },
          }).catch(() => {});
        }
      }

      // Suggest stock entry for insumo expenses
      if (expenseData.expenseType === 'insumo' && expenseData.product && expenseData.quantity && expenseData.unit && pending.fieldId) {
        try {
          const { StockPurchaseService } = await import('../stock/stock-purchase.service.js');
          const purchaseService = new StockPurchaseService();
          const suggestion = await purchaseService.suggestStockEntry(
            userId, saved.id, expenseData.product, expenseData.quantity, expenseData.unit, pending.fieldId,
          );
          if (suggestion) {
            messages.push(
              `\n📦 ¿Querés cargar *${expenseData.quantity}${expenseData.unit} de ${expenseData.product}* al stock del Depósito ${suggestion.warehouseName}?`
            );
            return {
              messages,
              interactive: {
                type: 'buttons' as const,
                body: messages.join('\n'),
                buttons: [
                  { id: `stock_entry_yes_${saved.id}`, title: 'Sí, cargar' },
                  { id: `stock_entry_no_${saved.id}`, title: 'No' },
                ],
              },
              sideEffects: {
                setPendingStockEntry: suggestion,
              },
            };
          }
        } catch (stockErr) {
          console.error('[financial] Stock suggestion failed in handleConfirm:', stockErr);
          logError('financial', 'STOCK_SUGGEST_CONFIRM', stockErr as Error, { userId });
        }
      }

      return { messages, suggestionKey: 'expense_saved' };
    }
  }

  // --- Command handlers ---

  async handleCommand(cmd: ParsedCommand, userId: UserId, user: User, settings: UserSettings): Promise<HandlerResponse> {
    switch (cmd.command) {
      // --- Unified financial report (agent tool_use) ---
      case 'financial_report': {
        return this.handleFinancialReport(cmd, userId);
      }

      // --- Edit last expense: clear lot or reassign ---
      case 'edit_last_expense': {
        const categoryFilter = cmd.categoryFilter as string | null;
        const newPlotName = cmd.newPlotName as string | null;
        const newFieldName = cmd.newFieldName as string | null;
        const clearLot = !!cmd.clearLot;

        if (!newPlotName && !clearLot && !newFieldName) {
          return { messages: ['¿Qué corregimos del gasto? Indicá el nuevo lote o pedí "sin lote" para dejarlo a nivel de campo. Ej:\n✏️ *los sueldos eran del campo, sin lote*\n✏️ *el gasoil al lote norte*'] };
        }

        const last = await this.service.findLastExpenseByCategory(userId, categoryFilter);
        if (!last) {
          const filterDesc = categoryFilter ? ` de tipo *${categoryFilter}*` : '';
          return { messages: [`No encontré un gasto reciente${filterDesc} para editar.`] };
        }

        let newPlotId: number | null = null;
        let newFieldId: number | null = null;
        let newPlotLabel: string | null = null;
        if (clearLot) {
          newPlotId = null;
          newFieldId = last.field_id;  // keep field_id, drop plot_id
          newPlotLabel = '(sin lote)';
        } else if (newPlotName) {
          const resolved = await this.plotDiscovery.resolveFromNames(userId, newFieldName, newPlotName);
          if (!resolved.plotId) {
            return { messages: [`No encontré el lote *${newPlotName}*. Revisá el nombre o escribí *mis lotes*.`] };
          }
          newPlotId = resolved.plotId;
          newFieldId = resolved.fieldId;
          newPlotLabel = resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName;
        }

        await this.service.updateExpensePlot(last.id, newFieldId, newPlotId);

        const oldLabel = last.plot_name ? (last.field_name ? `${last.field_name} > ${last.plot_name}` : last.plot_name) : (last.field_name || 'sin lote');
        return {
          messages: [
            `✏️ Gasto corregido: *${last.category}* $${Number(last.amount).toLocaleString('es-AR')}\n📍 ${oldLabel} → *${newPlotLabel}*`,
          ],
        };
      }

      // --- Result / Rentability ---
      case 'monthly_result': {
        const { ingresos, gastos } = await this.service.getMonthlyResult(userId);
        if (ingresos === 0 && gastos === 0) {
          return { messages: ['No hay movimientos este mes.'], suggestionKey: 'report_shown' };
        }
        return { messages: [formatResult(ingresos, gastos, `📊 Resultado financiero (${currentMonthLabel()})`)], suggestionKey: 'report_shown' };
      }

      case 'field_result': {
        // If user said "resultado lote X", compute lote-level result
        if (cmd.entityKeyword === 'lote') {
          const plotResult = await this.service.getPlotResult(userId, cmd.fieldName as string);
          if (!plotResult) {
            return { messages: [`No encontré el lote *${cmd.fieldName}*.`], suggestionKey: 'report_shown' };
          }
          if (plotResult.ingresos === 0 && plotResult.gastos === 0) {
            return { messages: [`No hay movimientos para lote *${plotResult.plotName}* este mes.`], suggestionKey: 'report_shown' };
          }
          return { messages: [formatResult(plotResult.ingresos, plotResult.gastos, `📊 Resultado financiero — lote ${plotResult.plotName} (${plotResult.fieldName}, ${currentMonthLabel()})`)], suggestionKey: 'report_shown' };
        }
        const { ingresos, gastos } = await this.service.getFieldResult(userId, cmd.fieldName as string);
        if (ingresos === 0 && gastos === 0) {
          return { messages: [`No hay movimientos para ${cmd.fieldName} este mes.`], suggestionKey: 'report_shown' };
        }
        return { messages: [formatResult(ingresos, gastos, `📊 Resultado financiero — ${cmd.fieldName} (${currentMonthLabel()})`)], suggestionKey: 'report_shown' };
      }

      // --- Compare months ---
      case 'compare_months': {
        const now = new Date();
        const year = now.getFullYear();
        const [gastos1, gastos2] = await Promise.all([
          this.service.getMonthlyReportForMonth(userId, cmd.mes1 as number, year),
          this.service.getMonthlyReportForMonth(userId, cmd.mes2 as number, year),
        ]);
        const map1 = Object.fromEntries(gastos1.map((r) => [r.category, Number(r.total)]));
        const map2 = Object.fromEntries(gastos2.map((r) => [r.category, Number(r.total)]));
        const allCats = [...new Set([...Object.keys(map1), ...Object.keys(map2)])];

        if (allCats.length === 0) {
          return { messages: [`No hay datos para comparar ${cmd.mes1Name} con ${cmd.mes2Name}.`] };
        }

        let total1 = 0, total2 = 0;
        const mes1Name = cmd.mes1Name as string;
        const mes2Name = cmd.mes2Name as string;
        let msg = `📊 Comparación financiera — ${mes1Name.charAt(0).toUpperCase() + mes1Name.slice(1)} vs ${mes2Name.charAt(0).toUpperCase() + mes2Name.slice(1)} (${year})\n\n`;
        for (const cat of allCats) {
          const v1 = map1[cat] || 0;
          const v2 = map2[cat] || 0;
          total1 += v1;
          total2 += v2;
          if (v2 > 0) {
            const pct = Math.round(((v1 - v2) / v2) * 100);
            const sign = pct >= 0 ? '+' : '';
            msg += `${cat}: ${sign}${pct}%\n`;
          } else if (v1 > 0) {
            msg += `${cat}: nuevo\n`;
          }
        }
        if (total2 > 0) {
          const totalPct = Math.round(((total1 - total2) / total2) * 100);
          const totalSign = totalPct >= 0 ? '+' : '';
          msg += `\nTotal: ${totalSign}${totalPct}%`;
        }
        msg += `\n\n${mes1Name}: $${total1.toLocaleString('es-AR')}`;
        msg += `\n${mes2Name}: $${total2.toLocaleString('es-AR')}`;
        return { messages: [msg], suggestionKey: 'report_shown' };
      }

      // --- Weekly report ---
      case 'weekly_report': {
        const rows = await this.service.getWeeklyReport(userId);
        if (rows.length === 0) {
          return { messages: ['No hay gastos registrados esta semana.'], suggestionKey: 'report_shown' };
        }
        const { lines, total } = formatReportRows(rows);
        return { messages: [`📊 *Resumen financiero* (${currentWeekLabel()})\n\n${lines}\nTotal: $${total.toLocaleString('es-AR')}\n\n_Pedí "resumen mes" para ver el mes completo._`], suggestionKey: 'report_shown' };
      }

      // --- Monthly report ---
      case 'monthly_report': {
        const rows = await this.service.getMonthlyReport(userId);
        const pnl = await this.service.getMonthlyResultByCurrency(userId);

        const hasAny = rows.length > 0
          || Object.values(pnl).some(v => v.ingresos > 0 || v.gastos > 0);
        if (!hasAny) {
          return { messages: [`No hay movimientos este mes.`], suggestionKey: 'report_shown' };
        }

        // ── Header: P&L summary per currency ──
        let msg = `📊 *Movimientos del mes* (${currentMonthLabel()})\n`;
        for (const [cur, v] of Object.entries(pnl)) {
          if (v.ingresos === 0 && v.gastos === 0) continue;
          const symbol = cur === 'ARS' ? '$' : `${cur} `;
          const result = v.ingresos - v.gastos;
          msg += `\n💰 Ingresos: ${symbol}${v.ingresos.toLocaleString('es-AR')}`;
          msg += `\n💸 Gastos:   ${symbol}${v.gastos.toLocaleString('es-AR')}`;
          msg += `\n${result >= 0 ? '📈' : '📉'} Resultado: ${result < 0 ? '-' : ''}${symbol}${Math.abs(result).toLocaleString('es-AR')}`;
          if (Object.keys(pnl).filter(k => pnl[k].ingresos > 0 || pnl[k].gastos > 0).length > 1) {
            msg += ` (${cur})`;
          }
          msg += '\n';
        }

        // ── Categorías de gastos ──
        if (rows.length > 0) {
          const { lines, total } = formatReportRows(rows);
          msg += `\n*Por categoría (gastos):*\n${lines}\nTotal: $${total.toLocaleString('es-AR')}`;
        }

        // ── Per-plot breakdown ──
        const plotRows = await this.service.getMonthlyReportByPlot(userId);
        if (plotRows.length > 0) {
          msg += '\n\n📍 *Por lote:*';
          for (const pr of plotRows) {
            const resultado = pr.income_total - pr.expense_total;
            msg += `\n• ${pr.plot_name} (${pr.field_name}): gastos $${pr.expense_total.toLocaleString('es-AR')}`;
            if (pr.income_total > 0) msg += `, ingresos $${pr.income_total.toLocaleString('es-AR')}`;
            if (pr.income_total > 0 || pr.expense_total > 0) msg += ` → $${resultado.toLocaleString('es-AR')}`;
          }
        }

        return { messages: [msg], suggestionKey: 'report_shown' };
      }

      // --- Plot report ---
      case 'plot_report': {
        const report = await this.service.getPlotReport(userId, cmd.plotName as string);
        if (!report) {
          const allPlots = await this.service.findAllUserPlots(userId);
          if (allPlots.length === 0) {
            return { messages: [`No encontré el lote *${cmd.plotName}*.\nNo tenés lotes registrados.`] };
          }
          let msg = `No encontré el lote *${cmd.plotName}*.\n\nTus lotes son:\n`;
          for (const p of allPlots) msg += `• ${p.name} (campo ${p.field_name})\n`;
          return { messages: [msg.trimEnd()] };
        }
        if (report.rows.length === 0 && report.incomeTotal === 0) {
          return { messages: [`No hay movimientos para lote *${report.plotName}* (${currentMonthLabel()}).\n\n_Para ver actividades agronómicas: "qué pasó en el lote ${report.plotName}"_`], suggestionKey: 'report_shown' };
        }
        const { lines: plotLines, total: plotTotal } = formatReportRows(report.rows);
        let plotMsg = `📊 *Resumen financiero — lote ${report.plotName}* (${report.fieldName}, ${currentMonthLabel()})\n`;
        if (report.rows.length > 0) plotMsg += `\n${plotLines}\nGastos: $${plotTotal.toLocaleString('es-AR')}`;
        if (report.incomeTotal > 0) plotMsg += `\nIngresos: $${report.incomeTotal.toLocaleString('es-AR')}`;
        if (report.rows.length > 0 || report.incomeTotal > 0) {
          const resultado = report.incomeTotal - plotTotal;
          plotMsg += `\nResultado: $${resultado.toLocaleString('es-AR')}`;
        }
        plotMsg += `\n\n_Para actividades agronómicas: "qué pasó en el lote ${report.plotName}"_`;
        return { messages: [plotMsg], suggestionKey: 'report_shown' };
      }

      // --- Field report ---
      case 'field_report': {
        // Safety net: if entityKeyword is "lote", try plot report first
        if (cmd.entityKeyword === 'lote') {
          const plotReport = await this.service.getPlotReport(userId, cmd.fieldName as string);
          if (plotReport) {
            if (plotReport.rows.length === 0 && plotReport.incomeTotal === 0) {
              return { messages: [`No hay movimientos para lote *${plotReport.plotName}* (${currentMonthLabel()}).\n\n_Para actividades agronómicas: "qué pasó en el lote ${plotReport.plotName}"_`], suggestionKey: 'report_shown' };
            }
            const { lines: pLines, total: pTotal } = formatReportRows(plotReport.rows);
            let pMsg = `📊 *Resumen financiero — lote ${plotReport.plotName}* (${plotReport.fieldName}, ${currentMonthLabel()})\n`;
            if (plotReport.rows.length > 0) pMsg += `\n${pLines}\nGastos: $${pTotal.toLocaleString('es-AR')}`;
            if (plotReport.incomeTotal > 0) pMsg += `\nIngresos: $${plotReport.incomeTotal.toLocaleString('es-AR')}`;
            if (plotReport.rows.length > 0 || plotReport.incomeTotal > 0) {
              const pResultado = plotReport.incomeTotal - pTotal;
              pMsg += `\nResultado: $${pResultado.toLocaleString('es-AR')}`;
            }
            pMsg += `\n\n_Para actividades agronómicas: "qué pasó en el lote ${plotReport.plotName}"_`;
            return { messages: [pMsg], suggestionKey: 'report_shown' };
          }
        }
        const rows = await this.service.getFieldReport(userId, cmd.fieldName as string);
        if (rows.length === 0) {
          return { messages: [`No hay gastos registrados para ${cmd.fieldName} (${currentMonthLabel()}).\n\n_Para reporte agronómico: "reporte campo ${cmd.fieldName}"_`], suggestionKey: 'report_shown' };
        }
        const { lines, total } = formatReportRows(rows);
        return { messages: [`📊 *Resumen financiero — ${cmd.fieldName}* (${currentMonthLabel()})\n\n${lines}\nTotal: $${total.toLocaleString('es-AR')}\n\n_Para reporte agronómico: "reporte campo ${cmd.fieldName}"_`], suggestionKey: 'report_shown' };
      }

      // --- Date range report (flexible: field, plot, category, type filters) ---
      case 'date_range_report': {
        // Resolve dates: AI sends strings ("2026-01-01") or days (30)
        let desde: Date;
        let hasta: Date = new Date();
        hasta.setHours(23, 59, 59, 999);

        if (cmd.desde) {
          desde = new Date(cmd.desde as string);
        } else if (cmd.days) {
          desde = new Date();
          desde.setDate(desde.getDate() - (cmd.days as number));
        } else {
          // Default: current month
          desde = new Date();
          desde.setDate(1);
        }
        desde.setHours(0, 0, 0, 0);

        if (cmd.hasta) {
          hasta = new Date(cmd.hasta as string);
          hasta.setHours(23, 59, 59, 999);
        }

        const fieldName = cmd.fieldName as string | null;
        const plotName = cmd.plotName as string | null;
        const category = cmd.category as string | null;
        const reportType = (cmd.reportType as string) || 'both';
        const isAll = !!(cmd as Record<string, unknown>).isAll;

        // Detail-mode triggers: category filter set OR user asked "todos".
        // In detail-mode we list individual movements; otherwise we aggregate
        // by category (the original behavior).
        const detailMode = !!category || isAll;

        const desdeStr = desde.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const hastaStr = hasta.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const rangeLabel = isAll ? 'Todo el historial' : `${desdeStr} — ${hastaStr}`;

        const scopeParts: string[] = [];
        if (fieldName) scopeParts.push(`campo ${fieldName}`);
        if (plotName) scopeParts.push(`lote ${plotName}`);
        if (category) scopeParts.push(category.toLowerCase());
        const scopeLabel = scopeParts.length > 0 ? ` — ${scopeParts.join(', ')}` : '';

        // Sum amounts split by currency (NEVER mix ARS and USD)
        const sumByCurrency = (rows: Array<{ amount: string | number; currency: string }>) => {
          const out: Record<string, number> = {};
          for (const r of rows) {
            const c = r.currency || 'ARS';
            out[c] = (out[c] || 0) + Number(r.amount);
          }
          return out;
        };
        const fmtMoney = (n: number, cur: string) => cur === 'USD'
          ? `USD ${n.toLocaleString('es-AR')}`
          : `$${n.toLocaleString('es-AR')}`;

        const fmtDay = (d: Date | string) => {
          const date = new Date(d);
          return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
        };

        if (detailMode) {
          // Fetch individual movements
          const { getMovementsInRange } = await import('../../services/expenses.js');
          const movs = await getMovementsInRange(userId, desde, hasta, {
            fieldName, plotName, category, type: reportType, limit: 200,
          });

          const hasE = movs.expenses.length > 0;
          const hasI = movs.incomes.length > 0;
          if (!hasE && !hasI) {
            return { messages: [`No hay registros${scopeLabel} (${rangeLabel}).`], suggestionKey: 'report_shown' };
          }

          let msg = `📊 *Movimientos${scopeLabel}*\n📅 ${rangeLabel}\n`;
          const LIST_CAP = 20;

          if (hasE) {
            const expTotalsByCur = sumByCurrency(movs.expenses);
            msg += `\n*Gastos* (${movs.expenses.length})\n`;
            if (movs.expenses.length <= LIST_CAP) {
              for (const r of movs.expenses) {
                const loc = [r.field_name, r.plot_name].filter(Boolean).join('/');
                const tail = loc ? ` · ${loc}` : '';
                msg += `• ${fmtDay(r.date)} — ${r.description || r.category} — ${fmtMoney(Number(r.amount), r.currency)}${tail}\n`;
              }
            } else {
              msg += `_(${movs.expenses.length} movimientos — descargá CSV para verlos todos)_\n`;
            }
            for (const [cur, total] of Object.entries(expTotalsByCur)) {
              msg += `*Total ${cur}: ${fmtMoney(total, cur)}*\n`;
            }
          }

          if (hasI) {
            const incTotalsByCur = sumByCurrency(movs.incomes);
            msg += `\n*Ingresos* (${movs.incomes.length})\n`;
            if (movs.incomes.length <= LIST_CAP) {
              for (const r of movs.incomes) {
                const loc = [r.field_name, r.plot_name].filter(Boolean).join('/');
                const tail = loc ? ` · ${loc}` : '';
                msg += `• ${fmtDay(r.date)} — ${r.description || r.category} — ${fmtMoney(Number(r.amount), r.currency)}${tail}\n`;
              }
            } else {
              msg += `_(${movs.incomes.length} movimientos — descargá CSV para verlos todos)_\n`;
            }
            for (const [cur, total] of Object.entries(incTotalsByCur)) {
              msg += `*Total ${cur}: ${fmtMoney(total, cur)}*\n`;
            }
          }

          // Offer CSV when listing was truncated
          const totalRows = movs.expenses.length + movs.incomes.length;
          if (totalRows > LIST_CAP) {
            return {
              messages: [msg.trim()],
              interactive: {
                type: 'buttons',
                body: '¿Querés descargar el detalle?',
                buttons: [
                  { id: 'cmd_exportar_csv', title: '📥 Exportar CSV' },
                  { id: 'back_menu', title: '📋 Menú' },
                ],
              },
              suggestionKey: 'report_shown',
            };
          }
          return { messages: [msg.trim()], suggestionKey: 'report_shown' };
        }

        // ── Aggregate mode (no category, normal date range) ──
        const results = await this.service.getDateRangeReport(userId, desde, hasta, {
          fieldName, plotName, category, type: reportType,
        });

        const hasExpenses = results.expenses.length > 0;
        const hasIncomes = results.incomes.length > 0;
        if (!hasExpenses && !hasIncomes) {
          return { messages: [`No hay registros${scopeLabel} (${rangeLabel}).`], suggestionKey: 'report_shown' };
        }

        let msg = `📊 *Resumen financiero${scopeLabel}*\n📅 ${rangeLabel}\n`;

        if (hasExpenses) {
          msg += '\n*Gastos por categoría:*\n';
          for (const r of results.expenses) {
            const monto = Number(r.total);
            msg += `${r.category}: ${fmtMoney(monto, r.currency || 'ARS')}\n`;
          }
          const expByCur = sumByCurrency(results.expenses.map(r => ({ amount: r.total, currency: r.currency || 'ARS' })));
          for (const [cur, total] of Object.entries(expByCur)) {
            msg += `*Total gastos ${cur}: ${fmtMoney(total, cur)}*\n`;
          }
        }

        if (hasIncomes) {
          msg += '\n*Ingresos por categoría:*\n';
          for (const r of results.incomes) {
            const monto = Number(r.total);
            msg += `${r.category}: ${fmtMoney(monto, r.currency || 'ARS')}\n`;
          }
          const incByCur = sumByCurrency(results.incomes.map(r => ({ amount: r.total, currency: r.currency || 'ARS' })));
          for (const [cur, total] of Object.entries(incByCur)) {
            msg += `*Total ingresos ${cur}: ${fmtMoney(total, cur)}*\n`;
          }
        }

        return { messages: [msg.trim()], suggestionKey: 'report_shown' };
      }

      // --- Budget ---
      case 'set_budget': {
        await this.service.setBudget(userId, cmd.category as string, cmd.amount as number);
        return { messages: [`\ud83d\udccb Presupuesto configurado: ${cmd.category}: $${(cmd.amount as number).toLocaleString('es-AR')}/mes`] };
      }

      // --- Delete / Edit ---
      case 'delete_last': {
        const deleted = await this.service.deleteLastExpense(userId);
        if (!deleted) {
          return { messages: ['No hay gastos para borrar.'] };
        }
        return { messages: [`\ud83d\uddd1\ufe0f Gasto eliminado: ${deleted.category} $${deleted.amount.toLocaleString('es-AR')}`] };
      }

      case 'delete_last_income': {
        const deleted = await this.service.deleteLastIncome(userId);
        if (!deleted) {
          return { messages: ['No hay ingresos para borrar.'] };
        }
        return { messages: [`\ud83d\uddd1\ufe0f Ingreso eliminado: ${deleted.category} $${deleted.amount.toLocaleString('es-AR')}`] };
      }

      case 'delete_specific': {
        const deleted = await this.service.deleteSpecificExpense(userId, cmd.filter as string);
        if (!deleted) {
          return { messages: [`No encontr\u00e9 un gasto con "${cmd.filter}".`] };
        }
        return { messages: [`\ud83d\uddd1\ufe0f Gasto eliminado: ${deleted.category} $${deleted.amount.toLocaleString('es-AR')}`] };
      }

      case 'edit_specific': {
        const edited = await this.service.editSpecificExpense(userId, cmd.filter as string, cmd.amount as number);
        if (!edited) {
          return { messages: [`No encontr\u00e9 un gasto con "${cmd.filter}".`] };
        }
        return { messages: [`\u270f\ufe0f Gasto actualizado: ${edited.category}\n$${edited.oldAmount.toLocaleString('es-AR')} \u2192 $${(cmd.amount as number).toLocaleString('es-AR')}`] };
      }

      case 'edit_last': {
        const edited = await this.service.editLastExpense(userId, cmd.amount as number);
        if (!edited) {
          return { messages: ['No hay gastos para editar.'] };
        }
        return { messages: [`\u270f\ufe0f Gasto actualizado: ${edited.category}\n$${edited.oldAmount.toLocaleString('es-AR')} \u2192 $${(cmd.amount as number).toLocaleString('es-AR')}`] };
      }

      // --- Expense Templates (recurring) ---
      case 'create_expense_template': {
        const templateName = cmd.name as string | undefined;
        const templateAmount = cmd.amount as number | undefined;
        if (!templateName || !templateAmount) {
          return { messages: ['Necesito al menos el nombre y monto del gasto recurrente.'] };
        }
        const recurrenceType = (cmd.recurrenceType as string) || 'monthly';
        let recurrenceDay = cmd.recurrenceDay as number | undefined;
        if (recurrenceDay == null) {
          recurrenceDay = recurrenceType === 'monthly' ? 1 : 1; // 1st of month or Monday
        }

        let fieldId: number | null = null;
        let plotId: number | null = null;
        const fieldName = cmd.fieldName as string | undefined;
        const plotName = cmd.plotName as string | undefined;
        if (fieldName || plotName) {
          const resolution = await this.service.resolveField(userId, fieldName, plotName);
          fieldId = resolution.fieldId ?? null;
          plotId = resolution.plotId ?? null;
        }

        const { ExpenseTemplateService } = await import('./expense-template.service.js');
        const templateService = new ExpenseTemplateService();
        const template = await templateService.create(userId, {
          name: templateName,
          amount: templateAmount,
          currency: (cmd.currency as string) || 'ARS',
          category: cmd.category as string | undefined,
          description: cmd.description as string | undefined,
          fieldId: fieldId ?? undefined,
          plotId: plotId ?? undefined,
          recurrenceType,
          recurrenceDay,
        });

        const freqLabel = recurrenceType === 'weekly' ? 'semanal' : recurrenceType === 'biweekly' ? 'quincenal' : 'mensual';
        const currLabel = template.currency === 'USD' ? ' USD' : '';
        let msg = `\u2705 Gasto recurrente creado\n\n`;
        msg += `\ud83d\udcdd *${template.name}*\n`;
        msg += `\ud83d\udcb0 $${template.amount.toLocaleString('es-AR')}${currLabel}\n`;
        msg += `\ud83d\udd04 Frecuencia: ${freqLabel}\n`;
        msg += `\ud83d\udcc5 Pr\u00f3ximo: ${new Date(template.next_run_date + 'T12:00:00').toLocaleDateString('es-AR')}`;
        if (template.field_name) msg += `\n\ud83d\udccd ${template.field_name}`;
        if (template.plot_name) msg += ` - ${template.plot_name}`;
        return { messages: [msg] };
      }

      case 'list_expense_templates': {
        const { ExpenseTemplateService } = await import('./expense-template.service.js');
        const templateService = new ExpenseTemplateService();
        const templates = await templateService.list(userId);

        if (templates.length === 0) {
          return { messages: ['No ten\u00e9s gastos recurrentes configurados.\n\nPod\u00e9s crear uno con:\n_"gasto fijo mensual 50k combustible"_'] };
        }

        let msg = `\ud83d\udd04 *Gastos recurrentes activos*\n`;
        for (const t of templates) {
          const freqLabel = t.recurrence_type === 'weekly' ? 'semanal' : t.recurrence_type === 'biweekly' ? 'quincenal' : 'mensual';
          const currLabel = t.currency === 'USD' ? ' USD' : '';
          msg += `\n\u2022 *${t.name}* — $${t.amount.toLocaleString('es-AR')}${currLabel} (${freqLabel})`;
          const nextDate = new Date(t.next_run_date + 'T12:00:00').toLocaleDateString('es-AR');
          msg += `\n  Pr\u00f3ximo: ${nextDate}`;
          if (t.field_name) msg += ` | ${t.field_name}`;
          if (t.plot_name) msg += ` - ${t.plot_name}`;
        }
        return { messages: [msg] };
      }

      case 'delete_expense_template': {
        const { ExpenseTemplateService } = await import('./expense-template.service.js');
        const templateService = new ExpenseTemplateService();
        let deleted = false;

        if (cmd.templateId) {
          deleted = await templateService.delete(userId, cmd.templateId as number);
        } else if (cmd.name) {
          deleted = await templateService.deleteByName(userId, cmd.name as string);
        } else {
          return { messages: ['Necesito el nombre del gasto recurrente a eliminar.\n\nEscrib\u00ed _"mis gastos fijos"_ para ver la lista.'] };
        }

        if (!deleted) {
          return { messages: ['No encontr\u00e9 un gasto recurrente activo con ese nombre.'] };
        }
        return { messages: ['\ud83d\uddd1\ufe0f Gasto recurrente eliminado correctamente.'] };
      }

      // --- Export ---
      case 'export_csv': {
        const rows = await this.service.getMonthlyExpenses(userId);
        if (rows.length === 0) {
          return { messages: ['No hay gastos este mes para exportar.'] };
        }
        const csv = generateCSV(rows);
        const now = new Date();
        const filename = `gastos_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}.csv`;
        return {
          messages: [],
          attachment: {
            buffer: Buffer.from(csv, 'utf-8'),
            filename,
            mime: 'text/plain',
            caption: '\ud83d\udcce Gastos del mes',
          },
        };
      }

      // --- Fields ---
      case 'set_field_city': {
        const cityFieldName = cmd.fieldName as string | null;
        const cityValue = cmd.city as string | null;

        // No field specified — auto-assign if single field
        if (!cityFieldName) {
          const fields = await this.service.getUserFields(userId);
          if (fields.length === 0) {
            return { messages: ['No tenés campos registrados.\n\nPrimero creá un campo:\n\ud83d\udccd *agregar campo [nombre]*'] };
          }
          if (fields.length === 1) {
            const singleField = fields[0];
            if (cityValue) {
              const lookup = localidadLookup.lookup(cityValue);
              if (lookup.status === 'exact') {
                const loc = lookup.matches[0];
                await this.service.setFieldCity(userId, singleField.name, loc.nombre, loc.provincia);
                return { messages: [`\ud83d\udccd Campo *${singleField.name}* ubicado en *${formatLocation(loc.nombre, loc.provincia)}*`] };
              }
              // Non-exact: save as-is, enter pending for correction
              return {
                messages: [`\u00bfEn qu\u00e9 ciudad/localidad est\u00e1 tu campo *${singleField.name}*?`],
                sideEffects: { setPendingFieldCity: { fieldName: singleField.name } },
              };
            }
            return {
              messages: [`\u00bfEn qu\u00e9 ciudad/localidad est\u00e1 tu campo *${singleField.name}*?`],
              sideEffects: { setPendingFieldCity: { fieldName: singleField.name } },
            };
          }
          // Multiple fields — ask which one
          return {
            messages: [`Ten\u00e9s ${fields.length} campos. \u00bfA cu\u00e1l quer\u00e9s asignarle ubicaci\u00f3n?\n\n${fields.map(f => `\u2022 *${f.name}*`).join('\n')}\n\nEscrib\u00ed: *campo [nombre] est\u00e1 en [ciudad]*`],
          };
        }

        const labelCity = (!cmd.entityKeyword || cmd.entityKeyword === 'campo') ? 'Campo' : 'Lote';
        const existingFieldCity = await this.service.getFieldByName(userId, cityFieldName);
        if (!existingFieldCity) {
          return {
            messages: [`No encontr\u00e9 el ${labelCity.toLowerCase()} *${cityFieldName}*.\nPrimero crealo: *agregar campo ${cityFieldName}*`],
          };
        }
        if (!cityValue) {
          return {
            messages: [`\u00bfEn qu\u00e9 ciudad/localidad est\u00e1 *${cityFieldName}*?`],
            sideEffects: { setPendingFieldCity: { fieldName: cityFieldName } },
          };
        }
        // Validate city via localidad lookup
        const lookupResult = localidadLookup.lookup(cityValue);
        if (lookupResult.status === 'exact') {
          const loc = lookupResult.matches[0];
          await this.service.setFieldCity(userId, cityFieldName, loc.nombre, loc.provincia);
          return { messages: [`\ud83d\udccd ${labelCity} *${cityFieldName}* ubicado en *${formatLocation(loc.nombre, loc.provincia)}*`] };
        }
        // Non-exact: enter pending state for re-prompt
        return {
          messages: [`\u00bfEn qu\u00e9 ciudad/localidad est\u00e1 *${cityFieldName}*?`],
          sideEffects: { setPendingFieldCity: { fieldName: cityFieldName } },
        };
      }

      case 'add_field_city': {
        const city = cmd.city as string;
        return {
          messages: [],
          sideEffects: {
            startFlow: { state: 'field_flow' as FlowState, data: { city } },
          },
        };
      }

      case 'add_field': {
        const kwAdd = (cmd.entityKeyword as string) || 'campo';

        // Smart lote flow: when user says "agregar lote X" without specifying field
        if (kwAdd === 'lote') {
          const fields = await this.service.getUserFields(userId);

          if (fields.length === 0) {
            // No fields → ask user to create a field first
            return {
              messages: [`No tenés campos registrados.\n\nPara agregar el lote *${cmd.fieldName}*, primero creá un campo:\n📍 *agregar campo [nombre]*\n\nDespués podés agregar el lote.`],
            };
          }

          if (fields.length === 1) {
            // Single field → auto-assign lot to it
            const field = await this.service.getFieldByName(userId, fields[0].name);
            if (field) {
              const plotsBefore = await this.service.findAllUserPlots(userId);
              const plot = await this.service.getOrCreatePlot(field.id, cmd.fieldName as string);
              const messages: string[] = [];
              const loteSideEffects: HandlerResponse['sideEffects'] = {};
              if (cmd.hectares) {
                await this.service.setPlotArea(plot.id, cmd.hectares as number);
                messages.push(`📍 Lote *${cmd.fieldName}* (${cmd.hectares} ha) creado en campo *${fields[0].name}*`);
              } else {
                messages.push(`📍 Lote *${cmd.fieldName}* creado en campo *${fields[0].name}*`);
                loteSideEffects.setPendingPlotArea = { plotId: plot.id, plotName: plot.name, fieldName: fields[0].name };
              }
              if (plotsBefore.length === 0) {
                const welcomeMsg = await getSetting('ONBOARDING_FIRST_PLOT_MESSAGE');
                if (welcomeMsg) messages.push(interpolate(welcomeMsg, { nombre: user.name || '' }));
              }
              return { messages, suggestionKey: 'plot_created', sideEffects: loteSideEffects };
            }
          }

          // Multiple fields → buttons (up to 3) or list (4+)
          const bodyMsg = `\u00bfEn qu\u00e9 campo quer\u00e9s crear el lote *${cmd.fieldName}*?`;
          const plotSlug = (cmd.fieldName as string).replace(/\s+/g, '_');

          if (fields.length <= 3) {
            return {
              messages: [bodyMsg],
              interactive: {
                type: 'buttons',
                body: bodyMsg,
                buttons: fields.map(f => ({
                  id: `create_plot_${plotSlug}_in_${f.name.replace(/\s+/g, '_')}`,
                  title: f.name.substring(0, 20),
                })),
              },
            };
          }

          // 4+ fields → use list (max 10 rows)
          return {
            messages: [bodyMsg],
            interactive: {
              type: 'list',
              body: bodyMsg,
              buttonText: 'Elegir campo',
              sections: [{
                title: 'Tus campos',
                rows: fields.slice(0, 10).map(f => ({
                  id: `create_plot_${plotSlug}_in_${f.name.replace(/\s+/g, '_')}`,
                  title: f.name.substring(0, 24),
                  description: f.city ? formatLocation(f.city, f.province).substring(0, 72) : undefined,
                })),
              }],
            },
          };
        }

        // Max fields check for campo/parcela
        const fieldCount = await this.service.getUserFieldCount(userId);
        const maxFields = (settings as any).max_fields || 10;
        if (fieldCount >= maxFields) {
          return { messages: [`Ya ten\u00e9s ${fieldCount} campos (m\u00e1ximo: ${maxFields}). Elimin\u00e1 uno antes de agregar otro.`] };
        }

        const fieldName = (cmd.fieldName as string).trim();
        const labelAdd = cmd.entityKeyword === 'campo' ? 'Campo' : (cmd.entityKeyword === 'parcela' ? 'Parcela' : 'Lote');

        // Check if field already exists — ask user what to do (never silent overwrite)
        const existing = await this.service.getFieldByName(userId, fieldName);
        if (existing) {
          const city = cmd.city as string | null;
          const cityChanged = city && city.toLowerCase() !== (existing.city || '').toLowerCase();
          let msg = `⚠️ Ya existe un ${labelAdd.toLowerCase()} llamado *${existing.name}*`;
          if (existing.city) msg += ` (ubicación: ${formatLocation(existing.city, existing.province)})`;
          msg += '.';
          if (cityChanged) msg += `\nLa nueva ubicación sería *${city}*.`;
          msg += '\n\n¿Qué querés hacer?';

          const buttons: { id: string; title: string }[] = [];
          if (cityChanged) buttons.push({ id: 'field_dup_update', title: 'Actualizar ubic.' });
          buttons.push({ id: 'field_dup_rename', title: 'Otro nombre' });
          buttons.push({ id: 'field_dup_cancel', title: 'Cancelar' });

          return {
            messages: [msg],
            interactive: { type: 'buttons' as const, body: '¿Qué querés hacer?', buttons },
            sideEffects: { setFieldDuplicate: { name: fieldName, city } },
          };
        }

        // If city was provided and matches exactly, fast path (create + set city immediately)
        if (cmd.city) {
          const lookup = localidadLookup.lookup(cmd.city as string);
          if (lookup.status === 'exact') {
            await this.service.getOrCreateField(userId, fieldName);
            const loc = lookup.matches[0];
            await this.service.setFieldCity(userId, fieldName, loc.nombre, loc.provincia);
            return {
              messages: [`\ud83d\udccd ${labelAdd} *${fieldName}* creado en *${formatLocation(loc.nombre, loc.provincia)}*`],
              suggestionKey: 'field_created',
            };
          }
        }

        // No city or non-exact match: start field_flow with name pre-filled
        // so the user sees the 3 location method buttons
        const prefillData: Record<string, unknown> = { name: fieldName };
        if (cmd.city) {
          // User already typed a city but it didn't match exactly — skip to city step
          prefillData.locationMethod = 'city';
        }
        return {
          messages: [`📍 Vamos a crear el campo *${fieldName}*.`],
          sideEffects: { startFlow: { state: 'field_flow' as const, data: prefillData } },
        };
      }

      case 'list_fields': {
        const fields = await this.service.getUserFields(userId);
        if (fields.length === 0) {
          return { messages: ['No ten\u00e9s campos registrados.\n\nPara agregar uno escrib\u00ed:\n\ud83d\udccd *agregar campo norte en Pergamino*\no\n\ud83d\udccd *tengo un campo en Lincoln*'] };
        }
        let totalHa = 0;
        let msg = `\ud83d\udccd *Tus campos (${fields.length}):*\n`;
        for (const f of fields) {
          const loc = f.city
            ? formatLocation(f.city, f.province)
            : f.province
              ? f.province
              : (f as any).location_method === 'map'
                ? 'ubicado en mapa'
                : null;
          const plotCount = (f as any).plot_count || 0;
          const ha = Number((f as any).total_hectares) || 0;
          totalHa += ha;
          const details: string[] = [];
          if (plotCount > 0) details.push(`${plotCount} lote${plotCount > 1 ? 's' : ''}`);
          if (ha > 0) details.push(`${ha.toLocaleString('es-AR')} ha`);
          const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';
          msg += `\n\u2022 *${f.name}*${loc ? ` \u2014 ${loc}` : ' \u2014 sin ubicaci\u00f3n'}${detailStr}`;
        }
        if (totalHa > 0) {
          msg += `\n\n\ud83d\udcd0 *Total: ${totalHa.toLocaleString('es-AR')} ha*`;
        }
        msg += '\n\n_Comandos: agregar campo X, lotes del campo X, info campo X_';
        return { messages: [msg] };
      }

      case 'delete_field': {
        const labelDel = cmd.entityKeyword === 'campo' ? 'Campo' : 'Lote';
        const exists = await this.service.getFieldByName(userId, cmd.fieldName as string);
        if (!exists) {
          return { messages: [`No encontr\u00e9 ${labelDel.toLowerCase()} *${cmd.fieldName}*.`] };
        }

        // Owner-only check for shared fields
        const isOwnerDel = await this.sharingService.isOwner(userId, exists.id);
        if (!isOwnerDel) {
          return { messages: [`Solo el dueño del campo *${cmd.fieldName}* puede eliminarlo.`] };
        }

        // Get associated data counts for confirmation message
        const info = await this.service.getFieldInfo(userId, cmd.fieldName as string);
        const plotCount = info ? info.plotCount : 0;
        const dataCount = info ? (info.expenses.count + info.incomes.count + info.rainfall.count) : 0;

        let confirmMsg = `\u00bfSeguro que quer\u00e9s eliminar ${labelDel.toLowerCase()} *${cmd.fieldName}*?`;
        if (plotCount && plotCount > 0) confirmMsg += `\nTiene ${plotCount} lote${plotCount > 1 ? 's' : ''} que tambi\u00e9n se eliminar\u00e1${plotCount > 1 ? 'n' : ''}.`;
        if (dataCount > 0) confirmMsg += `\nTiene ${dataCount} registro${dataCount > 1 ? 's' : ''} asociado${dataCount > 1 ? 's' : ''} que quedar\u00e1${dataCount > 1 ? 'n' : ''} sin asignar.`;

        // Warn about shared members
        try {
          const members = await this.sharingService.listMembers(userId, exists.id);
          const nonOwners = members.filter((m: any) => m.role !== 'owner');
          if (nonOwners.length > 0) {
            confirmMsg += `\n⚠️ ${nonOwners.length} usuario${nonOwners.length > 1 ? 's' : ''} compartido${nonOwners.length > 1 ? 's' : ''} perderá${nonOwners.length > 1 ? 'n' : ''} acceso.`;
          }
        } catch { /* sharing query failed — continue without warning */ }

        confirmMsg += `\n\n_Pod\u00e9s restaurarlo despu\u00e9s con "restaurar ${labelDel.toLowerCase()} ${cmd.fieldName}"_`;

        return {
          messages: [confirmMsg],
          interactive: {
            type: 'buttons',
            body: confirmMsg,
            buttons: [
              { id: `confirm_delete_field_${(cmd.fieldName as string).replace(/\s+/g, '_')}`, title: 'Confirmar' },
              { id: 'cancel_action', title: 'Cancelar' },
            ],
          },
        };
      }

      case 'rename_field': {
        const labelRen = cmd.entityKeyword === 'campo' ? 'Campo' : 'Lote';
        // Check ownership before renaming
        const fieldToRename = await this.service.getFieldByName(userId, cmd.oldName as string);
        if (!fieldToRename) {
          return { messages: [`No encontré ${labelRen.toLowerCase()} *${cmd.oldName}*.`] };
        }
        const isOwnerRen = await this.sharingService.isOwner(userId, fieldToRename.id);
        if (!isOwnerRen) {
          return { messages: [`Solo el dueño del campo *${cmd.oldName}* puede renombrarlo.`] };
        }
        const renamed = await this.service.renameField(userId, cmd.oldName as string, cmd.newName as string);
        if (!renamed) {
          return { messages: [`No encontré ${labelRen.toLowerCase()} *${cmd.oldName}*.`] };
        }
        return { messages: [`✏️ ${labelRen} *${cmd.oldName}* renombrado a *${cmd.newName}*`] };
      }

      case 'rename_plot': {
        const oldPlotName = cmd.oldName as string;
        const newPlotName = cmd.newName as string;
        const renPlotFieldName = cmd.fieldName as string | null;

        // Resolve field for ownership check
        let renPlotField: any = null;
        if (renPlotFieldName) {
          renPlotField = await this.service.getFieldByName(userId, renPlotFieldName);
          if (!renPlotField) {
            return { messages: [`No encontré el campo *${renPlotFieldName}*.`] };
          }
        } else {
          // Auto-resolve: find plots with oldName across user's fields
          const plotMatches = await this.service.findPlotByNameAcrossFields(userId, oldPlotName);
          if (plotMatches.length === 0) {
            return { messages: [`No encontré el lote *${oldPlotName}*.`] };
          }
          if (plotMatches.length > 1) {
            return { messages: [`Hay ${plotMatches.length} lotes con nombre *${oldPlotName}*. Indicá el campo:\n*renombrar lote ${oldPlotName} a ${newPlotName} en campo [nombre]*`] };
          }
          renPlotField = await this.service.getFieldByName(userId, plotMatches[0].field_name);
        }

        if (renPlotField) {
          const isOwnerRenPlot = await this.sharingService.isOwner(userId, renPlotField.id);
          if (!isOwnerRenPlot) {
            return { messages: [`Solo el dueño del campo *${renPlotField.name}* puede renombrar sus lotes.`] };
          }
        }

        const renamedPlot = await this.service.renamePlot(userId, oldPlotName, newPlotName, renPlotFieldName);
        if (!renamedPlot) {
          return { messages: [`No encontré el lote *${oldPlotName}*${renPlotFieldName ? ` en campo *${renPlotFieldName}*` : ''}.`] };
        }
        return { messages: [`✏️ Lote *${oldPlotName}* renombrado a *${newPlotName}* (campo ${renamedPlot.fieldName})`] };
      }

      case 'field_info': {
        // Plot lookup: route through plotDiscovery so we get fuzzy whitespace
        // matching, "__last__" pronoun resolution AND a side-effect that
        // updates conversation_state. Without this, follow-up questions
        // ("ese lote", "promedio?", "y la cosecha?") infer wrong plots
        // because field_info wasn't bumping last_plot_id.
        if (cmd.entityKeyword === 'lote') {
          const resolved = await this.plotDiscovery.resolveFromNamesWithContext(
            userId, null, cmd.fieldName as string,
          );
          if (resolved.plotId && resolved.plotName) {
            const plotInfo = await this.service.getPlotInfo(userId, resolved.plotName);
            if (plotInfo) {
              return { messages: [this.formatPlotInfo(plotInfo)], suggestionKey: 'field_info_shown' };
            }
          }
          // Fall through to field lookup
        }
        const info = await this.service.getFieldInfo(userId, cmd.fieldName as string);
        if (!info) {
          const label = cmd.entityKeyword === 'lote' ? 'lote' : 'campo';
          return { messages: [`No encontr\u00e9 el ${label} *${cmd.fieldName}*.\nEscrib\u00ed *mis campos* para ver los que ten\u00e9s.`] };
        }
        // Same layout philosophy as formatPlotInfo: agro first, financial as
        // a one-liner, PDF hint at the end. Empty observations render as
        // "ninguna" instead of being silently omitted.
        const resultado = info.incomes.total - info.expenses.total;
        const metaParts: string[] = [];
        if (info.plotCount && info.plotCount > 0) {
          metaParts.push(`${info.plotCount} lote${info.plotCount > 1 ? 's' : ''}`);
        }
        if (info.totalHectares > 0) metaParts.push(`${info.totalHectares.toLocaleString('es-AR')} ha`);
        let msg = `📍 *Campo ${info.name}*${metaParts.length ? ` · ${metaParts.join(' · ')}` : ''}\n`;
        msg += info.city ? `📌 ${formatLocation(info.city, info.province)}\n` : `📌 Ubicación: sin asignar\n`;

        msg += `\n🔍 *Observaciones recientes:* `;
        if (info.observations && info.observations.length > 0) {
          msg += `\n`;
          for (const o of info.observations) {
            const date = new Date(o.created_at);
            const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
            const plotLabel = o.plot_name ? ` [${o.plot_name}]` : '';
            msg += `  • ${o.observation_text}${plotLabel} (${dateStr})\n`;
          }
        } else {
          msg += `ninguna\n`;
        }

        msg += `🌧️ *Lluvia (mes):* ${info.rainfall.count > 0 ? `${info.rainfall.total} mm (${info.rainfall.count} reg.)` : '0 mm'}\n`;

        msg += `\n💰 *Resumen mes:* gastos $${info.expenses.total.toLocaleString('es-AR')} (${info.expenses.count}) · ingresos $${info.incomes.total.toLocaleString('es-AR')} (${info.incomes.count}) · resultado $${resultado.toLocaleString('es-AR')}\n`;

        msg += `\n📊 *Reportes en PDF:* pedí _"reporte agro campo ${info.name}"_ o _"reporte financiero campo ${info.name}"_`;

        return { messages: [msg.trimEnd()], suggestionKey: 'field_info_shown' };
      }

      // --- Plots ---
      case 'list_plots': {
        // Grupo filter takes priority over field filter
        if (cmd.grupo) {
          const grupoName = (cmd.grupo as string).trim();
          const grupoPlots = await this.service.findPlotsByGrupo(userId, grupoName);
          if (grupoPlots.length === 0) {
            return {
              messages: [`No encontré lotes asignados al grupo *${grupoName}*.\n\nPara asignar: *los lotes A, B son del grupo ${grupoName}*`],
            };
          }
          let msg = `🏷️ *Lotes del grupo ${grupoName} (${grupoPlots.length}):*\n`;
          let total = 0;
          const grouped = new Map<string, typeof grupoPlots>();
          for (const p of grupoPlots) {
            const list = grouped.get(p.field_name) || [];
            list.push(p);
            grouped.set(p.field_name, list);
          }
          for (const [fieldName, plots] of grouped) {
            msg += `\n• *${fieldName}*`;
            for (const p of plots) {
              const ha = p.area_hectares ? Number(p.area_hectares) : 0;
              total += ha;
              msg += `\n  └ ${p.name}${ha > 0 ? ` — ${ha.toLocaleString('es-AR')} ha` : ''}`;
            }
          }
          if (total > 0) {
            msg += `\n\n📐 *Total: ${total.toLocaleString('es-AR')} ha*`;
          }
          return { messages: [msg], suggestionKey: 'field_info_shown' };
        }
        if (!cmd.fieldName) {
          const fields = await this.service.getUserFields(userId);
          const allPlots = await this.service.findAllUserPlots(userId);

          if (fields.length === 0) {
            return {
              messages: ['No tenés campos registrados, por lo tanto no hay lotes todavía.\n\nPara empezar, agregá un campo:\n📍 *agregar campo norte en Pergamino*'],
              suggestionKey: 'field_info_shown',
            };
          }

          if (allPlots.length === 0) {
            const example = fields[0].name;
            return {
              messages: [`Tenés ${fields.length} campo${fields.length > 1 ? 's' : ''} pero todavía no registraste lotes.\n\nPara agregar uno escribí:\n📍 *agregar lote 1 en campo ${example}*`],
              suggestionKey: 'field_info_shown',
            };
          }

          const fieldSet = new Set(allPlots.map(p => p.field_name));
          let msg = `📍 *Tus lotes (${allPlots.length}) en ${fieldSet.size} campo${fieldSet.size > 1 ? 's' : ''}:*\n`;
          const grouped = new Map<string, typeof allPlots>();
          for (const p of allPlots) {
            const list = grouped.get(p.field_name) || [];
            list.push(p);
            grouped.set(p.field_name, list);
          }
          let grandTotal = 0;
          for (const [fieldName, plots] of grouped) {
            let fieldHa = 0;
            const plotLines: string[] = [];
            for (const p of plots) {
              const ha = p.area_hectares ? Number(p.area_hectares) : 0;
              fieldHa += ha;
              plotLines.push(`\n  └ ${p.name}${ha > 0 ? ` — ${ha.toLocaleString('es-AR')} ha` : ''}`);
            }
            grandTotal += fieldHa;
            const fieldHaLabel = fieldHa > 0 ? ` (${fieldHa.toLocaleString('es-AR')} ha)` : '';
            msg += `\n• *${fieldName}*${fieldHaLabel}`;
            msg += plotLines.join('');
          }
          if (grandTotal > 0) {
            msg += `\n\n📐 *Total: ${grandTotal.toLocaleString('es-AR')} ha*`;
          }
          return { messages: [msg], suggestionKey: 'field_info_shown' };
        }
        const field = await this.service.getFieldByName(userId, cmd.fieldName as string);
        if (!field) {
          return { messages: [`No encontré el campo *${cmd.fieldName}*. Escribí *mis campos* para ver tus campos.`] };
        }
        const plots = await this.service.getPlotsByField(field.id);
        if (plots.length === 0) {
          return { messages: [`El campo *${field.name}* no tiene lotes.\n\nPara agregar uno escrib\u00ed:\n\ud83d\udccd *agregar lote 3 en campo ${field.name}*`] };
        }
        let msg = `\ud83d\udccd *Lotes de ${field.name} (${plots.length}):*\n`;
        let totalHa = 0;
        for (const p of plots) {
          msg += `\n\u2022 *${p.name}*`;
          if (p.area_hectares) {
            msg += ` \u2014 ${p.area_hectares} ha`;
            totalHa += Number(p.area_hectares);
          }
          if (p.soil_type) msg += ` (${p.soil_type})`;
        }
        if (totalHa > 0) {
          msg += `\n\n📐 *Total: ${totalHa.toLocaleString('es-AR')} ha*`;
        }
        return { messages: [msg] };
      }

      case 'add_plots_batch': {
        const plotNames = cmd.plotNames as string[];
        if (!plotNames || plotNames.length === 0) {
          return { messages: ['No pude detectar los nombres de los lotes.\n\nEscrib\u00ed: *agregar lotes A, B y C*'] };
        }
        const fields = await this.service.getUserFields(userId);
        if (fields.length === 0) {
          return { messages: ['No ten\u00e9s campos registrados.\n\nPrimero cre\u00e1 un campo:\n\ud83d\udccd *agregar campo [nombre]*'] };
        }
        let targetField: { id: number; name: string };
        if (cmd.fieldName) {
          const f = await this.service.getFieldByName(userId, cmd.fieldName as string);
          if (!f) {
            return { messages: [`No encontré el campo *${cmd.fieldName}*.\n\nEscribí *mis campos* para ver tus campos.`] };
          }
          targetField = f;
        } else if (fields.length === 1) {
          const f = await this.service.getFieldByName(userId, fields[0].name);
          if (!f) return { messages: ['Error al obtener el campo.'] };
          targetField = f;
        } else {
          return {
            messages: [`Ten\u00e9s ${fields.length} campos. Indic\u00e1 en cu\u00e1l crear los lotes.\n\nEscrib\u00ed: *agregar lote [nombre] en [campo]*`],
          };
        }
        const plotsBeforeBatch = await this.service.findAllUserPlots(userId);
        const created: Array<{ name: string; id: number }> = [];
        const existing: string[] = [];
        const existingPlots = await this.service.getPlotsByField(targetField.id);
        for (const name of plotNames) {
          const already = existingPlots.some(p => p.name.toLowerCase() === name.toLowerCase());
          if (already) {
            existing.push(name);
          } else {
            const plot = await this.service.getOrCreatePlot(targetField.id, name);
            created.push({ name: plot.name, id: plot.id });
          }
        }

        // If the user already gave us the area ("de 50 ha cada uno"), apply
        // it upfront so we skip the per-plot "¿cuántas hectáreas?" queue.
        const areaCadaUno = typeof cmd.area === 'number' && cmd.area > 0 ? cmd.area : null;
        if (areaCadaUno) {
          for (const c of created) {
            await this.service.setPlotArea(c.id, areaCadaUno);
          }
        }

        let msg = '';
        if (created.length > 0) {
          msg += `📍 Lotes creados en campo *${targetField.name}*:\n${created.map(c => `  \u2022 *${c.name}*${areaCadaUno ? ` \u2014 ${areaCadaUno} ha` : ''}`).join('\n')}`;
        }
        if (existing.length > 0) {
          if (created.length > 0) msg += '\n\n';
          msg += `Ya exist\u00edan: ${existing.map(n => `*${n}*`).join(', ')}`;
        }
        const batchMessages = [msg];
        if (created.length > 0 && plotsBeforeBatch.length === 0) {
          const welcomeMsg = await getSetting('ONBOARDING_FIRST_PLOT_MESSAGE');
          if (welcomeMsg) batchMessages.push(interpolate(welcomeMsg, { nombre: user.name || '' }));
        }
        const batchSideEffects: HandlerResponse['sideEffects'] = {};
        if (created.length > 0 && !areaCadaUno) {
          const now = Date.now();
          batchSideEffects.setPendingPlotAreaQueue = created.map(c => ({
            plotId: c.id, plotName: c.name, fieldName: targetField.name,
          }));
        }
        return { messages: batchMessages, suggestionKey: 'plot_created', sideEffects: batchSideEffects };
      }

      case 'add_plot': {
        if (!cmd.plotName || (typeof cmd.plotName === 'string' && cmd.plotName.trim() === '')) {
          return {
            messages: ['Necesitás indicar el nombre del lote.\n\n📍 Escribí *agregar lote [nombre] en campo [campo]*'],
          };
        }
        // Auto-split: if plotName contains commas or " y ", redirect to add_plots_batch
        if (typeof cmd.plotName === 'string' && /[,]|\sy\s/.test(cmd.plotName)) {
          const names = cmd.plotName.split(/\s*,\s*|\s+y\s+/).map((n: string) => n.trim()).filter(Boolean);
          if (names.length > 1) {
            cmd.command = 'add_plots_batch';
            cmd.plotNames = names;
            delete cmd.plotName;
            return this.handleCommand(cmd, userId, user, settings);
          }
        }
        let field: any;
        if (!cmd.fieldName) {
          const fields = await this.service.getUserFields(userId);
          if (fields.length === 0) {
            return {
              messages: ['Para agregar un lote primero necesit\u00e1s crear un campo.\n\n\ud83d\udccd Escrib\u00ed *agregar campo [nombre]*'],
            };
          }
          if (fields.length === 1) {
            field = fields[0];
          } else {
            // Buttons cap at 3 on WhatsApp; use a list (10 rows) when the
            // user has more than 3 campos so they can pick from all of them.
            const plotSlugAdd = (cmd.plotName as string).replace(/\s+/g, '_');
            const askMsgAdd = `\u00bfEn qu\u00e9 campo quer\u00e9s agregar el lote *${cmd.plotName}*?`;
            if (fields.length <= 3) {
              const buttons = fields.map((f: any) => ({
                id: `create_plot_${plotSlugAdd}_in_${f.name.replace(/\s+/g, '_')}`,
                title: f.name.slice(0, 20),
              }));
              return {
                messages: [askMsgAdd],
                interactive: { type: 'buttons' as const, body: '\u00bfEn qu\u00e9 campo?', buttons },
              };
            }
            return {
              messages: [askMsgAdd],
              interactive: {
                type: 'list' as const,
                body: askMsgAdd,
                buttonText: 'Elegir campo',
                sections: [{
                  title: 'Tus campos',
                  rows: fields.slice(0, 10).map((f: any) => ({
                    id: `create_plot_${plotSlugAdd}_in_${f.name.replace(/\s+/g, '_')}`,
                    title: f.name.substring(0, 24),
                    description: f.city ? formatLocation(f.city, f.province).substring(0, 72) : undefined,
                  })),
                }],
              },
            };
          }
        } else {
          field = await this.service.getFieldByName(userId, cmd.fieldName as string);
        }
        if (!field) {
          return {
            messages: [`No encontr\u00e9 el campo *${cmd.fieldName}*.\n\nPrimero cre\u00e1 el campo:\n\ud83d\udccd *agregar campo ${cmd.fieldName}*`],
          };
        }
        // Check if plot already exists before creating
        const existingPlots = await this.service.getPlotsByField(field.id);
        const plotExists = existingPlots.some(p => p.name.toLowerCase() === (cmd.plotName as string).toLowerCase());
        const plotsBeforeAdd = await this.service.findAllUserPlots(userId);
        const plot = await this.service.getOrCreatePlot(field.id, cmd.plotName as string);
        // Update conversation state so "ahí"/"ese lote" references the new plot
        await updateConversationState(userId, field.id, plot.id);
        if (plotExists) {
          return {
            messages: [`Ya existía el lote *${plot.name}* en campo *${field.name}*.`],
            suggestionKey: 'field_info_shown',
          };
        }
        const addPlotMessages: string[] = [];
        const addPlotSideEffects: HandlerResponse['sideEffects'] = {};
        // If hectares provided inline, set area immediately
        if (cmd.hectares) {
          await this.service.setPlotArea(plot.id, cmd.hectares as number);
          addPlotMessages.push(`📍 Lote *${plot.name}* (${cmd.hectares} ha) creado en campo *${field.name}*`);
        } else {
          addPlotMessages.push(`📍 Lote *${plot.name}* creado en campo *${field.name}*`);
          addPlotSideEffects.setPendingPlotArea = { plotId: plot.id, plotName: plot.name, fieldName: field.name };
        }
        if (plotsBeforeAdd.length === 0) {
          const welcomeMsg = await getSetting('ONBOARDING_FIRST_PLOT_MESSAGE');
          if (welcomeMsg) addPlotMessages.push(interpolate(welcomeMsg, { nombre: user.name || '' }));
        }
        return { messages: addPlotMessages, suggestionKey: 'plot_created', sideEffects: addPlotSideEffects };
      }

      case 'delete_plot': {
        const field = await this.service.getFieldByName(userId, cmd.fieldName as string);
        if (!field) {
          return { messages: [`No encontr\u00e9 el campo *${cmd.fieldName}*.`] };
        }

        // Owner-only check
        const isOwnerDelPlot = await this.sharingService.isOwner(userId, field.id);
        if (!isOwnerDelPlot) {
          return { messages: [`Solo el dueño del campo *${cmd.fieldName}* puede eliminar sus lotes.`] };
        }

        const plotsForDel = await this.service.findPlotByNameAcrossFields(userId, cmd.plotName as string);
        const plotForDel = plotsForDel.find(p => p.field_id === field.id);
        if (!plotForDel) {
          return { messages: [`No encontr\u00e9 el lote *${cmd.plotName}* en campo *${cmd.fieldName}*.`] };
        }

        const confirmPlotMsg = `\u00bfSeguro que quer\u00e9s eliminar el lote *${cmd.plotName}* del campo *${cmd.fieldName}*?\nLos registros asociados quedar\u00e1n sin lote.\n\n_Pod\u00e9s restaurarlo despu\u00e9s con "restaurar lote ${cmd.plotName} del campo ${cmd.fieldName}"_`;
        return {
          messages: [confirmPlotMsg],
          interactive: {
            type: 'buttons',
            body: confirmPlotMsg,
            buttons: [
              { id: `confirm_delete_plot_${(cmd.plotName as string).replace(/\s+/g, '_')}_in_${(cmd.fieldName as string).replace(/\s+/g, '_')}`, title: 'Confirmar' },
              { id: 'cancel_action', title: 'Cancelar' },
            ],
          },
        };
      }

      case 'plot_info': {
        const plotInfo = await this.service.getPlotInfo(userId, cmd.plotName as string);
        if (!plotInfo) {
          const allPlots = await this.service.findAllUserPlots(userId);
          if (allPlots.length === 0) {
            return { messages: [`No encontr\u00e9 el lote *${cmd.plotName}*.\nNo ten\u00e9s lotes registrados.`] };
          }
          return { messages: [`No encontré el lote *${cmd.plotName}*.\n\nTus lotes:\n${formatPlotListGrouped(allPlots)}`] };
        }
        return { messages: [this.formatPlotInfo(plotInfo)], suggestionKey: 'field_info_shown' };
      }

      case 'set_plot_area': {
        const plots = await this.service.findPlotByNameAcrossFields(userId, cmd.plotName as string);
        if (plots.length === 0) {
          return { messages: [`No encontr\u00e9 el lote *${cmd.plotName}*.`] };
        }
        await this.service.setPlotArea(plots[0].id, cmd.hectares as number);
        return { messages: [`\ud83d\udccd Lote *${plots[0].name}*: superficie actualizada a *${cmd.hectares} ha*`] };
      }

      case 'set_plot_grupo': {
        const grupo = cmd.grupo as string;
        // Support both batch (plotNames[]) and single (plotName) for backward compat with regex
        const targetNames: string[] = Array.isArray(cmd.plotNames) && cmd.plotNames.length > 0
          ? (cmd.plotNames as string[])
          : cmd.plotName
            ? [cmd.plotName as string]
            : [];
        if (targetNames.length === 0) {
          return { messages: ['No pude detectar los lotes. Escribí: *asignar grupo X al lote Y* o *los lotes A, B son del grupo X*.'] };
        }
        if (!grupo) {
          return { messages: ['No pude detectar el grupo/sociedad. Escribí: *lote Y es del grupo X*.'] };
        }
        const updated: string[] = [];
        const notFound: string[] = [];
        for (const rawName of targetNames) {
          const name = rawName.trim();
          if (!name) continue;
          const plots = await this.service.findPlotByNameAcrossFields(userId, name);
          if (plots.length === 0) {
            notFound.push(name);
            continue;
          }
          await this.service.setPlotGrupo(plots[0].id, grupo);
          updated.push(plots[0].name);
        }
        if (updated.length === 0) {
          return { messages: [`No encontré los lotes: ${notFound.join(', ')}.`] };
        }
        const lines: string[] = [];
        if (updated.length === 1) {
          lines.push(`🏷️ Lote *${updated[0]}*: grupo asignado → *${grupo}*`);
        } else {
          lines.push(`🏷️ ${updated.length} lotes asignados al grupo *${grupo}*:`);
          for (const n of updated) lines.push(`  • ${n}`);
        }
        if (notFound.length > 0) {
          lines.push(`\n⚠️ No encontré: ${notFound.join(', ')}`);
        }
        return { messages: [lines.join('\n')] };
      }

      case 'restore_field': {
        const kwRestore = (cmd.entityKeyword as string) || 'campo';

        // If regex gave entityKeyword='lote', search deleted plots instead
        if (kwRestore === 'lote') {
          // Try to find which field the deleted plot belongs to
          const allFields = await this.service.getUserFields(userId);
          for (const f of allFields) {
            const restoredPlot = await this.service.restorePlot(userId, cmd.fieldName as string, f.name);
            if (restoredPlot) {
              return {
                messages: [`✅ Lote *${restoredPlot.name}* restaurado correctamente en campo *${f.name}*.`],
                suggestionKey: 'field_created',
              };
            }
          }
          return { messages: [`No encontré lote eliminado con nombre *${cmd.fieldName}*.`] };
        }

        const restored = await this.service.restoreField(userId, cmd.fieldName as string);
        if (!restored) {
          return { messages: [`No encontr\u00e9 campo eliminado con nombre *${cmd.fieldName}*.`] };
        }
        return {
          messages: [`\u2705 Campo *${restored.name}* restaurado correctamente.\nSus lotes asociados tambi\u00e9n fueron restaurados.`],
          suggestionKey: 'field_created',
        };
      }

      case 'restore_plot': {
        const plotToRestore = cmd.plotName as string;
        const fieldForRestore = cmd.fieldName as string;
        const restoredPlot = await this.service.restorePlot(userId, plotToRestore, fieldForRestore);
        if (!restoredPlot) {
          return { messages: [`No encontré lote eliminado *${plotToRestore}* en campo *${fieldForRestore}*.`] };
        }
        return {
          messages: [`✅ Lote *${restoredPlot.name}* restaurado correctamente en campo *${fieldForRestore}*.`],
          suggestionKey: 'field_created',
        };
      }

      default:
        return { messages: [] };
    }
  }

  // --- Category pick/create (interactive button callbacks) ---

  async pickCategory(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const kind = (cmd.kind as string) as 'expense' | 'income';
    const categoryId = Number(cmd.categoryId);
    const category = await this.categoryService.findById(userId as number, categoryId);
    if (!category || category.kind !== kind) {
      return { messages: ['No encontré esa categoría. Probá registrar el gasto/ingreso de nuevo.'] };
    }
    if (kind === 'expense') {
      const { data, fieldId, plotId } = decodePendingExpensePayload(cmd.payload as string);
      data.category = category.name;
      await this.service.saveExpense(userId, data, fieldId, plotId);
      this.categoryService.bump(category.id).catch(() => {});
      const resFieldName = fieldId ? await this.lookupFieldName(userId, fieldId) : null;
      const resPlotName = plotId ? await this.lookupPlotName(userId, plotId) : null;
      return { messages: [await buildExpenseConfirmation(data, resFieldName, resPlotName)] };
    } else {
      const { data, fieldId, plotId } = decodePendingIncomePayload(cmd.payload as string);
      data.category = category.name;
      await this.service.saveIncome(userId, data, fieldId, plotId);
      this.categoryService.bump(category.id).catch(() => {});
      const resFieldName = fieldId ? await this.lookupFieldName(userId, fieldId) : null;
      const resPlotName = plotId ? await this.lookupPlotName(userId, plotId) : null;
      return { messages: [await buildIncomeConfirmation(data, resFieldName, resPlotName)] };
    }
  }

  async createCategoryInline(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const kind = (cmd.kind as string) as 'expense' | 'income';
    const { pool: dbPool } = await import('../../config/db.js');
    await dbPool.query(
      `INSERT INTO conversation_state (user_id, flow_state, flow_step, flow_data, updated_at)
       VALUES ($1, 'awaiting_new_category_name', 0, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         flow_state = 'awaiting_new_category_name',
         flow_step = 0,
         flow_data = $2::jsonb,
         updated_at = NOW()`,
      [userId, JSON.stringify({ kind, payload: cmd.payload })],
    );
    return {
      messages: [`¿Cómo se llama la nueva categoría de ${kind === 'expense' ? 'gasto' : 'ingreso'}?`],
    };
  }

  async resumeCreateCategory(userId: UserId, name: string, flowData: { kind: 'expense' | 'income'; payload: string }): Promise<HandlerResponse> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60) {
      return { messages: ['El nombre tiene que tener entre 1 y 60 caracteres. Probá de nuevo:'] };
    }

    // Similarity check before creating
    const similar = await this.categoryService.findSimilar(userId as number, flowData.kind, trimmed);
    if (similar) {
      const payload = flowData.payload;
      const kindPrefix = flowData.kind === 'expense' ? 'exp' : 'inc';
      return {
        messages: [],
        interactive: {
          type: 'buttons' as const,
          body: `Ya tenés una categoría parecida: *${similar.name}*.\n¿Usás esa o creás *${trimmed}* como nueva?`,
          buttons: [
            { id: `cat_sim_use_${kindPrefix}_${payload}_${similar.id}`, title: `Usar ${similar.name}` },
            { id: `cat_sim_new_${kindPrefix}_${payload}_${encodeURIComponent(trimmed)}`, title: `Crear ${trimmed}` },
            { id: 'cat_sim_cancel', title: 'Cancelar' },
          ],
        },
      };
    }

    const cat = await this.categoryService.match(userId as number, flowData.kind, trimmed, 'new');
    if (cat.kind !== 'matched') {
      return { messages: ['No pude crear la categoría. Probá de nuevo o cancelá.'] };
    }
    if (flowData.kind === 'expense') {
      const { data, fieldId, plotId } = decodePendingExpensePayload(flowData.payload);
      data.category = cat.category.name;
      await this.service.saveExpense(userId, data, fieldId, plotId);
      this.categoryService.bump(cat.category.id).catch(() => {});
      const resFieldName = fieldId ? await this.lookupFieldName(userId, fieldId) : null;
      const resPlotName = plotId ? await this.lookupPlotName(userId, plotId) : null;
      return { messages: [`✅ Categoría '${cat.category.name}' creada.\n${await buildExpenseConfirmation(data, resFieldName, resPlotName)}`] };
    } else {
      const { data, fieldId, plotId } = decodePendingIncomePayload(flowData.payload);
      data.category = cat.category.name;
      await this.service.saveIncome(userId, data, fieldId, plotId);
      this.categoryService.bump(cat.category.id).catch(() => {});
      const resFieldName = fieldId ? await this.lookupFieldName(userId, fieldId) : null;
      const resPlotName = plotId ? await this.lookupPlotName(userId, plotId) : null;
      return { messages: [`✅ Categoría '${cat.category.name}' creada.\n${await buildIncomeConfirmation(data, resFieldName, resPlotName)}`] };
    }
  }

  async categorySimilarUse(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const kind = cmd.kind as 'expense' | 'income';
    const categoryId = Number(cmd.categoryId);
    const category = await this.categoryService.findById(userId as number, categoryId);
    if (!category || category.kind !== kind) {
      return { messages: ['No encontré esa categoría. Probá registrar el gasto/ingreso de nuevo.'] };
    }

    if (kind === 'expense') {
      const { data, fieldId, plotId } = decodePendingExpensePayload(cmd.payload as string);
      data.category = category.name;
      await this.service.saveExpense(userId, data, fieldId, plotId);
      this.categoryService.bump(category.id).catch(() => {});
      const resFieldName = fieldId ? await this.lookupFieldName(userId, fieldId) : null;
      const resPlotName = plotId ? await this.lookupPlotName(userId, plotId) : null;
      return { messages: [await buildExpenseConfirmation(data, resFieldName, resPlotName)] };
    } else {
      const { data, fieldId, plotId } = decodePendingIncomePayload(cmd.payload as string);
      data.category = category.name;
      await this.service.saveIncome(userId, data, fieldId, plotId);
      this.categoryService.bump(category.id).catch(() => {});
      const resFieldName = fieldId ? await this.lookupFieldName(userId, fieldId) : null;
      const resPlotName = plotId ? await this.lookupPlotName(userId, plotId) : null;
      return { messages: [await buildIncomeConfirmation(data, resFieldName, resPlotName)] };
    }
  }

  async categorySimilarNew(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const kind = cmd.kind as 'expense' | 'income';
    const newName = decodeURIComponent(cmd.newName as string);
    const cat = await this.categoryService.match(userId as number, kind, newName, 'new');
    if (cat.kind !== 'matched') {
      return { messages: ['No pude crear la categoría. Probá de nuevo.'] };
    }

    if (kind === 'expense') {
      const { data, fieldId, plotId } = decodePendingExpensePayload(cmd.payload as string);
      data.category = cat.category.name;
      await this.service.saveExpense(userId, data, fieldId, plotId);
      this.categoryService.bump(cat.category.id).catch(() => {});
      const resFieldName = fieldId ? await this.lookupFieldName(userId, fieldId) : null;
      const resPlotName = plotId ? await this.lookupPlotName(userId, plotId) : null;
      return { messages: [`✅ Categoría '${cat.category.name}' creada.\n${await buildExpenseConfirmation(data, resFieldName, resPlotName)}`] };
    } else {
      const { data, fieldId, plotId } = decodePendingIncomePayload(cmd.payload as string);
      data.category = cat.category.name;
      await this.service.saveIncome(userId, data, fieldId, plotId);
      this.categoryService.bump(cat.category.id).catch(() => {});
      const resFieldName = fieldId ? await this.lookupFieldName(userId, fieldId) : null;
      const resPlotName = plotId ? await this.lookupPlotName(userId, plotId) : null;
      return { messages: [`✅ Categoría '${cat.category.name}' creada.\n${await buildIncomeConfirmation(data, resFieldName, resPlotName)}`] };
    }
  }

  async categorySimilarCancel(_cmd: ParsedCommand, _userId: UserId): Promise<HandlerResponse> {
    return { messages: ['Cancelado. Si querés volver a intentarlo, registrá el gasto/ingreso de nuevo.'] };
  }

  private async lookupFieldName(userId: UserId, fieldId: number): Promise<string | null> {
    const { pool: dbPool } = await import('../../config/db.js');
    const { rows } = await dbPool.query('SELECT name FROM fields WHERE id = $1 AND user_id = $2', [fieldId, userId]);
    return rows[0]?.name ?? null;
  }

  private async lookupPlotName(userId: UserId, plotId: number): Promise<string | null> {
    const { pool: dbPool } = await import('../../config/db.js');
    const { rows } = await dbPool.query(
      `SELECT p.name FROM plots p JOIN fields f ON f.id = p.field_id WHERE p.id = $1 AND f.user_id = $2`,
      [plotId, userId],
    );
    return rows[0]?.name ?? null;
  }
}

// ─── Helpers + renderers for the unified financial_report ───────────────────

interface RawRow {
  id: number;
  date: string | Date;
  category: string;
  description: string | null;
  product?: string | null;
  amount: string | number;
  currency: string;
  quantity?: string | number | null;
  unit?: string | null;
  field_name: string | null;
  plot_name: string | null;
}

interface RenderCtx {
  rangeLabel: string;
  scope: string;
  isAll: boolean;
  filters: { category?: string | null; descriptionSearch?: string | null; currency?: string | null; type?: string; groupBy?: string; categories?: string[] };
}

const LIST_CAP = 20;

function buildScopeLabel(f: { fieldName?: string | null; plotName?: string | null; category?: string | null; categories?: string[]; descriptionSearch?: string | null; currency?: string | null; excludeCategories?: string[]; amountMin?: number | null; amountMax?: number | null }): string {
  const parts: string[] = [];
  if (f.fieldName) parts.push(`campo ${f.fieldName}`);
  if (f.plotName) parts.push(`lote ${f.plotName}`);
  if (f.category) parts.push(f.category.toLowerCase());
  if (f.categories && f.categories.length > 0) {
    // Collapse long lists ("cereales" = 8 categories) into a single noun rather than dumping them
    parts.push(f.categories.length > 3 ? `${f.categories.length} categorías` : f.categories.join('/').toLowerCase());
  }
  if (f.descriptionSearch) parts.push(`"${f.descriptionSearch}"`);
  if (f.currency) parts.push(f.currency);
  if (f.excludeCategories && f.excludeCategories.length > 0) parts.push(`sin ${f.excludeCategories.join('/').toLowerCase()}`);
  if (f.amountMin != null && f.amountMax != null) parts.push(`$${f.amountMin.toLocaleString('es-AR')}–$${f.amountMax.toLocaleString('es-AR')}`);
  else if (f.amountMin != null) parts.push(`> $${f.amountMin.toLocaleString('es-AR')}`);
  else if (f.amountMax != null) parts.push(`< $${f.amountMax.toLocaleString('es-AR')}`);
  return parts.length > 0 ? ` — ${parts.join(', ')}` : '';
}

function sumByCurrency(rows: Array<{ amount: string | number; currency: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const c = r.currency || 'ARS';
    out[c] = (out[c] || 0) + Number(r.amount);
  }
  return out;
}

function fmtMoney(n: number, cur: string): string {
  return cur === 'USD' ? `USD ${n.toLocaleString('es-AR')}` : `$${n.toLocaleString('es-AR')}`;
}

function fmtDay(d: string | Date): string {
  const date = new Date(d);
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
}

function renderMovementLine(r: RawRow): string {
  const loc = [r.field_name, r.plot_name].filter(Boolean).join('/');
  const tail = loc ? ` · ${loc}` : '';
  const desc = r.description || r.product || r.category;
  return `• ${fmtDay(r.date)} — ${desc} — ${fmtMoney(Number(r.amount), r.currency)}${tail}`;
}

function renderDetail(rows: { expenses: RawRow[]; incomes: RawRow[] }, ctx: RenderCtx): HandlerResponse {
  const hasE = rows.expenses.length > 0;
  const hasI = rows.incomes.length > 0;
  if (!hasE && !hasI) {
    return { messages: [`No hay registros${ctx.scope} (${ctx.rangeLabel}).`], suggestionKey: 'report_shown' };
  }

  let msg = `📊 *Movimientos${ctx.scope}*\n📅 ${ctx.rangeLabel}\n`;
  let truncated = false;

  if (hasE) {
    msg += `\n*Gastos* (${rows.expenses.length})\n`;
    if (rows.expenses.length <= LIST_CAP) {
      for (const r of rows.expenses) msg += renderMovementLine(r) + '\n';
    } else {
      truncated = true;
      msg += `_(${rows.expenses.length} movimientos — descargá CSV para verlos todos)_\n`;
    }
    for (const [cur, total] of Object.entries(sumByCurrency(rows.expenses))) {
      msg += `*Total ${cur}: ${fmtMoney(total, cur)}*\n`;
    }
  }

  if (hasI) {
    msg += `\n*Ingresos* (${rows.incomes.length})\n`;
    if (rows.incomes.length <= LIST_CAP) {
      for (const r of rows.incomes) msg += renderMovementLine(r) + '\n';
    } else {
      truncated = true;
      msg += `_(${rows.incomes.length} movimientos — descargá CSV para verlos todos)_\n`;
    }
    for (const [cur, total] of Object.entries(sumByCurrency(rows.incomes))) {
      msg += `*Total ${cur}: ${fmtMoney(total, cur)}*\n`;
    }
  }

  if (truncated) {
    return {
      messages: [msg.trim()],
      interactive: {
        type: 'buttons',
        body: '¿Querés descargar el detalle?',
        buttons: [
          { id: 'cmd_exportar_csv', title: '📥 Exportar CSV' },
          { id: 'back_menu', title: '📋 Menú' },
        ],
      },
      suggestionKey: 'report_shown',
    };
  }
  return { messages: [msg.trim()], suggestionKey: 'report_shown' };
}

function renderAggregate(rows: { expenses: RawRow[]; incomes: RawRow[] }, ctx: RenderCtx): HandlerResponse {
  const hasE = rows.expenses.length > 0;
  const hasI = rows.incomes.length > 0;
  if (!hasE && !hasI) {
    return { messages: [`No hay registros${ctx.scope} (${ctx.rangeLabel}).`], suggestionKey: 'report_shown' };
  }

  // Group by category+currency for the aggregate view
  const aggregate = (xs: RawRow[]) => {
    const map = new Map<string, { category: string; currency: string; total: number }>();
    for (const r of xs) {
      const key = `${r.category}__${r.currency || 'ARS'}`;
      const prev = map.get(key) || { category: r.category, currency: r.currency || 'ARS', total: 0 };
      prev.total += Number(r.amount);
      map.set(key, prev);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  };

  let msg = `📊 *Resumen financiero${ctx.scope}*\n📅 ${ctx.rangeLabel}\n`;

  // If a category appears in multiple currencies, label the non-default ones
  // explicitly so the user doesn't see two "Insumos" lines next to each other.
  const labelLine = (r: { category: string; currency: string; total: number }, multiCurrencies: Set<string>): string => {
    const showCur = multiCurrencies.has(r.category) && r.currency !== 'ARS';
    const label = showCur ? `${r.category} (${r.currency})` : r.category;
    return `${label}: ${fmtMoney(r.total, r.currency)}\n`;
  };
  const findMultiCurrencyCats = (agg: { category: string; currency: string; total: number }[]): Set<string> => {
    const seen = new Map<string, Set<string>>();
    for (const r of agg) {
      const s = seen.get(r.category) || new Set<string>();
      s.add(r.currency);
      seen.set(r.category, s);
    }
    return new Set([...seen.entries()].filter(([, s]) => s.size > 1).map(([c]) => c));
  };

  if (hasE) {
    const agg = aggregate(rows.expenses);
    const multi = findMultiCurrencyCats(agg);
    msg += '\n*Gastos por categoría:*\n';
    for (const r of agg) msg += labelLine(r, multi);
    for (const [cur, total] of Object.entries(sumByCurrency(rows.expenses))) {
      msg += `*Total gastos ${cur}: ${fmtMoney(total, cur)}*\n`;
    }
  }

  if (hasI) {
    const agg = aggregate(rows.incomes);
    const multi = findMultiCurrencyCats(agg);
    msg += '\n*Ingresos por categoría:*\n';
    for (const r of agg) msg += labelLine(r, multi);
    for (const [cur, total] of Object.entries(sumByCurrency(rows.incomes))) {
      msg += `*Total ingresos ${cur}: ${fmtMoney(total, cur)}*\n`;
    }
  }

  return { messages: [msg.trim()], suggestionKey: 'report_shown' };
}

function renderTopCategories(rows: { expenses: RawRow[]; incomes: RawRow[] }, ctx: RenderCtx): HandlerResponse {
  // Pick which side to rank. Default to gastos for 'both' (the common framing).
  const isIncome = ctx.filters.type === 'incomes';
  const xs = isIncome ? rows.incomes : rows.expenses;
  const label = isIncome ? 'ingresos' : 'gastos';
  const titleLabel = isIncome ? 'Top categorías de ingresos' : 'Top categorías de gastos';
  if (xs.length === 0) {
    return { messages: [`No hay ${label}${ctx.scope} (${ctx.rangeLabel}).`], suggestionKey: 'report_shown' };
  }
  // Rank per currency separately (mixing currencies in a ranking is misleading).
  // Critical for ingresos: grain sales are typically USD, so an ARS-only ranking would be empty.
  const byCurrency = new Map<string, Map<string, number>>();
  for (const r of xs) {
    const cur = r.currency || 'ARS';
    const inner = byCurrency.get(cur) || new Map<string, number>();
    inner.set(r.category, (inner.get(r.category) || 0) + Number(r.amount));
    byCurrency.set(cur, inner);
  }
  // Title already says "Top categorías de gastos/ingresos", drop "de gastos/ingresos" from scope to avoid duplication
  const scopeForTitle = ctx.scope;
  let msg = `🏆 *${titleLabel}${scopeForTitle}*\n📅 ${ctx.rangeLabel}\n`;
  for (const [cur, inner] of byCurrency.entries()) {
    const ranked = [...inner.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((s, [, v]) => s + v, 0);
    msg += `\n*${cur}:*\n`;
    let i = 1;
    for (const [cat, sum] of ranked.slice(0, 10)) {
      const pct = Math.round((sum / total) * 100);
      msg += `${i}. ${cat}: ${fmtMoney(sum, cur)} (${pct}%)\n`;
      i++;
    }
    msg += `*Total ${cur}: ${fmtMoney(total, cur)}*\n`;
  }
  return { messages: [msg.trim()], suggestionKey: 'report_shown' };
}

function renderMax(rows: { expenses: RawRow[]; incomes: RawRow[] }, ctx: RenderCtx, topN: number): HandlerResponse {
  // Respect ctx.filters.type — pick gastos / ingresos based on the request.
  const isIncome = ctx.filters.type === 'incomes';
  const xs = isIncome ? rows.incomes : (rows.expenses.length > 0 ? rows.expenses : rows.incomes);
  if (xs.length === 0) {
    return { messages: [`No hay registros${ctx.scope} (${ctx.rangeLabel}).`], suggestionKey: 'report_shown' };
  }
  // Sort by amount within each currency separately (can't compare ARS to USD)
  const byCurrency = new Map<string, RawRow[]>();
  for (const r of xs) {
    const c = r.currency || 'ARS';
    byCurrency.set(c, [...(byCurrency.get(c) || []), r]);
  }
  const kindLabel = isIncome ? 'ingreso' : 'gasto';
  let msg = topN === 1
    ? `🔝 *El ${kindLabel} más alto${ctx.scope}* (${ctx.rangeLabel})\n`
    : `🔝 *Top ${topN} ${kindLabel}s más altos${ctx.scope}* (${ctx.rangeLabel})\n`;
  for (const [cur, items] of byCurrency.entries()) {
    items.sort((a, b) => Number(b.amount) - Number(a.amount));
    msg += `\n*${cur}:*\n`;
    for (const r of items.slice(0, topN)) msg += renderMovementLine(r) + '\n';
  }
  return { messages: [msg.trim()], suggestionKey: 'report_shown' };
}

function renderCompare(
  a: { expenses: RawRow[]; incomes: RawRow[] },
  b: { expenses: RawRow[]; incomes: RawRow[] },
  opts: { labelA: string; labelB: string; type: string },
): HandlerResponse {
  const collectTotals = (set: { expenses: RawRow[]; incomes: RawRow[] }) => {
    const rows = opts.type === 'incomes' ? set.incomes : set.expenses;
    return sumByCurrency(rows);
  };
  const ta = collectTotals(a);
  const tb = collectTotals(b);
  const currencies = new Set([...Object.keys(ta), ...Object.keys(tb)]);
  let msg = `📊 *Comparación: ${opts.labelA} vs ${opts.labelB}*\n`;
  for (const cur of currencies) {
    const va = ta[cur] || 0;
    const vb = tb[cur] || 0;
    msg += `\n${cur}:\n`;
    msg += `• ${opts.labelA}: ${fmtMoney(va, cur)}\n`;
    msg += `• ${opts.labelB}: ${fmtMoney(vb, cur)}\n`;
    if (vb > 0) {
      const pct = Math.round(((va - vb) / vb) * 100);
      msg += `Δ: ${pct >= 0 ? '+' : ''}${pct}%\n`;
    }
  }
  return { messages: [msg.trim()], suggestionKey: 'report_shown' };
}

// --- top_locations: rank by plot or field (mirror of top_categories but per-location) ---
function renderTopLocations(rows: { expenses: RawRow[]; incomes: RawRow[] }, ctx: RenderCtx): HandlerResponse {
  const isIncome = ctx.filters.type === 'incomes';
  const xs = isIncome ? rows.incomes : rows.expenses;
  const label = isIncome ? 'ingresos' : 'gastos';
  const dim = ctx.filters.groupBy === 'field' ? 'field_name' : 'plot_name';
  const dimLabel = ctx.filters.groupBy === 'field' ? 'campos' : 'lotes';
  if (xs.length === 0) {
    return { messages: [`No hay ${label}${ctx.scope} (${ctx.rangeLabel}).`], suggestionKey: 'report_shown' };
  }
  const byCurrency = new Map<string, Map<string, number>>();
  for (const r of xs) {
    const loc = (r as RawRow & Record<string, string | null>)[dim] || 'Sin asignar';
    const cur = r.currency || 'ARS';
    const inner = byCurrency.get(cur) || new Map<string, number>();
    inner.set(loc, (inner.get(loc) || 0) + Number(r.amount));
    byCurrency.set(cur, inner);
  }
  let msg = `🏆 *Top ${dimLabel} por ${label}${ctx.scope}*\n📅 ${ctx.rangeLabel}\n`;
  for (const [cur, inner] of byCurrency.entries()) {
    const ranked = [...inner.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((s, [, v]) => s + v, 0);
    msg += `\n*${cur}:*\n`;
    let i = 1;
    for (const [loc, sum] of ranked.slice(0, 10)) {
      const pct = total > 0 ? Math.round((sum / total) * 100) : 0;
      msg += `${i}. ${loc}: ${fmtMoney(sum, cur)} (${pct}%)\n`;
      i++;
    }
    msg += `*Total ${cur}: ${fmtMoney(total, cur)}*\n`;
  }
  return { messages: [msg.trim()], suggestionKey: 'report_shown' };
}

// --- balance: ingresos - gastos, optionally grouped by plot/field/category/month ---
function renderBalance(rows: { expenses: RawRow[]; incomes: RawRow[] }, ctx: RenderCtx): HandlerResponse {
  const { expenses, incomes } = rows;
  if (expenses.length === 0 && incomes.length === 0) {
    return { messages: [`No hay movimientos${ctx.scope} (${ctx.rangeLabel}).`], suggestionKey: 'report_shown' };
  }
  const gb = ctx.filters.groupBy;
  const bucket = (xs: RawRow[], keyOf: (r: RawRow) => string): Map<string, Record<string, number>> => {
    const m = new Map<string, Record<string, number>>();
    for (const r of xs) {
      const k = keyOf(r);
      const cur = r.currency || 'ARS';
      const inner = m.get(k) || {};
      inner[cur] = (inner[cur] || 0) + Number(r.amount);
      m.set(k, inner);
    }
    return m;
  };
  const keyOf: (r: RawRow) => string =
    gb === 'plot' ? (r) => r.plot_name || 'Sin lote' :
    gb === 'field' ? (r) => r.field_name || 'Sin campo' :
    gb === 'month' ? (r) => {
      const d = new Date(r.date);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    } :
    gb === 'category' ? (r) => r.category || 'Sin categoría' :
    () => '__all__';

  const ePer = bucket(expenses, keyOf);
  const iPer = bucket(incomes, keyOf);
  const allKeys = new Set([...ePer.keys(), ...iPer.keys()]);

  const netLine = (ing: Record<string, number>, gas: Record<string, number>): string => {
    const currencies = new Set([...Object.keys(ing), ...Object.keys(gas)]);
    const lines: string[] = [];
    for (const cur of currencies) {
      const i = ing[cur] || 0;
      const g = gas[cur] || 0;
      const net = i - g;
      const sign = net >= 0 ? '🟢' : '🔴';
      lines.push(`${sign} ${cur}: ingresos ${fmtMoney(i, cur)} − gastos ${fmtMoney(g, cur)} = *${fmtMoney(net, cur)}*`);
    }
    return lines.join('\n');
  };

  if (gb !== 'plot' && gb !== 'field' && gb !== 'category' && gb !== 'month') {
    const ing = iPer.get('__all__') || {};
    const gas = ePer.get('__all__') || {};
    return {
      messages: [`💰 *Balance${ctx.scope}*\n📅 ${ctx.rangeLabel}\n\n${netLine(ing, gas)}`],
      suggestionKey: 'report_shown',
    };
  }

  const groupLabel = gb === 'plot' ? 'lote' : gb === 'field' ? 'campo' : gb === 'month' ? 'mes' : 'categoría';
  const groupsAsNet = [...allKeys].map(k => {
    const ing = iPer.get(k) || {};
    const gas = ePer.get(k) || {};
    const currencies = new Set([...Object.keys(ing), ...Object.keys(gas)]);
    const nets: Record<string, number> = {};
    for (const cur of currencies) nets[cur] = (ing[cur] || 0) - (gas[cur] || 0);
    const sortVal = Math.abs(nets['ARS'] || 0) + Math.abs(nets['USD'] || 0) * 1000;
    return { k, ing, gas, sortVal };
  }).sort((a, b) => gb === 'month' ? a.k.localeCompare(b.k) : b.sortVal - a.sortVal);

  let msg = `💰 *Balance por ${groupLabel}${ctx.scope}*\n📅 ${ctx.rangeLabel}\n`;
  for (const g of groupsAsNet.slice(0, 12)) {
    msg += `\n*${g.k}*\n${netLine(g.ing, g.gas)}\n`;
  }
  const totIng: Record<string, number> = {};
  const totGas: Record<string, number> = {};
  for (const r of incomes) {
    const cur = r.currency || 'ARS';
    totIng[cur] = (totIng[cur] || 0) + Number(r.amount);
  }
  for (const r of expenses) {
    const cur = r.currency || 'ARS';
    totGas[cur] = (totGas[cur] || 0) + Number(r.amount);
  }
  msg += `\n━━━━━━━━━━━━━━\n*Total ${ctx.rangeLabel}:*\n${netLine(totIng, totGas)}`;
  return { messages: [msg.trim()], suggestionKey: 'report_shown' };
}

// --- volume: physical quantity (tn / litros / bolsas / kg) per category, expenses OR incomes ---
// Strategy: keep separate buckets per unit-family because we can't compare litros vs tn.
// Show movements when filtered to one category; show ranked summary when scoping by all.
function renderVolume(rows: { expenses: RawRow[]; incomes: RawRow[] }, ctx: RenderCtx): HandlerResponse {
  const isIncome = ctx.filters.type === 'incomes' || (rows.incomes.length > 0 && rows.expenses.length === 0);
  const xs = isIncome ? rows.incomes : rows.expenses;
  const verb = isIncome ? 'vendido' : 'comprado';
  if (xs.length === 0) {
    return { messages: [`No hay registros${ctx.scope} (${ctx.rangeLabel}).`], suggestionKey: 'report_shown' };
  }
  // Family = mass / volume / count. We aggregate to a base unit per family so 1 kg + 1 tn add correctly.
  type Family = 'mass' | 'volume' | 'count' | 'unknown';
  const classify = (u: unknown): { family: Family; base: number; baseLabel: string } => {
    const unit = String(u || '').toLowerCase().trim();
    // mass → kg
    if (unit === 'tn' || unit.startsWith('tonel')) return { family: 'mass', base: 1000, baseLabel: 'kg' };
    if (unit === 'qq' || unit.startsWith('quint')) return { family: 'mass', base: 100, baseLabel: 'kg' };
    if (unit === 'kg') return { family: 'mass', base: 1, baseLabel: 'kg' };
    if (unit === 'bolsas') return { family: 'mass', base: 40, baseLabel: 'kg' }; // bolsa ≈ 40 kg AR
    // volume → litros
    if (unit === 'lt' || unit === 'l' || unit === 'litros' || unit === 'litro') return { family: 'volume', base: 1, baseLabel: 'lt' };
    if (unit === 'ml' || unit === 'cc') return { family: 'volume', base: 0.001, baseLabel: 'lt' };
    // count
    if (unit === 'u' || unit === 'unidad' || unit === 'unidades') return { family: 'count', base: 1, baseLabel: 'u' };
    return { family: 'unknown', base: 1, baseLabel: unit || '?' };
  };

  // Group by category × family. Track base-unit total + per-row details + per-currency revenue/cost.
  type Bucket = { totalBase: number; baseLabel: string; rowsWithQty: number; totalRows: number; revenue: Record<string, number>; rows: { date: string | Date; qty: number; unit: string; baseValue: number }[] };
  const map = new Map<string, Map<Family, Bucket>>();
  for (const r of xs) {
    const inner = map.get(r.category) || new Map<Family, Bucket>();
    const { family, base, baseLabel } = classify(r.unit);
    const b = inner.get(family) || { totalBase: 0, baseLabel, rowsWithQty: 0, totalRows: 0, revenue: {}, rows: [] };
    b.totalRows++;
    const qty = r.quantity != null && Number.isFinite(Number(r.quantity)) ? Number(r.quantity) : null;
    if (qty != null && qty > 0) {
      const baseValue = qty * base;
      b.totalBase += baseValue;
      b.rowsWithQty++;
      b.rows.push({ date: r.date, qty, unit: String(r.unit || ''), baseValue });
    }
    const cur = r.currency || 'ARS';
    b.revenue[cur] = (b.revenue[cur] || 0) + Number(r.amount);
    inner.set(family, b);
    map.set(r.category, inner);
  }

  // Format a "mass" total as the most legible unit (tn if >= 1000kg, else kg).
  const fmtBaseTotal = (total: number, family: Family, baseLabel: string): string => {
    if (family === 'mass') {
      if (total >= 1000) return `${(total / 1000).toLocaleString('es-AR', { maximumFractionDigits: 2 })} tn`;
      return `${total.toLocaleString('es-AR', { maximumFractionDigits: 0 })} kg`;
    }
    if (family === 'volume') return `${total.toLocaleString('es-AR', { maximumFractionDigits: 2 })} lt`;
    if (family === 'count') return `${total.toLocaleString('es-AR', { maximumFractionDigits: 0 })} u`;
    return `${total.toLocaleString('es-AR', { maximumFractionDigits: 2 })} ${baseLabel}`;
  };

  // If filtering to one category AND only one family, show detail list (more useful for "total de soja").
  const singleCat = ctx.filters.category || (ctx.filters.categories && ctx.filters.categories.length === 1 ? ctx.filters.categories[0] : null);
  const firstCatBuckets = singleCat ? map.get(singleCat) : null;
  if (firstCatBuckets && firstCatBuckets.size === 1) {
    const [family, b] = [...firstCatBuckets.entries()][0];
    // Build a scope label that omits the category (already in the title)
    const scopeWithoutCat = buildScopeLabel({ ...ctx.filters, category: null, categories: undefined });
    let msg = `📦 *Total de ${singleCat} ${verb}${scopeWithoutCat}*\n📅 ${ctx.rangeLabel}\n\n`;
    if (b.rows.length === 0) {
      msg += '_(no hay registros con cantidad cargada)_';
    } else {
      const sortedRows = [...b.rows].sort((a, b2) => new Date(b2.date).getTime() - new Date(a.date).getTime());
      for (const r of sortedRows) {
        const qtyLabel = `${r.qty.toLocaleString('es-AR', { maximumFractionDigits: 2 })} ${r.unit || ''}`.trim();
        msg += `• ${fmtDay(r.date)} — ${qtyLabel}\n`;
      }
      msg += `\n*Total ${verb}: ${fmtBaseTotal(b.totalBase, family, b.baseLabel)}*`;
      if (b.rowsWithQty < b.totalRows) {
        msg += `  _(${b.rowsWithQty}/${b.totalRows} registros con cantidad)_`;
      }
      // Avg USD/tn or USD/lt if applicable. Round to integer for legibility
      // (avoid "USD 295,455" which looks like 295k due to es-AR decimal comma).
      if (b.totalBase > 0 && (b.revenue['USD'] || 0) > 0) {
        if (family === 'mass') {
          const avgPerTn = Math.round((b.revenue['USD'] || 0) / (b.totalBase / 1000));
          msg += `\n   • ~${fmtMoney(avgPerTn, 'USD')}/tn promedio`;
        } else if (family === 'volume') {
          const avgPerLt = Math.round((b.revenue['USD'] || 0) / b.totalBase);
          msg += `\n   • ~${fmtMoney(avgPerLt, 'USD')}/lt promedio`;
        }
      }
    }
    return { messages: [msg.trim()], suggestionKey: 'report_shown' };
  }

  // Multi-category or multi-family view: ranked summary per family
  const ranked = [...map.entries()].sort((a, b) => {
    const sumA = [...a[1].values()].reduce((s, x) => s + (x.totalBase || 0), 0);
    const sumB = [...b[1].values()].reduce((s, x) => s + (x.totalBase || 0), 0);
    return sumB - sumA;
  });
  let msg = `📦 *Volumen ${verb}${ctx.scope}*\n📅 ${ctx.rangeLabel}\n`;
  for (const [cat, families] of ranked) {
    msg += `\n*${cat}*`;
    for (const [family, b] of families.entries()) {
      const label = b.totalBase > 0 ? fmtBaseTotal(b.totalBase, family, b.baseLabel) : '— (sin cantidad cargada)';
      msg += `\n   • ${label}`;
      if (b.rowsWithQty < b.totalRows) msg += `  _(${b.rowsWithQty}/${b.totalRows})_`;
      if (b.totalBase > 0 && (b.revenue['USD'] || 0) > 0 && family === 'mass') {
        const avg = Math.round((b.revenue['USD'] || 0) / (b.totalBase / 1000));
        msg += `\n     ~${fmtMoney(avg, 'USD')}/tn`;
      }
    }
  }
  return { messages: [msg.trim()], suggestionKey: 'report_shown' };
}

// --- last: most recent N records, sorted by date desc ---
function renderLast(rows: { expenses: RawRow[]; incomes: RawRow[] }, ctx: RenderCtx, topN: number): HandlerResponse {
  const isIncome = ctx.filters.type === 'incomes';
  const xs = isIncome ? rows.incomes : (rows.expenses.length > 0 ? rows.expenses : rows.incomes);
  if (xs.length === 0) {
    return { messages: [`No hay registros${ctx.scope} (${ctx.rangeLabel}).`], suggestionKey: 'report_shown' };
  }
  const sorted = [...xs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, topN);
  const kindLabel = isIncome ? 'ingreso' : 'movimiento';
  const title = topN === 1 ? `📅 *Último ${kindLabel}${ctx.scope}*` : `📅 *Últimos ${topN} ${kindLabel}s${ctx.scope}*`;
  let msg = title + '\n';
  for (const r of sorted) msg += renderMovementLine(r) + '\n';
  return { messages: [msg.trim()], suggestionKey: 'report_shown' };
}
