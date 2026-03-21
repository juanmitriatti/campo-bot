import { FinancialService } from './financial.service.js';
import { generateCSV } from '../../utils/csv.js';
import { recordAlert } from '../../services/alert.service.js';
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
} from '../../types/index.js';

// --- Formatting helpers ---

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
  if (fieldName && plotName) return `${fieldName} > ${plotName}`;
  if (plotName) return plotName;
  if (fieldName) return fieldName;
  return '';
}

function buildExpenseConfirmation(data: ParsedExpense, fieldName: string | null, plotName: string | null = null): string {
  const currency = data.currency === 'USD' ? 'USD' : '';
  let msg = `\u2705 Gasto registrado\n${data.category}\n$${Number(data.amount).toLocaleString('es-AR')} ${currency}`.trim();
  const loc = buildLocationLabel(fieldName, plotName);
  if (loc) msg += `\n\ud83d\udccd ${loc}`;
  return msg;
}

function buildIncomeConfirmation(data: ParsedIncome | Record<string, unknown>, fieldName: string | null, plotName: string | null = null): string {
  const currency = (data.currency as string) === 'USD' ? 'USD' : '';
  let msg = `\ud83d\udcb0 Ingreso registrado\n${data.category}\n$${Number(data.amount).toLocaleString('es-AR')} ${currency}`.trim();
  if (data.quantity && data.unit) {
    msg += `\n${data.quantity} ${data.unit}`;
    if (data.unit_price) msg += ` a $${Number(data.unit_price).toLocaleString('es-AR')}`;
  }
  const loc = buildLocationLabel(fieldName, plotName);
  if (loc) msg += `\n\ud83d\udccd ${loc}`;
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
  msg += `Campo: ${loc || 'General'}\n`;
  msg += `\nResponder *SI* para confirmar o *NO* para cancelar.`;
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

// --- Handler ---

export class FinancialHandler {
  constructor(private service: FinancialService) {}

  private formatPlotInfo(info: PlotInfoData): string {
    const resultado = info.incomes.total - info.expenses.total;
    let msg = `\ud83d\udccd *Lote ${info.name}* (campo ${info.field_name})\n`;
    if (info.area_hectares) msg += `Superficie: ${info.area_hectares} ha\n`;
    if (info.soil_type) msg += `Suelo: ${info.soil_type}\n`;
    msg += `\n\ud83d\udcca *Este mes:*\n`;
    msg += `\ud83d\udcb8 Gastos: $${info.expenses.total.toLocaleString('es-AR')} (${info.expenses.count} reg.)\n`;
    msg += `\ud83d\udcb0 Ingresos: $${info.incomes.total.toLocaleString('es-AR')} (${info.incomes.count} reg.)\n`;
    msg += `\ud83d\udcc8 Resultado: $${resultado.toLocaleString('es-AR')}\n`;
    if (info.rainfall.count > 0) {
      msg += `\ud83c\udf27\ufe0f Lluvia: ${info.rainfall.total}mm (${info.rainfall.count} reg.)`;
    }
    return msg;
  }

  // --- Expense flow ---

  async handleExpense(
    userId: UserId,
    data: ParsedExpense,
    text: string,
    settings: UserSettings,
    user: User,
    claudeField?: string | null
  ): Promise<HandlerResponse> {
    const { fieldId, fieldName, plotId, plotName } = await this.service.resolveField(userId, text, claudeField);

    if (settings.confirm_before_save) {
      return {
        messages: [buildPendingMessage('expense', data, fieldName, plotName)],
        sideEffects: {
          setPending: { type: 'expense', data, fieldId, fieldName, plotId, plotName, timestamp: Date.now() },
        },
      };
    }

    await this.service.saveExpense(userId, data, fieldId, plotId);
    const messages = [buildExpenseConfirmation(data, fieldName, plotName)];

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
    claudeField?: string | null
  ): Promise<HandlerResponse> {
    const { fieldId, fieldName, plotId, plotName } = await this.service.resolveField(userId, text, claudeField);

    if (settings.confirm_before_save) {
      return {
        messages: [buildPendingMessage('income', data, fieldName, plotName)],
        sideEffects: {
          setPending: { type: 'income', data, fieldId, fieldName, plotId, plotName, timestamp: Date.now() },
        },
      };
    }

    await this.service.saveIncome(userId, data, fieldId, plotId);
    const messages = [buildIncomeConfirmation(data, fieldName, plotName)];
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
        return { messages: [`📊 *Resumen financiero* (${currentMonthLabel()})\n\n${lines}\nTotal: $${total.toLocaleString('es-AR')}\n\n_Pedí "resultado mes" para ver ingresos vs gastos._`], suggestionKey: 'report_shown' };
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

      // --- Date range report ---
      case 'date_range_report': {
        const desde = cmd.desde as Date;
        const hasta = cmd.hasta as Date;
        const rows = await this.service.getDateRangeReport(userId, desde, hasta);
        const desdeStr = desde.toLocaleDateString('es-AR');
        const hastaStr = hasta.toLocaleDateString('es-AR');
        if (rows.length === 0) {
          return { messages: [`No hay gastos entre ${desdeStr} y ${hastaStr}.`], suggestionKey: 'report_shown' };
        }
        const { lines, total } = formatReportRows(rows);
        return { messages: [`📊 *Resumen financiero* (${desdeStr} — ${hastaStr})\n\n${lines}\nTotal: $${total.toLocaleString('es-AR')}`], suggestionKey: 'report_shown' };
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
        const labelCity = cmd.entityKeyword === 'campo' ? 'Campo' : 'Lote';
        await this.service.getOrCreateField(userId, cmd.fieldName as string);
        await this.service.setFieldCity(userId, cmd.fieldName as string, cmd.city as string);
        return { messages: [`\ud83d\udccd ${labelCity} *${cmd.fieldName}* ubicado en *${cmd.city}*`] };
      }

      case 'add_field_city': {
        const labelAddCity = cmd.entityKeyword === 'campo' ? 'Campo' : 'Lote';
        const kw = (cmd.entityKeyword as string) || 'campo';
        const autoName = (cmd.city as string).toLowerCase().replace(/\s+/g, '-');
        await this.service.getOrCreateField(userId, autoName);
        await this.service.setFieldCity(userId, autoName, cmd.city as string);
        return { messages: [`\ud83d\udccd ${labelAddCity} *${autoName}* creado en *${cmd.city}*\n\nSi quer\u00e9s ponerle otro nombre, escrib\u00ed:\n*${kw} [nombre] est\u00e1 en ${cmd.city}*`] };
      }

      case 'add_field': {
        const kwAdd = (cmd.entityKeyword as string) || 'campo';

        // Smart lote flow: when user says "agregar lote X" without specifying field
        if (kwAdd === 'lote') {
          const fields = await this.service.getUserFields(userId);

          if (fields.length === 0) {
            // No fields → create default "general" field, then lot in it
            const field = await this.service.getOrCreateField(userId, 'general');
            await this.service.getOrCreatePlot(field.id, cmd.fieldName as string);
            return {
              messages: [`\ud83d\udccd Lote *${cmd.fieldName}* creado en campo *general*\n_(Creamos el campo "general" autom\u00e1ticamente)_`],
              suggestionKey: 'plot_created',
            };
          }

          if (fields.length === 1) {
            // Single field → auto-assign lot to it
            const field = await this.service.getFieldByName(userId, fields[0].name);
            if (field) {
              await this.service.getOrCreatePlot(field.id, cmd.fieldName as string);
              return {
                messages: [`\ud83d\udccd Lote *${cmd.fieldName}* creado en campo *${fields[0].name}*`],
                suggestionKey: 'plot_created',
              };
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
                  description: f.city ? f.city.substring(0, 72) : undefined,
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

        const labelAdd = cmd.entityKeyword === 'campo' ? 'Campo' : (cmd.entityKeyword === 'parcela' ? 'Parcela' : 'Lote');
        await this.service.getOrCreateField(userId, cmd.fieldName as string);
        if (cmd.city) {
          await this.service.setFieldCity(userId, cmd.fieldName as string, cmd.city as string);
          return {
            messages: [`\ud83d\udccd ${labelAdd} *${cmd.fieldName}* creado en *${cmd.city}*`],
            suggestionKey: 'field_created',
          };
        }
        return {
          messages: [`\ud83d\udccd ${labelAdd} *${cmd.fieldName}* creado correctamente.\n\nPara asignarle ubicaci\u00f3n escrib\u00ed:\n*${kwAdd} ${cmd.fieldName} est\u00e1 en [ciudad]*`],
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
          msg += `\n\u2022 *${f.name}*${f.city ? ` \u2014 ${f.city}` : ' \u2014 sin ubicaci\u00f3n'}`;
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
        const renamed = await this.service.renameField(userId, cmd.oldName as string, cmd.newName as string);
        if (!renamed) {
          return { messages: [`No encontr\u00e9 ${labelRen.toLowerCase()} *${cmd.oldName}*.`] };
        }
        return { messages: [`\u270f\ufe0f ${labelRen} *${cmd.oldName}* renombrado a *${cmd.newName}*`] };
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
        let msg = `\ud83d\udccd *Campo ${info.name}*\n`;
        msg += info.city ? `Ubicaci\u00f3n: ${info.city}\n` : `Ubicaci\u00f3n: sin asignar\n`;
        if (info.plotCount && info.plotCount > 0) {
          msg += `Lotes: ${info.plotCount}\n`;
        }
        msg += `\n\ud83d\udcca *Este mes:*\n`;
        msg += `\ud83d\udcb8 Gastos: $${info.expenses.total.toLocaleString('es-AR')} (${info.expenses.count} reg.)\n`;
        msg += `\ud83d\udcb0 Ingresos: $${info.incomes.total.toLocaleString('es-AR')} (${info.incomes.count} reg.)\n`;
        msg += `\ud83d\udcc8 Resultado: $${resultado.toLocaleString('es-AR')}\n`;
        if (info.rainfall.count > 0) {
          msg += `\ud83c\udf27\ufe0f Lluvia: ${info.rainfall.total}mm (${info.rainfall.count} reg.)`;
        }
        return { messages: [msg], suggestionKey: 'field_info_shown' };
      }

      // --- Plots ---
      case 'list_plots': {
        if (!cmd.fieldName) {
          // No field specified — show all plots grouped by field
          const allPlots = await this.service.findAllUserPlots(userId);
          if (allPlots.length === 0) {
            return { messages: ['No tenés lotes registrados.\n\nPara agregar uno escribí:\n📍 *agregar lote 3 en campo norte*'] };
          }
          let msg = `📍 *Tus lotes (${allPlots.length}):*\n`;
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
          return { messages: [msg] };
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

      case 'add_plot': {
        const field = await this.service.getOrCreateField(userId, cmd.fieldName as string);
        const plot = await this.service.getOrCreatePlot(field.id, cmd.plotName as string);
        return {
          messages: [`\ud83d\udccd Lote *${plot.name}* creado en campo *${field.name}*`],
          suggestionKey: 'plot_created',
        };
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
          let notFoundMsg = `No encontr\u00e9 el lote *${cmd.plotName}*.\n\nTus lotes son:\n`;
          for (const p of allPlots) {
            notFoundMsg += `\u2022 ${p.name} (campo ${p.field_name})\n`;
          }
          return { messages: [notFoundMsg.trimEnd()] };
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

      case 'set_plot_coords': {
        const plots = await this.service.findPlotByNameAcrossFields(userId, cmd.plotName as string);
        if (plots.length === 0) {
          return { messages: [`No encontr\u00e9 el lote *${cmd.plotName}*.`] };
        }
        await this.service.setPlotCoords(plots[0].id, cmd.lat as number, cmd.lng as number);
        return { messages: [`\ud83d\udccd Lote *${plots[0].name}*: coordenadas actualizadas (${cmd.lat}, ${cmd.lng})`] };
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
