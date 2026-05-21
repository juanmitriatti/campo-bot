import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import fs from "fs";
import path from "path";
import { pool } from "../config/db.js";
import { getPlotsByField, getActiveCrop } from "./expenses.js";
import { getWeekObservations, getWeekObservationsByPlot, getObservationsByDateRange, getObservationsByDateRangeAndPlot, getWeekNumber, deduplicateObservations, getNowArgentina } from "./observations.js";
import { getSetting, getSettingBool } from "./settings.service.js";
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
  spraying: 'Fumigación',
  fertilization: 'Fertilización',
  planting: 'Siembra',
  tillage: 'Labranza',
  harvest: 'Cosecha',
  irrigation: 'Riego',
  // Livestock events also surface in the unified domain_events stream and
  // need friendly Spanish labels (previously they leaked as snake_case).
  weighing: 'Pesaje',
  health_event: 'Sanidad',
  repro_event: 'Reproducción',
  livestock_birth: 'Nacimiento',
  livestock_death: 'Muerte',
  livestock_movement: 'Movimiento hacienda',
  observation: 'Observación',
  scouting: 'Monitoreo',
  tacto: 'Tacto',
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

  // 6. Financial summary + yield + comparison + rainfall + toggles
  const { dateFromIso, dateToIso } = resolveReportWindow({ hasDateRange, desde, hasta, year, weekNumber });
  const financial = await getFinancialSummary({
    fieldId,
    plotId: filterPlotId,
    dateFrom: dateFromIso,
    dateTo: dateToIso,
  });

  // Previous period of same length (for comparison)
  const { prevFromIso, prevToIso } = shiftPeriodBack(dateFromIso, dateToIso);
  const prevFinancial = await getFinancialSummary({
    fieldId,
    plotId: filterPlotId,
    dateFrom: prevFromIso,
    dateTo: prevToIso,
  });
  const prevActivities = await getActivitiesInWindow({ fieldId, plotId: filterPlotId, dateFrom: prevFromIso, dateTo: prevToIso });

  // Rainfall aggregate + nearby forecast
  const rainfall = await getRainfallForWindow({ fieldId, plotId: filterPlotId, dateFrom: dateFromIso, dateTo: dateToIso });

  // Crop scouting in window
  const scoutings = await getScoutingsForWindow({ fieldId, plotId: filterPlotId, dateFrom: dateFromIso, dateTo: dateToIso });

  // Attach activities to each plot bucket (for the per-plot section + timeline colours)
  const activityPlotMap = new Map();
  for (const act of activities) {
    if (act.plot_id) {
      if (!activityPlotMap.has(act.plot_id)) activityPlotMap.set(act.plot_id, []);
      activityPlotMap.get(act.plot_id).push(act);
    }
  }
  for (const [pid, p] of plotMap) {
    p.activities = activityPlotMap.get(pid) || [];
  }

  // Toggle matrix + branding
  const toggles = await loadReportToggles();

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
    prevFinancial,
    prevActivitiesCount: prevActivities.length,
    rainfall,
    scoutings,
    toggles,
    dateFromIso,
    dateToIso,
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

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

