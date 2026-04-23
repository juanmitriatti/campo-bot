import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { pool } from "../config/db.js";
import { getPlotsByField, getActiveCrop } from "./expenses.js";
import { getWeekObservations, getWeekObservationsByPlot, getObservationsByDateRange, getObservationsByDateRangeAndPlot, getWeekNumber, deduplicateObservations, getNowArgentina } from "./observations.js";
import { getSetting } from "./settings.service.js";
import { logError } from "./error-logger.js";

async function getReportsDir() {
  const storagePath = await getSetting('REPORTS_STORAGE_PATH');
  return path.resolve(process.cwd(), storagePath || 'data/reports');
}

const CATEGORY_LABELS = {
  malezas: 'Malezas',
  sanidad: 'Sanidad',
  nutricion: 'Nutrición',
  fenologia: 'Fenología',
  clima: 'Clima',
  general: 'General',
};

const ACTIVITY_LABELS = {
  spraying: 'Fumigacion',
  fertilization: 'Fertilizacion',
  planting: 'Siembra',
  tillage: 'Labranza',
  harvest: 'Cosecha',
  irrigation: 'Riego',
};

const fmtNumAR = (n) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(Math.round(Number(n || 0)));

/**
 * Aggregate financial + yield data for the report's scope.
 * - If plotId is given, restrict to that plot.
 * - Otherwise aggregate all plots in the field.
 * - dateFrom/dateTo bracket the expenses/incomes window. Yields come from
 *   any plot_crops that closed inside the window.
 */
async function getFinancialSummary({ fieldId, plotId, dateFrom, dateTo }) {
  const plotFilter = plotId ? `AND plot_id = $3` : `AND field_id = $3`;
  const scopeId = plotId || fieldId;

  const expR = await pool.query(
    `SELECT COALESCE(currency, 'ARS') AS currency, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
     FROM expenses
     WHERE deleted_at IS NULL
       AND expense_date BETWEEN $1 AND $2
       ${plotFilter}
     GROUP BY currency`,
    [dateFrom, dateTo, scopeId]
  );

  const incR = await pool.query(
    `SELECT COALESCE(currency, 'ARS') AS currency, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
     FROM incomes
     WHERE deleted_at IS NULL
       AND income_date BETWEEN $1 AND $2
       ${plotFilter}
     GROUP BY currency`,
    [dateFrom, dateTo, scopeId]
  );

  // Yields from harvests inside the window. Sum kg and kg/ha across plots.
  const yieldR = await pool.query(
    `SELECT pc.yield_kg, p.area_hectares, p.name AS plot_name, pc.crop
     FROM plot_crops pc
     JOIN plots p ON p.id = pc.plot_id
     WHERE pc.yield_kg IS NOT NULL
       AND pc.harvested_at BETWEEN $1 AND $2
       ${plotId ? 'AND pc.plot_id = $3' : 'AND p.field_id = $3 AND p.deleted_at IS NULL'}`,
    [dateFrom, dateTo, scopeId]
  );

  const byCurrency = (rows) => {
    const map = { ARS: { total: 0, count: 0 }, USD: { total: 0, count: 0 } };
    for (const r of rows) map[r.currency === 'USD' ? 'USD' : 'ARS'] = { total: Number(r.total), count: Number(r.count) };
    return map;
  };

  const expenses = byCurrency(expR.rows);
  const incomes = byCurrency(incR.rows);

  let yieldKg = 0;
  let areaWithYield = 0;
  const yieldDetail = [];
  for (const row of yieldR.rows) {
    const kg = Number(row.yield_kg || 0);
    const ha = Number(row.area_hectares || 0);
    yieldKg += kg;
    if (ha > 0) areaWithYield += ha;
    yieldDetail.push({ plotName: row.plot_name, crop: row.crop, kg, kgPerHa: ha > 0 ? Math.round(kg / ha) : null });
  }
  const kgPerHa = areaWithYield > 0 ? Math.round(yieldKg / areaWithYield) : null;

  return {
    expenses,
    incomes,
    yield: { kg: yieldKg, kgPerHa, detail: yieldDetail },
    netARS: incomes.ARS.total - expenses.ARS.total,
    netUSD: incomes.USD.total - expenses.USD.total,
    hasAny: expenses.ARS.count + expenses.USD.count + incomes.ARS.count + incomes.USD.count > 0 || yieldDetail.length > 0,
  };
}

