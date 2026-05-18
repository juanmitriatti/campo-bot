/**
 * Detects if a Spanish text is likely a question or analytical query (NOT an observation/registro).
 * Used to prevent questions from being misclassified as observations.
 *
 * Triggers:
 *  - Starts with question word + ends with `?` (e.g. "¿cuándo X?")
 *  - Contains analytical/statistical keywords ANYWHERE (evolución, promedio, cantidad,
 *    porcentaje, máximo/mínimo, ranking, comparar, relacionar, resumen, total) — these
 *    are NEVER observations, even without `?`.
 *  - Starts with action verbs that indicate query intent (mostrame, ver, listame, filtrame,
 *    compará, buscame, sacame, sumame, contame).
 */
export function isLikelyQuestion(texto: string): boolean {
  const lower = texto.toLowerCase().trim();
  // Classic: question word + ?
  if (/^(?:qu[eé]|c[oó]mo|cu[aá]nto|cu[aá]ndo|d[oó]nde|cu[aá]l(?:es)?|por\s*qu[eé]|qui[eé]n(?:es)?)(?=\s|$)/.test(lower) && /\?\s*$/.test(lower)) {
    return true;
  }
  // Analytical / statistical keywords — these are queries, never observations
  if (/\b(evoluci[oó]n|promedio|m[aá]ximo|m[aá]xima|m[ií]nimo|m[ií]nima|cantidad\b|porcentaje|relacion[aá]|relacionar|compar[aá]|comparar|ranking|resumen|estad[ií]stica|total\s+de|m[aá]s\s+alto|m[aá]s\s+bajo)\b/.test(lower)) {
    return true;
  }
  // Action verbs at start that indicate "show/list/filter" intent (the user is asking for data, not registering)
  if (/^(?:mostr[aá]me|mostrar|ver|listar|listame|filtrar|filtr[aá]|filtra|buscar|buscame|busc[aá]me|cont[aá]me|cont[aá]|sum[aá]|sac[aá])\b/.test(lower)) {
    return true;
  }
  return false;
}

/**
 * Detects if a tool-arg value looks like a placeholder/hallucination from the agent
 * (e.g. "<UNKNOWN>", "desconocido", "?", "cultivo", empty string). When a required
 * semantic field comes back like this, the handler should re-prompt the user instead
 * of persisting corrupted data.
 */
export function isPlaceholder(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (/^<.*>$/.test(trimmed)) return true;
  return /^(unknown|desconocido|sin\s+especificar|n\/?a|none|null|undefined|cultivo|producto|fertilizante|insumo|categoria|categoría|\?+|-+)$/i.test(trimmed);
}
