import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { pool } from "../config/db.js";
import { getPlotsByField, getActiveCrop } from "./expenses.js";
import { getWeekObservations, getWeekObservationsByPlot, getWeekNumber } from "./observations.js";
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

/**
 * Generate a weekly agronomic PDF report for a field.
 */
export async function generateWeeklyReport(userId, fieldId, filterPlotId = null) {
  try {
  // 1. Fetch field info
  const fieldResult = await pool.query(`SELECT * FROM fields WHERE id = $1`, [fieldId]);
  if (fieldResult.rows.length === 0) throw new Error('Campo no encontrado');
  const field = fieldResult.rows[0];

  // 2. Fetch user info (agronomist name)
  const userResult = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  const user = userResult.rows[0];

  // 3. Get current ISO week
  const now = new Date();
  const { weekNumber, year } = getWeekNumber(now);

  // 4. Fetch observations for this week (lote-scoped or field-scoped)
  const observations = filterPlotId
    ? await getWeekObservationsByPlot(filterPlotId, weekNumber, year)
    : await getWeekObservations(fieldId, weekNumber, year);

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

  // 6. Generate PDF
  const reportsDir = await getReportsDir();
  fs.mkdirSync(reportsDir, { recursive: true });
  const plotSuffix = filterPlotId ? `_P${filterPlotId}` : '';
  const filename = `${userId}_${fieldId}${plotSuffix}_W${weekNumber}_${year}.pdf`;
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
  });

  // 7. Save report record
  const reportResult = await pool.query(
    `INSERT INTO agronomic_reports (user_id, field_id, week_number, year, pdf_path)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, fieldId, weekNumber, year, pdfPath]
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
function generateReportPDF({ field, agronomist, weekNumber, year, plots, fieldObservations, pdfPath, filterPlotName = null }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // --- Header ---
    doc.fontSize(20).font('Helvetica-Bold')
       .text('Reporte Agronómico Semanal', { align: 'center' });
    doc.moveDown(0.5);

    const scopeLabel = filterPlotName
      ? `Campo: ${field.name} > Lote: ${filterPlotName}`
      : `Campo: ${field.name}`;
    doc.fontSize(11).font('Helvetica')
       .text(`${scopeLabel}${field.city ? ` — ${field.city}` : ''}`, { align: 'center' });
    doc.text(`Agrónomo: ${agronomist}`, { align: 'center' });
    doc.text(`Semana ${weekNumber} — ${year}`, { align: 'center' });
    doc.text(`Generado: ${new Date().toLocaleDateString('es-AR')}`, { align: 'center' });
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

    if (!hasContent) {
      doc.fontSize(12).font('Helvetica')
         .text('No hay observaciones registradas para esta semana.', { align: 'center' });
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
