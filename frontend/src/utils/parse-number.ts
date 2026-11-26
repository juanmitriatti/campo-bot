/**
 * Número tal como lo escribe un argentino: "80,5" = 80,5 · "1.500" = 1500 ·
 * "1.500.000,50" = 1500000,5 · "80.5" = 80,5. null si está vacío o no es un número.
 *
 * Con `<input type="number">` el valor depende del navegador y del idioma: "1.500"
 * llegaba como 1,5 (una superficie de 1,5 ha en vez de 1.500) y "1.500.000" como
 * "" (error confuso o dato ignorado en silencio). Los campos numéricos del
 * dashboard son de texto con `inputMode="decimal"` y pasan por acá (auditoría de
 * datos, nov 2026). Espejo del criterio del bot (normalizarMonto).
 */
export function parseNumberAR(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).replace(/[\s$]/g, '');
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
