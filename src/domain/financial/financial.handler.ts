import { FinancialService } from './financial.service.js';
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

import { splitPool } from '../../utils/template.js';

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

// --- Handler ---

export class FinancialHandler {
  private sharingService: FieldSharingService;
  private plotDiscovery = new PlotDiscoveryService();

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
    const fieldName = cmd.fieldName as string | null;
    const plotName = cmd.plotName as string | null;
    const period = cmd.period as string | null;
    const desde = cmd.desde as string | null;
    const hasta = cmd.hasta as string | null;
    const days = cmd.days as number | null;
    const category = cmd.category as string | null;
    const reportType = (cmd.reportType as string) || 'both';
    const includeActivities = cmd.include_activities as boolean | null;
    const activityFilter = cmd.activity_filter as string | null;

    const hasDateFilter = desde || hasta || days;
    const hasScope = fieldName || plotName;

    // Weekly report shortcut
    if (period === 'week' && !hasScope && !hasDateFilter && !category) {
      return this.handleCommand({ command: 'weekly_report' }, userId, {} as any, {} as any);
    }

    // Date range / category / days filters → date_range_report logic
    if (hasDateFilter || category || period === 'year') {
      const dateCmd: ParsedCommand = {
        command: 'date_range_report',
        ...(fieldName ? { fieldName } : {}),
        ...(plotName ? { plotName } : {}),
        ...(category ? { category } : {}),
        reportType,
      };
      if (period === 'year') {
        const nowAR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
        dateCmd.desde = `${nowAR.getFullYear()}-01-01`;
        dateCmd.hasta = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
      } else {
        if (desde) dateCmd.desde = desde;
        if (hasta) dateCmd.hasta = hasta;
        if (days) dateCmd.days = days;
      }
      const result = await this.handleCommand(dateCmd, userId, {} as any, {} as any);

      // Append activities section if requested
      if (includeActivities && result.messages.length > 0) {
        const activitiesSection = await this.buildActivitiesSection(userId, plotName, activityFilter);
        if (activitiesSection) {
          result.messages[result.messages.length - 1] += '\n\n' + activitiesSection;
        }
      }
      return result;
    }

    // Plot-scoped (no dates) → plot_report
    if (plotName && !fieldName) {
      const result = await this.handleCommand({ command: 'plot_report', plotName }, userId, {} as any, {} as any);
      if (includeActivities && result.messages.length > 0) {
        const activitiesSection = await this.buildActivitiesSection(userId, plotName, activityFilter);
        if (activitiesSection) {
          result.messages[result.messages.length - 1] += '\n\n' + activitiesSection;
        }
      }
      return result;
    }

    // Field-scoped (no dates) → field_report
    if (fieldName) {
      const result = await this.handleCommand({ command: 'field_report', fieldName }, userId, {} as any, {} as any);
      if (includeActivities && result.messages.length > 0) {
        const activitiesSection = await this.buildActivitiesSection(userId, plotName, activityFilter);
        if (activitiesSection) {
          result.messages[result.messages.length - 1] += '\n\n' + activitiesSection;
        }
      }
      return result;
    }

    // No params or period=month → monthly report (default)
    if (reportType === 'both' && !category) {
      return this.handleCommand({ command: 'monthly_report' }, userId, {} as any, {} as any);
    }

    // Type filter only (e.g., "solo gastos este mes") → monthly with type context
    return this.handleCommand({ command: 'monthly_report' }, userId, {} as any, {} as any);
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

