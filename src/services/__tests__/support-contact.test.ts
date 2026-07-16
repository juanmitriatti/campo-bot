import { describe, it, expect, afterEach, vi } from 'vitest';
import { getSupportLine } from '../support-contact.js';
import * as settings from '../settings.service.js';

// Import estático (una sola instancia del módulo): con vi.resetModules() el
// spy quedaba pegado a la instancia vieja de settings.service y el módulo
// re-importado leía la DB real — el test pasaba o fallaba según qué valor
// hubiera dejado el harness de integración en system_settings.
describe('getSupportLine (checklist de lanzamiento)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('con SUPPORT_CONTACT configurado devuelve la línea', async () => {
    vi.spyOn(settings, 'getSetting').mockResolvedValue('soporte@campo.bot');
    expect(await getSupportLine()).toBe('🆘 Soporte: soporte@campo.bot');
  });

  it('sin configurar (vacío o null) devuelve "" — ningún mensaje muestra la línea', async () => {
    const spy = vi.spyOn(settings, 'getSetting');
    spy.mockResolvedValue('   ');
    expect(await getSupportLine()).toBe('');
    spy.mockResolvedValue(null);
    expect(await getSupportLine()).toBe('');
  });
});
