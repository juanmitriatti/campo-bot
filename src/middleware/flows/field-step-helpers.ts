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
    return `No tenés campos creados. Escribí *cancelar* y después *agregar campo [nombre]* para crear uno.`;
  }
  const list = buildFieldListText(fields);
  return `${label}\n${list}\n\nEscribí el nombre o número.`;
}

export function buildFieldInteractive(
  fields: string[],
  body = '¿En qué campo?',
): InteractiveMessage | null {
  if (fields.length === 0) return null;
  const capped = fields.slice(0, MAX_INTERACTIVE_ROWS + 1); // No extra "General" row anymore
  const rows = capped.map(f => ({
    id: `flow_field_${f.toLowerCase().replace(/\s+/g, '_')}`,
    title: f.length > 24 ? f.slice(0, 24) : f,
  }));
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

  // No fields exist → block, ask user to cancel and create field first
  if (fields.length === 0) {
    return { error: 'No tenés campos creados. Escribí *cancelar* y después *agregar campo [nombre]* para crear uno.' };
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

// Plot validation — supports grouped-by-field display

export interface PlotWithField {
  plotName: string;
  fieldName: string;
}

export function buildPlotPrompt(plots: string[], label = '¿En qué lote?'): string {
  if (plots.length === 0) {
    return `No tenés lotes creados. Escribí *cancelar* y después *agregar lote [nombre] en campo [campo]* para crear uno.`;
  }
  const lines = plots.map((p, i) => `${i + 1}. ${p}`);
  return `${label}\n${lines.join('\n')}\n\nEscribí el nombre o número.`;
}

export function buildPlotPromptGrouped(plots: PlotWithField[], label = '¿En qué lote?'): string {
  if (plots.length === 0) {
    return `No tenés lotes creados. Escribí *cancelar* y después *agregar lote [nombre] en campo [campo]* para crear uno.`;
  }
  const fieldNames = [...new Set(plots.map(p => p.fieldName))];
  if (fieldNames.length <= 1) {
    return buildPlotPrompt(plots.map(p => p.plotName), label);
  }
  let text = `${label}\n`;
  for (const fn of fieldNames) {
    text += `\n*${fn}:*\n`;
    const fieldPlots = plots.filter(p => p.fieldName === fn);
    for (const p of fieldPlots) {
      text += `  • ${p.plotName}\n`;
    }
  }
  text += `\nEscribí el nombre del lote.`;
  return text;
}

export function buildPlotInteractive(
  plots: string[],
  body = '¿En qué lote?',
): InteractiveMessage | null {
  if (plots.length === 0) return null;
  const capped = plots.slice(0, MAX_INTERACTIVE_ROWS + 1);
  const rows = capped.map(p => ({
    id: `flow_plot_${p.toLowerCase().replace(/\s+/g, '_')}`,
    title: p.length > 24 ? p.slice(0, 24) : p,
  }));
  return {
    type: 'list' as const,
    body,
    buttonText: 'Ver lotes',
    sections: [{ title: 'Lotes', rows }],
  };
}

export function buildPlotInteractiveGrouped(
  plots: PlotWithField[],
  body = '¿En qué lote?',
): InteractiveMessage | null {
  if (plots.length === 0) return null;
  const fieldNames = [...new Set(plots.map(p => p.fieldName))];
  if (fieldNames.length <= 1) {
    return buildPlotInteractive(plots.map(p => p.plotName), body);
  }
  // Group by field as separate sections
  const sections: { title: string; rows: { id: string; title: string }[] }[] = [];
  let totalRows = 0;
  for (const fn of fieldNames) {
    if (totalRows >= MAX_INTERACTIVE_ROWS + 1) break;
    const fieldPlots = plots.filter(p => p.fieldName === fn);
    const rows = fieldPlots
      .slice(0, MAX_INTERACTIVE_ROWS + 1 - totalRows)
      .map(p => ({
        id: `flow_plot_${p.plotName.toLowerCase().replace(/\s+/g, '_')}`,
        title: p.plotName.length > 24 ? p.plotName.slice(0, 24) : p.plotName,
      }));
    totalRows += rows.length;
    sections.push({ title: fn, rows });
  }
  return {
    type: 'list' as const,
    body,
    buttonText: 'Lotes',
    sections,
  };
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
