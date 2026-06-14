/**
 * Simple template interpolation for configurable bot messages.
 * Replaces {{varName}} with values from the vars object.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  const filled = template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  // Limpieza defensiva: cuando una variable expande a '' o a un valor con coma
  // de apertura (ej. nombre=', Ana' en "Hola {{nombre}}"), quedan artefactos
  // "Hola , Ana" (espacio antes de coma) o "Hola  👋" (doble espacio). Visto
  // live en el saludo a usuarios nuevos (Jun 2026). Esto protege TODOS los
  // templates de una, sin importar cómo los editen en el admin.
  return filled
    .replace(/ +([,;.!?])/g, '$1')  // espacio(s) antes de puntuación
    .replace(/ {2,}/g, ' ')          // espacios consecutivos
    .replace(/ +\n/g, '\n');         // espacio al final de línea
}

/**
 * Split a newline-separated pool string into an array of non-empty strings.
 * Used for confirmation message pools stored as a single setting value.
 */
export function splitPool(setting: string): string[] {
  return setting.split('\n').map(s => s.trim()).filter(Boolean);
}
