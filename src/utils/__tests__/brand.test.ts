import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = new Map<string, string | null>();
vi.mock('../../services/settings.service.js', () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
}));

const { getAppName, brandSettingOrAppName, DEFAULT_APP_NAME } = await import('../brand.js');

describe('brand — fuente única del nombre de la app', () => {
  beforeEach(() => settings.clear());

  it('sin APP_NAME usa el default', async () => {
    expect(await getAppName()).toBe(DEFAULT_APP_NAME);
  });

  it('APP_NAME del admin gana, sin espacios', async () => {
    settings.set('APP_NAME', '  OtraMarca ');
    expect(await getAppName()).toBe('OtraMarca');
  });

  it('un setting de marca vacío cae al nombre de la app', async () => {
    settings.set('APP_NAME', 'MiAgro');
    settings.set('MAIL_FROM_NAME', '');
    expect(await brandSettingOrAppName('MAIL_FROM_NAME')).toBe('MiAgro');
    settings.set('MAIL_FROM_NAME', 'Equipo MiAgro');
    expect(await brandSettingOrAppName('MAIL_FROM_NAME')).toBe('Equipo MiAgro');
  });
});
