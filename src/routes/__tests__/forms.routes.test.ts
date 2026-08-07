// src/routes/__tests__/forms.routes.test.ts
// Sin supertest (no existe en el repo): se testean los handlers de la ruta
// invocándolos con req/res mockeados, patrón de tests de servicios del repo.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionValidate = vi.fn();
vi.mock('../../services/form-session.service.js', () => ({
  formSessionService: { validate: (...a: unknown[]) => sessionValidate(...a) },
}));
const submitMock = vi.fn();
vi.mock('../../forms/form-submit.service.js', () => ({
  submitForm: (...a: unknown[]) => submitMock(...a),
}));
const getUserFieldsMock = vi.fn();
const getPlotsByFieldMock = vi.fn();
const getAllActiveCropsMock = vi.fn();
vi.mock('../../services/expenses.js', () => ({
  getUserFields: (...a: unknown[]) => getUserFieldsMock(...a),
  getPlotsByField: (...a: unknown[]) => getPlotsByFieldMock(...a),
  getAllActiveCrops: (...a: unknown[]) => getAllActiveCropsMock(...a),
}));

const { formsGetHandler, formsPostHandler } = await import('../forms.routes.js');

function mockRes() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe('GET /api/forms/:token', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404 con token muerto', async () => {
    sessionValidate.mockResolvedValue(null);
    const res = mockRes();
    await formsGetHandler({ params: { token: 'x' } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('devuelve definición + opciones; cosecha filtra lotes sin cultivo activo', async () => {
    sessionValidate.mockResolvedValue({
      token: 't', user_id: 9, action: 'harvest_crop', prefill: {},
    });
    getUserFieldsMock.mockResolvedValue([{ id: 1, name: 'La Esperanza' }]);
    getPlotsByFieldMock.mockResolvedValue([
      { id: 7, name: 'Norte' }, { id: 8, name: 'Sur' },
    ]);
    getAllActiveCropsMock.mockResolvedValue([{ plot_id: 7, crop: 'maíz' }]);
    const res = mockRes();
    await formsGetHandler({ params: { token: 't' } } as never, res as never);
    const body = res.json.mock.calls[0][0];
    expect(body.action).toBe('harvest_crop');
    expect(body.options.plots).toEqual([
      { id: 7, name: 'Norte', fieldName: 'La Esperanza', activeCrop: 'maíz' },
    ]); // Sur (sin cultivo) filtrado
    expect(body.options.crops).toContain('soja');
  });
});

describe('POST /api/forms/:token', () => {
  it('propaga status y error del servicio', async () => {
    submitMock.mockResolvedValue({ ok: false, status: 422, error: 'Cultivo es obligatorio.' });
    const res = mockRes();
    await formsPostHandler({ params: { token: 't' }, body: {} } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cultivo es obligatorio.' });
  });

  it('200 con message en éxito', async () => {
    submitMock.mockResolvedValue({ ok: true, message: '🌱 Listo' });
    const res = mockRes();
    await formsPostHandler({ params: { token: 't' }, body: { crop: 'soja' } } as never, res as never);
    expect(res.json).toHaveBeenCalledWith({ ok: true, message: '🌱 Listo' });
  });
});
