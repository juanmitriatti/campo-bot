import PDFDocument from 'pdfkit';
import { CampaignStatsService } from '../domain/agronomy/campaign-stats.service.js';
import { pool } from '../config/db.js';
import type { UserId } from '../types/index.js';

export class ReportShareService {
  private campaignStatsService = new CampaignStatsService();

  async generateCampaignPDF(
    userId: UserId,
    plotName?: string | null,
    fieldName?: string | null,
    crop?: string | null,
  ): Promise<{ buffer: Buffer; filename: string; mime: string } | string> {
    const stats = await this.campaignStatsService.getCampaignStats(userId, plotName, fieldName, crop);
    if (typeof stats === 'string') return stats;

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    // Title
    doc.fontSize(18).text(`Campaña ${stats.crop} ${stats.seasonLabel}`, { align: 'center' });
    doc.fontSize(12).text(`${stats.plot}${stats.field ? ` — ${stats.field}` : ''}`, { align: 'center' });
    doc.moveDown();

    const stateMap: Record<string, string> = { active: 'Activa', harvested: 'Cosechada', closed: 'Cerrada' };
    doc.fontSize(10).text(`Estado: ${stateMap[stats.state] ?? stats.state} | Duración: ${stats.durationDays} días`);
    if (stats.areaHectares) doc.text(`Superficie: ${stats.areaHectares} ha`);
    doc.moveDown();

    // Expenses
    if (stats.expenses.count > 0) {
      doc.fontSize(14).text('Gastos', { underline: true });
      doc.fontSize(10).text(`Total ARS: $${stats.expenses.totalARS.toLocaleString('es-AR')}`);
      if (stats.expenses.totalUSD > 0) doc.text(`Total USD: US$${stats.expenses.totalUSD.toLocaleString('es-AR')}`);
      const sortedCats = Object.entries(stats.expenses.byCategory).sort(([, a], [, b]) => b - a);
      for (const [cat, amt] of sortedCats) {
        doc.text(`  • ${cat}: $${amt.toLocaleString('es-AR')}`);
      }
      doc.moveDown();
    }

    // Incomes
    if (stats.incomes.count > 0) {
      doc.fontSize(14).text('Ingresos', { underline: true });
      doc.fontSize(10).text(`Total ARS: $${stats.incomes.totalARS.toLocaleString('es-AR')}`);
      if (stats.incomes.totalUSD > 0) doc.text(`Total USD: US$${stats.incomes.totalUSD.toLocaleString('es-AR')}`);
      doc.moveDown();
    }

    // Yield
    if (stats.yield.kg) {
      doc.fontSize(14).text('Rendimiento', { underline: true });
      doc.fontSize(10).text(`${stats.yield.kg.toLocaleString('es-AR')} kg`);
      if (stats.yield.kgPerHa) doc.text(`${stats.yield.kgPerHa.toLocaleString('es-AR')} kg/ha`);
      doc.moveDown();
    }

    // Profitability
    doc.fontSize(14).text('Rentabilidad', { underline: true });
    const sign = stats.profitability.netARS >= 0 ? '+' : '';
    doc.fontSize(10).text(`Resultado neto: ${sign}$${stats.profitability.netARS.toLocaleString('es-AR')} ARS`);
    if (stats.profitability.costPerHaARS != null) doc.text(`Costo/ha: $${stats.profitability.costPerHaARS.toLocaleString('es-AR')}`);
    if (stats.profitability.incomePerHaARS != null) doc.text(`Ingreso/ha: $${stats.profitability.incomePerHaARS.toLocaleString('es-AR')}`);
    if (stats.profitability.costPerTnARS != null) doc.text(`Costo/tn: $${stats.profitability.costPerTnARS.toLocaleString('es-AR')}`);
    if (stats.profitability.incomePerTnARS != null) doc.text(`Ingreso/tn: $${stats.profitability.incomePerTnARS.toLocaleString('es-AR')}`);
    doc.moveDown();

    // Activities
    if (stats.activities.total > 0) {
      doc.fontSize(14).text('Actividades', { underline: true });
      doc.fontSize(10);
      for (const act of stats.activities.list) {
        let line = `${act.date} — ${act.label}`;
        if (act.product) line += ` (${act.product})`;
        doc.text(line);
      }
      doc.moveDown();
    }

    // Footer
    doc.fontSize(8).text(
      `Generado el ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} — Campo Bot`,
      { align: 'center' },
    );

    doc.end();

    return new Promise((resolve) => {
      doc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const filename = `campaña_${stats.crop}_${stats.seasonLabel.replace('/', '-')}_${stats.plot}.pdf`;
        resolve({ buffer, filename, mime: 'application/pdf' });
      });
    });
  }

  async generateFinancialPDF(
    userId: UserId,
    fieldName?: string | null,
    period?: string | null,
  ): Promise<{ buffer: Buffer; filename: string; mime: string } | string> {
    // Get date range based on period
    let desde: Date;
    const hasta: Date = new Date();
    let periodLabel: string;

    if (period === 'year') {
      desde = new Date(hasta.getFullYear(), 0, 1);
      periodLabel = `Año ${hasta.getFullYear()}`;
    } else if (period === 'week') {
      desde = new Date(hasta);
      desde.setDate(desde.getDate() - 7);
      periodLabel = 'Última semana';
    } else {
      // Default: month
      desde = new Date(hasta.getFullYear(), hasta.getMonth(), 1);
      periodLabel = hasta.toLocaleDateString('es-AR', {
        month: 'long',
        year: 'numeric',
        timeZone: 'America/Argentina/Buenos_Aires',
      });
    }

    // Build field filter
    let fieldFilter = '';
    const params: unknown[] = [userId, desde.toISOString().slice(0, 10), hasta.toISOString().slice(0, 10)];
    if (fieldName) {
      fieldFilter = ` AND f.name ILIKE $4`;
      params.push(`%${fieldName}%`);
    }

    // Expenses
    const { rows: expenses } = await pool.query(
      `SELECT e.description, e.amount, e.currency, e.category, e.expense_date,
              f.name AS field_name, p.name AS plot_name
         FROM expenses e
         LEFT JOIN fields f ON e.field_id = f.id
         LEFT JOIN plots p ON e.plot_id = p.id
        WHERE e.user_id = $1 AND e.deleted_at IS NULL
          AND e.expense_date >= $2 AND e.expense_date <= $3
          ${fieldFilter}
        ORDER BY e.expense_date DESC`,
      params,
    );

    // Incomes (reuse same params)
    const { rows: incomes } = await pool.query(
      `SELECT i.description, i.amount, i.currency, i.category, i.income_date,
              f.name AS field_name, p.name AS plot_name
         FROM incomes i
         LEFT JOIN fields f ON i.field_id = f.id
         LEFT JOIN plots p ON i.plot_id = p.id
        WHERE i.user_id = $1 AND i.deleted_at IS NULL
          AND i.income_date >= $2 AND i.income_date <= $3
          ${fieldFilter}
        ORDER BY i.income_date DESC`,
      params,
    );

    if (expenses.length === 0 && incomes.length === 0) {
      return `No hay gastos ni ingresos registrados${fieldName ? ` en ${fieldName}` : ''} (${periodLabel}).`;
    }

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    doc.fontSize(18).text('Reporte Financiero', { align: 'center' });
    doc.fontSize(12).text(`${periodLabel}${fieldName ? ` — ${fieldName}` : ''}`, { align: 'center' });
    doc.moveDown();

    // Totals
    let totalExpARS = 0;
    let totalIncARS = 0;
    for (const e of expenses) totalExpARS += e.currency === 'ARS' ? Number(e.amount) : 0;
    for (const i of incomes) totalIncARS += i.currency === 'ARS' ? Number(i.amount) : 0;

    const netResult = totalIncARS - totalExpARS;
    const netSign = netResult >= 0 ? '+' : '';
    doc.fontSize(12).text(
      `Gastos: $${totalExpARS.toLocaleString('es-AR')} | Ingresos: $${totalIncARS.toLocaleString('es-AR')} | Resultado: ${netSign}$${netResult.toLocaleString('es-AR')}`,
    );
    doc.moveDown();

    // Expenses detail
    if (expenses.length > 0) {
      doc.fontSize(14).text('Gastos', { underline: true });
      doc.fontSize(9);
      for (const e of expenses) {
        const date = new Date(e.expense_date).toLocaleDateString('es-AR');
        doc.text(
          `${date} | ${e.description || '-'} | $${Number(e.amount).toLocaleString('es-AR')} ${e.currency} | ${e.category || '-'}`,
        );
      }
      doc.moveDown();
    }

    // Incomes detail
    if (incomes.length > 0) {
      doc.fontSize(14).text('Ingresos', { underline: true });
      doc.fontSize(9);
      for (const i of incomes) {
        const date = new Date(i.income_date).toLocaleDateString('es-AR');
        doc.text(
          `${date} | ${i.description || '-'} | $${Number(i.amount).toLocaleString('es-AR')} ${i.currency} | ${i.category || '-'}`,
        );
      }
      doc.moveDown();
    }

    doc.fontSize(8).text(
      `Generado el ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} — Campo Bot`,
      { align: 'center' },
    );
    doc.end();

    return new Promise((resolve) => {
      doc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const safePeriod = periodLabel.replace(/\s+/g, '_');
        const filename = `reporte_financiero_${safePeriod}${fieldName ? `_${fieldName}` : ''}.pdf`;
        resolve({ buffer, filename, mime: 'application/pdf' });
      });
    });
  }
}
