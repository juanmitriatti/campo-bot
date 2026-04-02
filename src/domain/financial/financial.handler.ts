import { FinancialService } from './financial.service.js';
import { generateCSV } from '../../utils/csv.js';
import { recordAlert } from '../../services/alert.service.js';
import { getActivityLabel } from '../agronomy/activity.service.js';
import { getSetting } from '../../services/settings.service.js';
import { localidadLookup } from '../../services/localidad-lookup.service.js';
import { formatLocation } from '../../middleware/pending-field-city-handler.js';
import { queryPlotHistory } from '../../services/expenses.js';
import { FieldSharingService } from '../sharing/field-sharing.service.js';
import { formatPlotListGrouped } from '../../middleware/flows/field-step-helpers.js';
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

const EXPENSE_CONFIRMATIONS = ['✅ Listo, gasto registrado', '✅ Anotado', '✅ Gasto guardado', '✅ Registrado'];
const INCOME_CONFIRMATIONS = ['💰 Listo, ingreso registrado', '💰 Anotado', '💰 Ingreso guardado', '💰 Registrado'];

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
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  if (d.toDateString() === today.toDateString()) return null;
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function buildExpenseConfirmation(data: ParsedExpense, fieldName: string | null, plotName: string | null = null): string {
  const currency = data.currency === 'USD' ? 'USD' : '';
  let msg = `${pickRandom(EXPENSE_CONFIRMATIONS)}\n${data.category}\n$${Number(data.amount).toLocaleString('es-AR')} ${currency}`.trim();
  const loc = buildLocationLabel(fieldName, plotName);
  if (loc) msg += `\n\ud83d\udccd ${loc}`;
  const dateLabel = formatEventDate(data.expenseDate);
  if (dateLabel) msg += `\n\ud83d\udcc5 ${dateLabel}`;
  return msg;
}

