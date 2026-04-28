import { DomainRouter } from './router.js';
import { logError } from '../services/error-logger.js';
import type { FinancialHandler } from './financial/financial.handler.js';
import type { ParseResult, ParsedCommand, ParsedExpense, ParsedIncome, UserId, User, UserSettings, HandlerResponse } from '../types/index.js';
import { LIVESTOCK_CATEGORY_LABEL } from './livestock/livestock.types.js';
import type { LivestockCategory } from './livestock/livestock.types.js';

export interface CompoundResult {
  messages: string[];
  lastSideEffects: HandlerResponse['sideEffects'];
  stoppedAtFlow: boolean;
  /** Last non-null interactive element (from the final step that had one) */
  lastInteractive: HandlerResponse['interactive'];
  /** Last attachment (from the final step that had one) */
  lastAttachment: HandlerResponse['attachment'];
  /** Last suggestionKey */
  lastSuggestionKey: string | undefined;
}

/** Livestock commands that produce per-category messages we want to merge */
const LIVESTOCK_COMMANDS = new Set([
  'add_livestock', 'remove_livestock', 'record_livestock_birth', 'record_livestock_death', 'adjust_livestock',
]);

/** Intent types that can be executed in a compound action */
const COMPOUND_TYPES = new Set(['command', 'expense', 'income']);

/**
 * Executes multiple ParseResults sequentially from a single agent response,
 * collecting responses into a single combined result.
 *
 * Handles command, expense, and income types. If a step triggers a
 * `startFlow` side effect, execution stops there (flow needs user input).
 */
export class CompoundExecutor {
  constructor(
    private router: DomainRouter,
    private financialHandler?: FinancialHandler,
  ) {}

  /**
   * @returns Combined result, or `null` if there are ≤1 actionable results
   *          (caller should fall through to normal single-action path).
   */
  async execute(
    results: ParseResult[],
    userId: UserId,
    user: User,
    settings: UserSettings,
    originalText?: string,
  ): Promise<CompoundResult | null> {
    // Filter to actionable types only
    const actionable = results.filter(r => COMPOUND_TYPES.has(r.intent.type));
    if (actionable.length <= 1) return null;

    const messages: string[] = [];
    let lastSideEffects: HandlerResponse['sideEffects'];
    let lastInteractive: HandlerResponse['interactive'];
    let lastAttachment: HandlerResponse['attachment'];
    let lastSuggestionKey: string | undefined;
    let stoppedAtFlow = false;

    // Force skip confirmation for expenses/incomes in compound context
    const noConfirmSettings = { ...settings, confirm_before_save: false };

    for (const step of actionable) {
      try {
        let response: HandlerResponse | null = null;

        if (step.intent.type === 'command') {
          const data = step.intent.data as ParsedCommand;
          if (originalText) data.originalText = originalText;
          response = await this.router.routeCommand(data, userId, user, settings);
        } else if (step.intent.type === 'expense' && this.financialHandler) {
          const expData = step.intent.data as ParsedExpense & { field?: string; plot?: string };
          response = await this.financialHandler.handleExpense(
            userId, expData, originalText ?? '', noConfirmSettings, user,
            expData.field, expData.plot,
          );
        } else if (step.intent.type === 'income' && this.financialHandler) {
          const incData = step.intent.data as ParsedIncome & { field?: string; plot?: string };
          response = await this.financialHandler.handleIncome(
            userId, incData, originalText ?? '', noConfirmSettings,
            incData.field, incData.plot,
          );
        }

        if (!response) continue;

        messages.push(...response.messages);
        if (response.interactive) lastInteractive = response.interactive;
        if (response.attachment) lastAttachment = response.attachment;
        if (response.suggestionKey) lastSuggestionKey = response.suggestionKey;

        // If this step triggers a flow, stop here — flow needs user input
        if (response.sideEffects?.startFlow) {
          lastSideEffects = response.sideEffects;
          stoppedAtFlow = true;
          break;
        }

        // Skip setPending for expenses/incomes in compound — already saved directly
        if (response.sideEffects && !response.sideEffects.setPending) {
          lastSideEffects = response.sideEffects;
        }
      } catch (err) {
        const label = step.intent.type === 'command'
          ? (step.intent.data as ParsedCommand).command
          : step.intent.type;
        console.error(`[COMPOUND] Error executing step "${label}":`, err);
        logError('compound', 'STEP_EXECUTE', err as Error, { userId, context: { label } });
      }
    }

    const consolidated = consolidateRainfallPrompts(messages, actionable, lastInteractive);
    return {
      messages: consolidateLivestockMessages(consolidated.messages, actionable),
      lastSideEffects,
      stoppedAtFlow,
      lastInteractive: consolidated.interactive ?? lastInteractive,
      lastAttachment,
      lastSuggestionKey,
    };
  }
}

/**
 * When a compound action has multiple log_rainfall steps that all need a
 * field choice (no field passed, multiple fields exist), merge their
 * "Llovieron Xmm 🌧️ ¿En qué campo?" prompts into a single buttoned message.
 * The button callback is `rain_batch_<field>_<base64payload>` carrying all
 * mm/date pairs so the interactive handler can persist them in one shot.
 */
