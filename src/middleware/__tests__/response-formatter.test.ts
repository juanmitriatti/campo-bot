import { describe, it, expect } from 'vitest';
import { formatObservationResponse, formatAgroReportResponse } from '../response-formatter.js';
import type { ObservationCategory } from '../../types/index.js';

describe('formatObservationResponse', () => {
  it('sanidad category shows bug emoji, recommendation, and fumigaci\u00f3n suggestion', () => {
    const result = formatObservationResponse({
      locationLabel: 'general > Lote 3',
      plotName: '3',
      category: 'sanidad',
      observationText: 'Presencia de pulg\u00f3n',
    });

    expect(result).toContain('\ud83d\udc1b Sanidad');
    expect(result).toContain('\u26a0\ufe0f *Recomendaci\u00f3n*');
    expect(result).toContain('Monitorear en los pr\u00f3ximos d\u00edas');
    expect(result).toContain('fumigaci\u00f3n lote 3');
    expect(result).toContain('otra observaci\u00f3n lote 3');
  });

  it('malezas category shows herb emoji, recommendation, and fumigaci\u00f3n suggestion', () => {
    const result = formatObservationResponse({
      locationLabel: 'general > Lote 2',
      plotName: '2',
      category: 'malezas',
      observationText: 'Rama negra presente',
    });

    expect(result).toContain('\ud83c\udf3f Malezas');
    expect(result).toContain('herbicida');
    expect(result).toContain('fumigaci\u00f3n lote 2');
  });

  it('nutricion category shows fertilizaci\u00f3n suggestion', () => {
    const result = formatObservationResponse({
      locationLabel: 'campo norte > Lote 1',
      plotName: '1',
      category: 'nutricion',
      observationText: 'Clorosis en hojas',
    });

    expect(result).toContain('\ud83e\uddea Nutrici\u00f3n');
    expect(result).toContain('fertilizaci\u00f3n lote 1');
    expect(result).toContain('an\u00e1lisis foliar');
    expect(result).not.toContain('fumigaci\u00f3n');
  });

  it('fenologia category shows correct label and recommendation', () => {
    const result = formatObservationResponse({
      locationLabel: 'general > Lote 5',
      plotName: '5',
      category: 'fenologia',
      observationText: 'Estado V3',
    });

    expect(result).toContain('\ud83c\udf31 Fenolog\u00eda');
    expect(result).toContain('seguimiento fenol\u00f3gico');
  });

  it('general category has no recommendation section', () => {
    const result = formatObservationResponse({
      locationLabel: 'General',
      plotName: null,
      category: 'general',
      observationText: 'Todo bien',
    });

    expect(result).toContain('\ud83d\udcdd General');
    expect(result).not.toContain('\u26a0\ufe0f *Recomendaci\u00f3n*');
    expect(result).toContain('otra observaci\u00f3n');
  });

  it('null plotName shows suggestions without lote suffix', () => {
    const result = formatObservationResponse({
      locationLabel: 'General',
      plotName: null,
      category: 'sanidad',
      observationText: 'Chinches',
    });

    expect(result).toContain('fumigaci\u00f3n');
    expect(result).not.toContain('fumigaci\u00f3n lote');
    expect(result).toContain('otra observaci\u00f3n');
    expect(result).not.toContain('otra observaci\u00f3n lote');
  });
});

describe('formatAgroReportResponse', () => {
  it('renders full report with all sections', () => {
    const result = formatAgroReportResponse({
      fieldName: 'general',
      weekNumber: 11,
      observationCount: 3,
      plotSummaries: [
        { plotName: 'Lote 3', observations: ['pulg\u00f3n', 'chinches'] },
        { plotName: 'Lote 5', observations: ['malezas'] },
      ],
      recentActivities: [
        { label: 'Observaci\u00f3n', detail: 'pulg\u00f3n', plotName: 'Lote 3' },
      ],
    });

    expect(result).toContain('Reporte agronómico — general');
    expect(result).toContain('semana 11');
    expect(result).toContain('Observaciones: 3');
    expect(result).toContain('*Detalle por lote*');
    expect(result).toContain('\ud83c\udf31 Lote 3');
    expect(result).toContain('\u2022 pulg\u00f3n');
    expect(result).toContain('\u2022 chinches');
    expect(result).toContain('\ud83c\udf31 Lote 5');
    expect(result).toContain('*Actividad reciente*');
    expect(result).toContain('Observaci\u00f3n: pulg\u00f3n (Lote 3)');
  });

  it('hides "Detalle por lote" when plotSummaries is empty', () => {
    const result = formatAgroReportResponse({
      fieldName: 'campo sur',
      weekNumber: 10,
      observationCount: 0,
      plotSummaries: [],
      recentActivities: [
        { label: 'Pulverizaci\u00f3n', detail: 'glifosato', plotName: 'Lote 1' },
      ],
    });

    expect(result).not.toContain('*Detalle por lote*');
    expect(result).toContain('*Actividad reciente*');
  });

  it('hides "Actividad reciente" when activities is empty', () => {
    const result = formatAgroReportResponse({
      fieldName: 'campo norte',
      weekNumber: 12,
      observationCount: 2,
      plotSummaries: [
        { plotName: 'Lote 1', observations: ['helada'] },
      ],
      recentActivities: [],
    });

    expect(result).toContain('*Detalle por lote*');
    expect(result).not.toContain('*Actividad reciente*');
  });
});
