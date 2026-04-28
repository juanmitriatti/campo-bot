import { describe, it, expect, vi } from 'vitest';
import { handlePendingCity } from '../pending-field-city-handler.js';
import type { FinancialService } from '../../domain/financial/financial.service.js';

const fakeFs = {
  setFieldCity: vi.fn().mockResolvedValue(undefined),
} as unknown as FinancialService;

const userId = 1 as unknown as Parameters<typeof handlePendingCity>[2];

describe('pending-field-city escape hatch', () => {
  const cases: Array<[string, string]> = [
    ['Cosecha lote 1A: Britos 30 tn, Pérez 25 tn', 'cosecha con lista'],
    ['Sembré soja en lote 1A con 80 kg/ha', 'siembra con métricas'],
    ['¿Cómo viene la campaña?', 'pregunta'],
    ['DROP TABLE fields; sembré soja', 'sql injection'],
    ['Usé 600 lt de glifosato hoy', 'aplicación de insumo'],
    ['Cargué 500 lt de glifosato al galpón norte', 'stock'],
    ['cancelar', 'cancel literal'],
    ['52 hectáreas', 'numero+unidad'],
    ['Llovió 20mm anoche', 'lluvia'],
    ['$50000 en gasoil', 'gasto con $'],
    ['Hoy hice un montón: fumigué 1A con glifo', 'mensaje muy largo'],
    ['Florentino Ameghino, Buenos Aires, Argentina', 'tres comas en input'],
  ];

  for (const [text, label] of cases) {
    it(`aborta el bucle ante: ${label}`, async () => {
      const result = await handlePendingCity(text, { fieldName: 'Test' }, userId, fakeFs);
      expect(result.clearPending).toBe(true);
      expect(result.messages[0]).toMatch(/Dejé pendiente/i);
    });
  }

  it('NO aborta para una localidad válida ("Pergamino")', async () => {
    const fs = { setFieldCity: vi.fn().mockResolvedValue(undefined) } as unknown as FinancialService;
    const result = await handlePendingCity('Pergamino', { fieldName: 'Test' }, userId, fs);
    expect(result.messages[0]).not.toMatch(/Dejé pendiente/i);
  });

  it('NO aborta para "está en X"', async () => {
    const fs = { setFieldCity: vi.fn().mockResolvedValue(undefined) } as unknown as FinancialService;
    const result = await handlePendingCity('está en Pergamino', { fieldName: 'Test' }, userId, fs);
    expect(result.messages[0]).not.toMatch(/Dejé pendiente/i);
  });
});
