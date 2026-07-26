/**
 * Format large kg quantities as tn for human readability.
 * Examples: (213200, "kg") → "≈ 213,2 tn" | (500, "kg") → "500 kg" | (50, "tn") → "50 tn"
 */
/** Solo el número en toneladas, sin unidad: 25000 → "25", 120490 → "120,5". */
export function formatTn(kg: number): string {
  return (kg / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 });
}

export function formatQuantityHuman(quantity: number, unit: string): string {
  if (unit === 'kg' && quantity >= 1000) {
    const tn = quantity / 1000;
    return `≈ ${tn.toLocaleString('es-AR', { maximumFractionDigits: 1 })} tn`;
  }
  return `${quantity.toLocaleString('es-AR')} ${unit}`;
}
