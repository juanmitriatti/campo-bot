import { DomainRouter } from './router.js';
import { logError } from '../services/error-logger.js';
import { withTransaction } from '../config/db.js';
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

    try {
      return await withTransaction(async () =>
        this._runSteps(actionable, userId, user, settings, originalText),
      );
    } catch (err) {
      const label = err instanceof Error ? err.message : String(err);
      console.error('[COMPOUND] Transaction rolled back:', label);
      logError('compound', 'TX_ROLLBACK', err as Error, { userId });
      return {
        messages: [
          '❌ No pude registrar todas las acciones del mensaje. Ningún dato quedó guardado. Probá de nuevo o registralo en mensajes separados.',
        ],
        lastSideEffects: undefined,
        stoppedAtFlow: false,
        lastInteractive: undefined,
        lastAttachment: undefined,
        lastSuggestionKey: undefined,
      };
    }
  }

  private async _runSteps(
    actionableIn: ParseResult[],
    userId: UserId,
    user: User,
    settings: UserSettings,
    originalText?: string,
  ): Promise<CompoundResult> {
    let actionable = actionableIn;
    const messages: string[] = [];
    let lastSideEffects: HandlerResponse['sideEffects'];
    let lastInteractive: HandlerResponse['interactive'];
    let lastAttachment: HandlerResponse['attachment'];
    let lastSuggestionKey: string | undefined;
    let stoppedAtFlow = false;

    // Force skip confirmation for expenses/incomes in compound context
    const noConfirmSettings = { ...settings, confirm_before_save: false };

    // Bulk mode: when the compound has 2+ financial writes, handlers should
    // skip the "¿En qué lote?" pending flow and save at field/user level instead
    // of stopping the whole compound for one missing plot. The plot can be
    // assigned later via edit_last_expense.
    const financialWriteCount = actionable.filter((s) =>
      s.intent.type === 'expense' || s.intent.type === 'income'
    ).length;
    const bulkMode = financialWriteCount >= 2;

    // Pre-execution consolidation: when the agent fires multiple log_rainfall
    // calls for the SAME field on different dates ("8mm el lunes, 14mm el martes,
    // 5mm anoche en La Esperanza"), collapse them into one log_rainfall_batch
    // call so the dedup logic doesn't reject day-2 and day-3.
    actionable = consolidateSameFieldRainfalls(actionable);

    // Drop exact-duplicate steps (same command + same key params). The agent
    // sometimes fires the SAME tool twice in a single compound — Roberto's
    // chaos run had two identical log_spraying calls in the same response,
    // producing duplicated UI confirmations and double-prompting the user
    // for stock deduction. Dedup is keyed on command + plot + product +
    // quantity + unit + amount/category, which covers the cases that matter
    // (sprays, fertilizations, expenses, incomes, livestock movements).
    const seen = new Set<string>();
    const deduped: ParseResult[] = [];
    for (const step of actionable) {
      const data = (step.intent.data || {}) as Record<string, unknown>;
      const fp = JSON.stringify([
        step.intent.type,
        data.command ?? '',
        data.plotName ?? data.plot ?? '',
        data.fieldName ?? data.field ?? '',
        data.product ?? '',
        data.quantity ?? '',
        data.unit ?? '',
        data.amount ?? '',
        data.category ?? '',
        data.crop ?? '',
        data.count ?? '',
      ]);
      if (seen.has(fp)) continue;
      seen.add(fp);
      deduped.push(step);
    }

    // Reorder: writes (mutations) BEFORE reads (queries). When the agent
    // fires "compré urea + dame el resumen" in compound, the agent may emit
    // them in the WRONG order — read first, then write — and the report
    // returns stale state without the just-created expense. Forcing writes
    // first ensures the report query sees the new row (within the same
    // withTransaction). Within each group we preserve the original order.
    const READ_ONLY_TOOLS = new Set([
      'financial_report', 'monthly_result', 'field_result', 'compare_months',
      'weekly_report', 'monthly_report', 'field_report', 'plot_report',
      'date_range_report', 'monthly_summary',
      'campaign_stats', 'compare_campaigns', 'crop_history', 'active_crop',
      'query_plot_history', 'plot_activities', 'activity_stats',
      'check_stock', 'stock_history', 'check_low_stock', 'list_warehouses',
      'list_fields', 'list_plots', 'plot_info', 'field_info',
      'list_livestock', 'livestock_history',
      'tacto_summary', 'query_health_events', 'query_repro_events',
      'query_weighings', 'query_scoutings', 'query_harvest_loads',
      'rainfall_report', 'rainfall_range', 'compare_rainfall_months',
      'compare_rainfall_years',
      'list_documents', 'list_field_members',
      'weather_full', 'weather_forecast', 'weather_field', 'weather_all',
      'generate_agro_report', 'show_reports_menu',
    ]);
    const isRead = (s: ParseResult) => {
      const data = (s.intent.data || {}) as Record<string, unknown>;
      const cmd = (data.command as string) || '';
      return READ_ONLY_TOOLS.has(cmd);
    };
    const writes = deduped.filter(s => !isRead(s));
    const reads = deduped.filter(s => isRead(s));
    const ordered = [...writes, ...reads];

    for (const step of ordered) {
      let response: HandlerResponse | null = null;

      if (step.intent.type === 'command') {
        const data = step.intent.data as ParsedCommand;
        if (originalText) data.originalText = originalText;
        response = await this.router.routeCommand(data, userId, user, settings);
      } else if (step.intent.type === 'expense' && this.financialHandler) {
        const expData = step.intent.data as ParsedExpense & { field?: string; plot?: string };
        response = await this.financialHandler.handleExpense(
          userId, expData, originalText ?? '', noConfirmSettings, user,
          expData.field, expData.plot, bulkMode,
        );
      } else if (step.intent.type === 'income' && this.financialHandler) {
        const incData = step.intent.data as ParsedIncome & { field?: string; plot?: string };
        response = await this.financialHandler.handleIncome(
          userId, incData, originalText ?? '', noConfirmSettings,
          incData.field, incData.plot, bulkMode,
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

  // Replace all "¿En qué campo?" prompts with a single consolidated message
  const filtered = messages.filter((_, i) => !askIndices.includes(i));
  const consolidatedMsg = `🌧️ Registré ${items.length} lluvias (${summary}). ¿En qué campo?`;
  filtered.push(consolidatedMsg);

  // Buttons cap at 3 on WhatsApp; switch to a list when the user has more.
  if (fieldNames.length <= 3) {
    const buttons = fieldNames.map(name => ({
      id: `rain_batch_${name}_${payloadB64}`,
      title: name.slice(0, 20),
    }));
    return {
      messages: filtered,
      interactive: { type: 'buttons' as const, body: 'Elegí el campo:', buttons },
    };
  }
  return {
    messages: filtered,
    interactive: {
      type: 'list' as const,
      body: 'Elegí el campo:',
      buttonText: 'Elegir campo',
      sections: [{
        title: 'Tus campos',
        rows: fieldNames.slice(0, 10).map(name => ({
          id: `rain_batch_${name}_${payloadB64}`,
          title: name.substring(0, 24),
        })),
      }],
    },
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

/**
 * Pre-execution consolidation: when the agent emits multiple log_rainfall steps
 * targeting the SAME field on different dates ("8mm el lunes, 14mm el martes, 5mm
 * anoche en La Esperanza"), collapse them into one log_rainfall_batch step. Without
 * this, the first call succeeds and the rest hit the same-day dedup or get noisy
 * "ya hay un registro" messages mid-compound.
 */
function consolidateSameFieldRainfalls(actionable: ParseResult[]): ParseResult[] {
  const rainSteps: { idx: number; data: ParsedCommand }[] = [];
  actionable.forEach((r, idx) => {
    if (r.intent.type === 'command' && (r.intent.data as ParsedCommand).command === 'log_rainfall') {
      rainSteps.push({ idx, data: r.intent.data as ParsedCommand });
    }
  });
  if (rainSteps.length < 2) return actionable;

  // Group by fieldName (must be set on ALL of them; if any lacks field, leave to
  // the post-execution consolidator that handles the ask-prompt path).
  const allHaveField = rainSteps.every(s => typeof s.data.fieldName === 'string' && s.data.fieldName.length > 0);
  if (!allHaveField) return actionable;

  const firstField = (rainSteps[0].data.fieldName as string).toLowerCase().trim();
  const sameField = rainSteps.every(s => (s.data.fieldName as string).toLowerCase().trim() === firstField);
  if (!sameField) return actionable;

  // Build the batch step and replace ALL rainfall steps with a single batch step
  // at the position of the first one.
  const items = rainSteps.map(s => ({
    mm: Number(s.data.mm ?? s.data.quantity ?? 0),
    date: typeof s.data.eventDate === 'string' ? s.data.eventDate : null,
  })).filter(it => it.mm > 0);
  if (items.length < 2) return actionable;

  const batchStep: ParseResult = {
    intent: {
      type: 'command',
      data: {
        command: 'log_rainfall_batch',
        fieldName: rainSteps[0].data.fieldName,
        items,
      } as ParsedCommand,
    },
    confidence: 1,
    aiUsed: true,
    source: 'ai',
    missingFields: [],
  };

  const rainIdxSet = new Set(rainSteps.map(s => s.idx));
  const result: ParseResult[] = [];
  let inserted = false;
  actionable.forEach((r, idx) => {
    if (rainIdxSet.has(idx)) {
      if (!inserted) {
        result.push(batchStep);
        inserted = true;
      }
      return;
    }
    result.push(r);
  });
  return result;
}
