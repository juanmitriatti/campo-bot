/**
 * Número tal como lo escribe un argentino: "80,5" = 80,5 · "1.500" = 1500 ·
 * "1.500.000,50" = 1500000,5 · "80.5" = 80,5. null si está vacío o no es un número.
 *
 * Fuente única del lado del servidor (formularios); espejo de
 * frontend/src/utils/parse-number.ts. `Number("1.500")` da 1,5: así un camión de
 * 28.500 kg quedaba guardado como 28,5 kg.
 */
export function parseNumberAR(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/[\s$]/g, '');
  if (!s) return null;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^-?[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // puntos de miles: 1.500 · 1.500.000
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