function shiftPeriodBack(fromIso, toIso) {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  const prevTo = new Date(from); prevTo.setUTCDate(from.getUTCDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevTo.getUTCDate() - (days - 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { prevFromIso: iso(prevFrom), prevToIso: iso(prevTo) };
}

async function getActivitiesInWindow({ fieldId, plotId, dateFrom, dateTo }) {
  const plotFilter = plotId ? `de.plot_id = $3` : `de.plot_id IN (SELECT id FROM plots WHERE field_id = $3 AND deleted_at IS NULL)`;
  const { rows } = await pool.query(
    `SELECT de.id, de.event_type, de.event_date, de.plot_id, de.crop, de.product, de.quantity, de.unit,
            p.name AS plot_name
     FROM domain_events de
     LEFT JOIN plots p ON p.id = de.plot_id
     WHERE ${plotFilter}
       AND de.event_date BETWEEN $1 AND $2
       AND de.deleted_at IS NULL
     ORDER BY de.event_date DESC, de.id DESC`,
    [dateFrom, dateTo, plotId || fieldId],
  );
  return rows;
}

async function getScoutingsForWindow({ fieldId, plotId, dateFrom, dateTo }) {
  // Qualify plot_id with the alias `s` — without it, Postgres errors with
  // "column reference 'plot_id' is ambiguous" because plot_crops also
  // has a plot_id column and we LEFT JOIN it. This was the root cause of
  // the recurring "Hubo un error generando el reporte agronómico" the
  // QA chaos persona kept hitting.
  const plotFilter = plotId
    ? `s.plot_id = $3`
    : `s.plot_id IN (SELECT id FROM plots WHERE field_id = $3 AND deleted_at IS NULL)`;
  const { rows } = await pool.query(
    `SELECT s.*, p.name AS plot_name, pc.crop AS crop
     FROM crop_scoutings s
     LEFT JOIN plots p ON p.id = s.plot_id
     LEFT JOIN plot_crops pc ON pc.id = s.plot_crop_id
     WHERE ${plotFilter}
       AND s.scouting_date BETWEEN $1 AND $2
       AND s.deleted_at IS NULL
     ORDER BY s.scouting_date DESC, s.id DESC`,
    [dateFrom, dateTo, plotId || fieldId],
  );
  return rows;
}

async function getRainfallForWindow({ fieldId, plotId, dateFrom, dateTo }) {
  const plotFilter = plotId ? `plot_id = $3` : `field_id = $3`;
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(millimeters), 0) AS total_mm, COUNT(*) AS events
     FROM rainfall
     WHERE ${plotFilter}
       AND rainfall_date BETWEEN $1 AND $2`,
    [dateFrom, dateTo, plotId || fieldId],
  );
  return { totalMm: Number(rows[0].total_mm || 0), events: Number(rows[0].events || 0) };
}

async function loadReportToggles() {
  const keys = [
    'AGRO_REPORT_SHOW_HEADER_SUMMARY', 'AGRO_REPORT_SHOW_KPIS', 'AGRO_REPORT_SHOW_COMPARISON',
    'AGRO_REPORT_SHOW_PER_PLOT', 'AGRO_REPORT_SHOW_TIMELINE', 'AGRO_REPORT_SHOW_INSIGHTS',
    'AGRO_REPORT_SHOW_WEATHER_SECTION', 'AGRO_REPORT_SHOW_FINANCIAL_SUMMARY',
    'AGRO_REPORT_SHOW_SCOUTING',
    'AGRO_REPORT_SHOW_CHARTS_YIELD', 'AGRO_REPORT_SHOW_CHARTS_CROPS',
    'AGRO_REPORT_SHOW_LOGO',
  ];
  const bools = await Promise.all(keys.map(k => getSettingBool(k)));
  const t = {};
  keys.forEach((k, i) => { t[k.replace('AGRO_REPORT_SHOW_', '').toLowerCase()] = bools[i] !== false; });
  t.logo = bools[keys.indexOf('AGRO_REPORT_SHOW_LOGO')] === true;
  t.logoPath = (await getSetting('AGRO_REPORT_LOGO_PATH')) || '';
  t.brandName = (await getSetting('AGRO_REPORT_BRAND_NAME')) || 'Agrobot';
  return t;
}

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

function computeKPIs({ plots, activities, financial, filterPlotId }) {
  let totalHa = 0;
  let activePlots = 0;
  const cropSet = new Set();
  for (const [, p] of plots) {
    if (filterPlotId && p.id !== filterPlotId) continue;
    if (p.area) totalHa += Number(p.area);
    if (p.crop) { activePlots += 1; cropSet.add(p.crop); }
  }
  return {
    hectares: totalHa || null,
    kgHarvested: financial?.yield?.kg || 0,
    avgKgPerHa: financial?.yield?.kgPerHa || null,
    activePlots,
    crops: Array.from(cropSet),
    activitiesCount: activities.length,
    expensesARS: financial?.expenses?.ARS?.total || 0,
    expensesUSD: financial?.expenses?.USD?.total || 0,
    incomesARS: financial?.incomes?.ARS?.total || 0,
    incomesUSD: financial?.incomes?.USD?.total || 0,
  };
}

function pctDelta(curr, prev) {
  // ASCII-safe sign/arrow tokens. Helvetica (default PDFKit font) doesn't ship
  // glyphs for ▲▼−●, so they used to render as garbage like "9@" / "%²" / "%Ï".
  if (prev == null || prev === 0) return curr > 0 ? { sign: '+', pct: 100, arrow: '+' } : null;
  const d = ((curr - prev) / prev) * 100;
  if (Math.abs(d) < 0.1) return { sign: '=', pct: 0, arrow: '=' };
  return { sign: d > 0 ? '+' : '-', pct: Math.abs(d).toFixed(1), arrow: d > 0 ? '+' : '-' };
}

function computeInsights({ kpis, plots, prevKpis, activities }) {
  const out = [];

  // 1. Lote outperformer — mayor rinde vs promedio del campo
  if (kpis.avgKgPerHa && kpis.avgKgPerHa > 0) {
    let best = null;
    for (const [, p] of plots) {
      const harvested = (p.activities || []).find(a => a.event_type === 'harvest');
      if (!harvested || !p.area || !harvested.quantity) continue;
      const kgHa = Number(harvested.quantity) * (harvested.unit === 'tn' ? 1000 : (harvested.unit === 'qq' ? 100 : 1)) / Number(p.area);
      if (!best || kgHa > best.kgHa) best = { name: p.name, kgHa: Math.round(kgHa) };
    }
    if (best && best.kgHa > kpis.avgKgPerHa * 1.1) {
      const pct = Math.round(((best.kgHa - kpis.avgKgPerHa) / kpis.avgKgPerHa) * 100);
      out.push(`El lote *${best.name}* rindió un ${pct}% por encima del promedio del campo.`);
    }
  }

  // 2. Comparación semana anterior
  if (prevKpis) {
    const deltaKg = pctDelta(kpis.kgHarvested, prevKpis.kgHarvested);
    if (deltaKg && deltaKg.pct !== 0 && kpis.kgHarvested > 0) {
      out.push(`Los kg cosechados ${deltaKg.sign === '−' ? 'bajaron' : 'subieron'} ${deltaKg.pct}% respecto al período anterior.`);
    }
    const deltaYield = pctDelta(kpis.avgKgPerHa, prevKpis.avgKgPerHa);
    if (deltaYield && deltaYield.pct !== 0 && kpis.avgKgPerHa) {
      out.push(`El rinde promedio ${deltaYield.sign === '−' ? 'cayó' : 'mejoró'} ${deltaYield.pct}% vs. el período anterior.`);
    }
  }

  // 3. Lotes sin actividad
  const touched = new Set(activities.map(a => a.plot_id).filter(Boolean));
  const idle = [];
  for (const [pid, p] of plots) if (p.crop && !touched.has(pid)) idle.push(p.name);
  if (idle.length > 0 && plots.size > 1) {
    out.push(`Sin actividad registrada en: ${idle.slice(0, 4).join(', ')}${idle.length > 4 ? '…' : ''}.`);
  }

  // 4. Cultivo dominante
  if (kpis.crops.length > 1) {
    const byCrop = new Map();
    for (const [, p] of plots) if (p.crop && p.area) byCrop.set(p.crop, (byCrop.get(p.crop) || 0) + Number(p.area));
    const total = [...byCrop.values()].reduce((a, b) => a + b, 0);
    for (const [crop, ha] of byCrop) {
      if (ha / total > 0.6) {
        out.push(`El cultivo dominante es *${crop}* con el ${Math.round(ha / total * 100)}% de la superficie.`);
        break;
      }
    }
  }

  // 5. Semana sin aplicaciones
  const hasApp = activities.some(a => a.event_type === 'spraying' || a.event_type === 'fertilization');
  if (!hasApp && activities.length > 0) {
    out.push('No se registraron fumigaciones ni fertilizaciones en el período.');
  }

  // 6. Concentración de cosecha en un lote
  const harvestKgByPlot = new Map();
  for (const a of activities) {
    if (a.event_type !== 'harvest' || !a.quantity) continue;
    const kg = Number(a.quantity) * (a.unit === 'tn' ? 1000 : (a.unit === 'qq' ? 100 : 1));
    harvestKgByPlot.set(a.plot_name, (harvestKgByPlot.get(a.plot_name) || 0) + kg);
  }
  const totalHarvested = [...harvestKgByPlot.values()].reduce((a, b) => a + b, 0);
  if (totalHarvested > 0 && harvestKgByPlot.size > 1) {
    for (const [plot, kg] of harvestKgByPlot) {
      if (kg / totalHarvested > 0.7) {
        out.push(`El lote *${plot}* concentra el ${Math.round(kg / totalHarvested * 100)}% de la producción cosechada.`);
        break;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Styling tokens
// ---------------------------------------------------------------------------

const COLORS = {
  primary: '#16a34a',
  secondary: '#0891b2',
  warn: '#f59e0b',
  danger: '#dc2626',
  gray: '#6b7280',
  lightGray: '#e5e7eb',
  bg: '#f9fafb',
};
const ACTIVITY_DOT = {
  harvest: '#16a34a',
  planting: '#22c55e',
  spraying: '#f59e0b',
  fertilization: '#f97316',
  tillage: '#6b7280',
  irrigation: '#0ea5e9',
};

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function pageBreakIfNeeded(doc, minSpace = 140) {
  if (doc.y > 792 - 60 - minSpace) doc.addPage();
}

function sectionTitle(doc, text) {
  pageBreakIfNeeded(doc, 60);
  doc.moveDown(0.4);
  doc.fontSize(13).font('Helvetica-Bold').fillColor(COLORS.primary).text(text);
  doc.fillColor('#000');
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).lineWidth(0.5).strokeColor(COLORS.lightGray).stroke().strokeColor('#000').lineWidth(1);
  doc.moveDown(0.5);
}

function renderHeader({ doc, field, filterPlotName, agronomist, periodLabel, toggles, kpis, rainfall }) {
  const startY = doc.y;

  // Logo (optional)
  if (toggles.logo && toggles.logoPath && fs.existsSync(toggles.logoPath)) {
    try {
      doc.image(toggles.logoPath, 50, startY, { fit: [80, 40] });
    } catch { /* ignore bad logos */ }
  }

  const brand = toggles.brandName || 'Agrobot';
  doc.fontSize(9).font('Helvetica').fillColor(COLORS.gray).text(brand, 50, startY, { align: 'right', width: 495 });
  doc.fillColor('#000');

  doc.moveDown(0.8);
  doc.fontSize(18).font('Helvetica-Bold').text('Reporte Agronómico', { align: 'center' });
  doc.moveDown(0.2);
  const scope = filterPlotName
    ? `Campo ${field.name} › Lote ${filterPlotName}`
    : `Campo ${field.name}`;
  doc.fontSize(11).font('Helvetica').fillColor(COLORS.gray)
     .text(`${scope}${field.city ? ` — ${field.city}` : ''}`, { align: 'center' });
  doc.text(`${periodLabel}  ·  Agrónomo: ${agronomist}`, { align: 'center' });
  doc.text(`Generado: ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`, { align: 'center' });
  doc.fillColor('#000');

  if (toggles.header_summary) {
    doc.moveDown(0.4);
    const chips = [];
    if (kpis.hectares) chips.push(`${fmtNumAR(kpis.hectares)} ha monitoreadas`);
    if (rainfall && rainfall.totalMm > 0) chips.push(`${fmtNumAR(rainfall.totalMm)} mm de lluvia`);
    if (kpis.crops.length > 0) chips.push(`Cultivos: ${kpis.crops.join(', ')}`);
    if (chips.length > 0) {
      doc.fontSize(10).font('Helvetica').fillColor(COLORS.secondary).text(chips.join('   ·   '), { align: 'center' });
      doc.fillColor('#000');
    }
  }
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(1).strokeColor(COLORS.primary).stroke().strokeColor('#000');
  doc.moveDown(0.6);
}

function renderKPIs(doc, kpis) {
  sectionTitle(doc, 'Métricas del período');
  const rows = [
    ['Hectáreas monitoreadas', kpis.hectares ? `${fmtNumAR(kpis.hectares)} ha` : '—'],
    ['Kg cosechados', kpis.kgHarvested ? `${fmtNumAR(kpis.kgHarvested)} kg` : '—'],
    ['Rinde promedio', kpis.avgKgPerHa ? `${fmtNumAR(kpis.avgKgPerHa)} kg/ha` : '—'],
    ['Lotes activos', String(kpis.activePlots)],
    ['Actividades registradas', String(kpis.activitiesCount)],
    ['Gastos (ARS)', kpis.expensesARS ? `$${fmtNumAR(kpis.expensesARS)}` : '—'],
    ['Ingresos (ARS)', kpis.incomesARS ? `$${fmtNumAR(kpis.incomesARS)}` : '—'],
  ];
  const colWidth = (545 - 50) / 2;
  doc.fontSize(10).font('Helvetica');
  const rowHeight = 18;
  let y = doc.y;
  for (let i = 0; i < rows.length; i += 2) {
    const [lKey, lVal] = rows[i];
    const [rKey, rVal] = rows[i + 1] || ['', ''];
    doc.rect(50, y, colWidth, rowHeight).fillAndStroke(COLORS.bg, COLORS.lightGray);
    doc.rect(50 + colWidth, y, colWidth, rowHeight).fillAndStroke(COLORS.bg, COLORS.lightGray);
    doc.fillColor(COLORS.gray).font('Helvetica').text(lKey, 56, y + 5, { width: colWidth - 12 });
    doc.fillColor('#000').font('Helvetica-Bold').text(lVal, 56, y + 5, { width: colWidth - 12, align: 'right' });
    if (rKey) {
      doc.fillColor(COLORS.gray).font('Helvetica').text(rKey, 56 + colWidth, y + 5, { width: colWidth - 12 });
      doc.fillColor('#000').font('Helvetica-Bold').text(rVal, 56 + colWidth, y + 5, { width: colWidth - 12, align: 'right' });
    }
    y += rowHeight;
  }
  doc.y = y;
  doc.fillColor('#000').font('Helvetica');
  doc.moveDown(0.5);
}

function renderComparison(doc, { kpis, prevKpis }) {
  if (!prevKpis) return;
  sectionTitle(doc, 'Comparación con período anterior');
  const cmp = [
    ['Kg cosechados', kpis.kgHarvested, prevKpis.kgHarvested, (v) => v ? fmtNumAR(v) : '—'],
    ['Rinde (kg/ha)', kpis.avgKgPerHa, prevKpis.avgKgPerHa, (v) => v ? fmtNumAR(v) : '—'],
    ['Actividades', kpis.activitiesCount, prevKpis.activitiesCount, (v) => String(v)],
    ['Gastos ARS', kpis.expensesARS, prevKpis.expensesARS, (v) => v ? `$${fmtNumAR(v)}` : '—'],
    ['Ingresos ARS', kpis.incomesARS, prevKpis.incomesARS, (v) => v ? `$${fmtNumAR(v)}` : '—'],
  ];
  const colW = [180, 120, 120, 75];
  let y = doc.y;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.gray);
  ['Métrica', 'Actual', 'Anterior', 'Variación'].forEach((h, i) => {
    const x = 50 + colW.slice(0, i).reduce((a, b) => a + b, 0);
    doc.text(h, x + 4, y + 4, { width: colW[i] - 8 });
  });
  y += 18;
  doc.fillColor('#000').font('Helvetica').fontSize(10);
  for (const [name, curr, prev, fmt] of cmp) {
    const delta = pctDelta(curr, prev);
    doc.text(name, 54, y + 4, { width: colW[0] - 8 });
    doc.text(fmt(curr), 54 + colW[0], y + 4, { width: colW[1] - 8, align: 'right' });
    doc.text(fmt(prev), 54 + colW[0] + colW[1], y + 4, { width: colW[2] - 8, align: 'right' });
    if (delta) {
      const color = delta.arrow === '+' ? COLORS.primary : (delta.arrow === '-' ? COLORS.danger : COLORS.gray);
      doc.fillColor(color).text(`${delta.sign}${delta.pct}%`, 54 + colW[0] + colW[1] + colW[2], y + 4, { width: colW[3] - 8, align: 'right' });
      doc.fillColor('#000');
    } else {
      doc.fillColor(COLORS.gray).text('-', 54 + colW[0] + colW[1] + colW[2], y + 4, { width: colW[3] - 8, align: 'right' });
      doc.fillColor('#000');
    }
    y += 16;
  }
  doc.y = y;
  doc.moveDown(0.5);
}

function renderInsights(doc, insights) {
  if (!insights || insights.length === 0) return;
  sectionTitle(doc, 'Insights del período');
  doc.fontSize(10).font('Helvetica');
  for (const line of insights) {
    // Single text call with a left-margin start. The previous version set
    // width:14 on a "continued: true" call, which made PDFKit wrap every
    // subsequent character at 14px — one letter per line, vertically.
    doc.fillColor(COLORS.secondary).text('*', 54, doc.y, { continued: true });
    doc.fillColor('#000').text('  ' + line, { width: 485, indent: 0 });
    doc.moveDown(0.25);
  }
  doc.moveDown(0.3);
}

function renderPerPlot(doc, { plots, fieldObservations, filterPlotId }) {
  if (fieldObservations.length === 0 && [...plots.values()].every(p => (!p.observations || p.observations.length === 0) && (!p.activities || p.activities.length === 0))) {
    return false;
  }

  if (fieldObservations.length > 0) {
    sectionTitle(doc, 'Observaciones generales del campo');
    for (const obs of fieldObservations) _renderObservation(doc, obs);
    doc.moveDown(0.3);
  }

  for (const [pid, p] of plots) {
    if (filterPlotId && pid !== filterPlotId) continue;
    const acts = p.activities || [];
    const obs = p.observations || [];
    if (acts.length === 0 && obs.length === 0) continue;

    pageBreakIfNeeded(doc, 120);
    const plotHeader = `${p.name}${p.crop ? ` — ${p.crop}` : ''}${p.area ? ` (${p.area} ha)` : ''}`;
    doc.fontSize(12).font('Helvetica-Bold').fillColor(COLORS.primary).text(plotHeader);
    doc.fillColor('#000');
    doc.moveDown(0.1);

    if (acts.length > 0) {
      doc.fontSize(9).font('Helvetica').fillColor(COLORS.gray).text('Actividades:');
      doc.fillColor('#000');
      for (const a of acts) _renderTimelineDot(doc, a);
      doc.moveDown(0.2);
    }
    if (obs.length > 0) {
      doc.fontSize(9).font('Helvetica').fillColor(COLORS.gray).text('Observaciones:');
      doc.fillColor('#000');
      for (const o of obs) _renderObservation(doc, o);
    }
    doc.moveDown(0.4);
  }
  return true;
}

function _renderTimelineDot(doc, act) {
  const color = ACTIVITY_DOT[act.event_type] || COLORS.gray;
  const typeLabel = ACTIVITY_LABELS[act.event_type] || act.event_type;
  const dateStr = act.event_date
    ? new Date(act.event_date).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' })
    : '';
  const detail = [act.product, act.crop].filter(Boolean).join(' ') || '';
  const qty = act.quantity ? ` — ${fmtNumAR(act.quantity)} ${act.unit || ''}` : '';

  const x0 = 54;
  const y0 = doc.y + 4;
  doc.circle(x0 + 3, y0, 3).fillAndStroke(color, color);
  // The previous version used continued:true + a possibly-empty trailing text(),
  // which left the line "open" when the activity had no product/qty (Labranza,
  // Reproducción) — making the NEXT entry render on the same visual line.
  // Build the full line as one string with the bold label inlined.
  const tail = `${detail ? ' — ' + detail : ''}${qty}`;
  doc.fillColor('#000').fontSize(9).font('Helvetica-Bold')
    .text(`${dateStr}  ${typeLabel}`, x0 + 14, doc.y, { continued: tail.length > 0 });
  if (tail.length > 0) {
    doc.font('Helvetica').text(tail);
  }
  doc.moveDown(0.35);
}

function renderTimeline(doc, activities) {
  if (!activities || activities.length === 0) return;
  sectionTitle(doc, 'Actividad del período');
  for (const a of activities) {
    pageBreakIfNeeded(doc, 20);
    const color = ACTIVITY_DOT[a.event_type] || COLORS.gray;
    const typeLabel = ACTIVITY_LABELS[a.event_type] || a.event_type;
    const dateStr = a.event_date
      ? new Date(a.event_date).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' })
      : '';
    const detail = [a.product, a.crop].filter(Boolean).join(' ');
    const qty = a.quantity ? ` · ${fmtNumAR(a.quantity)} ${a.unit || ''}` : '';
    const plot = a.plot_name ? ` · ${a.plot_name}` : '';
    const y = doc.y;
    doc.circle(58, y + 7, 4).fillAndStroke(color, color);
    // Same fix as _renderTimelineDot: avoid leaving the line "open" with
    // continued:true when there's nothing to append after the bold label.
    const tail = `${detail ? ' — ' + detail : ''}${qty}${plot}`;
    doc.fillColor('#000').fontSize(10).font('Helvetica-Bold')
      .text(`${dateStr}  ${typeLabel}`, 72, y, { continued: tail.length > 0 });
    if (tail.length > 0) {
      doc.font('Helvetica').text(tail);
    }
    doc.moveDown(0.35);
  }
  doc.moveDown(0.3);
}

function renderWeatherSection(doc, { rainfall, dateFromIso, dateToIso }) {
  sectionTitle(doc, 'Clima del período');
  doc.fontSize(10).font('Helvetica');
  if (rainfall && rainfall.totalMm > 0) {
    doc.text(`Lluvia acumulada: ${fmtNumAR(rainfall.totalMm)} mm en ${rainfall.events} registro${rainfall.events !== 1 ? 's' : ''}.`);
  } else {
    doc.fillColor(COLORS.gray).text(`Sin registros de lluvia entre ${dateFromIso} y ${dateToIso}.`).fillColor('#000');
  }
  doc.fontSize(8).fillColor(COLORS.gray).text('Temperatura histórica no disponible en este reporte.').fillColor('#000');
  doc.moveDown(0.4);
}

function renderScoutingSection(doc, scoutings) {
  if (!scoutings || scoutings.length === 0) return;
  sectionTitle(doc, 'Monitoreo del cultivo');
  doc.fontSize(10).font('Helvetica');

  const sevLabels = ['', 'ausente', 'leve', 'moderada', 'alta', 'severa'];
  const moistLabels = ['', 'seco', 'algo seco', 'normal', 'húmedo', 'saturado'];

  // Aggregate quick view
  const stages = scoutings.filter(s => s.stage_code).map(s => s.stage_code);
  const lastStage = stages.length ? stages[0] : null;
  const weeds = scoutings.filter(s => s.weed_coverage_pct != null);
  const avgWeed = weeds.length ? Math.round(weeds.reduce((a, s) => a + Number(s.weed_coverage_pct), 0) / weeds.length * 10) / 10 : null;
  let maxSev = null, maxSevSpecies = null;
  for (const s of scoutings) {
    if (s.pest_severity_1_5 != null && (maxSev == null || s.pest_severity_1_5 > maxSev)) {
      maxSev = s.pest_severity_1_5;
      maxSevSpecies = s.pest_species;
    }
  }
  const densities = scoutings.filter(s => s.plant_density_m2 != null);
  const avgDensity = densities.length ? Math.round(densities.reduce((a, s) => a + Number(s.plant_density_m2), 0) / densities.length * 10) / 10 : null;
  const lastEmerg = scoutings.find(s => s.emergence_pct != null);

  doc.font('Helvetica-Bold').text('Resumen del período', { continued: false });
  doc.font('Helvetica');
  if (lastStage) doc.text(`  Último estadio: ${lastStage}`);
  if (avgWeed != null) doc.text(`  Cobertura malezas (promedio): ${avgWeed}%`);
  if (maxSev != null) doc.text(`  Plaga más severa: ${maxSevSpecies || '—'} (${sevLabels[maxSev]} ${maxSev}/5)`);
  if (avgDensity != null) doc.text(`  Densidad promedio: ${fmtNumAR(avgDensity)} pl/m²`);
  if (lastEmerg) doc.text(`  Emergencia (último registro): ${lastEmerg.emergence_pct}%`);
  doc.moveDown(0.3);

  // Detail list (last 10)
  const recent = scoutings.slice(0, 10);
  doc.font('Helvetica-Bold').text(`Detalle (${recent.length}${scoutings.length > 10 ? ` de ${scoutings.length}` : ''})`);
  doc.font('Helvetica');
  for (const s of recent) {
    pageBreakIfNeeded(doc, 16);
    const date = s.scouting_date ? new Date(s.scouting_date).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) : '';
    const parts = [];
    if (s.stage_code) parts.push(`${s.stage_code}`);
    if (s.weed_coverage_pct != null) {
      const sp = Array.isArray(s.weed_species) && s.weed_species.length ? ` (${s.weed_species.join(', ')})` : '';
      parts.push(`${s.weed_coverage_pct}% maleza${sp}`);
    }
    if (s.pest_species) {
      const sev = s.pest_severity_1_5 ? ` ${sevLabels[s.pest_severity_1_5]}` : '';
      const aff = s.pest_affected_pct != null ? ` ${s.pest_affected_pct}% afect.` : '';
      parts.push(`${s.pest_species}${sev}${aff}`);
    }
    if (s.soil_moisture_1_5 != null) parts.push(`humedad ${moistLabels[s.soil_moisture_1_5]}`);
    if (s.emergence_pct != null) parts.push(`${s.emergence_pct}% emerg.`);
    if (s.plant_density_m2 != null) parts.push(`${s.plant_density_m2} pl/m²`);
    const detail = parts.length ? ` — ${parts.join(' · ')}` : '';
    doc.text(`  • ${date}${detail}`);
    if (s.notes) {
      doc.fontSize(9).fillColor(COLORS.gray).text(`    ${s.notes}`).fillColor('#000').fontSize(10);
    }
  }
  doc.moveDown(0.4);
}

function renderFinancialSummary(doc, financial) {
  if (!financial || !financial.hasAny) return;
  sectionTitle(doc, 'Resumen económico');
  const expARS = financial.expenses.ARS.total;
  const expUSD = financial.expenses.USD.total;
  const incARS = financial.incomes.ARS.total;
  const incUSD = financial.incomes.USD.total;
  doc.fontSize(10).font('Helvetica');
  if (expARS || incARS) {
    doc.font('Helvetica-Bold').text('Pesos (ARS)');
    doc.font('Helvetica')
       .text(`  Gastos: $${fmtNumAR(expARS)} · Ingresos: $${fmtNumAR(incARS)} · Resultado: ${financial.netARS >= 0 ? '+' : ''}$${fmtNumAR(financial.netARS)}`);
    doc.moveDown(0.2);
  }
  if (expUSD || incUSD) {
    doc.font('Helvetica-Bold').text('Dólares (USD)');
    doc.font('Helvetica')
       .text(`  Gastos: USD ${fmtNumAR(expUSD)} · Ingresos: USD ${fmtNumAR(incUSD)} · Resultado: ${financial.netUSD >= 0 ? '+' : ''}USD ${fmtNumAR(financial.netUSD)}`);
    doc.moveDown(0.2);
  }
  if (financial.yield && financial.yield.kg > 0) {
    doc.font('Helvetica-Bold').text('Rinde cosechado');
    doc.font('Helvetica').text(`  Total: ${fmtNumAR(financial.yield.kg)} kg${financial.yield.kgPerHa ? ` (${fmtNumAR(financial.yield.kgPerHa)} kg/ha promedio)` : ''}`);
  }
  doc.fontSize(8).fillColor(COLORS.gray).text('Nota: ARS y USD se muestran por separado (sin conversión).').fillColor('#000');
  doc.moveDown(0.4);
}

// ---------------------------------------------------------------------------
// SVG charts
// ---------------------------------------------------------------------------

function buildBarChartSVG({ title, data, width = 480, height = 180 }) {
  if (!data || data.length === 0) return null;
  const padL = 80, padR = 20, padT = 30, padB = 30;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;
  const max = Math.max(...data.map(d => d.value), 1);
  const barW = chartW / data.length * 0.7;
  const gap = chartW / data.length * 0.3;

  let bars = '';
  data.forEach((d, i) => {
    const h = (d.value / max) * chartH;
    const x = padL + i * (barW + gap) + gap / 2;
    const y = padT + chartH - h;
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${COLORS.primary}" rx="2"/>`;
    bars += `<text x="${x + barW / 2}" y="${padT + chartH + 12}" font-size="9" fill="${COLORS.gray}" text-anchor="middle">${escXml(d.label)}</text>`;
    bars += `<text x="${x + barW / 2}" y="${y - 3}" font-size="8" fill="#000" text-anchor="middle">${escXml(d.valueLabel || String(d.value))}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <text x="${width / 2}" y="15" font-size="11" font-weight="bold" text-anchor="middle">${escXml(title)}</text>
    <line x1="${padL}" y1="${padT + chartH}" x2="${padL + chartW}" y2="${padT + chartH}" stroke="${COLORS.lightGray}" stroke-width="1"/>
    ${bars}
  </svg>`;
}

function buildPieChartSVG({ title, data, width = 360, height = 200 }) {
  if (!data || data.length === 0) return null;
  const total = data.reduce((a, b) => a + b.value, 0);
  if (total === 0) return null;
  const cx = 100, cy = 110, r = 70;
  const palette = ['#16a34a', '#0891b2', '#f59e0b', '#dc2626', '#8b5cf6', '#64748b'];
  let acc = 0;
  let slices = '';
  let legend = '';
  data.forEach((d, i) => {
    const pct = d.value / total;
    const start = acc * 2 * Math.PI;
    const end = (acc + pct) * 2 * Math.PI;
    acc += pct;
    const x1 = cx + r * Math.sin(start);
    const y1 = cy - r * Math.cos(start);
    const x2 = cx + r * Math.sin(end);
    const y2 = cy - r * Math.cos(end);
    const largeArc = pct > 0.5 ? 1 : 0;
    const color = palette[i % palette.length];
    slices += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2} Z" fill="${color}"/>`;
    legend += `<rect x="200" y="${60 + i * 20}" width="12" height="12" fill="${color}"/>`;
    legend += `<text x="218" y="${70 + i * 20}" font-size="10" fill="#000">${escXml(d.label)} · ${Math.round(pct * 100)}%</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <text x="${width / 2}" y="15" font-size="11" font-weight="bold" text-anchor="middle">${escXml(title)}</text>
    ${slices}
    ${legend}
  </svg>`;
}

function escXml(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]); }