/**
 * Generate an agronomic PDF report for a field.
 * Supports optional date range (desde/hasta) — defaults to current ISO week.
 */
export async function generateWeeklyReport(userId, fieldId, filterPlotId = null, { activities = [], desde, hasta } = {}) {
  try {
  // 1. Fetch field info
  const fieldResult = await pool.query(`SELECT * FROM fields WHERE id = $1`, [fieldId]);
  if (fieldResult.rows.length === 0) throw new Error('Campo no encontrado');
  const field = fieldResult.rows[0];

  // 2. Fetch user info (agronomist name)
  const userResult = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  const user = userResult.rows[0];

  // 3. Get current ISO week (Argentina timezone)
  const now = getNowArgentina();
  const { weekNumber, year } = getWeekNumber(now);
  const hasDateRange = !!(desde && hasta);

  // 4. Fetch observations (date-range or current week), deduplicated
  let rawObservations;
  if (hasDateRange) {
    rawObservations = filterPlotId
      ? await getObservationsByDateRangeAndPlot(filterPlotId, desde, hasta)
      : await getObservationsByDateRange(fieldId, desde, hasta);
  } else {
    rawObservations = filterPlotId
      ? await getWeekObservationsByPlot(filterPlotId, weekNumber, year)
      : await getWeekObservations(fieldId, weekNumber, year);
  }
  const observations = deduplicateObservations(rawObservations);

  // 5. Group by plot, separating field-level observations
  const plots = await getPlotsByField(fieldId);
  const plotMap = new Map();
  const fieldObservations = []; // field-level (plot_id IS NULL)

  for (const plot of plots) {
    // When filtering by lote, only include the target plot
    if (filterPlotId && plot.id !== filterPlotId) continue;
    const crop = await getActiveCrop(plot.id);
    plotMap.set(plot.id, {
      name: plot.name,
      area: plot.area_hectares,
      crop: crop?.crop || null,
      observations: [],
    });
  }

  for (const obs of observations) {
    if (obs.plot_id === null) {
      fieldObservations.push(obs);
    } else {
      const entry = plotMap.get(obs.plot_id);
      if (entry) {
        entry.observations.push(obs);
      } else {
        // Plot not in current scope — treat as field-level
        fieldObservations.push(obs);
      }
    }
  }

  // 6. Financial summary + yield for the same date window
  const { dateFromIso, dateToIso } = resolveReportWindow({ hasDateRange, desde, hasta, year, weekNumber });
  const financial = await getFinancialSummary({
    fieldId,
    plotId: filterPlotId,
    dateFrom: dateFromIso,
    dateTo: dateToIso,
  });

  // 7. Generate PDF
  const reportsDir = await getReportsDir();
  fs.mkdirSync(reportsDir, { recursive: true });
  const plotSuffix = filterPlotId ? `_P${filterPlotId}` : '';
  const dateSuffix = hasDateRange ? `_${desde}_${hasta}` : `_W${weekNumber}_${year}`;
  const filename = `${userId}_${fieldId}${plotSuffix}${dateSuffix}.pdf`;
  const pdfPath = path.join(reportsDir, filename);
  await generateReportPDF({
    field,
    agronomist: user?.name || 'Agrónomo',
    weekNumber,
    year,
    plots: plotMap,
    fieldObservations,
    pdfPath,
    filterPlotName: filterPlotId ? (plotMap.get(filterPlotId)?.name || null) : null,
    activities,
    desde: hasDateRange ? desde : null,
    hasta: hasDateRange ? hasta : null,
    financial,
  });

  // 7. Save report record (plot_id lets us distinguish per-plot reports from field-level ones)
  const reportResult = await pool.query(
    `INSERT INTO agronomic_reports (user_id, field_id, plot_id, week_number, year, pdf_path)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, fieldId, filterPlotId, weekNumber, year, pdfPath]
  );

  return {
    reportId: reportResult.rows[0].id,
    pdfPath,
    filename,
    weekNumber,
    year,
    observationCount: observations.length,
  };
  } catch (err) {
    logError('agro-report', 'REPORT_GENERATION_ERROR', err, {
      userId,
      context: { fieldId, action: 'generateWeeklyReport' },
    });
    throw err;
  }
}

/**
 * Generate the PDF file using PDFKit.
 */
/**
 * Resolve the ISO date window the report covers, used to fetch expenses/incomes/yields.
 * - With `desde`/`hasta`: uses them as-is.
 * - Weekly mode: Monday..Sunday of the given ISO week.
 */
function resolveReportWindow({ hasDateRange, desde, hasta, year, weekNumber }) {
  if (hasDateRange) return { dateFromIso: desde, dateToIso: hasta };
  const simple = new Date(Date.UTC(year, 0, 1 + (weekNumber - 1) * 7));
  const day = simple.getUTCDay();
  const monday = new Date(simple);
  if (day <= 4) monday.setUTCDate(simple.getUTCDate() - simple.getUTCDay() + 1);
  else monday.setUTCDate(simple.getUTCDate() + 8 - simple.getUTCDay());
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { dateFromIso: iso(monday), dateToIso: iso(sunday) };
}

function generateReportPDF({ field, agronomist, weekNumber, year, plots, fieldObservations, pdfPath, filterPlotName = null, activities = [], desde = null, hasta = null, financial = null }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // --- Header ---
    const title = desde && hasta ? 'Reporte Agronómico' : 'Reporte Agronómico Semanal';
    doc.fontSize(20).font('Helvetica-Bold')
       .text(title, { align: 'center' });
    doc.moveDown(0.5);

    const scopeLabel = filterPlotName
      ? `Campo: ${field.name} > Lote: ${filterPlotName}`
      : `Campo: ${field.name}`;
    doc.fontSize(11).font('Helvetica')
       .text(`${scopeLabel}${field.city ? ` — ${field.city}` : ''}`, { align: 'center' });
    doc.text(`Agrónomo: ${agronomist}`, { align: 'center' });
    const periodLabel = desde && hasta
      ? `${desde} a ${hasta}`
      : `Semana ${weekNumber} — ${year}`;
    doc.text(periodLabel, { align: 'center' });
    doc.text(`Generado: ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`, { align: 'center' });
    doc.moveDown(1);

    // --- Horizontal rule ---
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1);

    let hasContent = false;

    // --- Field-level observations (general, no specific plot) ---
    if (fieldObservations.length > 0) {
      hasContent = true;
      doc.fontSize(14).font('Helvetica-Bold').text('Observaciones Generales del Campo');
      doc.moveDown(0.3);

      for (const obs of fieldObservations) {
        _renderObservation(doc, obs);
      }
      doc.moveDown(0.8);
    }

    // --- Plot-level observations ---
    for (const [plotId, plotData] of plots) {
      if (plotData.observations.length === 0) continue;
      hasContent = true;

      // Plot header
      let plotHeader = plotData.name;
      if (plotData.crop) plotHeader += ` — ${plotData.crop}`;
      if (plotData.area) plotHeader += ` (${plotData.area} ha)`;

      doc.fontSize(14).font('Helvetica-Bold').text(plotHeader);
      doc.moveDown(0.3);

      for (const obs of plotData.observations) {
        _renderObservation(doc, obs);
      }
      doc.moveDown(0.8);
    }

    // --- Recent activities ---
    if (activities.length > 0) {
      hasContent = true;

      if (doc.y > 650) doc.addPage();
      doc.fontSize(14).font('Helvetica-Bold').text('Actividad Reciente');
      doc.moveDown(0.3);

      for (const act of activities) {
        _renderActivity(doc, act);
      }
      doc.moveDown(0.8);
    }

    // --- Financial + yield summary (new, appended after activities) ---
    if (financial && financial.hasAny) {
      hasContent = true;
      if (doc.y > 620) doc.addPage();
      doc.fontSize(14).font('Helvetica-Bold').text('Resumen económico y de rinde');
      doc.moveDown(0.3);

      const expARS = financial.expenses.ARS.total;
      const expUSD = financial.expenses.USD.total;
      const incARS = financial.incomes.ARS.total;
      const incUSD = financial.incomes.USD.total;

      if (expARS || incARS) {
        doc.fontSize(10).font('Helvetica-Bold').text('Pesos (ARS)', { continued: false });
        doc.font('Helvetica').fontSize(10)
           .text(`  Gastos: $${fmtNumAR(expARS)} (${financial.expenses.ARS.count} registros)`)
           .text(`  Ingresos: $${fmtNumAR(incARS)} (${financial.incomes.ARS.count} registros)`)
           .text(`  Resultado: ${financial.netARS >= 0 ? '+' : ''}$${fmtNumAR(financial.netARS)}`);
        doc.moveDown(0.3);
      }

      if (expUSD || incUSD) {
        doc.fontSize(10).font('Helvetica-Bold').text('Dólares (USD)');
        doc.font('Helvetica').fontSize(10)
           .text(`  Gastos: USD ${fmtNumAR(expUSD)} (${financial.expenses.USD.count} registros)`)
           .text(`  Ingresos: USD ${fmtNumAR(incUSD)} (${financial.incomes.USD.count} registros)`)
           .text(`  Resultado: ${financial.netUSD >= 0 ? '+' : ''}USD ${fmtNumAR(financial.netUSD)}`);
        doc.moveDown(0.3);
      }

      if (financial.yield && financial.yield.kg > 0) {
        doc.fontSize(10).font('Helvetica-Bold').text('Rinde cosechado');
        doc.font('Helvetica').fontSize(10)
           .text(`  Total: ${fmtNumAR(financial.yield.kg)} kg`
             + (financial.yield.kgPerHa ? ` (${fmtNumAR(financial.yield.kgPerHa)} kg/ha promedio)` : ''));
        for (const d of financial.yield.detail) {
          const line = `  • ${d.plotName}${d.crop ? ` — ${d.crop}` : ''}: ${fmtNumAR(d.kg)} kg`
            + (d.kgPerHa ? ` (${fmtNumAR(d.kgPerHa)} kg/ha)` : '');
          doc.text(line);
        }
        doc.moveDown(0.3);
      }

      doc.fontSize(8).fillColor('#888888')
         .text('Nota: solo se suman gastos/ingresos asignados al alcance del reporte dentro del período. Montos en ARS y USD se muestran por separado (sin conversión).')
         .fillColor('#000000');
      doc.moveDown(0.6);
    }

    if (!hasContent) {
      const emptyMsg = desde && hasta
        ? 'No hay observaciones ni actividades registradas en el período seleccionado.'
        : 'No hay observaciones ni actividades registradas para esta semana.';
      doc.fontSize(12).font('Helvetica')
         .text(emptyMsg, { align: 'center' });
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function _renderObservation(doc, obs) {
  const categoryLabel = CATEGORY_LABELS[obs.category] || obs.category;
  const dateStr = new Date(obs.created_at).toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const source = obs.source === 'audio' ? ' [audio]' : '';

  doc.fontSize(10).font('Helvetica-Bold')
     .text(`[${categoryLabel}]`, { continued: true })
     .font('Helvetica')
     .text(` ${obs.observation_text}${source}`);
  doc.fontSize(8).fillColor('#888888')
     .text(`  ${dateStr} — ${obs.user_name || 'Usuario'}`)
     .fillColor('#000000');
  doc.moveDown(0.3);

  if (doc.y > 720) {
    doc.addPage();
  }
}

function _renderActivity(doc, act) {
  const typeLabel = ACTIVITY_LABELS[act.event_type] || act.event_type;
  const detail = act.product || act.crop || '';
  const plotLabel = act.plot_name || 'General';
  const dateStr = act.event_date
    ? new Date(act.event_date).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })
    : '';

  doc.fontSize(10).font('Helvetica-Bold')
     .text(`[${typeLabel}]`, { continued: true })
     .font('Helvetica')
     .text(` ${detail}${detail ? ' — ' : ''}${plotLabel}`);
  if (dateStr) {
    doc.fontSize(8).fillColor('#888888')
       .text(`  ${dateStr}`)
       .fillColor('#000000');
  }
  doc.moveDown(0.3);

  if (doc.y > 720) {
    doc.addPage();
  }
}

/**
 * Get all agronomic reports for a given end user (self + shared fields).
 * Joins field + plot names for display in the user dashboard.
 */
export async function getReportsByUserId(userId) {
  const result = await pool.query(
    `SELECT r.id, r.field_id, r.plot_id, r.week_number, r.year, r.pdf_path, r.created_at,
            f.name AS field_name,
            p.name AS plot_name
     FROM agronomic_reports r
     LEFT JOIN fields f ON r.field_id = f.id
     LEFT JOIN plots p ON r.plot_id = p.id
     WHERE r.user_id = $1
        OR r.field_id IN (
             SELECT field_id FROM field_members WHERE user_id = $1
           )
     ORDER BY r.created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Fetch a report by id, scoped to the given user (self-owned or shared field).
 * Returns null when the report doesn't exist or the user can't access it.
 */
export async function getReportByIdForUser(reportId, userId) {
  const result = await pool.query(
    `SELECT r.id, r.user_id, r.field_id, r.plot_id, r.week_number, r.year, r.pdf_path, r.created_at,
            f.name AS field_name,
            p.name AS plot_name
     FROM agronomic_reports r
     LEFT JOIN fields f ON r.field_id = f.id
     LEFT JOIN plots p ON r.plot_id = p.id
     WHERE r.id = $1
       AND (
         r.user_id = $2
         OR r.field_id IN (SELECT field_id FROM field_members WHERE user_id = $2)
       )`,
    [reportId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Get all agronomic reports for a field.
 */
export async function getReportsByField(fieldId) {
  const result = await pool.query(
    `SELECT r.*, u.name AS user_name
     FROM agronomic_reports r
     LEFT JOIN users u ON r.user_id = u.id
     WHERE r.field_id = $1
     ORDER BY r.created_at DESC`,
    [fieldId]
  );
  return result.rows;
}

/**
 * Get all agronomic reports.
 */
export async function getAllReports() {
  const result = await pool.query(
    `SELECT r.*, u.name AS user_name, f.name AS field_name
     FROM agronomic_reports r
     LEFT JOIN users u ON r.user_id = u.id
     LEFT JOIN fields f ON r.field_id = f.id
     ORDER BY r.created_at DESC`
  );
  return result.rows;
}

/**
 * Get a single report by ID.
 */
export async function getReportById(reportId) {
  const result = await pool.query(
    `SELECT r.*, u.name AS user_name, f.name AS field_name
     FROM agronomic_reports r
     LEFT JOIN users u ON r.user_id = u.id
     LEFT JOIN fields f ON r.field_id = f.id
     WHERE r.id = $1`,
    [reportId]
  );
  return result.rows[0] || null;
}

/**
 * Clean up old PDF report files and DB records older than `days` days.
 * Returns the number of files deleted.
 */
export async function cleanupOldReports(days = 30) {
  try {
    const result = await pool.query(
      `SELECT id, pdf_path FROM agronomic_reports WHERE created_at < NOW() - $1::interval`,
      [`${days} days`]
    );

    let deleted = 0;
    for (const row of result.rows) {
      if (row.pdf_path) {
        try {
          fs.unlinkSync(row.pdf_path);
          deleted++;
        } catch {
          // File already gone — continue
        }
      }
    }

    if (result.rows.length > 0) {
      const ids = result.rows.map(r => r.id);
      await pool.query(
        `DELETE FROM agronomic_reports WHERE id = ANY($1)`,
        [ids]
      );
    }

    return deleted;
  } catch (err) {
    logError('agro-report', 'CLEANUP_ERROR', err, { context: { days } });
    return 0;
  }
}
