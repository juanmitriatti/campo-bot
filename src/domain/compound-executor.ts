import { DomainRouter } from './router.js';
import { callbackPayloadStore } from '../middleware/callback-payload-store.js';
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
    // Bulk plot tracking: any handler that saved in bulkMode WITHOUT a plot
    // emits savedRecordsWithoutPlot. We collect across steps and append a
    // single "¿a qué lote los asigno?" prompt at the end so the user can
    // assign all of them — across kinds: expense, income, activity, livestock,
    // observation, scouting, etc. — with one tap.
    type BulkRec = { kind: 'expense' | 'income' | 'activity' | 'observation' | 'scouting' | 'livestock' | 'rainfall' | 'stock_movement'; id: number; fieldId: number };
    const bulkSaved: BulkRec[] = [];
    // Cola de hectáreas ACUMULADA entre pasos: cada add_plot suelto emite su
    // setPendingPlotArea individual, pero el pipeline solo aplica
    // lastSideEffects — con N add_plot en compound sobrevivía únicamente el
    // pending del ÚLTIMO lote y los demás se pisaban en silencio (visto en
    // prod Jul 18: "campo con lotes Norte y Sur" preguntó solo Sur). Se
    // juntan acá y al final se promueven como setPendingPlotAreaQueue (la
    // cola serial que add_plots_batch ya usa).
    const plotAreaQueue: Array<{ plotId: number; plotName: string; fieldName: string }> = [];
    // Serial pending queue: when multiple items in the compound need follow-up
    // (partials with missing price, handlers that returned setPendingActivity
    // before the interceptor stripped it), we collect them all and process
    // serially in the next turns — one item at a time, so the user's answers
    // can't conflate across items.
    type QueueItem = { command: string; data: Record<string, unknown>; missing?: string[]; askPrompt?: string };
    const pendingQueue: QueueItem[] = [];

    // Force skip confirmation for expenses/incomes in compound context
    const noConfirmSettings = { ...settings, confirm_before_save: false };

    // Bulk mode: ANY compound action with 2+ items (actionable OR partials)
    // triggers bulk semantics — handlers should NOT stop the train asking for
    // missing plot/category/etc. Counting partials too is critical: when a
    // compound is [complete income, partial income], without including the
    // partial we'd get bulkMode=false, and the complete income would trigger
    // its own "¿En qué lote?" flow that eats the user's next reply intended
    // for the partial. That defeats the serial queue. See test
    // 06_2x_venta_one_no_price in qa-repeated-combos-20.
    const bulkMode = actionable.length + partials.length >= 2;

    // Pre-execution consolidation: when the agent fires multiple log_rainfall
    // calls for the SAME field on different dates ("8mm el lunes, 14mm el martes,
    // 5mm anoche en La Esperanza"), collapse them into one log_rainfall_batch
    // call so the dedup logic doesn't reject day-2 and day-3.
    actionable = await consolidateSameFieldRainfalls(actionable, userId);

    // Drop exact-duplicate steps (same command + same key params). The agent
    // sometimes fires the SAME tool twice in a single compound — Roberto's
    // chaos run had two identical log_spraying calls in the same response,
    // producing duplicated UI confirmations and double-prompting the user
    // for stock deduction. Dedup is keyed on command + plot + product +
    // quantity + unit + amount/category, which covers the cases that matter
    // (sprays, fertilizations, expenses, incomes, livestock movements).
    // Fingerprint = intent type + the FULL normalized command data (every
    // meaningful field), not a hardcoded subset. The old subset missed fields
    // like disease/vaccine, avg_weight_kg, animal_category, dose, etc., so two
    // identical vacunaciones deduped correctly but a single price/weight that
    // differed between otherwise-similar tools could be wrongly collapsed —
    // and, worse, a NEW field (any future tool) would never enter the key.
    // Hashing the whole payload makes dedup exact: identical → dropped,
    // anything different in ANY field → kept. Internal flags (keys starting
    // with "_", e.g. _bulkMode) are volatile and excluded.
    // Volatile/descriptive fields that don't change the IDENTITY of a write —
    // the agent often fills them on one duplicate but not the other (e.g. a
    // `reason`/`notes` on the first add_livestock only), which would otherwise
    // defeat dedup and double-count. Two writes that match on everything except
    // these ARE the same action.
    const VOLATILE_KEYS = new Set([
      'reason', 'notes', 'description', 'isPurchase', 'isSale',
      'is_purchase', 'is_sale', 'category_match', 'confidence',
    ]);
    const seen = new Set<string>();
    const deduped: ParseResult[] = [];
    for (const step of actionable) {
      const data = (step.intent.data || {}) as Record<string, unknown>;
      const stable: Record<string, unknown> = {};
      for (const key of Object.keys(data).sort()) {
        if (key.startsWith('_') || VOLATILE_KEYS.has(key)) continue;
        const v = data[key];
        if (v === undefined || v === null || v === '') continue;
        stable[key] = v;
      }
      const fp = JSON.stringify([step.intent.type, stable]);
      if (seen.has(fp)) continue;
      seen.add(fp);
      deduped.push(step);
    }

    // Livestock-add de-duplication: "N vacas con M terneros" makes the agent
    // sometimes emit add_livestock for the FIRST category TWICE (once with a
    // plot, once without), which the generic dedup misses (they differ on the
    // plot field) → the mother category gets double-counted (vaca=160). Two
    // add_livestock with the same category+breed+count in ONE message are a
    // duplicate unless they target DIFFERENT explicit plots — a farmer dictating
    // one message never means "add 80 vacas, then another 80 vacas" to the same
    // place. Collapse them, preferring the step that carries an explicit plot.
    {
      const addKey = (s: ParseResult): string | null => {
        const d = (s.intent.data || {}) as Record<string, unknown>;
        if (d.command !== 'add_livestock') return null;
        return [d.category ?? '', d.breed ?? '', d.count ?? '', d.corralName ?? d.corral ?? ''].join('|');
      };
      const explicitPlot = (s: ParseResult): string => {
        const d = (s.intent.data || {}) as Record<string, unknown>;
        return String(d.plotName ?? d.plot ?? '');
      };
      const byKey = new Map<string, ParseResult[]>();
      for (const s of deduped) {
        const k = addKey(s);
        if (k) { (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(s); }
      }
      const drop = new Set<ParseResult>();
      for (const group of byKey.values()) {
        if (group.length < 2) continue;
        const plots = new Set(group.map(explicitPlot).filter(p => p !== ''));
        // More than one DISTINCT explicit plot → genuinely different adds, keep all.
        if (plots.size > 1) continue;
        // Same (or unspecified) destination → duplicates. Keep the one WITH an
        // explicit plot if any, drop the rest.
        const keep = group.find(s => explicitPlot(s) !== '') ?? group[0];
        for (const s of group) if (s !== keep) drop.add(s);
      }
      if (drop.size > 0) {
        for (let i = deduped.length - 1; i >= 0; i--) if (drop.has(deduped[i])) deduped.splice(i, 1);
      }
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
      'agronomy_question',
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

      // bulkMode interceptor: if a non-financial handler tried to STOP the
      // compound (startFlow / setPendingActivity / setPendingObservation),
      // strip those side-effects from the immediate response (so the compound
      // doesn't stop). When the handler returned a setPendingActivity with
      // missing-slot info, CAPTURE it into the serial pendingQueue — the
      // controller will surface its askPrompt AFTER the current pending
      // completes (or as the lead item if there's no current).
      // For startFlow / setPendingObservation (which can't be merged into the
      // pending-action processor), just inject a "💡 no pude" advisory.
      if (bulkMode && response.sideEffects) {
        const se = response.sideEffects;
        const wouldBlock = !!(se.startFlow || se.setPendingActivity || se.setPendingObservation);
        if (wouldBlock) {
          const stepCommand = (step.intent.type === 'command'
            ? (step.intent.data as ParsedCommand).command
            : step.intent.type) ?? 'acción';
          // Capture the setPendingActivity into the queue (recoverable: user
          // can answer the missing slots in a future turn). Tag the askPrompt
          // with the action context so the user knows which item is being
          // asked about.
          if (se.setPendingActivity) {
            const pa = se.setPendingActivity;
            const contextLabel = describeQueueItem(stepCommand, pa.data);
            pendingQueue.push({
              command: pa.command,
              data: pa.data,
              missing: pa.missing,
              askPrompt: contextLabel ? `👇 ${contextLabel}: ${pa.askPrompt ?? 'me faltan datos'}` : pa.askPrompt,
            });
          } else {
            // startFlow / setPendingObservation: can't queue (different
            // mechanism). Just advise the user.
            messages.push(`💡 No pude completar *${stepCommand}* automáticamente — me faltan datos. Después podés repetirla aclarando lote/producto/cantidad.`);
          }
          // Drop blocking sideEffects AND clear messages/interactive that
          // carried the prompt — otherwise the user sees both the captured
          // ask AND the original handler's blocking question.
          response = {
            ...response,
            messages: [], // suppress the handler's own prompt
            interactive: undefined,
            sideEffects: {
              ...se,
              startFlow: undefined,
              setPendingActivity: undefined,
              setPendingObservation: undefined,
            },
          };
        }
      }

      messages.push(...response.messages);
      if (response.interactive) lastInteractive = response.interactive;
      if (response.attachment) lastAttachment = response.attachment;
      if (response.suggestionKey) lastSuggestionKey = response.suggestionKey;
      // Legacy single-record shape (handleExpense/handleIncome).
      if (response.savedFinanceWithoutPlot) bulkSaved.push(response.savedFinanceWithoutPlot);
      // New multi-record shape: any handler can push 0..N records.
      if (response.savedRecordsWithoutPlot) bulkSaved.push(...response.savedRecordsWithoutPlot);
      // Hectáreas: acumular los pendings de CADA paso (single o queue) — sin
      // esto, N add_plot en compound solo preguntaba el último lote.
      if (response.sideEffects?.setPendingPlotArea) plotAreaQueue.push(response.sideEffects.setPendingPlotArea);
      if (response.sideEffects?.setPendingPlotAreaQueue) plotAreaQueue.push(...response.sideEffects.setPendingPlotAreaQueue);

      // If this step triggers a flow, stop here — flow needs user input.
      // (After the bulkMode interceptor above, this branch only fires for
      //  non-bulk paths or for flows the interceptor couldn't strip.)
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

    // Surface income_partial / expense_partial: queue each one (NOT just the
    // first) so they get processed serially. Each partial becomes its own
    // queue item with context-tagged askPrompt.
    if (partials.length > 0 && !stoppedAtFlow) {
      for (const p of partials) {
        const data = ((p.intent as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
        const isIncome = p.intent.type === 'income_partial';
        const cat = (data.category as string) || (isIncome ? 'la venta' : 'el gasto');
        const qty = typeof data.quantity === 'number' ? data.quantity : null;
        const unit = typeof data.unit === 'string' ? data.unit : null;
        const qtyTag = qty != null && unit ? ` (${qty} ${unit})` : '';
        pendingQueue.push({
          command: isIncome ? 'log_income' : 'log_expense',
          data: { ...data },
          missing: ['amount'],
          askPrompt: `👇 ${isIncome ? 'Venta' : 'Gasto'} de *${cat}*${qtyTag}: ¿cuánto fue el precio?`,
        });
      }
    }

    // Promote la cola de hectáreas acumulada: pisa cualquier single del último
    // paso (la cola contiene TODOS los lotes, incluido ese). El pipeline la
    // aplica via storePlotAreaSideEffects → pregunta lote por lote.
    if (plotAreaQueue.length > 0 && !stoppedAtFlow) {
      if (plotAreaQueue.length > 1) {
        console.log(`[compound] plot-area queue: ${plotAreaQueue.length} lotes acumulados (${plotAreaQueue.map(p => p.plotName).join(', ')})`);
      }
      lastSideEffects = { ...(lastSideEffects ?? {}) };
      delete lastSideEffects.setPendingPlotArea;
      lastSideEffects.setPendingPlotAreaQueue = plotAreaQueue;
    }

    // Promote the queue into setPendingActivity: first item is current pending,
    // the rest waits in `nextInQueue`. When the user answers the current item
    // and it re-routes successfully, the controller pops the next from the
    // queue and asks its question. Repeats until empty.
    if (pendingQueue.length > 0 && !stoppedAtFlow && !lastSideEffects?.setPendingActivity) {
      const [first, ...rest] = pendingQueue;
      // Lead announcement so the user knows multiple items are pending.
      if (pendingQueue.length > 1) {
        finalMessages.push(`💡 Tengo *${pendingQueue.length} acciones pendientes* — te las pregunto una por una.`);
      }
      // Show the FIRST item's askPrompt RIGHT NOW so the user knows what to
      // answer. Controllers store the pending but only display the askPrompt
      // when the queue ADVANCES — for the leading item we need to surface it
      // here, in the compound's own response messages.
      if (first.askPrompt) finalMessages.push(first.askPrompt);
      lastSideEffects = {
        ...(lastSideEffects ?? {}),
        setPendingActivity: {
          command: first.command,
          data: first.data,
          missing: first.missing,
          askPrompt: first.askPrompt,
          ...(rest.length > 0 ? { nextInQueue: rest } : {}),
        },
      };
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
   * Build the "¿A qué lote los asigno?" prompt. Works across:
   *   - any kind (expense, income, activity, livestock, observation, scouting)
   *   - any count of records of any kind (encoded via base64 payload, no 256-char limit risk)
   * Returns null when no useful prompt can be built (multi-field, or only
   * one plot exists — in that case the handlers auto-resolved already).
   */
  private async buildBulkPlotPrompt(
    bulkSaved: Array<{ kind: string; id: number; fieldId: number }>,
    userId: UserId,
  ): Promise<{ message: string; interactive: InteractiveMessage } | null> {
    const fieldIds = Array.from(new Set(bulkSaved.map(s => s.fieldId).filter(id => id > 0)));
    if (fieldIds.length !== 1) return null;
    const fieldId = fieldIds[0];

    const plotsRes = await pool.query(
      `SELECT id, name FROM plots WHERE field_id = $1 AND deleted_at IS NULL ORDER BY name`,
      [fieldId],
    );
    const plots = plotsRes.rows as Array<{ id: number; name: string }>;
    if (plots.length < 2) return null;

    const fieldRes = await pool.query(
      `SELECT name FROM fields WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [fieldId, userId],
    );
    const fieldName = (fieldRes.rows[0]?.name as string) ?? 'el campo';

    // Group ids by kind so the button callback can route each kind to the
    // right UPDATE statement.
    const byKind: Record<string, number[]> = {};
    for (const r of bulkSaved) {
      (byKind[r.kind] ?? (byKind[r.kind] = [])).push(r.id);
    }

    // Human-readable summary line per kind.
    const KIND_LABEL: Record<string, [string, string]> = {
      expense: ['gasto', 'gastos'],
      income: ['ingreso', 'ingresos'],
      activity: ['actividad', 'actividades'],
      observation: ['observación', 'observaciones'],
      scouting: ['monitoreo', 'monitoreos'],
      livestock: ['movimiento de hacienda', 'movimientos de hacienda'],
      rainfall: ['lluvia', 'lluvias'],
      stock_movement: ['movimiento de stock', 'movimientos de stock'],
    };
    const summaryParts: string[] = [];
    for (const [kind, ids] of Object.entries(byKind)) {
      const labels = KIND_LABEL[kind] ?? [kind, `${kind}s`];
      summaryParts.push(`${ids.length} ${ids.length === 1 ? labels[0] : labels[1]}`);
    }
    const summary = summaryParts.join(' + ');
    const body = `💡 Guardé ${summary} a nivel campo *${fieldName}*. ¿A qué lote los asigno?`;

    // Encode payload as base64 and register it in the callbackPayloadStore,
    // embedding only the short token (~8 chars) in callback_data. Telegram caps
    // callback_data at 64 BYTES — inline base64 with 3+ records overflowed it
    // and the sendMessage fallaba con HTTP 400 silencioso (el usuario no veía
    // los botones). Format: bap2_<token>_<plotId>. The router resolves token →
    // payload via callbackPayloadStore (with inline-base64 fallback for any
    // in-flight buttons rendered before this change).
    const recordsPayload = callbackPayloadStore.set(
      Buffer.from(JSON.stringify(byKind)).toString('base64url'),
    );

    const optionRows = [
      ...plots.map(p => ({
        id: `bap2_${recordsPayload}_${p.id}`,
        title: p.name.slice(0, 24),
      })),
      {
        id: `bap2_${recordsPayload}_0`, // 0 = leave at field-level
        title: 'Dejar a nivel campo',
      },
    ];

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
        sections: [{ title: 'Lotes', rows: optionRows.map(r => ({ id: r.id, title: r.title })) }],
      },
    };
  }
}

/**
 * Build a short context label for a queued pending item so the askPrompt
 * makes clear WHICH action is being asked about (e.g. "Venta de 2 vacas" vs
 * "Gasto en glifosato"). Without this, in a multi-pending queue the user
 * would see consecutive "¿en qué lote?" / "¿cuánto?" with no clue which
 * item each refers to.
 */
function describeQueueItem(command: string, data: Record<string, unknown>): string | null {
  const c = command.toLowerCase();
  const cat = (data.category as string) || (data.crop as string) || (data.product as string);
  const qty = typeof data.quantity === 'number' ? data.quantity : (typeof data.count === 'number' ? data.count : null);
  const unit = data.unit as string;
  const qtyStr = qty != null ? (unit ? `${qty} ${unit}` : `${qty}`) : '';
  switch (c) {
    case 'log_spraying': return `Fumigación${cat ? ` con ${cat}` : ''}${qtyStr ? ` (${qtyStr})` : ''}`;
    case 'log_fertilization': return `Fertilización${cat ? ` con ${cat}` : ''}${qtyStr ? ` (${qtyStr})` : ''}`;
    case 'log_tillage': return `Labranza`;
    case 'log_irrigation': return `Riego`;
    case 'sow_crop': return `Siembra${cat ? ` de ${cat}` : ''}`;
    case 'harvest_crop': return `Cosecha${cat ? ` de ${cat}` : ''}`;
    case 'log_observation': return `Observación`;
    case 'log_crop_scouting': return `Monitoreo`;
    case 'log_health_event': return `Evento sanitario${cat ? ` (${cat})` : ''}`;
    case 'log_repro_event': return `Evento reproductivo`;
    case 'log_weighing': return `Pesaje${qtyStr ? ` (${qtyStr})` : ''}`;
    case 'add_livestock': return `Alta de hacienda${cat ? ` (${qty ?? ''} ${cat})`.trim() : ''}`;
    case 'remove_livestock': return `Baja de hacienda${cat ? ` (${qty ?? ''} ${cat})`.trim() : ''}`;
    case 'add_stock': return `Carga de stock${cat ? ` (${cat})` : ''}`;
    case 'remove_stock': return `Descuento de stock${cat ? ` (${cat})` : ''}`;
    case 'log_income': return `Venta${cat ? ` de ${cat}` : ''}${qtyStr ? ` (${qtyStr})` : ''}`;
    case 'log_expense': return `Gasto${cat ? ` en ${cat}` : ''}`;
    case 'log_rainfall': return `Lluvia`;
    default: return null;
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

  // Token corto en vez de base64 inline: Telegram limita callback_data a 64
  // bytes y 3+ días de lluvia + nombre de campo largo lo superaban (HTTP 400
  // silencioso, el usuario no veía los botones). El router resuelve el token.
  const payloadB64 = callbackPayloadStore.set(
    Buffer.from(JSON.stringify(items)).toString('base64url'),
  );

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
  // La card consolidada se fabrica desde los INTENTS — si algún paso FALLÓ,
  // consolidarla inventa un éxito que no ocurrió ("➖ 2 Vaca" sin baja real,
  // P0 del test de fuego Ago 2026). Con cualquier marca de error, se muestran
  // los mensajes reales (cards + error) sin maquillar.
  if (messages.some(m => /❌|no hay |no encontré|no pude/i.test(m))) {
    console.log('[INTERCEPT] compound: consolidación de hacienda salteada — un paso falló, se muestran los mensajes reales');
    return messages;
  }

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
async function consolidateSameFieldRainfalls(actionable: ParseResult[], userId: UserId): Promise<ParseResult[]> {
  const rainSteps: { idx: number; data: ParsedCommand }[] = [];
  actionable.forEach((r, idx) => {
    if (r.intent.type === 'command' && (r.intent.data as ParsedCommand).command === 'log_rainfall') {
      rainSteps.push({ idx, data: r.intent.data as ParsedCommand });
    }
  });
  if (rainSteps.length < 2) return actionable;

  // R02 fix: when none have field, try auto-resolve to user's single field.
  const noneHaveField = rainSteps.every(s => !s.data.fieldName);
  if (noneHaveField) {
    try {
      const { pool } = await import('../config/db.js');
      const fr = await pool.query(`SELECT name FROM fields WHERE user_id=$1 AND deleted_at IS NULL`, [userId]);
      if (fr.rows.length === 1) {
        const singleField = String(fr.rows[0].name);
        rainSteps.forEach(s => { s.data.fieldName = singleField; });
      }
    } catch { /* non-fatal */ }
  }

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