function renderYieldChart(doc, { activities, plots }) {
  const data = [];
  for (const [, p] of plots) {
    if (!p.area) continue;
    const harv = (p.activities || []).find(a => a.event_type === 'harvest' && a.quantity);
    if (!harv) continue;
    const kg = Number(harv.quantity) * (harv.unit === 'tn' ? 1000 : (harv.unit === 'qq' ? 100 : 1));
    const kgHa = Math.round(kg / Number(p.area));
    data.push({ label: p.name.slice(0, 8), value: kgHa, valueLabel: fmtNumAR(kgHa) });
  }
  if (data.length === 0) return;
  sectionTitle(doc, 'Rinde por lote (kg/ha)');
  const svg = buildBarChartSVG({ title: '', data });
  if (!svg) return;
  pageBreakIfNeeded(doc, 180);
  SVGtoPDF(doc, svg, 50, doc.y, { width: 495, assumePt: true });
  doc.y += 180;
  doc.moveDown(0.3);
}

function renderCropsChart(doc, { plots }) {
  const byCrop = new Map();
  for (const [, p] of plots) {
    if (!p.crop || !p.area) continue;
    byCrop.set(p.crop, (byCrop.get(p.crop) || 0) + Number(p.area));
  }
  if (byCrop.size === 0) return;
  const data = [...byCrop.entries()].map(([label, value]) => ({ label, value }));
  sectionTitle(doc, 'Distribución de cultivos (hectáreas)');
  const svg = buildPieChartSVG({ title: '', data });
  if (!svg) return;
  pageBreakIfNeeded(doc, 210);
  SVGtoPDF(doc, svg, 50, doc.y, { width: 360, assumePt: true });
  doc.y += 200;
  doc.moveDown(0.3);
}