    // No plot resolved → redirect to expense flow so user picks one
    if (!plotId) {
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

      return { messages };
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

      return { messages };
    }
  }

  // --- Command handlers ---

  async handleCommand(cmd: ParsedCommand, userId: UserId, user: User, settings: UserSettings): Promise<HandlerResponse> {
    switch (cmd.command) {
      // --- Unified financial report (agent tool_use) ---
      case 'financial_report': {
        return this.handleFinancialReport(cmd, userId);
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
        if (rows.length === 0) {
          return { messages: ['No hay gastos registrados este mes.'], suggestionKey: 'report_shown' };
        }
        const { lines, total } = formatReportRows(rows);
        let msg = `📊 *Resumen financiero* (${currentMonthLabel()})\n\n${lines}\nTotal: $${total.toLocaleString('es-AR')}`;

        // Per-plot breakdown
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

        msg += '\n\n_Pedí "resultado mes" para ver ingresos vs gastos._';
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

        const results = await this.service.getDateRangeReport(userId, desde, hasta, {
          fieldName, plotName, category, type: reportType,
        });

        const desdeStr = desde.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const hastaStr = hasta.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

        // Build scope label
        const scopeParts: string[] = [];
        if (fieldName) scopeParts.push(`campo ${fieldName}`);
        if (plotName) scopeParts.push(`lote ${plotName}`);
        if (category) scopeParts.push(category.toLowerCase());
        const scopeLabel = scopeParts.length > 0 ? ` — ${scopeParts.join(', ')}` : '';

        const hasExpenses = results.expenses.length > 0;
        const hasIncomes = results.incomes.length > 0;

        if (!hasExpenses && !hasIncomes) {
          return { messages: [`No hay registros${scopeLabel} entre ${desdeStr} y ${hastaStr}.`], suggestionKey: 'report_shown' };
        }

        let msg = `📊 *Resumen financiero${scopeLabel}*\n(${desdeStr} — ${hastaStr})\n`;

        if (hasExpenses) {
          msg += '\n*Gastos:*\n';
          for (const r of results.expenses) {
            const monto = Number(r.total);
            const curr = r.currency === 'USD' ? ' USD' : '';
            msg += `${r.category}: $${monto.toLocaleString('es-AR')}${curr}\n`;
          }
          if (results.expenses.length > 1 || !category) {
            msg += `*Total gastos: $${results.expenseTotal.toLocaleString('es-AR')}*\n`;
          }
        }

        if (hasIncomes) {
          msg += '\n*Ingresos:*\n';
          for (const r of results.incomes) {
            const monto = Number(r.total);
            const curr = r.currency === 'USD' ? ' USD' : '';
            msg += `${r.category}: $${monto.toLocaleString('es-AR')}${curr}\n`;
          }
          if (results.incomes.length > 1 || !category) {
            msg += `*Total ingresos: $${results.incomeTotal.toLocaleString('es-AR')}*\n`;
          }
        }

        if (hasExpenses && hasIncomes) {
          const resultado = results.incomeTotal - results.expenseTotal;
          msg += `\n*Resultado: $${resultado.toLocaleString('es-AR')}*`;
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
                if (welcomeMsg) messages.push(welcomeMsg);
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
        let msg = '';
        if (created.length > 0) {
          msg += `📍 Lotes creados en campo *${targetField.name}*:\n${created.map(c => `  \u2022 *${c.name}*`).join('\n')}`;
        }
        if (existing.length > 0) {
          if (created.length > 0) msg += '\n\n';
          msg += `Ya exist\u00edan: ${existing.map(n => `*${n}*`).join(', ')}`;
        }
        const batchMessages = [msg];
        if (created.length > 0 && plotsBeforeBatch.length === 0) {
          const welcomeMsg = await getSetting('ONBOARDING_FIRST_PLOT_MESSAGE');
          if (welcomeMsg) batchMessages.push(welcomeMsg);
        }
        const batchSideEffects: HandlerResponse['sideEffects'] = {};
        if (created.length > 0) {
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
            const buttons = fields.slice(0, 3).map((f: any) => ({
              id: `create_plot_${(cmd.plotName as string).replace(/\s+/g, '_')}_in_${f.name.replace(/\s+/g, '_')}`,
              title: f.name.slice(0, 20),
            }));
            return {
              messages: [`\u00bfEn qu\u00e9 campo quer\u00e9s agregar el lote *${cmd.plotName}*?`],
              interactive: { type: 'buttons' as const, body: '\u00bfEn qu\u00e9 campo?', buttons },
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
          if (welcomeMsg) addPlotMessages.push(welcomeMsg);
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
}
