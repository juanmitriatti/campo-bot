import { describe, it, expect } from 'vitest';
import { formatHistoryResponse, prioritizeRows, type QueryContext } from '../plot-query.service.js';
import type { PlotHistoryRow } from '../../../types/index.js';

// Use noon UTC to avoid timezone offset issues in Argentina (UTC-3)
function makeDate(iso: string): Date {
  return new Date(iso + 'T12:00:00Z');
}

function makeRow(overrides: Partial<PlotHistoryRow> = {}): PlotHistoryRow {
  return {
    source: 'activity',
    id: 1,
    type: 'spraying',
    date: makeDate('2026-03-15'),
    detail: 'Glifosato',
    quantity: 3,
    unit: 'lt/ha',
    crop: 'Soja',
    plot_id: 1,
    plot_name: 'lote 3',
    field_name: 'campo norte',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    plotLabel: 'lote 3',
    timeLabel: '',
    isUltimaVez: false,
    isBinaryQuestion: false,
    hasNoFilters: false,
    activityFilter: null,
    ...overrides,
  };
}

describe('formatHistoryResponse — decision engine', () => {
  // --- Empty ---
  it('returns empty message when no results', () => {
    const msg = formatHistoryResponse([], makeCtx());
    expect(msg).toContain('No encontré actividades');
    expect(msg).toContain('lote 3');
  });

  it('includes activity label in empty filtered response', () => {
    const msg = formatHistoryResponse([], makeCtx({ activityFilter: 'spraying' }));
    expect(msg).toContain('fumigación');
  });

  // --- Binary NO ---
  it('returns ❌ for binary question with no results', () => {
    const msg = formatHistoryResponse([], makeCtx({ isBinaryQuestion: true, activityFilter: 'spraying' }));
    expect(msg).toMatch(/^❌/);
    expect(msg).toContain('fumigación');
  });

  // --- Binary YES ---
  it('returns ✅ for binary question with results', () => {
    const rows = [makeRow(), makeRow({ id: 2, date: makeDate('2026-03-10') })];
    const msg = formatHistoryResponse(rows, makeCtx({ isBinaryQuestion: true, activityFilter: 'spraying' }));
    expect(msg).toMatch(/^✅/);
    expect(msg).toContain('15/3/2026');
    expect(msg).toContain('Anteriores');
  });

  it('binary YES with single result has no "Anteriores" section', () => {
    const rows = [makeRow()];
    const msg = formatHistoryResponse(rows, makeCtx({ isBinaryQuestion: true }));
    expect(msg).toMatch(/^✅/);
    expect(msg).not.toContain('Anteriores');
  });

  // --- Single (última vez) ---
  it('returns single event for isUltimaVez', () => {
    const rows = [makeRow()];
    const msg = formatHistoryResponse(rows, makeCtx({ isUltimaVez: true }));
    expect(msg).toContain('La última');
    expect(msg).toContain('fumigación');
    expect(msg).toContain('Glifosato');
    expect(msg).toContain('Soja');
  });

  // --- Recent summary (no filters) ---
  it('returns recent summary with guidance when hasNoFilters', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      makeRow({ id: i, date: makeDate(`2026-03-${String(15 - i).padStart(2, '0')}`) })
    );
    const msg = formatHistoryResponse(rows, makeCtx({ hasNoFilters: true }));
    expect(msg).toContain('📍');
    expect(msg).toContain('Últimas actividades');
    expect(msg).toContain('...y 3 más');
    expect(msg).toContain('💡 Podés preguntar');
    expect(msg).toContain('última vez que se fumigó');
  });

  it('recent summary with few events does not show "más"', () => {
    const rows = [makeRow(), makeRow({ id: 2, date: makeDate('2026-03-10') })];
    const msg = formatHistoryResponse(rows, makeCtx({ hasNoFilters: true }));
    expect(msg).toContain('📍');
    expect(msg).not.toContain('...y');
    expect(msg).toContain('💡 Podés preguntar');
  });

  // --- Summary + list (large result set) ---
  it('returns summary + list for large filtered result set', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({ id: i, date: makeDate(`2026-03-${String(15 - i).padStart(2, '0')}`) })
    );
    const msg = formatHistoryResponse(rows, makeCtx({ timeLabel: 'este mes' }));
    expect(msg).toContain('Resumen (10 registros)');
    expect(msg).toContain('Detalle');
    expect(msg).toContain('Mostrando 7 de 10');
  });

  // --- Clean list (small filtered result) ---
  it('returns clean list for small filtered result set', () => {
    const rows = [
      makeRow(),
      makeRow({ id: 2, source: 'rainfall', type: 'rainfall', detail: '22', quantity: 22, unit: 'mm', date: makeDate('2026-03-12') }),
    ];
    const msg = formatHistoryResponse(rows, makeCtx({ timeLabel: 'esta semana' }));
    expect(msg).toContain('📋 *Historial — lote 3*');
    expect(msg).toContain('esta semana');
    expect(msg).toContain('Fumigación');
    expect(msg).toContain('Lluvia');
    expect(msg).toContain('22mm');
  });

  // --- Rainfall binary ---
  it('binary YES for rainfall shows mm', () => {
    const rows = [makeRow({ source: 'rainfall', type: 'rainfall', detail: '18', quantity: 18, unit: 'mm' })];
    const msg = formatHistoryResponse(rows, makeCtx({ isBinaryQuestion: true, activityFilter: 'rainfall' }));
    expect(msg).toMatch(/^✅/);
    expect(msg).toContain('18mm');
  });
});

describe('prioritizeRows', () => {
  it('sorts activities before rainfall before observations', () => {
    const obs = makeRow({ source: 'observation', type: 'general', date: makeDate('2026-03-15') });
    const rain = makeRow({ source: 'rainfall', type: 'rainfall', date: makeDate('2026-03-15') });
    const act = makeRow({ source: 'activity', type: 'spraying', date: makeDate('2026-03-15') });
    const sorted = prioritizeRows([obs, rain, act]);
    expect(sorted[0].source).toBe('activity');
    expect(sorted[1].source).toBe('rainfall');
    expect(sorted[2].source).toBe('observation');
  });

  it('within same source, sorts by date DESC', () => {
    const old = makeRow({ id: 1, date: makeDate('2026-03-05') });
    const recent = makeRow({ id: 2, date: makeDate('2026-03-15') });
    const sorted = prioritizeRows([old, recent]);
    expect(sorted[0].id).toBe(2);
    expect(sorted[1].id).toBe(1);
  });
});
