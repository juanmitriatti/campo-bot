import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../../config/db.js', () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));

const settingsValues: Record<string, string | number | null> = {
  TRIAL_DAYS: 14,
  SUPPORT_CONTACT: 'soporte@campo.bot',
};
vi.mock('../../../services/settings.service.js', () => ({
  getSetting: vi.fn(async (k: string) => settingsValues[k] as string | undefined),
  getSettingNumber: vi.fn(async (k: string) => settingsValues[k] as number | undefined),
  getSettingBool: vi.fn(async () => false),
}));

import { getPlanCatalog, invalidatePlanCatalogCache } from '../plan-catalog.service.js';

/**
 * El catálogo es la fuente ÚNICA de "qué se vende y a cuánto": lo leen la
 * landing (`/api/plans/public`) y el paywall del dashboard. Si divergieran,
 * la página de precios prometería un número y el checkout cobraría otro.
 */
describe('plan catalog', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    invalidatePlanCatalogCache();
  });

  it('sirve solo los planes públicos y activos, con los flags comerciales', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { name: 'pro', display_name: 'Pro', price_ars: '5000', price_ars_yearly: null, daily_ai_limit: 100, daily_document_limit: 10, is_featured: false, custom_pricing: false },
        { name: 'pro_plus', display_name: 'Pro+', price_ars: '12000', price_ars_yearly: '100000', daily_ai_limit: 300, daily_document_limit: 25, is_featured: true, custom_pricing: false },
      ],
    });

    const catalog = await getPlanCatalog();

    // El filtro vive en el SQL: free queda afuera por is_public=false.
    expect(mockQuery.mock.calls[0][0]).toMatch(/is_active AND is_public/);
    expect(catalog.trial_days).toBe(14);
    expect(catalog.support_contact).toBe('soporte@campo.bot');
    expect(catalog.plans).toHaveLength(2);
    expect(catalog.plans[1]).toMatchObject({
      name: 'pro_plus', price_ars: 12000, price_ars_yearly: 100000, featured: true, custom_pricing: false,
    });
  });

  it('manda price_ars en null cuando el plan se cotiza a mano', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { name: 'enterprise', display_name: 'Dedicado', price_ars: '0', price_ars_yearly: null, daily_ai_limit: 1000, daily_document_limit: 100, is_featured: false, custom_pricing: true },
      ],
    });

    const catalog = await getPlanCatalog();

    // El precio real es 0 en la tabla (se cotiza aparte); mandarlo como número
    // haría que la card diga "$0" y se lea como gratis.
    expect(catalog.plans[0].price_ars).toBeNull();
    expect(catalog.plans[0].custom_pricing).toBe(true);
  });

  it('cachea entre llamadas y se invalida cuando el admin edita un plan', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getPlanCatalog();
    await getPlanCatalog();
    expect(mockQuery).toHaveBeenCalledTimes(1);

    invalidatePlanCatalogCache();
    await getPlanCatalog();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