function consolidateRainfallPrompts(
  messages: string[],
  actionable: ParseResult[],
  lastInteractive: HandlerResponse['interactive'],
): { messages: string[]; interactive: HandlerResponse['interactive'] } {
  const rainCommands: ParsedCommand[] = [];
  for (const r of actionable) {
    if (r.intent.type !== 'command') continue;
    if (r.intent.data.command !== 'log_rainfall') continue;
    rainCommands.push(r.intent.data);
  }
  if (rainCommands.length < 2) return { messages, interactive: lastInteractive };

  // Find rainfall ask-prompts in messages (one per step that needed field)
  const askIndices: number[] = [];
  messages.forEach((m, i) => {
    if (/^Llovieron \*\d+(?:\.\d+)?mm\* 🌧️ ¿En qué campo\?$/.test(m)) askIndices.push(i);
  });
  if (askIndices.length < 2) return { messages, interactive: lastInteractive };

  // Build payload: list of (mm, eventDate) for each pending rainfall
  const items = rainCommands.map(d => ({
    mm: Number(d.mm ?? d.quantity ?? 0),
    date: typeof d.eventDate === 'string' ? d.eventDate : null,
  })).filter(it => it.mm > 0);
  if (items.length < 2) return { messages, interactive: lastInteractive };

  // Take the existing buttons from lastInteractive (they have the field names)
  const fieldNames: string[] = [];
  if (lastInteractive && lastInteractive.type === 'buttons' && Array.isArray(lastInteractive.buttons)) {
    for (const b of lastInteractive.buttons) {
      const m = b.id.match(/^rain_field_(.+)_\d+(?:\.\d+)?$/);
      if (m) fieldNames.push(m[1]);
    }
  }
  if (fieldNames.length === 0) return { messages, interactive: lastInteractive };

  const summary = items
    .map(it => {
      const dateLabel = it.date
        ? new Date(it.date + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' })
        : '';
      return dateLabel ? `${it.mm}mm el ${dateLabel}` : `${it.mm}mm`;
    })
    .join(', ');

  const payloadB64 = Buffer.from(JSON.stringify(items)).toString('base64url');
  const buttons = fieldNames.slice(0, 3).map(name => ({
    id: `rain_batch_${name}_${payloadB64}`,
    title: name.slice(0, 20),
  }));

  // Replace all "¿En qué campo?" prompts with a single consolidated message
  const filtered = messages.filter((_, i) => !askIndices.includes(i));
  filtered.push(`🌧️ Registré ${items.length} lluvias (${summary}). ¿En qué campo?`);

  return {
    messages: filtered,
    interactive: { type: 'buttons' as const, body: 'Elegí el campo:', buttons },
  };
}

/**
 * When a compound action has multiple livestock steps for the same plot
 * (e.g. add_livestock vaca + add_livestock ternero), merge them into
 * a single user-friendly message so the user sees one confirmation.
 */
function consolidateLivestockMessages(
  messages: string[],
  actionable: ParseResult[],
): string[] {
  // Only consolidate when ALL steps are livestock commands
  const livestockSteps = actionable.filter(r =>
    r.intent.type === 'command' && LIVESTOCK_COMMANDS.has((r.intent.data as ParsedCommand).command),
  );
  if (livestockSteps.length < 2 || livestockSteps.length !== actionable.length) return messages;
  if (messages.length < 2) return messages;

  // Extract per-step info from the ParseResults
  interface StepInfo { category: string; count: number; plotName: string; fieldName: string; command: string }
  const steps: StepInfo[] = livestockSteps.map(r => {
    const d = r.intent.data as ParsedCommand;
    const cat = (d.category as string) || '';
    const label = LIVESTOCK_CATEGORY_LABEL[cat as LivestockCategory] || cat;
    return {
      category: label,
      count: (d.count as number) || 0,
      plotName: (d.plotName as string) || '',
      fieldName: (d.fieldName as string) || '',
      command: d.command,
    };
  });

  // Only merge if all steps target the same plot
  const plots = new Set(steps.map(s => s.plotName.toLowerCase()));
  if (plots.size > 1) return messages;

  const plotName = steps[0].plotName || '—';
  const fieldName = steps[0].fieldName || '';

  // Build one consolidated message
  const emoji = steps.some(s => s.command === 'record_livestock_birth') ? '🐣' : '🐄';
  const header = steps.some(s => s.command === 'record_livestock_birth')
    ? 'Nacimiento registrado'
    : 'Hacienda actualizada';

  const lines = steps.map(s => {
    const sign = s.command === 'remove_livestock' || s.command === 'record_livestock_death' ? '➖' : '➕';
    return `  ${sign} ${s.count} ${s.category}`;
  });

  const locationLine = fieldName ? `📍 ${plotName} (${fieldName})` : `📍 ${plotName}`;

  return [
    `${emoji} *${header}*\n\n${lines.join('\n')}\n  ${locationLine}`,
  ];
}
