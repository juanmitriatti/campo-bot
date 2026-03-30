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

  // Numeric selection: "1", "2", etc. — only if entire input is a number
  const num = /^\d+$/.test(input.trim()) ? parseInt(input, 10) : NaN;
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

  // Detect duplicate plot names (appear in >1 field)
  const nameCount = new Map<string, number>();
  for (const p of plots) {
    const key = p.plotName.toLowerCase();
    nameCount.set(key, (nameCount.get(key) || 0) + 1);
  }

  // Group by field as separate sections
  const sections: { title: string; rows: { id: string; title: string }[] }[] = [];
  let totalRows = 0;
  for (const fn of fieldNames) {
    if (totalRows >= MAX_INTERACTIVE_ROWS + 1) break;
    const fieldPlots = plots.filter(p => p.fieldName === fn);
    const rows = fieldPlots
      .slice(0, MAX_INTERACTIVE_ROWS + 1 - totalRows)
      .map(p => {
        const plotSlug = p.plotName.toLowerCase().replace(/\s+/g, '_');
        const isDuplicate = (nameCount.get(p.plotName.toLowerCase()) || 0) > 1;
        // Duplicate names get field__plot ID format; unique names keep backward-compatible format
        const id = isDuplicate
          ? `flow_plot_${fn.toLowerCase().replace(/\s+/g, '_')}__${plotSlug}`
          : `flow_plot_${plotSlug}`;
        return {
          id,
          title: p.plotName.length > 24 ? p.plotName.slice(0, 24) : p.plotName,
        };
      });
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

/**
 * Extract a field hint from user input when plot name alone is ambiguous.
 * Supports patterns:
 *   "1a la esperanza", "1a en la esperanza", "1a de don pedro", "1a (la esperanza)", "campo don pedro 1a"
 * Returns { plotName, fieldName } or null.
 */
export function extractFieldHint(
  rawInput: string,
  plots: PlotWithField[],
): { plotName: string; fieldName: string } | null {
  const input = normalize(rawInput);
  const fieldNames = [...new Set(plots.map(p => p.fieldName))];

  for (const fn of fieldNames) {
    const normField = normalize(fn);
    const fieldPlots = plots.filter(p => p.fieldName === fn);

    // Pattern: "campo {field} {plot}" → "campo don pedro 1a"
    const campoPrefix = `campo ${normField} `;
    if (input.startsWith(campoPrefix)) {
      const plotPart = input.slice(campoPrefix.length).trim();
      const match = fieldPlots.find(p => normalize(p.plotName) === plotPart || levenshtein(normalize(p.plotName), plotPart) <= 1);
      if (match) return { plotName: match.plotName, fieldName: fn };
    }

    // Pattern: "{plot} (field)" → "1a (la esperanza)"
    const parenMatch = input.match(new RegExp(`^(.+?)\\s*\\(\\s*${escapeRegex(normField)}\\s*\\)$`));
    if (parenMatch) {
      const plotPart = parenMatch[1].trim();
      const match = fieldPlots.find(p => normalize(p.plotName) === plotPart || levenshtein(normalize(p.plotName), plotPart) <= 1);
      if (match) return { plotName: match.plotName, fieldName: fn };
    }

    // Pattern: "{plot} en/de {field}" → "1a en la esperanza", "1a de don pedro"
    for (const prep of ['en', 'de']) {
      const sepIdx = input.indexOf(` ${prep} ${normField}`);
      if (sepIdx > 0 && sepIdx + ` ${prep} ${normField}`.length === input.length) {
        const plotPart = input.slice(0, sepIdx).trim();
        const match = fieldPlots.find(p => normalize(p.plotName) === plotPart || levenshtein(normalize(p.plotName), plotPart) <= 1);
        if (match) return { plotName: match.plotName, fieldName: fn };
      }
    }

    // Pattern: "{plot} {field}" (suffix) → "1a la esperanza"
    if (input.endsWith(` ${normField}`)) {
      const plotPart = input.slice(0, input.length - normField.length - 1).trim();
      if (plotPart.length > 0) {
        const match = fieldPlots.find(p => normalize(p.plotName) === plotPart || levenshtein(normalize(p.plotName), plotPart) <= 1);
        if (match) return { plotName: match.plotName, fieldName: fn };
      }
    }
  }

  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function validatePlotAsync(
  input: string,
  _data: Record<string, unknown>,
  userId: UserId,
): Promise<FlowStepValidationResult> {
  const val = input.trim();
  if (val.length < 1) return { error: 'Ingresá un nombre de lote válido.' };

  const plotsWithFields = await entityValidator.getUserPlotsWithFields(userId);

  // No plots exist → block, ask user to cancel and create plot first
  if (plotsWithFields.length === 0) {
    return { error: 'No tenés lotes creados. Escribí *cancelar* y después *agregar lote [nombre] en campo [campo]* para crear uno.' };
  }

  // Flatten to unique plot names for numeric selection
  const uniquePlotNames = [...new Set(plotsWithFields.map(p => p.plotName))];
  const normalizedInput = normalize(input);

  // Numeric selection — only if the ENTIRE input is a number (avoid "1B" → 1)
  const num = /^\d+$/.test(input.trim()) ? parseInt(input, 10) : NaN;
  if (!isNaN(num) && num >= 1 && num <= uniquePlotNames.length) {
    const selected = uniquePlotNames[num - 1];
    // Check if this name appears in multiple fields
    const matches = plotsWithFields.filter(p => p.plotName === selected);
    if (matches.length === 1) return { value: selected };
    // Ambiguous — fall through to disambiguation
  }

  // Exact match
  const exactMatches = plotsWithFields.filter(p => normalize(p.plotName) === normalizedInput);
  if (exactMatches.length === 1) return { value: exactMatches[0].plotName };

  if (exactMatches.length > 1) {
    // Duplicate plot name across fields — check for pre-stored field hint first (from interactive callback)
    const preHint = _data._resolvedFieldHint as string | undefined;
    if (preHint) {
      const hintMatch = exactMatches.find(p => normalize(p.fieldName) === normalize(preHint));
      if (hintMatch) return { value: hintMatch.plotName };
    }
    // Try extracting field hint from input text
    const hint = extractFieldHint(input, plotsWithFields);
    if (hint) {
      _data._resolvedFieldHint = hint.fieldName;
      return { value: hint.plotName };
    }
    // Show disambiguation message
    const options = exactMatches.map(p => `• ${p.plotName} (${p.fieldName})`).join('\n');
    return { error: `Hay varios lotes "${exactMatches[0].plotName}". ¿Cuál?\n${options}\n\nEj: "${exactMatches[0].plotName} ${exactMatches[0].fieldName}"` };
  }

  // Fuzzy match
  const fuzzyMatches: PlotWithField[] = [];
  for (const p of plotsWithFields) {
    if (levenshtein(normalize(p.plotName), normalizedInput) <= 2) {
      fuzzyMatches.push(p);
    }
  }
  // Deduplicate by plotName+fieldName
  const uniqueFuzzy = fuzzyMatches.filter((p, i, arr) => arr.findIndex(x => x.plotName === p.plotName && x.fieldName === p.fieldName) === i);
  if (uniqueFuzzy.length === 1) return { value: uniqueFuzzy[0].plotName };
  if (uniqueFuzzy.length > 1) {
    // Check if all matches are the same plot name (duplicates across fields)
    const uniqueNames = [...new Set(uniqueFuzzy.map(p => p.plotName))];
    if (uniqueNames.length === 1) {
      const hint = extractFieldHint(input, plotsWithFields);
      if (hint) {
        _data._resolvedFieldHint = hint.fieldName;
        return { value: hint.plotName };
      }
      const options = uniqueFuzzy.map(p => `• ${p.plotName} (${p.fieldName})`).join('\n');
      return { error: `Hay varios lotes "${uniqueFuzzy[0].plotName}". ¿Cuál?\n${options}\n\nEj: "${uniqueFuzzy[0].plotName} ${uniqueFuzzy[0].fieldName}"` };
    }
    // Multiple different plot names matched fuzzily — try field hint
    const hint = extractFieldHint(input, plotsWithFields);
    if (hint) {
      _data._resolvedFieldHint = hint.fieldName;
      return { value: hint.plotName };
    }
    // Return first fuzzy match (existing behavior for non-duplicate case)
    return { value: uniqueFuzzy[0].plotName };
  }

  // No match — try extractFieldHint for "plotname fieldname" pattern that didn't match above
  const hint = extractFieldHint(input, plotsWithFields);
  if (hint) {
    _data._resolvedFieldHint = hint.fieldName;
    return { value: hint.plotName };
  }

  // Show grouped list of available plots
  const fieldNames = [...new Set(plotsWithFields.map(p => p.fieldName))];
  let listText = '';
  for (const fn of fieldNames) {
    listText += `*${fn}:* ${plotsWithFields.filter(p => p.fieldName === fn).map(p => p.plotName).join(', ')}\n`;
  }
  return { error: `No encontré ese lote.\n\nTus lotes:\n${listText.trim()}` };
}
