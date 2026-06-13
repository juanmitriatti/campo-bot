/**
 * Formato de ubicación lote/campo para mensajes al usuario.
 *
 * Antes se construía inline como `${fieldName} > ${plotName}` (~20 sitios) —
 * el ">" se leía robótico (feedback del usuario, Jun 2026). Ahora:
 *   con campo:  "lote Sur (La Esperanza)"
 *   sin campo:  "lote Sur"
 *
 * No incluye markdown — el call-site decide si lo envuelve en *bold* o le
 * antepone un emoji 📍.
 */
export function formatPlotLocation(
  fieldName: string | null | undefined,
  plotName: string | null | undefined,
): string {
  const plot = (plotName ?? '').trim();
  const field = (fieldName ?? '').trim();
  if (!plot) return field || '—';
  return field ? `lote ${plot} (${field})` : `lote ${plot}`;
}

/** Capitaliza la primera letra (para nombres de cultivo que llegan en minúscula:
 *  "trigo" → "Trigo"). Respeta el resto tal cual. */
export function cap(word: string | null | undefined): string {
  const w = (word ?? '').trim();
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}
