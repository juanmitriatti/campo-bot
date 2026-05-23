import { DomainRouter } from './router.js';
import { logError } from '../services/error-logger.js';
import { withTransaction, pool } from '../config/db.js';
import type { FinancialHandler } from './financial/financial.handler.js';
import type { ParseResult, ParsedCommand, ParsedExpense, ParsedIncome, UserId, User, UserSettings, HandlerResponse, InteractiveMessage } from '../types/index.js';
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

/** Intent types that are "partial" (missing amount/price) — surfaced after the compound
 *  with a "💡 falta el precio de X" message + pending action wired into the unified
 *  pending system so the user's next message completes the registration. */
const PARTIAL_TYPES = new Set(['expense_partial', 'income_partial']);

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
    // Split into executable steps vs partials (missing amount/price).
    const actionable = results.filter(r => COMPOUND_TYPES.has(r.intent.type));
    const partials = results.filter(r => PARTIAL_TYPES.has(r.intent.type));
    // Activate compound flow if there are 2+ actionables, OR a mix of actionable + partial.
    // (One actionable alone is the single-action path; one partial alone is handled by the
    //  controller's standard intent path. Mixed = the user's "vendí X y vendí Y [no price]" case.)
    if (actionable.length + partials.length <= 1) return null;
    if (actionable.length === 0 && partials.length === 0) return null;

    try {
      return await withTransaction(async () =>
        this._runSteps(actionable, partials, userId, user, settings, originalText),
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
    partials: ParseResult[],
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
    // Bulk plot tracking: every handleExpense/handleIncome that saved in bulk
    // mode WITHOUT a plot (field has 2+ plots) emits savedFinanceWithoutPlot.
    // We collect across steps and append a single "¿a qué lote los asigno?"
    // prompt at the end so the user can assign all of them with one tap.
    const bulkSaved: Array<{ kind: 'expense' | 'income'; id: number; fieldId: number }> = [];

    // Force skip confirmation for expenses/incomes in compound context
    const noConfirmSettings = { ...settings, confirm_before_save: false };

    // Bulk mode: ANY compound action with 2+ writes triggers bulk semantics —
    // handlers should NOT stop the train asking for missing plot/category/etc.
    // Instead they save what they can (at field or user level), defer prompts,
    // and the post-compound bulk-plot handler asks ONCE at the end.
    // Previously this was financialWriteCount>=2 which left non-financial
    // compounds (e.g. spray + sow + observation) stopping at the first flow.
    const bulkMode = actionable.length >= 2;

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
        response = await this.router.routeCommand(data, userId, user, settings, bulkMode);
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
      if (response.savedFinanceWithoutPlot) bulkSaved.push(response.savedFinanceWithoutPlot);

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
    let finalMessages = consolidateLivestockMessages(consolidated.messages, actionable);
    let finalInteractive = consolidated.interactive ?? lastInteractive;

    // Fix B — surface income_partial / expense_partial that the agent fired
    // without a price. Append a clear "💡 falta el precio de X" line per
    // partial AND wire ONE pending action (first partial) so the user's next
    // message gets routed through the unified pending system to complete it.
    if (partials.length > 0 && !stoppedAtFlow) {
      for (const p of partials) {
        finalMessages.push(buildPartialMessage(p));
      }
      const pendingFromPartial = buildPendingFromFirstPartial(partials);
      if (pendingFromPartial && !lastSideEffects?.setPendingActivity) {
        lastSideEffects = { ...(lastSideEffects ?? {}), setPendingActivity: pendingFromPartial };
      }
    }

    // Fix A — when bulk mode saved 1+ records WITHOUT plot, ask once at the
    // end "¿A qué lote los asigno?" with buttons/list. Single tap updates
    // all of them via the assign_bulk_plot command.
    if (bulkSaved.length > 0 && !stoppedAtFlow) {
      const plotPrompt = await this.buildBulkPlotPrompt(bulkSaved, userId);
      if (plotPrompt) {
        finalMessages.push(plotPrompt.message);
        // Bulk-plot interactive replaces any prior interactive: the prompt
        // is the user's next-step UI, and any leftover interactive from a
        // step (e.g. stock dedup) would be stale at this point.
        finalInteractive = plotPrompt.interactive;
      }
    }

    return {
      messages: finalMessages,
      lastSideEffects,
      stoppedAtFlow,
      lastInteractive: finalInteractive,
      lastAttachment,
      lastSuggestionKey,
    };
  }

  /**
   * Build the "¿A qué lote los asigno?" prompt. Works across multiple fields:
   * if all bulk-saved records share one fieldId, the buttons/list use that
   * field's plots. If they span multiple fields, fall back to all user plots
   * (still tag with field name for clarity).
   *
   * Returns null when no useful prompt can be built (field unknown, or only
   * one plot exists — in that case auto-resolve already happened).
   */
  private async buildBulkPlotPrompt(
    bulkSaved: Array<{ kind: 'expense' | 'income'; id: number; fieldId: number }>,
    userId: UserId,
  ): Promise<{ message: string; interactive: InteractiveMessage } | null> {
    const fieldIds = Array.from(new Set(bulkSaved.map(s => s.fieldId)));
    if (fieldIds.length !== 1) return null; // Multi-field: skip the prompt, user can edit later
    const fieldId = fieldIds[0];

    const plotsRes = await pool.query(
      `SELECT id, name FROM plots WHERE field_id = $1 AND deleted_at IS NULL ORDER BY name`,
      [fieldId],
    );
    const plots = plotsRes.rows as Array<{ id: number; name: string }>;
    if (plots.length < 2) return null; // Should have been auto-resolved upstream

    const fieldRes = await pool.query(
      `SELECT name FROM fields WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [fieldId, userId],
    );
    const fieldName = (fieldRes.rows[0]?.name as string) ?? 'el campo';

    const eIds = bulkSaved.filter(s => s.kind === 'expense').map(s => s.id);
    const iIds = bulkSaved.filter(s => s.kind === 'income').map(s => s.id);
    const eIdsStr = eIds.join(',') || 'n';
    const iIdsStr = iIds.join(',') || 'n';

    const summary = [
      iIds.length > 0 ? `${iIds.length} ingreso${iIds.length === 1 ? '' : 's'}` : null,
      eIds.length > 0 ? `${eIds.length} gasto${eIds.length === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' + ');
    const body = `💡 Guardé ${summary} a nivel campo *${fieldName}*. ¿A qué lote los asigno?`;

    // Each button id: bap_<plotId>_<expenseIds>_<incomeIds>. Plot "0" + "n" markers
    // mean "leave at field level".
    const optionRows = [
      ...plots.map(p => ({ id: `bap_${p.id}_${eIdsStr}_${iIdsStr}`, title: p.name.slice(0, 24) })),
      { id: `bap_0_${eIdsStr}_${iIdsStr}`, title: 'Dejar a nivel campo' },
    ];

    // WhatsApp buttons cap at 3. Use list when there are more plots.
    if (optionRows.length <= 3) {
      return {
        message: body,
        interactive: {
          type: 'buttons',
          body: '¿A qué lote?',
          buttons: optionRows.map(r => ({ id: r.id, title: r.title.slice(0, 20) })),
        },
      };
    }
    return {
      message: body,
      interactive: {
        type: 'list',
        body: '¿A qué lote?',
        buttonText: 'Elegir',
        sections: [{
          title: 'Lotes',
          rows: optionRows.map(r => ({ id: r.id, title: r.title })),
        }],
      },
    };
  }
}

/**
 * Compose a "💡 No registré X — me falta el precio" message for a partial
 * income/expense parse result. Stays short + accurate even when category is
 * empty (uses "la venta" / "el gasto" fallback).
 */
function buildPartialMessage(p: ParseResult): string {
  const data = ((p.intent as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
  const isIncome = p.intent.type === 'income_partial';
  const verb = isIncome ? 'No registré' : 'No anoté';
  const label = (data.category as string) || (isIncome ? 'la venta' : 'el gasto');
  const qty = typeof data.quantity === 'number' ? data.quantity : null;
  const unit = typeof data.unit === 'string' ? data.unit : null;
  const qtyLabel = qty != null && unit ? ` (${qty} ${unit})` : '';
  return `💡 ${verb} *${label}*${qtyLabel} — me falta el precio. Decímelo y lo guardo.`;
}

/**
 * Wire the FIRST partial into the unified pending action system so the user's
 * next message (e.g. "900 dolares" or "900") completes the registration. We
 * limit to ONE pending because pendingActStore holds a single entry per user;
 * if multiple partials, the rest are informed via message but the user has to
 * re-type them. Trade-off in favor of simplicity.
 */
function buildPendingFromFirstPartial(partials: ParseResult[]): NonNullable<HandlerResponse['sideEffects']>['setPendingActivity'] | null {
  if (partials.length === 0) return null;
  const p = partials[0];
  const data = ((p.intent as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
  const isIncome = p.intent.type === 'income_partial';
  const command = isIncome ? 'log_income' : 'log_expense';
  const cat = (data.category as string) || (isIncome ? 'la venta' : 'el gasto');
  return {
    command,
    data: { ...data },
    missing: ['amount'],
    askPrompt: `¿Cuánto cobraste por *${cat}*? (decime el monto o el precio por unidad)`,
  };
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
