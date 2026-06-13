import type { ObservationCategory } from '../types/index.js';
import { formatPlotLocation } from '../utils/format-location.js';

// ============================================================================
// Observation Response
// ============================================================================

export interface ObservationResponseData {
  locationLabel: string;
  plotName: string | null;
  category: ObservationCategory;
  observationText: string;
}

const CATEGORY_LABELS: Record<ObservationCategory, string> = {
  sanidad: '\ud83d\udc1b Sanidad',
  malezas: '\ud83c\udf3f Malezas',
  nutricion: '\ud83e\uddea Nutrici\u00f3n',
  fenologia: '\ud83c\udf31 Fenolog\u00eda',
  clima: '\u26c8\ufe0f Clima',
  general: '\ud83d\udcdd General',
};

const CATEGORY_RECOMMENDATIONS: Record<ObservationCategory, string | null> = {
  sanidad: 'Monitorear en los pr\u00f3ximos d\u00edas para evaluar avance de la plaga.',
  malezas: 'Evaluar aplicaci\u00f3n de herbicida seg\u00fan estado de las malezas.',
  nutricion: 'Considerar an\u00e1lisis foliar para confirmar deficiencia.',
  fenologia: 'Registrar pr\u00f3ximo cambio de estado para seguimiento fenol\u00f3gico.',
  clima: 'Revisar pron\u00f3stico y evaluar medidas preventivas.',
  general: null,
};

function getObservationSuggestions(plotName: string | null, category: ObservationCategory): string[] {
  const suggestions: string[] = [];
  const suffix = plotName ? ` lote ${plotName}` : '';

  if (category === 'sanidad' || category === 'malezas') {
    suggestions.push(`fumigaci\u00f3n${suffix}`);
  }
  if (category === 'nutricion') {
    suggestions.push(`fertilizaci\u00f3n${suffix}`);
  }
  suggestions.push(`otra observaci\u00f3n${suffix}`);

  return suggestions;
}

export function formatObservationResponse(data: ObservationResponseData): string {
  const lines: string[] = [];

  lines.push('\ud83d\udd0d Observaci\u00f3n registrada');
  lines.push('');
  lines.push(`\ud83d\udccd ${data.locationLabel}`);
  lines.push(`\ud83d\udcc2 ${CATEGORY_LABELS[data.category]}`);
  lines.push(`\ud83d\udcdd ${data.observationText}`);

  const recommendation = CATEGORY_RECOMMENDATIONS[data.category];
  if (recommendation) {
    lines.push('');
    lines.push('\u26a0\ufe0f *Recomendaci\u00f3n*');
    lines.push(recommendation);
  }

  const suggestions = getObservationSuggestions(data.plotName, data.category);
  if (suggestions.length > 0) {
    lines.push('');
    lines.push('Pod\u00e9s registrar ahora:');
    for (const s of suggestions) {
      lines.push(`\u2022 ${s}`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Agro Report Response
// ============================================================================

export interface PlotObservationSummary {
  plotName: string;
  observations: string[];
}

export interface RecentActivity {
  label: string;
  detail: string;
  plotName: string;
}

export interface AgroReportResponseData {
  fieldName: string;
  filterPlotName?: string | null;
  weekNumber: number;
  observationCount: number;
  plotSummaries: PlotObservationSummary[];
  recentActivities: RecentActivity[];
  desde?: string;
  hasta?: string;
}

export function formatAgroReportResponse(data: AgroReportResponseData): string {
  const lines: string[] = [];

  const titleScope = data.filterPlotName
    ? formatPlotLocation(data.fieldName, data.filterPlotName)
    : data.fieldName;
  const periodLabel = data.desde && data.hasta
    ? `${data.desde} a ${data.hasta}`
    : `semana ${data.weekNumber}`;
  lines.push(`🌱 *Reporte agronómico — ${titleScope}* (${periodLabel})`);
  lines.push('');
  lines.push(`📊 Observaciones: ${data.observationCount}`);

  if (data.plotSummaries.length > 0) {
    lines.push('');
    lines.push('*Detalle por lote*');
    for (const plot of data.plotSummaries) {
      lines.push('');
      lines.push(`🌱 ${plot.plotName}`);
      for (const obs of plot.observations) {
        lines.push(`• ${obs}`);
      }
    }
  }

  if (data.recentActivities.length > 0) {
    lines.push('');
    lines.push(`*Actividades* (${data.recentActivities.length})`);
    for (const act of data.recentActivities) {
      const detail = act.detail ? `: ${act.detail}` : '';
      lines.push(`• ${act.label}${detail} (${act.plotName})`);
    }
  }

  lines.push('');
  lines.push('Te adjunto el PDF completo 👇');

  return lines.join('\n');
}
