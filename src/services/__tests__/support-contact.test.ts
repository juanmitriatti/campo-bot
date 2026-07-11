import { describe, it, expect, afterEach, vi } from 'vitest';
import * as settings from '../settings.service.js';

describe('getSupportLine (checklist de lanzamiento)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('con SUPPORT_CONTACT configurado devuelve la línea', async () => {
    vi.spyOn(settings, 'getSetting').mockResolvedValue('soporte@campo.bot');
    const { getSupportLine } = await import('../support-contact.js');
    expect(await getSupportLine()).toBe('🆘 Soporte: soporte@campo.bot');
  });

  it('sin configurar (vacío o null) devuelve "" — ningún mensaje muestra la línea', async () => {
    vi.spyOn(settings, 'getSetting').mockResolvedValue('   ');
    const { getSupportLine } = await import('../support-contact.js');
    expect(await getSupportLine()).toBe('');
  });
});
