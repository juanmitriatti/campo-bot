import { getActivityLabel } from './activity.service.js';
import type { PlotHistoryRow } from '../../types/index.js';

export interface QueryContext {
  plotLabel: string;
  timeLabel: string;
  isUltimaVez: boolean;
  isBinaryQuestion: boolean;
  hasNoFilters: boolean;       // no time + no activity filter
  activityFilter: string | null;
  crossPlot?: boolean;         // true when searching across all plots
}

// --- Response type decision engine ---

type ResponseType = 'empty' | 'binary_yes' | 'binary_no' | 'single' | 'list' | 'summary_list' | 'recent_summary';

const RECENT_LIMIT = 5;
const SUMMARY_THRESHOLD = 7;

function decideResponseType(rows: PlotHistoryRow[], ctx: QueryContext): ResponseType {
  if (rows.length === 0) {
    return ctx.isBinaryQuestion ? 'binary_no' : 'empty';
  }

  if (ctx.isBinaryQuestion) {
    return 'binary_yes';
  }

  if (ctx.isUltimaVez) {
    return 'single';
  }

  if (ctx.hasNoFilters) {
    return 'recent_summary';
  }

  if (rows.length > SUMMARY_THRESHOLD) {
    return 'summary_list';
  }

  return 'list';
}

// --- Result prioritization ---
// Sort: activities first, then rainfall, then observations. Within each group: date DESC.

const SOURCE_PRIORITY: Record<string, number> = {
  activity: 0,
  rainfall: 1,
  observation: 2,
};

export function prioritizeRows(rows: PlotHistoryRow[]): PlotHistoryRow[] {
  return [...rows].sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source] ?? 3;
    const pb = SOURCE_PRIORITY[b.source] ?? 3;
    if (pa !== pb) return pa - pb;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
}

// --- Formatting helpers ---

function formatEventLine(row: PlotHistoryRow, showPlot = false): string {
  const { emoji, label } = row.source === 'observation'
    ? { emoji: '📝', label: `Obs: ${row.type}` }
    : row.source === 'rainfall'
    ? { emoji: '🌧️', label: 'Lluvia' }
    : getActivityLabel(row.type);
  const dateStr = new Date(row.date).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  let line = `${emoji} *${label}* — ${dateStr}`;
  if (showPlot && row.plot_name) line += ` — 📍 ${row.plot_name}`;
  if (row.detail && row.source === 'rainfall') line += ` — ${row.detail}mm`;
  else if (row.detail && row.source !== 'observation') line += ` — ${row.detail}`;
  if (row.quantity && row.unit && row.source !== 'rainfall') line += ` (${row.quantity} ${row.unit})`;
  return line;
}

function buildSummaryBlock(rows: PlotHistoryRow[]): string {
  const counts: Record<string, number> = {};
  let totalRainfall = 0;

  for (const row of rows) {
    if (row.source === 'rainfall') {
      counts['rainfall'] = (counts['rainfall'] || 0) + 1;
      totalRainfall += Number(row.quantity) || 0;
    } else if (row.source === 'observation') {
      counts['observation'] = (counts['observation'] || 0) + 1;
    } else {
      counts[row.type] = (counts[row.type] || 0) + 1;
    }
  }

  const lines: string[] = [];
  for (const [type, count] of Object.entries(counts)) {
    if (type === 'rainfall') {
      lines.push(`• ${count} lluvia${count > 1 ? 's' : ''} (${totalRainfall}mm)`);
    } else if (type === 'observation') {
      lines.push(`• ${count} observacion${count > 1 ? 'es' : ''}`);
    } else {
      const { label } = getActivityLabel(type);
      lines.push(`• ${count} ${label.toLowerCase()}${count > 1 ? 'es' : ''}`);
    }
  }
  return lines.join('\n');
}

const GUIDANCE_HINTS = `\n\n💡 Podés preguntar:\n• "última vez que se fumigó"\n• "qué pasó esta semana"\n• "¿hubo lluvias este mes?"`;

// --- Main formatter ---

