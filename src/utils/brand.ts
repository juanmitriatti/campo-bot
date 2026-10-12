import { getSetting } from '../services/settings.service.js';

/**
 * Fuente ÚNICA del nombre del producto (setting APP_NAME). Todo texto que el
 * usuario ve con el nombre de la app lo lee de acá: estaba escrito a mano en ~25
 * lugares y cambiar de marca era un deploy. El asistente con el que se habla es
 * otra cosa: BOT_NAME (MIA).
 */
export const DEFAULT_APP_NAME = 'MiAgro';

export async function getAppName(): Promise<string> {
  try {
    const value = ((await getSetting('APP_NAME')) as string | null)?.trim();
    return value || DEFAULT_APP_NAME;
  } catch {
    return DEFAULT_APP_NAME;
  }
}

/** Setting de marca opcional que, vacío, cae al nombre de la app. */
export async function brandSettingOrAppName(key: string): Promise<string> {
  try {
    const value = ((await getSetting(key)) as string | null)?.trim();
    if (value) return value;
  } catch { /* cae al nombre de la app */ }
  return getAppName();
}
