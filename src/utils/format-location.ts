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
// Acepta `unknown` porque varias filas de query (livestock, financial) tienen
// field_name/plot_name sin tipar — el viejo `${x || ''}` coercía igual. Se
// coerce con String() internamente, tratando null/undefined/'' como vacío.
export function formatPlotLocation(
  fieldName: unknown,
  plotName: unknown,
): string {
  const plot = (fieldName == null && plotName == null) ? '' : String(plotName ?? '').trim();
  const field = String(fieldName ?? '').trim();
  if (!plot) return field || '—';
  return field ? `lote ${plot} (${field})` : `lote ${plot}`;
}

/** Capitaliza la primera letra (para nombres de cultivo que llegan en minúscula:
 *  "trigo" → "Trigo"). Respeta el resto tal cual. */
export function cap(word: string | null | undefined): string {
  const w = (word ?? '').trim();
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}
