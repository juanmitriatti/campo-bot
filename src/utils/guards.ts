/**
 * Detects if a Spanish text is likely a question (starts with question word + ends with ?).
 * Used to prevent questions from being misclassified as expenses/commands.
 */
export function isLikelyQuestion(texto: string): boolean {
  const lower = texto.toLowerCase().trim();
  return /^(?:qu[eé]|c[oó]mo|cu[aá]nto|cu[aá]ndo|d[oó]nde|cu[aá]l(?:es)?|por\s*qu[eé]|qui[eé]n(?:es)?)(?=\s|$)/.test(lower) && /\?\s*$/.test(lower);
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
