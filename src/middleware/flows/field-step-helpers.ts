import { EntityValidator } from '../../services/entity-validator.js';
import type { UserId, InteractiveMessage } from '../../types/index.js';
import type { FlowStepValidationResult } from './flow.interface.js';

const entityValidator = new EntityValidator();

const MAX_INTERACTIVE_ROWS = 9; // +1 for General/Sin campo = 10 max WhatsApp rows

function normalize(text: string): string {
  return text.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

function buildFieldListText(fields: string[], cap = false): string {
  if (fields.length === 0) return '';
  const toShow = cap ? fields.slice(0, MAX_INTERACTIVE_ROWS) : fields;
  const lines = toShow.map((f, i) => `${i + 1}. ${f}`);
  return lines.join('\n');
}

export function buildFieldPrompt(fields: string[], label = '¿En qué campo?'): string {
  if (fields.length === 0) {
    return `${label} (escribí el nombre o "general" si no aplica)`;
  }
  const list = buildFieldListText(fields);
  return `${label}\n${list}\n\nEscribí el nombre, número o "general".`;
}

export function buildFieldInteractive(
  fields: string[],
  body = '¿En qué campo?',
  noFieldLabel = 'General',
): InteractiveMessage | null {
  if (fields.length === 0) return null;
  const capped = fields.slice(0, MAX_INTERACTIVE_ROWS);
  const rows = capped.map(f => ({
    id: `flow_field_${f.toLowerCase().replace(/\s+/g, '_')}`,
    title: f.length > 24 ? f.slice(0, 24) : f,
  }));
  rows.push({ id: `flow_field_${normalize(noFieldLabel).replace(/\s+/g, '_')}`, title: noFieldLabel });
  return {
    type: 'list' as const,
    body,
    buttonText: 'Ver campos',
    sections: [{ title: 'Campos', rows }],
  };
}

export async function validateFieldAsync(
  input: string,
  _data: Record<string, unknown>,
  userId: UserId,
): Promise<FlowStepValidationResult> {
  const lower = input.toLowerCase().trim();

  // Null/skip values
  if (['general', 'ninguno', 'no', 'sin campo'].includes(lower)) {
    return { value: null };
  }

  // Get user's fields
  const fields = await entityValidator.getUserFieldNames(userId);

  // No fields exist → accept any name (will be auto-created on execute)
  if (fields.length === 0) {
    return { value: input.trim() };
  }

  const normalizedInput = normalize(input);

  // Numeric selection: "1", "2", etc.
  const num = parseInt(input, 10);
  if (!isNaN(num) && num >= 1 && num <= fields.length) {
    return { value: fields[num - 1] };
  }

  // Exact match (case-insensitive, accent-insensitive)
  for (const f of fields) {
    if (normalize(f) === normalizedInput) return { value: f };
  }

  // Fuzzy match (Levenshtein ≤ 2)
  for (const f of fields) {
    if (levenshtein(normalize(f), normalizedInput) <= 2) return { value: f };
  }

  // No match → show available fields
  const list = buildFieldListText(fields);
  return { error: `No encontré ese campo.\n\nTus campos:\n${list}` };
}

// Plot validation
export function buildPlotPrompt(plots: string[], label = '¿En qué lote?'): string {
  if (plots.length === 0) {
    return `${label} (escribí el nombre, opcional)`;
  }
  const lines = plots.map((p, i) => `${i + 1}. ${p}`);
  return `${label}\n${lines.join('\n')}\n\nEscribí el nombre o número.`;
}

export async function validatePlotAsync(
  input: string,
  _data: Record<string, unknown>,
  userId: UserId,
): Promise<FlowStepValidationResult> {
  const val = input.trim();
  if (val.length < 1) return { error: 'Ingresá un nombre de lote válido.' };

  const plots = await entityValidator.getUserPlotNames(userId);

  // No plots exist → accept any name
  if (plots.length === 0) {
    return { value: val };
  }

  const normalizedInput = normalize(input);

  // Numeric selection
  const num = parseInt(input, 10);
  if (!isNaN(num) && num >= 1 && num <= plots.length) {
    return { value: plots[num - 1] };
  }

  // Exact match
  for (const p of plots) {
    if (normalize(p) === normalizedInput) return { value: p };
  }

  // Fuzzy match
  for (const p of plots) {
    if (levenshtein(normalize(p), normalizedInput) <= 2) return { value: p };
  }

  // No match → show available plots
  const lines = plots.map((p, i) => `${i + 1}. ${p}`);
  return { error: `No encontré ese lote.\n\nTus lotes:\n${lines.join('\n')}` };
}