function buildIncomeConfirmation(data: ParsedIncome | Record<string, unknown>, fieldName: string | null, plotName: string | null = null): string {
  const currency = (data.currency as string) === 'USD' ? 'USD' : '';
  let msg = `${pickRandom(INCOME_CONFIRMATIONS)}\n${data.category}\n$${Number(data.amount).toLocaleString('es-AR')} ${currency}`.trim();
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

  constructor(private service: FinancialService, sharingService?: FieldSharingService) {
    this.sharingService = sharingService ?? new FieldSharingService();
  }

  private formatPlotInfo(info: PlotInfoData): string {
    const resultado = info.incomes.total - info.expenses.total;
    let msg = `📍 *Lote ${info.name}* (campo ${info.field_name})\n`;
    if (info.area_hectares) msg += `Superficie: ${info.area_hectares} ha\n`;
    if (info.soil_type) msg += `Suelo: ${info.soil_type}\n`;

    if (info.activeCrop) {
      msg += `\n🌱 *Cultivo activo:* ${info.activeCrop.crop} (${info.activeCrop.season_year})\n`;
    }

    msg += `\n📊 *Este mes:*\n`;
    msg += `💸 Gastos: $${info.expenses.total.toLocaleString('es-AR')} (${info.expenses.count} reg.)\n`;
    msg += `💰 Ingresos: $${info.incomes.total.toLocaleString('es-AR')} (${info.incomes.count} reg.)\n`;
    msg += `📈 Resultado: $${resultado.toLocaleString('es-AR')}\n`;
    if (info.rainfall.count > 0) {
      msg += `🌧️ Lluvia: ${info.rainfall.total}mm (${info.rainfall.count} reg.)\n`;
    }

    if (info.recentActivities && info.recentActivities.length > 0) {
      msg += `\n📋 *Actividades recientes:*\n`;
      for (const a of info.recentActivities) {
        const date = new Date(a.event_date);
        const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        const { emoji, label } = getActivityLabel(a.event_type);
        const detail = a.product || a.crop || label;
        msg += `• ${emoji} ${label} — ${detail} (${dateStr})\n`;
      }
    }

    const obs = (info as any).observations;
    if (obs && obs.length > 0) {
      msg += `\n🔍 *Observaciones recientes:*\n`;
      for (const o of obs) {
        const date = new Date(o.created_at);
        const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        msg += `• ${o.observation_text} (${dateStr})\n`;
      }
    }
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
        const now = new Date();
        dateCmd.desde = `${now.getFullYear()}-01-01`;
        dateCmd.hasta = now.toISOString().slice(0, 10);
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

    await this.service.saveExpense(userId, data, fieldId, plotId);
    const messages = [buildExpenseConfirmation(data, resFieldName, resPlotName)];

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

    await this.service.saveIncome(userId, data, fieldId, plotId);
    const messages = [buildIncomeConfirmation(data, resFieldName, resPlotName)];
    const { ingresos, gastos } = await this.service.getMonthlyResult(userId);
    if (gastos > 0) {
      messages.push(formatResult(ingresos, gastos, 'Resultado del mes hasta ahora'));
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
      await this.service.saveIncome(userId, incomeData, pending.fieldId, pending.plotId);
      const messages = [buildIncomeConfirmation(incomeData, pending.fieldName, pending.plotName)];
      const { ingresos, gastos } = await this.service.getMonthlyResult(userId);
      if (gastos > 0) {
        messages.push(formatResult(ingresos, gastos, 'Resultado del mes hasta ahora'));
      }
      return { messages };
    } else {
      await this.service.saveExpense(userId, pending.data as ParsedExpense, pending.fieldId, pending.plotId);
      const messages = [buildExpenseConfirmation(pending.data as ParsedExpense, pending.fieldName, pending.plotName)];
      if (settings.budget_alerts) {
        const alert = await this.service.checkBudgetAlert(userId, pending.data.category, user.name);
        if (alert) {
          messages.push(alert);
          const now = new Date();
          const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          const alertType = alert.startsWith('\u{1F534}') ? 'budget_100' : 'budget_80';
          recordAlert(userId, alertType, alert, {
            dedupKey: `${pending.data.category}_${monthKey}`,
            payload: { category: pending.data.category },
          }).catch(() => {});
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

        const desdeStr = desde.toLocaleDateString('es-AR');
        const hastaStr = hasta.toLocaleDateString('es-AR');

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
                messages.push(`📍 Lote *${cmd.fieldName}* creado en campo *${fields[0].name}*\n📐 ¿Cuántas hectáreas tiene? (podés decirme después)`);
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

        await this.service.getOrCreateField(userId, fieldName);
        if (cmd.city) {
          const lookup = localidadLookup.lookup(cmd.city as string);
          if (lookup.status === 'exact') {
            const loc = lookup.matches[0];
            await this.service.setFieldCity(userId, fieldName, loc.nombre, loc.provincia);
            return {
              messages: [`\ud83d\udccd ${labelAdd} *${fieldName}* creado en *${formatLocation(loc.nombre, loc.provincia)}*`],
              suggestionKey: 'field_created',
            };
          }
          // Non-exact: create field, enter pending for localidad resolution
          return {
            messages: [`📍 ${labelAdd} *${fieldName}* creado.\n\n¿En qué localidad está?`],
            sideEffects: { setPendingFieldCity: { fieldName } },
            suggestionKey: 'field_created',
          };
        }
        return {
          messages: [`📍 ${labelAdd} *${fieldName}* creado.\n\n¿En qué localidad está?`],
          sideEffects: { setPendingFieldCity: { fieldName } },
          suggestionKey: 'field_created',
        };
      }

      case 'list_fields': {
        const fields = await this.service.getUserFields(userId);
        if (fields.length === 0) {
          return { messages: ['No ten\u00e9s campos registrados.\n\nPara agregar uno escrib\u00ed:\n\ud83d\udccd *agregar campo norte en Pergamino*\no\n\ud83d\udccd *tengo un campo en Lincoln*'] };
        }
        let msg = `\ud83d\udccd *Tus campos (${fields.length}):*\n`;
        for (const f of fields) {
          msg += `\n\u2022 *${f.name}*${f.city ? ` \u2014 ${formatLocation(f.city, f.province)}` : ' \u2014 sin ubicaci\u00f3n'}`;
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

      case 'field_info': {
        // If keyword is "lote", try plot lookup first (safety net)
        if (cmd.entityKeyword === 'lote') {
          const plotInfo = await this.service.getPlotInfo(userId, cmd.fieldName as string);
          if (plotInfo) {
            return { messages: [this.formatPlotInfo(plotInfo)], suggestionKey: 'field_info_shown' };
          }
          // Fall through to field lookup
        }
        const info = await this.service.getFieldInfo(userId, cmd.fieldName as string);
        if (!info) {
          const label = cmd.entityKeyword === 'lote' ? 'lote' : 'campo';
          return { messages: [`No encontr\u00e9 el ${label} *${cmd.fieldName}*.\nEscrib\u00ed *mis campos* para ver los que ten\u00e9s.`] };
        }
        const resultado = info.incomes.total - info.expenses.total;
        let msg = `📍 *Campo ${info.name}*\n`;
        msg += info.city ? `Ubicación: ${formatLocation(info.city, info.province)}\n` : `Ubicación: sin asignar\n`;
        if (info.plotCount && info.plotCount > 0) {
          msg += `Lotes: ${info.plotCount}\n`;
        }
        msg += `\n📊 *Este mes:*\n`;
        msg += `💸 Gastos: $${info.expenses.total.toLocaleString('es-AR')} (${info.expenses.count} reg.)\n`;
        msg += `💰 Ingresos: $${info.incomes.total.toLocaleString('es-AR')} (${info.incomes.count} reg.)\n`;
        msg += `📈 Resultado: $${resultado.toLocaleString('es-AR')}\n`;
        if (info.rainfall.count > 0) {
          msg += `🌧️ Lluvia: ${info.rainfall.total}mm (${info.rainfall.count} reg.)\n`;
        }
        if (info.observations && info.observations.length > 0) {
          msg += `\n🔍 *Observaciones recientes:*\n`;
          for (const o of info.observations) {
            const date = new Date(o.created_at);
            const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
            const plotLabel = o.plot_name ? ` [${o.plot_name}]` : '';
            msg += `• ${o.observation_text}${plotLabel} (${dateStr})\n`;
          }
        }
        return { messages: [msg.trimEnd()], suggestionKey: 'field_info_shown' };
      }

      // --- Plots ---
      case 'list_plots': {
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
          const grouped = new Map<string, string[]>();
          for (const p of allPlots) {
            const list = grouped.get(p.field_name) || [];
            list.push(p.name);
            grouped.set(p.field_name, list);
          }
          for (const [fieldName, plots] of grouped) {
            msg += `\n• *${fieldName}*`;
            for (const name of plots) {
              msg += `\n  └ ${name}`;
            }
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
        for (const p of plots) {
          msg += `\n\u2022 *${p.name}*`;
          if (p.area_hectares) msg += ` \u2014 ${p.area_hectares} ha`;
          if (p.soil_type) msg += ` (${p.soil_type})`;
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
        if (fields.length === 1) {
          const f = await this.service.getFieldByName(userId, fields[0].name);
          if (!f) return { messages: ['Error al obtener el campo.'] };
          targetField = f;
        } else {
          return {
            messages: [`Ten\u00e9s ${fields.length} campos. Indic\u00e1 en cu\u00e1l crear los lotes.\n\nEscrib\u00ed: *agregar lote [nombre] en [campo]*`],
          };
        }
        const plotsBeforeBatch = await this.service.findAllUserPlots(userId);
        const created: string[] = [];
        const existing: string[] = [];
        const existingPlots = await this.service.getPlotsByField(targetField.id);
        for (const name of plotNames) {
          const already = existingPlots.some(p => p.name.toLowerCase() === name.toLowerCase());
          if (already) {
            existing.push(name);
          } else {
            await this.service.getOrCreatePlot(targetField.id, name);
            created.push(name);
          }
        }
        let msg = '';
        if (created.length > 0) {
          msg += `📍 Lotes creados en campo *${targetField.name}*:\n${created.map(n => `  \u2022 *${n}*`).join('\n')}`;
          msg += `\n\n📐 ¿Cuántas hectáreas tiene cada lote? Podés decirme: "${created[0]} tiene 120 ha"`;
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
        return { messages: batchMessages, suggestionKey: 'plot_created' };
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
          addPlotMessages.push(`📍 Lote *${plot.name}* creado en campo *${field.name}*\n📐 ¿Cuántas hectáreas tiene? (podés decirme después)`);
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
        const plotsForDel = await this.service.findPlotByNameAcrossFields(userId, cmd.plotName as string);
        const plotForDel = plotsForDel.find(p => p.field_id === field.id);
        if (!plotForDel) {
          return { messages: [`No encontr\u00e9 el lote *${cmd.plotName}* en campo *${cmd.fieldName}*.`] };
        }

        const confirmPlotMsg = `\u00bfSeguro que quer\u00e9s eliminar el lote *${cmd.plotName}* del campo *${cmd.fieldName}*?\nLos registros asociados quedar\u00e1n sin lote.\n\n_Pod\u00e9s restaurarlo despu\u00e9s con "restaurar lote ${cmd.plotName}"_`;
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

      case 'restore_field': {
        const kwRestore = (cmd.entityKeyword as string) || 'campo';
        const labelRestore = kwRestore === 'campo' ? 'Campo' : 'Lote';
        const restored = await this.service.restoreField(userId, cmd.fieldName as string);
        if (!restored) {
          return { messages: [`No encontr\u00e9 ${labelRestore.toLowerCase()} eliminado con nombre *${cmd.fieldName}*.`] };
        }
        return {
          messages: [`\u2705 ${labelRestore} *${restored.name}* restaurado correctamente.\nSus lotes asociados tambi\u00e9n fueron restaurados.`],
          suggestionKey: 'field_created',
        };
      }

      default:
        return { messages: [] };
    }
  }
}