// ---------------------------------------------------------------------------
// PDF orchestrator
// ---------------------------------------------------------------------------

function generateReportPDF({
  field, agronomist, weekNumber, year, plots, fieldObservations, pdfPath,
  filterPlotName = null, activities = [], desde = null, hasta = null,
  financial = null, prevFinancial = null, prevActivitiesCount = 0,
  rainfall = null, scoutings = [], toggles = {}, dateFromIso = null, dateToIso = null,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    const periodLabel = desde && hasta ? `${desde} a ${hasta}` : `Semana ${weekNumber} — ${year}`;
    const kpis = computeKPIs({ plots, activities, financial, filterPlotId: null });
    const prevKpis = prevFinancial ? computeKPIs({ plots, activities: new Array(prevActivitiesCount), financial: prevFinancial, filterPlotId: null }) : null;
    const insights = toggles.insights ? computeInsights({ kpis, plots, prevKpis, activities }) : [];

    renderHeader({ doc, field, filterPlotName, agronomist, periodLabel, toggles, kpis, rainfall });

    if (toggles.kpis) renderKPIs(doc, kpis);
    if (toggles.comparison && prevKpis) renderComparison(doc, { kpis, prevKpis });
    if (toggles.insights && insights.length > 0) renderInsights(doc, insights);
    if (toggles.charts_yield) renderYieldChart(doc, { activities, plots });
    if (toggles.charts_crops) renderCropsChart(doc, { plots });
    if (toggles.per_plot) renderPerPlot(doc, { plots, fieldObservations, filterPlotId: null });
    if (toggles.timeline && activities.length > 0) renderTimeline(doc, activities);
    if (toggles.weather_section) renderWeatherSection(doc, { rainfall, dateFromIso, dateToIso });
    if (toggles.scouting !== false) renderScoutingSection(doc, scoutings);
    if (toggles.financial_summary) renderFinancialSummary(doc, financial);

    // Fallback if everything came up empty
    if (fieldObservations.length === 0 && activities.length === 0 && (!financial || !financial.hasAny)) {
      doc.moveDown(1);
      doc.fontSize(11).font('Helvetica').fillColor(COLORS.gray)
         .text(desde && hasta
            ? 'No hay observaciones ni actividades registradas en el período seleccionado.'
            : 'No hay observaciones ni actividades registradas para esta semana.',
           { align: 'center' });
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
