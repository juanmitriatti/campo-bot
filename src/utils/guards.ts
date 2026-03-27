/**
 * Detects if a Spanish text is likely a question (starts with question word + ends with ?).
 * Used to prevent questions from being misclassified as expenses/commands.
 */
export function isLikelyQuestion(texto: string): boolean {
  const lower = texto.toLowerCase().trim();
  return /^(?:qu[eé]|c[oó]mo|cu[aá]nto|cu[aá]ndo|d[oó]nde|cu[aá]l(?:es)?|por\s*qu[eé]|qui[eé]n(?:es)?)(?=\s|$)/.test(lower) && /\?\s*$/.test(lower);
}