export function formatHistoryResponse(rows: PlotHistoryRow[], ctx: QueryContext): string {
  const responseType = decideResponseType(rows, ctx);

  switch (responseType) {
    case 'empty': {
      const filterLabel = ctx.activityFilter
        ? getActivityLabel(ctx.activityFilter).label.toLowerCase()
        : 'actividades';
      return `No encontré ${filterLabel} en *${ctx.plotLabel}*${ctx.timeLabel ? ` ${ctx.timeLabel}` : ''}.`;
    }

    case 'binary_no': {
      const filterLabel = ctx.activityFilter
        ? getActivityLabel(ctx.activityFilter).label.toLowerCase()
        : 'registros';
      return `❌ No, no hay ${filterLabel} en *${ctx.plotLabel}*${ctx.timeLabel ? ` ${ctx.timeLabel}` : ''}.`;
    }

    case 'binary_yes': {
      const row = rows[0];
      const { emoji, label } = getActivityLabel(row.type);
      const dateStr = new Date(row.date).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      let msg = `✅ Sí`;
      if (row.source === 'rainfall') {
        msg += `\nÚltima lluvia en *${ctx.plotLabel}*: *${dateStr}*`;
        if (row.quantity) msg += ` — ${row.quantity}mm`;
      } else {
        msg += `\nÚltima ${label.toLowerCase()} en *${ctx.plotLabel}*: *${dateStr}*`;
        if (row.detail) msg += `\n${row.detail}`;
        if (row.quantity && row.unit) msg += ` (${row.quantity} ${row.unit})`;
        if (row.crop) msg += `\nCultivo: ${row.crop}`;
      }

      // Show additional recent occurrences if available
      if (rows.length > 1) {
        const extra = rows.slice(1, 3);
        msg += `\n\nAnteriores:`;
        for (const r of extra) {
          const d = new Date(r.date).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
          const { emoji: e } = getActivityLabel(r.type);
          msg += `\n${e} ${d}`;
          if (r.detail && r.source === 'rainfall') msg += ` — ${r.detail}mm`;
          else if (r.detail && r.source !== 'observation') msg += ` — ${r.detail}`;
        }
      }
      return msg;
    }

    case 'single': {
      const row = rows[0];
      const { emoji, label } = getActivityLabel(row.type);
      const dateStr = new Date(row.date).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      const locationLabel = ctx.crossPlot && row.plot_name ? row.plot_name : ctx.plotLabel;
      let msg = `${emoji} La última *${label.toLowerCase()}* en *${locationLabel}* fue el *${dateStr}*.`;
      if (row.detail && row.source !== 'rainfall') msg += `\n${row.detail}`;
      if (row.quantity && row.unit) msg += ` (${row.quantity} ${row.unit})`;
      if (row.crop) msg += `\nCultivo: ${row.crop}`;
      return msg;
    }

    case 'recent_summary': {
      // No filters → show limited recent events + guidance
      const sorted = prioritizeRows(rows);
      const limited = sorted.slice(0, RECENT_LIMIT);

      let msg = `📍 *${ctx.plotLabel}*\n\nÚltimas actividades:\n`;
      for (const row of limited) {
        msg += `\n${formatEventLine(row, ctx.crossPlot)}`;
      }
      if (rows.length > RECENT_LIMIT) {
        msg += `\n\n_...y ${rows.length - RECENT_LIMIT} más_`;
      }
      msg += GUIDANCE_HINTS;
      return msg;
    }

    case 'summary_list': {
      // Large result set → summary counts + top events
      const sorted = prioritizeRows(rows);

      let msg = `📍 *${ctx.plotLabel}*`;
      if (ctx.timeLabel) msg += ` (${ctx.timeLabel})`;
      msg += `\n\n*Resumen (${rows.length} registros):*\n${buildSummaryBlock(rows)}`;
      msg += `\n\n*Detalle:*`;

      const top = sorted.slice(0, SUMMARY_THRESHOLD);
      for (const row of top) {
        msg += `\n${formatEventLine(row, ctx.crossPlot)}`;
      }
      if (rows.length > SUMMARY_THRESHOLD) {
        msg += `\n\n_Mostrando ${SUMMARY_THRESHOLD} de ${rows.length}. Refiná con fecha o actividad._`;
      }
      return msg;
    }

    case 'list': {
      // Small filtered result set → clean list
      let msg = `📋 *Historial — ${ctx.plotLabel}*`;
      if (ctx.timeLabel) msg += ` (${ctx.timeLabel})`;
      msg += '\n';

      for (const row of rows) {
        msg += `\n${formatEventLine(row, ctx.crossPlot)}`;
      }
      return msg;
    }
  }
}
