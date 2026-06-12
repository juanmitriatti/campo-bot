/**
 * message-pipeline — núcleo compartido de procesamiento de mensajes para los 3
 * canales (whatsapp / telegram / test-bot).
 *
 * Antes de este módulo, cada controller duplicaba ~900 líneas de pipeline de
 * texto + ~400 de manejo de botones, y los fixes aterrizaban en un canal pero
 * no en los otros (ej: telegram manejaba setPendingCampaignClose tras re-rutear
 * un pending y test-bot no; test-bot tenía try/catch sobre processPendingAction
 * y telegram no; solo whatsapp inyectaba la memoria de follow-up). Este módulo
 * es LA única implementación; los controllers conservan únicamente lo
 * específico del canal: parseo del webhook, auth/gating, audio, documentos y
 * render de los BotResponseItem al transporte.
 *
 * Reglas:
 *  - TODO side-effect de un HandlerResponse se aplica vía applySideEffects().
 *    NUNCA apliques un setPending* a mano en un branch — esa era la fuente de
 *    las inconsistencias entre canales.
 *  - Los stores pending viven acá como singletons únicos. El código específico
 *    de canal (fotos de documentos, audio) debe importar ESTOS stores, no crear
 *    los suyos.
 */

import { IntentClassifier } from './intent-classifier.js';
import { DomainRouter } from '../domain/router.js';
import { CompoundExecutor } from '../domain/compound-executor.js';
import { InteractiveRouter } from '../domain/interactive/interactive.router.js';
import { FinancialHandler } from '../domain/financial/financial.handler.js';
import { FinancialService } from '../domain/financial/financial.service.js';
import { FinancialRepository } from '../domain/financial/financial.repository.js';
import { AgronomyHandler } from '../domain/agronomy/agronomy.handler.js';
import { AgronomyRepository } from '../domain/agronomy/agronomy.repository.js';
import { SystemHandler } from '../domain/system/system.handler.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { formatQuantityHuman } from '../utils/format-quantity.js';
import { isPlotAnswerToFlow } from '../utils/plot-intent.js';
import { isAffirmation, looksLikeNewActionOrQuery, hasActionVerbOrQuery, isContentlessMessage, wantsFieldLevelSave } from '../middleware/conversation-guards.js';
import { isNewActionInterrupt } from '../middleware/pending-action-processor.js';
import { PendingTransactionStore, resolveReplacedPending, isCompletePending } from '../middleware/pending-transactions.js';
import { PendingObservationStore } from '../middleware/pending-observations.js';
import { PendingActivityStore } from '../middleware/pending-activities.js';
import { PendingFieldCityStore } from '../middleware/pending-field-city.js';
import { PendingPlotAreaStore } from '../middleware/pending-plot-area.js';
import { PendingFieldLocationStore } from '../middleware/pending-field-location.js';
import { PendingDocumentStore } from '../middleware/pending-documents.js';
import { PendingDocumentUploadStore } from '../middleware/pending-document-upload.js';
import type { DocumentUploadIntent } from '../middleware/pending-document-upload.js';
import { handlePendingCity } from '../middleware/pending-field-city-handler.js';
import { handlePendingPlotArea, storePlotAreaSideEffects } from '../middleware/pending-plot-area-handler.js';
import { LearningService } from '../domain/learning/learning.service.js';
import { ContextResolver } from '../domain/learning/context-resolver.js';
import { FeatureGate } from '../domain/billing/feature-gate.js';
import { getSettingNumber, getSettingBool } from './settings.service.js';
import { pool } from '../config/db.js';
import { ConversationStateRepository } from '../middleware/conversation-state.repository.js';
import { ConversationEngine, buildTimeoutMessage, isOtherItemCorrectionOrDelete } from '../middleware/conversation-engine.js';
import { ConversationLogger } from '../middleware/conversation-logger.js';
import { FlowRegistry } from '../middleware/flows/flow-registry.js';
import { expenseFlow } from '../middleware/flows/expense.flow.js';
import { incomeFlow } from '../middleware/flows/income.flow.js';
import { fieldFlow } from '../middleware/flows/field.flow.js';
import { rainfallFlow } from '../middleware/flows/rainfall.flow.js';
import { activityFlow } from '../middleware/flows/activity.flow.js';
import { EntityValidator } from './entity-validator.js';
import { getSuggestions, resolveSuggestionKey } from '../middleware/contextual-suggestions.js';
import { enrichWithContext } from '../middleware/context-reuse.js';
import { updateConversationMiniMemory } from './expenses.js';
import { ConversationObserver } from '../middleware/conversation-observer.js';
import { IntentExtractor } from '../ai/intent-extractor.js';
import { PromptBuilder } from '../ai/prompt-builder.js';
import { IntentValidator } from '../ai/intent-validator.js';
import { UserContextService } from '../ai/user-context.service.js';
import { ConversationHistoryService } from '../ai/conversation-history.service.js';
import { ConversationalFallbackService } from '../ai/conversational-fallback.service.js';
import { FewShotService } from '../ai/few-shot.service.js';
import { AgentService } from '../ai/agent.service.js';
import { AgentPromptBuilder } from '../ai/agent-prompt-builder.js';
import { AgentResponseMapper } from '../ai/agent-response-mapper.js';
import { formatPlotListGrouped } from '../middleware/flows/field-step-helpers.js';
import { isLikelyQuestion } from '../utils/guards.js';
import { extractCropFromText } from '../utils/crops.js';
import { saveObservation, SAVE_REJECTED_DUPLICATE } from './observations.js';
import { PlotDiscoveryService } from '../domain/plots/plot-discovery.service.js';
import { formatObservationResponse } from '../middleware/response-formatter.js';
import { pendingCampaignCloseStore } from '../middleware/pending-campaign-close.js';
import type { ParsedExpense, ParsedIncome, HandlerResponse, Intent, FlowState, ParseResult, InteractiveButton, InteractiveListSection, UserId, PendingTransaction, ParsedCommand } from '../types/index.js';

// ============================================================
// Grafo de servicios — UNA sola instancia compartida por los 3 canales.
// (Antes cada controller instanciaba su propia copia de todo, incluido el
// cache de UserContextService — tres caches fríos para el mismo usuario.)
// ============================================================

export const financialRepository = new FinancialRepository();
export const financialService = new FinancialService(financialRepository);
export const userRepository = new UserRepository();
export const financialHandler = new FinancialHandler(financialService);
export const agronomyRepository = new AgronomyRepository();
export const agronomyHandler = new AgronomyHandler(agronomyRepository);
export const systemHandler = new SystemHandler(userRepository, financialService);
export const featureGate = new FeatureGate();
export const domainRouter = new DomainRouter(financialHandler, agronomyHandler, systemHandler, featureGate);
export const interactiveRouter = new InteractiveRouter();

const entityValidator = new EntityValidator();
export const userContextService = new UserContextService(entityValidator);
const promptBuilder = new PromptBuilder();
const intentValidator = new IntentValidator();
const conversationHistoryService = new ConversationHistoryService();
const fewShotService = new FewShotService();
const intentExtractor = new IntentExtractor(promptBuilder, intentValidator, userContextService, userRepository, conversationHistoryService, fewShotService);
const agentPromptBuilder = new AgentPromptBuilder();
const agentService = new AgentService(agentPromptBuilder, userContextService, userRepository, conversationHistoryService, fewShotService);
const agentResponseMapper = new AgentResponseMapper();
export const intentClassifier = new IntentClassifier(undefined, undefined, intentExtractor, agentService, agentResponseMapper, userContextService);
export const conversationalFallback = new ConversationalFallbackService(userRepository);

export const plotDiscovery = new PlotDiscoveryService();
export const learningService = new LearningService();
export const contextResolver = new ContextResolver();

const flowRegistry = new FlowRegistry();
flowRegistry.register(expenseFlow);
flowRegistry.register(incomeFlow);
flowRegistry.register(fieldFlow);
flowRegistry.register(rainfallFlow);
flowRegistry.register(activityFlow);

const conversationStateRepo = new ConversationStateRepository();
export const conversationObserver = new ConversationObserver();
export const conversationEngine = new ConversationEngine(conversationStateRepo, flowRegistry, conversationObserver);
export const conversationLogger = new ConversationLogger();

// ============================================================
// Stores pending — singletons únicos, claveados por phone con prefijo de
// canal (wa: número real, tg: tg_<chatId>, testbot: testbot_<userId>) así
// no hay colisión entre canales.
// ============================================================

export const pendingStore = new PendingTransactionStore();
export const pendingObsStore = new PendingObservationStore();
export const pendingActStore = new PendingActivityStore();
export const pendingCityStore = new PendingFieldCityStore();
export const pendingPlotAreaStore = new PendingPlotAreaStore();
export const pendingFieldLocationStore = new PendingFieldLocationStore();
export const pendingStockEntryStore = new Map<string, Record<string, unknown>>();
export const pendingStockDeductionStore = new Map<string, Record<string, unknown>>();
export const pendingDocumentStore = new PendingDocumentStore();
export const pendingDocUploadStore = new PendingDocumentUploadStore();
export { pendingCampaignCloseStore };

export async function hydratePendingStores(phone: string): Promise<void> {
  await Promise.all([
    pendingStore.hydrate(phone),
    pendingObsStore.hydrate(phone),
    pendingActStore.hydrate(phone),
    pendingCityStore.hydrate(phone),
  ]);
}

// ============================================================
// Tipos
// ============================================================

export interface BotResponseItem {
  type: 'text' | 'interactive';
  text?: string;
  interactive?: {
    type: 'buttons' | 'list';
    body: string;
    buttons?: InteractiveButton[];
    buttonText?: string;
    sections?: InteractiveListSection[];
  };
}

export type ChannelName = 'whatsapp' | 'telegram' | 'testbot';

export interface ChannelContext {
  channel: ChannelName;
  phone: string;
  userId: UserId;
  user: any;
  settings: any;
  startTime: number;
  /**
   * Branches de botones específicos del canal (doc_* en telegram/whatsapp).
   * Devuelve null cuando el callback no es del canal → sigue el pipeline común.
   */
  handleDocCallback?: (callbackId: string, ctx: ChannelContext) => Promise<BotResponseItem[] | null>;
}

// ============================================================
// Helpers
// ============================================================

export function collectResponse(response: HandlerResponse): BotResponseItem[] {
  const items: BotResponseItem[] = [];

  // Avoid double-rendering: many handlers put the SAME text in both messages[]
  // and interactive.body (confirmations, plot prompts) — render the interactive
  // once and skip the duplicate plain message.
  const interactiveBody = response.interactive?.body?.trim();
  for (const msg of response.messages) {
    if (interactiveBody && msg.trim() === interactiveBody) continue;
    items.push({ type: 'text', text: msg });
  }

  if (response.attachment) {
    // Texto legible + binario adjunto (_attachment) para que el renderer del
    // canal pueda mandar el documento real (telegram/whatsapp). El test-bot
    // descarta _attachment antes del res.json. Antes test-bot perdía el binario
    // y telegram usaba un marker propio — unificado.
    items.push({ type: 'text', text: `[Archivo adjunto: ${response.attachment.filename}]`, ...({ _attachment: response.attachment } as object) });
  }

  if (response.interactive) {
    if (response.interactive.type === 'buttons') {
      items.push({
        type: 'interactive',
        interactive: { type: 'buttons', body: response.interactive.body, buttons: response.interactive.buttons },
      });
    } else if (response.interactive.type === 'list') {
      items.push({
        type: 'interactive',
        interactive: {
          type: 'list',
          body: response.interactive.body,
          buttonText: response.interactive.buttonText,
          sections: response.interactive.sections,
        },
      });
    }
  }

  // Contextual suggestions (only if no interactive already)
  if (!response.interactive && response.suggestionKey) {
    const suggestion = getSuggestions(response.suggestionKey);
    if (suggestion && suggestion.type === 'buttons') {
      items.push({
        type: 'interactive',
        interactive: { type: 'buttons', body: suggestion.body, buttons: suggestion.buttons },
      });
    }
  }

  return items;
}

export function interactiveButtons(body: string, buttons: InteractiveButton[]): BotResponseItem {
  return { type: 'interactive', interactive: { type: 'buttons', body, buttons } };
}

export function isCancelIntent(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (['cancelar', 'cancel', 'salir', 'no', 'parar', 'basta', 'chau', 'terminar'].includes(lower)) {
    return true;
  }
  if (/^no\s*(quiero|gracias|,?\s*gracias)$/i.test(lower)) {
    return true;
  }
  return false;
}

export function buildNoFieldsBlockItems(actionLabel: string): BotResponseItem[] {
  return [
    { type: 'text', text: `Para ${actionLabel} primero necesitás crear un campo.\n\n📍 Escribí *agregar campo [nombre]*` },
    interactiveButtons(`Necesitás un campo para ${actionLabel}.`, [
      { id: 'cmd_agregar_campo', title: 'Crear Campo' },
    ]),
  ];
}

export function buildNoPlotBlockItems(actionLabel: string, fieldName: string): BotResponseItem[] {
  return [
    { type: 'text', text: `Para ${actionLabel} necesitás al menos un lote.\n\n📍 Escribí *agregar lote [nombre] en campo ${fieldName}*` },
    interactiveButtons(`Necesitás un lote para ${actionLabel}.`, [
      { id: 'cmd_agregar_lote', title: 'Crear Lote' },
    ]),
  ];
}

export async function hasNoPrerequisites(userId: UserId): Promise<{ blocked: boolean; items?: BotResponseItem[] }> {
  const fields = await financialService.getUserFields(userId);
  if (fields.length === 0) {
    return { blocked: true, items: buildNoFieldsBlockItems('registrar') };
  }
  const allPlots = await financialService.findAllUserPlots(userId);
  if (allPlots.length === 0) {
    return { blocked: true, items: buildNoPlotBlockItems('registrar', fields[0].name) };
  }
  return { blocked: false };
}

export const DESTRUCTIVE_COMMANDS = new Set([
  'delete_last', 'delete_last_income', 'delete_specific',
]);

export const SAFE_INTERRUPTION_COMMANDS = new Set([
  'list_fields', 'list_plots', 'field_info', 'help', 'menu',
  'weather_full', 'financial_report', 'monthly_report', 'weekly_report', 'rainfall_report',
  'greeting', 'thanks', 'dollar',
]);

// ============================================================
// applySideEffects — punto ÚNICO de aplicación de side-effects.
//
// Históricamente cada branch de cada controller aplicaba a mano el subconjunto
// de setPending* que su autor recordaba en ese momento; los 5 bugs de "botón
// que no responde" / "pending perdido" de Jun 2026 salieron de ahí. Esta
// función aplica TODOS los side-effects de un HandlerResponse de una vez.
// startFlow queda afuera (es control de flujo, lo maneja cada call-site).
// ============================================================

export interface AppliedSideEffects {
  /** Prompt de hectáreas si el handler seteó setPendingPlotArea (append al final). */
  plotAreaPrompt: string | null;
  /** Pending de confirmación reemplazado (solo cuando había setPending). */
  replacedPending: PendingTransaction | null;
}

export function applySideEffects(
  sideEffects: HandlerResponse['sideEffects'] | undefined | null,
  phone: string,
): AppliedSideEffects {
  const out: AppliedSideEffects = { plotAreaPrompt: null, replacedPending: null };
  if (!sideEffects) return out;
  const fx = sideEffects as Record<string, any>;

  if (fx.setPending) {
    out.replacedPending = pendingStore.set(phone, fx.setPending);
  }
  if (fx.setPendingObservation) {
    const obs = fx.setPendingObservation;
    pendingObsStore.set(phone, { text: obs.text, category: obs.category, timestamp: Date.now() });
  }
  if (fx.setPendingActivity) {
    const act = fx.setPendingActivity;
    pendingActStore.set(phone, {
      command: act.command,
      data: act.data,
      timestamp: Date.now(),
      missing: act.missing,
      askPrompt: act.askPrompt,
      nextInQueue: act.nextInQueue,
    });
  }
  if (fx.setPendingFieldCity) {
    pendingCityStore.set(phone, { fieldName: fx.setPendingFieldCity.fieldName, timestamp: Date.now() });
  }
  if (fx.setPendingStockEntry) {
    pendingStockEntryStore.set(phone, fx.setPendingStockEntry as Record<string, unknown>);
  }
  if (fx.setPendingStockDeduction) {
    pendingStockDeductionStore.set(phone, fx.setPendingStockDeduction as Record<string, unknown>);
  }
  if (fx.setPendingFieldLocation) {
    const loc = fx.setPendingFieldLocation;
    pendingFieldLocationStore.set(phone, { fieldId: loc.fieldId, fieldName: loc.fieldName });
  }
  if (fx.setPendingCampaignClose) {
    pendingCampaignCloseStore.set(phone, fx.setPendingCampaignClose);
  }
  if (fx.setFieldDuplicate) {
    const dup = fx.setFieldDuplicate;
    pendingStore.set(phone, {
      type: 'expense', data: { type: 'expense', amount: 0, category: '', description: '', currency: 'ARS' },
      fieldId: null, fieldName: null, plotId: null, plotName: null,
      timestamp: Date.now(), _fieldDuplicate: dup,
    } as any);
  }
  out.plotAreaPrompt = storePlotAreaSideEffects(phone, pendingPlotAreaStore, sideEffects) ?? null;

  return out;
}

// ============================================================
// commitFinancialFlowFieldLevel
// ============================================================

/**
 * P0-2/P0-3: when an expense/income flow is parked at the OPTIONAL plot step, its
 * amount+category are already captured. Save it at FIELD LEVEL (plot_id=null) via
 * executeConfirm instead of silently dropping the record when the user pivots or
 * explicitly says "sin lote". Returns the confirmation items, or [] when the flow
 * is not a financial flow waiting on the plot.
 */
export async function commitFinancialFlowFieldLevel(
  userId: UserId,
  flowCtx: any,
  phone: string,
): Promise<BotResponseItem[]> {
  const origin = flowCtx.originFlow ?? flowCtx.state;
  if (!['expense_flow', 'income_flow'].includes(origin)) return [];
  // Commit when the record is already complete: either waiting on the OPTIONAL
  // plot, or sitting at the confirmation step. Both lose the record on pivot.
  const atPlot = conversationEngine.getCurrentStepField(flowCtx) === 'plotName';
  const atConfirm = flowCtx.state === 'confirming';
  if (!atPlot && !atConfirm) return [];
  const result = await conversationEngine.executeConfirm(userId, flowCtx);
  applySideEffects(result.response.sideEffects, phone);
  const kind = origin === 'income_flow' ? 'ingreso' : 'gasto';
  const note = flowCtx.data?.plotName
    ? `💡 Guardé el ${kind} antes de seguir.`
    : `💡 Guardé el ${kind} a nivel campo (sin lote).`;
  return [{ type: 'text', text: note }, ...collectResponse(result.response)];
}

// ============================================================
// processTextMessage — EL pipeline de texto canónico
// ============================================================

export async function processTextMessage(
  text: string,
  ctx: ChannelContext,
): Promise<BotResponseItem[]> {
  const { userId, user, settings, phone, startTime } = ctx;
  console.log(`[${ctx.channel}] TEXT:`, text);

  // Contentless message (empty / only emojis or punctuation) → gentle hint
  // instead of a blank reply or a full greeting.
  if (isContentlessMessage(text)) {
    return [{ type: 'text', text: '🤔 No te entendí. Contame qué querés hacer — ej: *gasté 50 mil en gasoil*, *sembré soja en el lote 1*, o escribí *menú*.' }];
  }

  // Track last activity
  pool.query('UPDATE users SET last_message_at = NOW() WHERE id = $1', [userId]).catch(() => {});

  // Log message received for analytics
  const sessionId = `${ctx.channel}_${userId}_${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })}`;
  conversationObserver.logMessageReceived(userId, { phone, messageType: 'text', messageLength: text.length }, sessionId);

  // --- Check awaiting_new_category_name (inline category creation) ---
  {
    const rawState = await pool.query(
      `SELECT flow_state, flow_data FROM conversation_state WHERE user_id = $1`,
      [userId],
    );
    if (rawState.rows[0]?.flow_state === 'awaiting_new_category_name') {
      const flowData = rawState.rows[0].flow_data as { kind: 'expense' | 'income'; payload: string };
      if (isCancelIntent(text)) {
        await conversationEngine.clearFlow(userId);
        return [{ type: 'text', text: '❌ Operación cancelada.' }];
      }
      await conversationEngine.clearFlow(userId);
      const response = await financialHandler.resumeCreateCategory(userId, text, flowData);
      return collectResponse(response);
    }
  }

  // --- Check active conversation flow ---
  const flowCtx = await conversationEngine.getFlowContext(userId);

  if (flowCtx.state !== 'idle') {
    if (conversationEngine.isExpired(flowCtx)) {
      const notifyEnabled = (await getSettingBool('FLOW_TIMEOUT_NOTIFICATION_ENABLED')) ?? true;
      const expiredFlowState = flowCtx.originFlow ?? flowCtx.state;
      await conversationEngine.clearFlow(userId);
      if (notifyEnabled) {
        return [{ type: 'text', text: buildTimeoutMessage(expiredFlowState) }];
      }
      // Notification disabled — fall through to normal processing
    } else {
      // FlowGuard: validate state consistency
      const guardResult = await conversationEngine.validateFlowState(userId, flowCtx);
      if (guardResult) {
        return collectResponse(guardResult.response);
      }

      // Cancel/back detection
      if (isCancelIntent(text)) {
        await conversationEngine.clearFlow(userId);
        const menuResponse = await systemHandler.handleCommand({ command: 'menu' }, userId, user, settings);
        return [
          { type: 'text', text: '❌ Operacion cancelada.' },
          ...collectResponse(menuResponse),
        ];
      }
      const lower = text.toLowerCase().trim();
      if (['volver', 'atras', 'atrás', 'back'].includes(lower) && flowCtx.step > 0) {
        const result = await conversationEngine.goBack(userId, flowCtx);
        if (result.nextContext) await conversationEngine.setFlowContext(userId, result.nextContext);
        return collectResponse(result.response);
      }

      // P0-1: an affirmation ("si/dale/ok/listo") while the flow is awaiting the
      // OPTIONAL plot ("¿en qué lote?") means "register at field level" — same as
      // tapping Confirmar. Without this, "si" reached the global confirm handler,
      // got "no hay nada pendiente", and the record was silently dropped.
      if (conversationEngine.getCurrentStepField(flowCtx) === 'plotName' && isAffirmation(text)) {
        const result = await conversationEngine.executeConfirm(userId, flowCtx);
        applySideEffects(result.response.sideEffects, phone);
        return collectResponse(result.response);
      }

      // P0-3: explicit "sin lote / no importa / a nivel campo" at the plot step →
      // save at field level instead of looping the plot question forever (which
      // silently dropped the income/expense). Same effect as tapping Confirmar.
      if (conversationEngine.getCurrentStepField(flowCtx) === 'plotName' && wantsFieldLevelSave(text)) {
        const items = await commitFinancialFlowFieldLevel(userId, flowCtx, phone);
        if (items.length > 0) return items;
      }

      // P0-3: a clearly-different NEW action or query mid-flow ("va a llover?",
      // "cómo vamos?", "vendí 10 novillos") abandons the flow and gets processed
      // normally — instead of the "estás en medio de un registro" nudge that
      // bricked clima/reportes/queries until the user typed "cancelar". A plot
      // answer ("lote A") is exempt — that's the flow's expected input.
      if (!isPlotAnswerToFlow(flowCtx.state, text) && (looksLikeNewActionOrQuery(text) || isOtherItemCorrectionOrDelete(text))) {
        // P0-2: a complete expense/income parked at the plot step must NOT be lost
        // just because the user pivoted to another action/query. Commit it at
        // field level first, then process the pivot. (P1-B: also abandon for a
        // correction/delete of a DIFFERENT item so the flow doesn't eat it.)
        const committed = await commitFinancialFlowFieldLevel(userId, flowCtx, phone);
        await conversationEngine.clearFlow(userId);
        if (committed.length > 0) {
          const rest = await processTextMessage(text, ctx);
          return [...committed, ...rest];
        }
        // fall through to normal processing below
      } else {

      // Smart interruption: check if the user typed a known command mid-flow
      const interruptCmd = intentClassifier.parseCommandOnly(text);
      // During field_flow name step, suppress ONLY field_info
      // (prevents "Campo Norte" from matching field_info, but allows "mis campos" → list_fields)
      const isFlowNameStep = flowCtx.state === 'field_flow' && flowCtx.step === 0;
      const effectiveCmd = (isFlowNameStep && interruptCmd?.command === 'field_info') ? null : interruptCmd;
      if (effectiveCmd && SAFE_INTERRUPTION_COMMANDS.has(effectiveCmd.command)) {
        // Greetings/thanks mid-flow → just re-prompt (avoid confusing mixed response)
        if (effectiveCmd.command === 'greeting' || effectiveCmd.command === 'thanks') {
          const reprompt = await conversationEngine.getCurrentStepPrompt(flowCtx, userId);
          if (reprompt) return collectResponse(reprompt);
          return [];
        }
        // Read-only command → execute without canceling the flow, then re-prompt
        const cmdItems: BotResponseItem[] = [];
        const cmdResponse = await domainRouter.routeCommand(effectiveCmd, userId, user, settings);
        if (cmdResponse) cmdItems.push(...collectResponse(cmdResponse));
        const reprompt = await conversationEngine.getCurrentStepPrompt(flowCtx, userId);
        if (reprompt) cmdItems.push(...collectResponse(reprompt));
        return cmdItems;
      }

      // Question detection: questions mid-flow get a gentle nudge + re-prompt
      if (isLikelyQuestion(text)) {
        const reprompt = await conversationEngine.getCurrentStepPrompt(flowCtx, userId);
        const items: BotResponseItem[] = [
          { type: 'text', text: 'Estás en medio de un registro. Escribí *cancelar* si querés salir y preguntar.' },
        ];
        if (reprompt) items.push(...collectResponse(reprompt));
        return items;
      }

      // Intent-first interruption: any non-safe command OR financial intent cancels the flow
      // — UNLESS the flow is asking for a plot and the user answered with one
      // ("lote A"), in which case it's the answer, not an interruption.
      if (!isPlotAnswerToFlow(flowCtx.state, text) && (effectiveCmd || intentClassifier.detectsFinancialIntent(text))) {
        // P0-2: commit a complete expense/income at field level before abandoning.
        const committed = await commitFinancialFlowFieldLevel(userId, flowCtx, phone);
        await conversationEngine.clearFlow(userId);
        if (committed.length > 0) {
          const rest = await processTextMessage(text, ctx);
          return [...committed, ...rest];
        }
        // Fall through to normal intent processing below
      } else {
        // No intent detected → process within active flow
        const result = await conversationEngine.processFlowMessage(userId, text, flowCtx);
        if (result.nextContext) {
          await conversationEngine.setFlowContext(userId, result.nextContext);
        } else {
          await conversationEngine.clearFlow(userId);
        }
        applySideEffects(result.response.sideEffects, phone);
        return collectResponse(result.response);
      }
      } // end P0-3 else (message was not a new action/query)
    }
  }

  // --- Check pending field city assignment ---
  const pendingCity = pendingCityStore.get(phone);
  if (pendingCity) {
    if (isCancelIntent(text)) {
      pendingCityStore.clear(phone);
      return [{ type: 'text', text: '👍 Podés asignar la ubicación después.' }];
    }
    const cityResult = await handlePendingCity(text, pendingCity, userId, financialService);
    if (cityResult.clearPending) pendingCityStore.clear(phone);
    return cityResult.messages.map(msg => ({ type: 'text' as const, text: msg }));
  }

  // --- Check pending plot area assignment ---
  const plotAreaResult = await handlePendingPlotArea(text, phone, pendingPlotAreaStore, financialService);
  if (plotAreaResult.handled) {
    return plotAreaResult.messages.map(msg => ({ type: 'text' as const, text: msg }));
  }

  // --- Check pending stock deduction quantity ---
  const pendingDeduction = pendingStockDeductionStore.get(phone) as Record<string, unknown> | undefined;
  if (pendingDeduction && (pendingDeduction as any).awaitingQuantity) {
    const qtyMatch = text.trim().match(/^[\d.,]+/);
    const qty = qtyMatch ? parseFloat(qtyMatch[0].replace(',', '.')) : NaN;
    if (!isNaN(qty) && qty > 0) {
      try {
        (pendingDeduction as any).totalQuantity = qty;
        (pendingDeduction as any).awaitingQuantity = false;
        const { StockDeductionService } = await import('../domain/stock/stock-deduction.service.js');
        const deductionService = new StockDeductionService();
        const { item } = await deductionService.applyDeduction(userId, pendingDeduction as any);
        pendingStockDeductionStore.delete(phone);
        return [{ type: 'text', text: `📤 Stock descontado: *${item.name}* → ${item.current_quantity} ${item.unit}` }];
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al descontar stock';
        pendingStockDeductionStore.delete(phone);
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    } else if (/cancel|no|salir/i.test(text.trim())) {
      pendingStockDeductionStore.delete(phone);
      return [{ type: 'text', text: '👍 OK, no se descontó del stock.' }];
    } else {
      return [{ type: 'text', text: `Decime la cantidad en ${pendingDeduction.unit || 'lt'}. Ej: *3*` }];
    }
  }

  // --- Check pending observation (plot disambiguation) ---
  const pendingObs = pendingObsStore.get(phone);
  if (pendingObs) {
    if (isCancelIntent(text)) {
      pendingObsStore.clear(phone);
      return [{ type: 'text', text: '❌ Observacion cancelada.' }];
    }
    // Escape hatch: if the message looks like a known command, clear pending and fall through
    const obsInterruptCmd = intentClassifier.parseCommandOnly(text);
    if (obsInterruptCmd || intentClassifier.detectsFinancialIntent(text) || looksLikeNewActionOrQuery(text)) {
      pendingObsStore.clear(phone);
      // Fall through to normal processing below
    } else {
      const obsResolved = await plotDiscovery.resolveExisting(userId, text);
      if (obsResolved.plotId) {
        pendingObsStore.clear(phone);
        const saved = await saveObservation(userId, {
          fieldId: obsResolved.fieldId,
          plotId: obsResolved.plotId,
          text: pendingObs.text,
          category: pendingObs.category,
          source: 'text',
        });

        if (saved === SAVE_REJECTED_DUPLICATE) {
          return [{ type: 'text', text: 'Observacion duplicada detectada' }];
        } else if (saved && !(saved as any)._rejected) {
          let locationLabel = 'General';
          if (obsResolved.plotName && obsResolved.fieldName) {
            locationLabel = `${obsResolved.fieldName} > ${obsResolved.plotName}`;
          } else if (obsResolved.plotName) {
            locationLabel = obsResolved.plotName;
          }
          const message = formatObservationResponse({
            locationLabel,
            plotName: obsResolved.plotName,
            category: pendingObs.category as any,
            observationText: saved.observation_text,
          });
          const response: HandlerResponse = { messages: [message], suggestionKey: 'observation_logged' };
          return collectResponse(response);
        }
        return [{ type: 'text', text: 'No se pudo guardar la observacion. Intenta de nuevo.' }];
      }

      const userPlots = await agronomyRepository.findAllUserPlots(userId);
      return [{ type: 'text', text: `No encontré ese lote. ¿En qué lote?\n\n${formatPlotListGrouped(userPlots)}` }];
    }
  }

  // --- Check pending activity (plot disambiguation for agro activities) ---
  const pendingAct = pendingActStore.get(phone);
  if (pendingAct) {
    if (isCancelIntent(text)) {
      pendingActStore.clear(phone);
      return [{ type: 'text', text: '❌ Actividad cancelada.' }];
    }
    const actInterruptCmd = intentClassifier.parseCommandOnly(text);
    // Guard: if the pending is for a financial action (log_income/log_expense)
    // and it's WAITING for amount/price/quantity, the user's reply WILL look
    // like a financial intent ("550 USD por tonelada"). Don't escape — let
    // the pending-action processor merge the slots. Without this guard the
    // pending gets silently cleared and the partial saves as $0.
    const expectsFinancialSlot = pendingAct.missing
      && (pendingAct.command === 'log_income' || pendingAct.command === 'log_expense' || pendingAct.command === 'set_livestock_price')
      && pendingAct.missing.some(s => s === 'amount' || s === 'quantity' || s === 'unit_price' || s === 'unit');
    // A NEW action with its own verb or a query escapes even a financial-slot
    // pending — only a BARE answer like "800 USD" should fill the slot.
    // When waiting for a financial slot, the answer is EXPECTED to be
    // money-shaped (and may contain unit words like "por cabeza"). Use the
    // stricter escape (real verb/query only) so a bare price answer fills the
    // slot instead of escaping to the agent and corrupting the last income.
    const escapePending = (expectsFinancialSlot ? hasActionVerbOrQuery(text) : looksLikeNewActionOrQuery(text))
      || isOtherItemCorrectionOrDelete(text)
      || (!expectsFinancialSlot && (isNewActionInterrupt(actInterruptCmd) || intentClassifier.detectsFinancialIntent(text)));
    if (escapePending) {
      // P0: don't silently drop the pending activity on pivot — save field-level
      // where possible, else tell the user it's deferred. Then process the pivot.
      const { flushPendingActivityOnPivot } = await import('../middleware/pending-activity-pivot.js');
      const pivotNotes = await flushPendingActivityOnPivot(userId, pendingAct, agronomyHandler);
      pendingActStore.clear(phone);
      if (pivotNotes.length > 0) {
        const rest = await processTextMessage(text, ctx);
        return [...pivotNotes.map(t => ({ type: 'text' as const, text: t })), ...rest];
      }
      // Fall through to normal processing
    } else if (pendingAct.missing && pendingAct.missing.length > 0) {
      // Unified multi-slot completion: run the SlotExtractor against the new
      // message and merge any newly-extracted slots into pending.data. If all
      // required slots are filled → re-execute. Otherwise → ask for what's
      // still missing. Works for log_fertilization, log_spraying, log_income,
      // log_expense, sow_crop, etc. — wherever the handler set `missing`.
      const { processPendingAction } = await import('../middleware/pending-action-processor.js');
      let result;
      try {
        result = processPendingAction(text, pendingAct);
      } catch (err) {
        console.error('[pending-processor] threw:', (err as Error).message);
        pendingActStore.clear(phone);
        return [{ type: 'text', text: 'No pude interpretar tu respuesta. Probá de nuevo o escribí *cancelar*.' }];
      }
      if (result.next === null) {
        // All required slots filled → re-route the command. Use the
        // processor's finalData (already merged + overwrites applied like
        // currency) rather than re-merging from the stale pending.data.
        pendingActStore.clear(phone);
        const merged = { ...result.finalData } as ParsedCommand;
        delete (merged as Record<string, unknown>)._needs;
        // Carry the pending's command into merged so routeCommand can dispatch.
        // Partial intents (income_partial / expense_partial) never put a
        // `command` in `data` — it lives only on the pending itself. Without
        // this, every multi-turn financial completion routed to undefined →
        // "No pude completar el registro" + silent data drop.
        if (!(merged as Record<string, unknown>).command) {
          (merged as Record<string, unknown>).command = pendingAct.command;
        }
        // P0: a financial pending with queued siblings re-routes in bulkMode so
        // income/expense SAVE at field-level instead of asking "¿en qué lote?".
        // That plot-ask spawned a parallel pending that desynced the serial queue
        // and lost BOTH sales. Field-level + the post-loop bulk-plot prompt is the
        // designed multi-item UX.
        const mergedCommand = (merged as Record<string, unknown>).command;
        const queueBulk = (mergedCommand === 'log_income' || mergedCommand === 'log_expense')
          && ((Array.isArray(pendingAct.nextInQueue) && pendingAct.nextInQueue.length > 0)
              || (pendingAct.data as Record<string, unknown>)?._fromQueue === true);
        const routed = await domainRouter.routeCommand(merged, userId, user, settings, queueBulk);
        const cmdResult = routed ?? { messages: ['No pude completar el registro. Probá de nuevo.'] };
        const { advanceQueueAfterCompletion } = await import('../middleware/pending-queue-advancer.js');
        const advanced = advanceQueueAfterCompletion(pendingActStore, phone, pendingAct, cmdResult);
        // Forward ALL sideEffects from the re-routed command (incl. setPending
        // confirmation, setPendingCampaignClose — telegram had campaign close
        // here and test-bot didn't; unified now).
        applySideEffects(cmdResult.sideEffects, phone);
        const items = collectResponse(cmdResult);
        if (advanced.askPrompt) items.push({ type: 'text', text: advanced.askPrompt });
        return items;
      }
      // Still missing slots → update pending state, re-ask
      pendingActStore.set(phone, result.next);
      return [{ type: 'text', text: result.next.askPrompt || 'Me falta algún dato. ¿Me lo pasás?' }];
    } else if (pendingAct.data._needs === 'crop') {
      const crop = extractCropFromText(text);
      if (crop) {
        pendingActStore.clear(phone);
        const merged = { ...pendingAct.data, crop } as unknown as ParsedCommand;
        delete (merged as Record<string, unknown>)._needs;
        if (!(merged as Record<string, unknown>).command) {
          (merged as Record<string, unknown>).command = pendingAct.command;
        }
        const result = await agronomyHandler.handleCommand(merged, userId, user, settings);
        applySideEffects(result.sideEffects, phone);
        return collectResponse(result);
      }
      return [{ type: 'text', text: `No reconocí ese cultivo. ¿Qué cultivo? (ej: soja, maíz, trigo, girasol)` }];
    } else {
      const actResolved = await plotDiscovery.resolveExisting(userId, text);
      if (actResolved.plotId) {
        pendingActStore.clear(phone);
        const result = await agronomyHandler.savePendingActivity(
          userId, pendingAct, actResolved.plotId,
          actResolved.fieldId, actResolved.plotName, actResolved.fieldName,
        );
        applySideEffects(result.sideEffects, phone);
        return collectResponse(result);
      }
      const userPlots = await agronomyRepository.findAllUserPlots(userId);
      return [{ type: 'text', text: `No encontré ese lote. ¿En qué lote?\n\n${formatPlotListGrouped(userPlots)}` }];
    }
  }

  // --- Check pending confirmation ---
  const pending = pendingStore.get(phone);

  // --- Pending correction intercept (category / amount mid-confirmation) ---
  // Before sending to the classifier: if there's a pending gasto/ingreso and
  // the user's text is a category or amount correction ("no, era en sueldos"
  // / "no, eran 75 mil"), patch the pending in-place and re-render the
  // confirmation. Without this the message falls through to the agent which
  // is sometimes inconsistent (CR02: it asked for a plot instead of fixing
  // the category).
  if (pending && (pending.type === 'expense' || pending.type === 'income')) {
    const { tryApplyPendingCorrection } = await import('../middleware/pending-correction-interceptor.js');
    const corr = tryApplyPendingCorrection(text, pending as any);
    if (corr.applied) {
      pendingStore.set(phone, corr.updatedPending as any);
      conversationLogger.log(userId, phone, text, corr.body!, 'command', 'correction_applied', null, null, false, Date.now() - startTime, true, 1.0, null, null, ctx.channel).catch(() => {});
      return [
        { type: 'text', text: corr.body! },
        { type: 'interactive', interactive: { type: 'buttons', body: '¿Confirmás?', buttons: corr.buttons! } } as BotResponseItem,
      ];
    }
  }

  // P0: a COMPLETE pending gasto/ingreso (auto-resolved plot → awaiting confirm)
  // must not be lost when the user pivots to a query or a different-domain action
  // without confirming. Auto-commit it first, then process the pivot. (A pivot to
  // a NEW financial action is left to the replaced-pending path, which keeps the
  // "guardé el anterior y registro el nuevo" UX.)
  if (pending && isCompletePending(pending as any)
      && ((looksLikeNewActionOrQuery(text) && !intentClassifier.detectsFinancialIntent(text))
          || isOtherItemCorrectionOrDelete(text))) {
    pendingStore.clear(phone);
    try { await financialHandler.handleConfirm(userId, pending, settings, user); } catch { /* best-effort */ }
    const kind = (pending as any).type === 'income' ? 'ingreso' : 'gasto';
    const rest = await processTextMessage(text, ctx);
    return [{ type: 'text', text: `💡 Guardé el ${kind} antes de seguir.` }, ...rest];
  }

  const lowConfidenceThreshold = (await getSettingNumber('CONFIDENCE_LOW_CONFIRM')) ?? 0.70;
  const unknownFallbackThreshold = (await getSettingNumber('CONFIDENCE_UNKNOWN_FALLBACK')) ?? 0.50;

  // Follow-up enrichment: detecta referencias a la conversación anterior y trae
  // memoria (plot/field/activity/time). El resultado se inyecta más abajo en el
  // command data — antes SOLO whatsapp lo hacía; unificado para los 3 canales.
  const enriched = await enrichWithContext(text, userId);

  // Classify intent
  const parseResult: ParseResult = await intentClassifier.classify(text, userId, settings, {
    pendingHint: pendingActStore.get(phone)?.askPrompt ?? null,
  });
  const { intent: rawIntent, aiUsed, confidence } = parseResult;
  const agentMode = (parseResult as any)._agentMode as string | undefined;
  const toolCallsData = (parseResult as any)._toolCalls as object[] | undefined;

  // Handle conversational response from Agent
  if ((parseResult as any)._conversationalResponse) {
    const convResponse = (parseResult as any)._conversationalResponse as string;
    conversationLogger.log(userId, phone, text, convResponse, 'conversational', null, null, null, true, Date.now() - startTime, false, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
    return [{ type: 'text', text: convResponse }];
  }

  // --- Handle compound actions from Agent (multiple tool calls) ---
  const compoundResults = (parseResult as any)._compoundResults as ParseResult[] | undefined;
  const truncatedFlag = (parseResult as any)._truncated === true;
  if (compoundResults && compoundResults.length > 1) {
    const executor = new CompoundExecutor(domainRouter, financialHandler);
    const result = await executor.execute(compoundResults, userId, user, settings, text);
    if (result && result.messages.length > 0) {
      if (truncatedFlag) {
        result.messages.push('⚠️ El mensaje era largo y se cortó. Si te quedaron acciones sin registrar, repetilas en un mensaje aparte.');
      }
      const items: BotResponseItem[] = result.messages.map(m => ({ type: 'text' as const, text: m }));
      if (result.stoppedAtFlow && result.lastSideEffects?.startFlow) {
        const { state, data } = result.lastSideEffects.startFlow;
        const flowResult = await conversationEngine.startFlow(userId, state, data);
        if (flowResult.nextContext) await conversationEngine.setFlowContext(userId, flowResult.nextContext);
        items.push(...collectResponse(flowResult.response));
      } else if (result.lastSideEffects) {
        const applied = applySideEffects(result.lastSideEffects, phone);
        if (applied.plotAreaPrompt) items.push({ type: 'text', text: applied.plotAreaPrompt });
      }
      if (result.lastInteractive) {
        items.push({ type: 'interactive', interactive: result.lastInteractive } as BotResponseItem);
      } else if (result.lastSuggestionKey) {
        const suggestion = getSuggestions(result.lastSuggestionKey);
        if (suggestion && suggestion.type === 'buttons') {
          items.push({ type: 'interactive', interactive: { type: 'buttons', body: suggestion.body, buttons: suggestion.buttons } } as BotResponseItem);
        }
      }
      conversationLogger.log(userId, phone, text, result.messages.join('\n\n') || null, 'command', 'compound', null, null, aiUsed, Date.now() - startTime, !!result.lastInteractive, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
      return items;
    }
  }

  // Log intent for analytics
  const intentCommand = rawIntent.type === 'command' ? rawIntent.data.command : null;
  conversationObserver.logIntentDetected(userId, rawIntent.type, intentCommand, confidence, parseResult.source, { aiUsed, missingFields: parseResult.missingFields.length > 0 ? parseResult.missingFields : undefined });

  // Enrich with learned vocabulary
  const intent: Intent = await contextResolver.enrichIntent(userId, text, rawIntent);

  // If follow-up detected and we have memory, inject context into command data
  // (antes solo whatsapp — unificado).
  if (enriched.enriched && enriched.memory && intent.type === 'command') {
    const mem = enriched.memory;
    const data = intent.data as Record<string, unknown>;
    if (!data.plotName && mem.plotName) data.plotName = mem.plotName;
    if (!data.fieldName && mem.fieldName) data.fieldName = mem.fieldName;
    if (!data.activityFilter && mem.lastActivityType) data.activityFilter = mem.lastActivityType;
    if (!data.timeRef && mem.lastTimeReference) {
      data._inheritedTimeLabel = mem.lastTimeReference;
    }
  }

  // Handle confirm/cancel for pending
  if (intent.type === 'command' && intent.data.command === 'confirm') {
    if (!pending) {
      return [{ type: 'text', text: 'No hay nada pendiente para confirmar.' }];
    }
    pendingStore.clear(phone);
    const response = await financialHandler.handleConfirm(userId, pending, settings, user);
    applySideEffects(response.sideEffects, phone);
    conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'command', 'confirm', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
    return collectResponse(response);
  }
  if (intent.type === 'command' && intent.data.command === 'cancel') {
    const { clearMultiTurnState } = await import('../middleware/multi-turn-state.js');
    await clearMultiTurnState(userId);
    if (!pending) {
      return [{ type: 'text', text: 'Listo, contexto limpio. ¿Qué hacemos?' }];
    }
    pendingStore.clear(phone);
    conversationLogger.log(userId, phone, text, 'Operacion cancelada.', 'command', 'cancel', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
    return [{ type: 'text', text: '❌ Operacion cancelada.' }];
  }

  // --- Phase 3: trial expired (access-gate blocked AI / writes) ---
  if (intent.type === 'trial_expired') {
    const { trialExpiredCopy } = await import('./access-gate.service.js');
    const reply = trialExpiredCopy();
    conversationLogger.log(userId, phone, text, reply, 'trial_expired', null, null, null, aiUsed, Date.now() - startTime, false, 0, toolCallsData, agentMode, ctx.channel).catch(() => {});
    return [{ type: 'text', text: reply }];
  }

  // --- Phase 2: regex fallback refused to parse a complex intent ---
  if (intent.type === 'fallback_blocked') {
    const { fallbackBlockedCopy } = await import('./intent-safety.js');
    const reply = fallbackBlockedCopy(intent.reason, intent.attemptedCommand);
    conversationLogger.log(userId, phone, text, reply, 'fallback_blocked', intent.attemptedCommand ?? null, null, null, aiUsed, Date.now() - startTime, false, 0, toolCallsData, agentMode, ctx.channel).catch(() => {});
    return [{ type: 'text', text: reply }];
  }

  // --- Partial parse → slot-extractor pending ---
  if (intent.type === 'expense_partial') {
    { const prereq = await hasNoPrerequisites(userId); if (prereq.blocked) return prereq.items!; }
    const hasExpenses = await featureGate.hasFeature(userId, 'expenses');
    if (!hasExpenses) {
      return [{ type: 'text', text: '🔒 El registro de gastos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
    }
    const { planExpensePartialPending } = await import('../middleware/financial-partial-pending.js');
    const planExp = planExpensePartialPending(intent.data as any);
    pendingActStore.set(phone, {
      command: planExp.command,
      data: planExp.data,
      timestamp: Date.now(),
      missing: planExp.missing,
      askPrompt: planExp.askPrompt,
    });
    conversationLogger.log(userId, phone, text, planExp.askPrompt, 'pending', 'expense_partial', null, 0, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
    return [{ type: 'text', text: planExp.askPrompt }];
  }

  if (intent.type === 'income_partial') {
    { const prereq = await hasNoPrerequisites(userId); if (prereq.blocked) return prereq.items!; }
    const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
    if (!hasIncomes) {
      return [{ type: 'text', text: '🔒 El registro de ingresos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
    }
    const { planIncomePartialPending } = await import('../middleware/financial-partial-pending.js');
    const planInc = planIncomePartialPending(intent.data as any);
    pendingActStore.set(phone, {
      command: planInc.command,
      data: planInc.data,
      timestamp: Date.now(),
      missing: planInc.missing,
      askPrompt: planInc.askPrompt,
    });
    conversationLogger.log(userId, phone, text, planInc.askPrompt, 'pending', 'income_partial', null, 0, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
    return [{ type: 'text', text: planInc.askPrompt }];
  }

  // --- Ambiguous → disambiguation buttons ---
  if (intent.type === 'ambiguous') {
    const buttons = intent.candidates.slice(0, 3).map((c, i) => ({
      id: `disambig_${i}`,
      title: c.label.slice(0, 20),
    }));
    conversationLogger.log(userId, phone, text, 'Disambiguation', 'ambiguous', null, null, null, aiUsed, Date.now() - startTime, true, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
    return [interactiveButtons('¿Que queres hacer?', buttons)];
  }

  // --- Route commands ---
  if (intent.type === 'command') {
    // Start flow commands → launch flow directly
    if (intent.data.command === 'start_expense_flow') {
      { const prereq = await hasNoPrerequisites(userId); if (prereq.blocked) return prereq.items!; }
      const result = await conversationEngine.startFlow(userId, 'expense_flow' as FlowState);
      if (result.nextContext) await conversationEngine.setFlowContext(userId, result.nextContext);
      return collectResponse(result.response);
    }
    if (intent.data.command === 'start_income_flow') {
      { const prereq = await hasNoPrerequisites(userId); if (prereq.blocked) return prereq.items!; }
      const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
      if (!hasIncomes) {
        return [{ type: 'text', text: '🔒 El registro de ingresos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
      }
      const result = await conversationEngine.startFlow(userId, 'income_flow' as FlowState);
      if (result.nextContext) await conversationEngine.setFlowContext(userId, result.nextContext);
      return collectResponse(result.response);
    }

    // Document upload intent ("quiero cargar una factura") → pending doc upload
    // (antes solo telegram/whatsapp — unificado; en test-bot el pending queda
    // seteado pero no hay path de fotos, inocuo).
    if (intent.data.command === 'start_document_upload') {
      const hasDocuments = await featureGate.hasFeature(userId, 'documents');
      if (!hasDocuments) {
        return [{ type: 'text', text: '🔒 El procesamiento de documentos no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.' }];
      }
      const docType = (intent.data.documentType as DocumentUploadIntent) || 'factura';
      const label = docType === 'factura' ? '🧾 factura' : docType === 'remito' ? '📋 remito' : '🎫 ticket';
      pendingDocUploadStore.set(phone, { intent: docType, timestamp: Date.now() });
      conversationLogger.log(userId, phone, text, `Start document upload: ${docType}`, 'command', 'start_document_upload', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
      return [{ type: 'text', text: `Enviame la foto o PDF del ${label} y lo proceso.` }];
    }

    if (DESTRUCTIVE_COMMANDS.has(intent.data.command)) {
      const actionLabels: Record<string, string> = {
        delete_last: 'eliminar el ultimo gasto',
        delete_last_income: 'eliminar el ultimo ingreso',
        delete_specific: 'eliminar un registro',
      };
      const label = actionLabels[intent.data.command] || 'realizar esta accion';
      pendingStore.set(phone, {
        type: 'expense',
        data: { type: 'expense', amount: 0, category: '', description: '', currency: 'ARS' },
        fieldId: null, fieldName: null, plotId: null, plotName: null,
        timestamp: Date.now(),
        _destructiveCommand: intent.data,
      } as any);
      return [interactiveButtons(
        `¿Seguro que queres ${label}?\nEsto no se puede deshacer.`,
        [
          { id: `confirm_destructive_${intent.data.command}`, title: 'Confirmar' },
          { id: 'cancel_destructive', title: 'Cancelar' },
        ],
      )];
    }

    // Attach original text so handlers can check if fields were explicitly mentioned
    intent.data.originalText = text;

    const response = await domainRouter.routeCommand(intent.data, userId, user, settings);
    if (response) {
      if (response.messages.length === 0 && !response.attachment && !response.interactive) {
        response.messages = ['No pude procesar ese comando. Escribi *ayuda* para ver las opciones.'];
      }
      response.suggestionKey = resolveSuggestionKey(intent.data.command, response.suggestionKey);
      // Start a flow if the handler requested it (e.g. add_field_city → field_flow)
      if (response.sideEffects?.startFlow) {
        const { state, data } = response.sideEffects.startFlow;
        let flowData = data;
        if (state === 'field_flow') {
          flowData = data ?? {};
          flowData._channel = ctx.channel;
          flowData._channelId = phone;
        }
        const flowResult = await conversationEngine.startFlow(userId, state, flowData);
        if (flowResult.nextContext) {
          await conversationEngine.setFlowContext(userId, flowResult.nextContext);
        }
        return collectResponse(flowResult.response);
      }
      const applied = applySideEffects(response.sideEffects, phone);
      learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
      conversationObserver.logCommandExecuted(userId, intent.data.command, { aiUsed, confidence });
      updateConversationMiniMemory(userId, {
        lastIntent: intent.data.command,
        lastActivityType: (intent.data.activityFilter as string) ?? (intent.data.activityType as string) ?? null,
        lastQueryType: intent.data.command.startsWith('query_') ? intent.data.command : null,
        lastTimeReference: (intent.data.timeLabel as string) ?? null,
      }).catch(() => {});
      conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'command', intent.data.command, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
      const items = collectResponse(response);
      if (applied.plotAreaPrompt) items.push({ type: 'text', text: applied.plotAreaPrompt });
      return items;
    }
  }

  // --- Handle expense ---
  if (intent.type === 'expense') {
    const hasExpenses = await featureGate.hasFeature(userId, 'expenses');
    if (!hasExpenses) {
      return [{ type: 'text', text: '🔒 El registro de gastos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
    }
    const effectiveSettings = confidence < lowConfidenceThreshold
      ? { ...settings, confirm_before_save: true }
      : settings;
    const expData = intent.data as ParsedExpense & { field?: string; plot?: string };
    const response = await financialHandler.handleExpense(userId, intent.data, text, effectiveSettings, user, expData.field, expData.plot);
    if (response.sideEffects?.startFlow) {
      const { state, data } = response.sideEffects.startFlow;
      const flowResult = await conversationEngine.startFlow(userId, state, data);
      if (flowResult.nextContext) {
        await conversationEngine.setFlowContext(userId, flowResult.nextContext);
      }
      const items = collectResponse(response);
      items.push(...collectResponse(flowResult.response));
      return items;
    }
    const appliedExp = applySideEffects(response.sideEffects, phone);
    learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
    updateConversationMiniMemory(userId, { lastIntent: 'expense' }).catch(() => {});
    conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'expense', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
    const itemsExp = collectResponse(response);
    if (appliedExp.replacedPending) {
      itemsExp.unshift({ type: 'text', text: await resolveReplacedPending(appliedExp.replacedPending, p => financialHandler.handleConfirm(userId, p, settings, user).then(() => {})) });
    }
    return itemsExp;
  }

  // --- Handle income ---
  if (intent.type === 'income') {
    const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
    if (!hasIncomes) {
      return [{ type: 'text', text: '🔒 El registro de ingresos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
    }
    const effectiveSettings = confidence < lowConfidenceThreshold
      ? { ...settings, confirm_before_save: true }
      : settings;
    const incData = intent.data as ParsedIncome & { field?: string; plot?: string };
    const response = await financialHandler.handleIncome(userId, intent.data, text, effectiveSettings, incData.field, incData.plot);
    if (response.sideEffects?.startFlow) {
      const { state, data } = response.sideEffects.startFlow;
      const flowResult = await conversationEngine.startFlow(userId, state, data);
      if (flowResult.nextContext) {
        await conversationEngine.setFlowContext(userId, flowResult.nextContext);
      }
      const items = collectResponse(response);
      items.push(...collectResponse(flowResult.response));
      return items;
    }
    const appliedInc = applySideEffects(response.sideEffects, phone);
    learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
    updateConversationMiniMemory(userId, { lastIntent: 'income' }).catch(() => {});
    conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'income', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
    const itemsInc = collectResponse(response);
    if (appliedInc.replacedPending) {
      itemsInc.unshift({ type: 'text', text: await resolveReplacedPending(appliedInc.replacedPending, p => financialHandler.handleConfirm(userId, p, settings, user).then(() => {})) });
    }
    return itemsInc;
  }

  // --- Unknown → Conversational fallback ---
  if (intent.type === 'unknown' || confidence < unknownFallbackThreshold) {
    await financialService.saveUnparsedMessage(userId, text);
    const fallbackResult = await conversationalFallback.respond(text, userId, settings);
    const items: BotResponseItem[] = [{ type: 'text', text: fallbackResult.response }];
    if (fallbackResult.aiUsed) {
      conversationLogger.log(userId, phone, text, fallbackResult.response, 'conversational', null, null, null, true, Date.now() - startTime, false, confidence, null, null, ctx.channel).catch(() => {});
    } else {
      const menuResponse = await systemHandler.handleCommand({ command: 'menu' }, userId, user, settings);
      items.push(...collectResponse(menuResponse));
      conversationLogger.log(userId, phone, text, fallbackResult.response, 'unknown', null, null, null, false, Date.now() - startTime, true, confidence, null, null, ctx.channel).catch(() => {});
    }
    return items;
  }

  return [];
}

// ============================================================
// handleInteractiveReply — manejo canónico de botones
// ============================================================

export async function handleInteractiveReply(
  callbackId: string,
  ctx: ChannelContext,
): Promise<BotResponseItem[]> {
  const { userId, user, settings, phone } = ctx;
  console.log(`[${ctx.channel}] INTERACTIVE:`, callbackId);

  conversationObserver.logMessageReceived(userId, { phone, messageType: 'interactive', messageLength: callbackId.length });

  // Branches específicos del canal (doc_* en tg/wa) — primero, para que el
  // canal pueda interceptar sus propios callbacks.
  if (ctx.handleDocCallback) {
    const channelItems = await ctx.handleDocCallback(callbackId, ctx);
    if (channelItems !== null) return channelItems;
  }

  // --- Flow callbacks ---
  if (callbackId.startsWith('flow_')) {
    const flowCtx = await conversationEngine.getFlowContext(userId);

    if (callbackId === 'flow_confirm') {
      const result = await conversationEngine.executeConfirm(userId, flowCtx);
      applySideEffects(result.response.sideEffects, phone);
      return collectResponse(result.response);
    }
    if (callbackId === 'flow_cancel') {
      await conversationEngine.clearFlow(userId);
      const menuResponse = await systemHandler.handleCommand({ command: 'menu' }, userId, user, settings);
      return [
        { type: 'text', text: '❌ Operacion cancelada.' },
        ...collectResponse(menuResponse),
      ];
    }
    if (callbackId === 'flow_skip') {
      const result = await conversationEngine.skipStep(userId, flowCtx);
      if (result.nextContext) await conversationEngine.setFlowContext(userId, result.nextContext);
      return collectResponse(result.response);
    }
    if (callbackId === 'flow_back') {
      const result = await conversationEngine.goBack(userId, flowCtx);
      if (result.nextContext) await conversationEngine.setFlowContext(userId, result.nextContext);
      return collectResponse(result.response);
    }
    if (callbackId.startsWith('flow_new_')) {
      const flowName = callbackId.replace('flow_new_', '') + '_flow';
      // Block financial/rainfall/activity flows if no fields or no plots
      if (['expense_flow', 'income_flow', 'rainfall_flow', 'activity_flow'].includes(flowName)) {
        const prereq = await hasNoPrerequisites(userId);
        if (prereq.blocked) return prereq.items!;
      }
      // field_flow necesita saber el canal para el paso de ubicación (mapa/share).
      const prefillData = flowName === 'field_flow' ? { _channel: ctx.channel, _channelId: phone } : undefined;
      const result = await conversationEngine.startFlow(userId, flowName as FlowState, prefillData);
      conversationObserver.logFlowStarted(userId, flowName, { trigger: 'interactive_button' });
      return collectResponse(result.response);
    }
    // flow_field_loc_ → location method buttons, pass full ID to flow engine
    if (callbackId.startsWith('flow_field_loc_') && flowCtx.state !== 'idle') {
      const result = await conversationEngine.processFlowMessage(userId, callbackId, flowCtx);
      if (result.nextContext) {
        await conversationEngine.setFlowContext(userId, result.nextContext);
      } else {
        await conversationEngine.clearFlow(userId);
      }
      return collectResponse(result.response);
    }
    // flow_cat_, flow_field_, flow_activity_ → feed into flow
    const prefixes = ['flow_cat_', 'flow_field_', 'flow_plot_', 'flow_activity_'] as const;
    for (const prefix of prefixes) {
      if (callbackId.startsWith(prefix)) {
        let value = callbackId.replace(prefix, '');
        if (prefix === 'flow_plot_') {
          // Handle field__plot format for duplicate plot names across fields
          // e.g. "don_pedro__1a" → plot="1a", fieldHint="don pedro"
          const doubleSepIdx = value.indexOf('__');
          if (doubleSepIdx > 0) {
            const fieldHint = value.slice(0, doubleSepIdx).replace(/_/g, ' ');
            value = value.slice(doubleSepIdx + 2).replace(/_/g, ' ');
            // Store field hint in flow data so execute() can disambiguate
            if (flowCtx.state !== 'idle') {
              flowCtx.data._resolvedFieldHint = fieldHint;
              await conversationEngine.setFlowContext(userId, flowCtx);
            }
          } else {
            value = value.replace(/_/g, ' ');
          }
        } else if (prefix === 'flow_field_') {
          value = value.replace(/_/g, ' ');
        }
        if (flowCtx.state !== 'idle') {
          const result = await conversationEngine.processFlowMessage(userId, value, flowCtx);
          if (result.nextContext) {
            await conversationEngine.setFlowContext(userId, result.nextContext);
          } else {
            await conversationEngine.clearFlow(userId);
          }
          applySideEffects(result.response.sideEffects, phone);
          return collectResponse(result.response);
        }
      }
    }
    return [];
  }

  // --- Destructive command confirmation ---
  if (callbackId.startsWith('confirm_destructive_')) {
    const pendingAction = pendingStore.get(phone) as any;
    pendingStore.clear(phone);
    if (pendingAction?._destructiveCommand) {
      const response = await domainRouter.routeCommand(pendingAction._destructiveCommand, userId, user, settings);
      if (response) return collectResponse(response);
    }
    return [];
  }

  if (callbackId === 'cancel_destructive' || callbackId === 'cancel_action' || callbackId === 'cancel_pending') {
    pendingStore.clear(phone);
    conversationLogger.log(userId, phone, `[${callbackId}]`, 'Operacion cancelada.', 'command', 'cancel', null, null, false, null, false, null, null, null, ctx.channel).catch(() => {});
    return [{ type: 'text', text: '❌ Operacion cancelada.' }];
  }

  // --- Confirm pending financial transaction (buttons) ---
  if (callbackId === 'confirm_pending') {
    const pendingTx = pendingStore.get(phone);
    if (!pendingTx) {
      conversationLogger.log(userId, phone, '[confirm_pending]', 'No hay nada pendiente para confirmar.', 'command', 'confirm', null, null, false, null, false, null, null, null, ctx.channel).catch(() => {});
      return [{ type: 'text', text: 'No hay nada pendiente para confirmar.' }];
    }
    pendingStore.clear(phone);
    const response = await financialHandler.handleConfirm(userId, pendingTx, settings, user);
    applySideEffects(response.sideEffects, phone);
    conversationLogger.log(userId, phone, '[confirm_pending]', response.messages[0] ?? response.interactive?.body ?? null, 'command', 'confirm', null, null, false, null, false, null, null, null, ctx.channel).catch(() => {});
    return collectResponse(response);
  }

  // --- Field duplicate resolution ---
  if (callbackId.startsWith('field_dup_')) {
    const pendingDup = pendingStore.get(phone) as any;
    const dupData = pendingDup?._fieldDuplicate as { name: string; city: string | null } | undefined;

    if (!dupData) {
      return [{ type: 'text', text: 'No hay un campo pendiente. Empeza de nuevo.' }];
    }

    pendingStore.clear(phone);

    if (callbackId === 'field_dup_update') {
      if (dupData.city) {
        await financialService.setFieldCity(userId, dupData.name, dupData.city);
        return [{ type: 'text', text: `📍 Campo *${dupData.name}* actualizado. Nueva ubicacion: *${dupData.city}*` }];
      }
      return [{ type: 'text', text: `El campo *${dupData.name}* ya existe y no hay cambios que aplicar.` }];
    }

    if (callbackId === 'field_dup_rename') {
      const prefill: Record<string, unknown> = { _channel: ctx.channel, _channelId: phone };
      if (dupData.city) prefill.city = dupData.city;
      const flowResult = await conversationEngine.startFlow(userId, 'field_flow' as FlowState, prefill);
      if (flowResult.nextContext) {
        await conversationEngine.setFlowContext(userId, flowResult.nextContext);
      }
      const items: BotResponseItem[] = [
        { type: 'text', text: `Elegi otro nombre para el campo${dupData.city ? ` en ${dupData.city}` : ''}:` },
        ...collectResponse(flowResult.response),
      ];
      return items;
    }

    // field_dup_cancel
    return [{ type: 'text', text: '❌ Operacion cancelada.' }];
  }

  // --- Create plot ---
  if (callbackId.startsWith('create_plot_')) {
    const match = callbackId.match(/^create_plot_(.+)_in_(.+)$/);
    if (match) {
      const plotName = match[1].replace(/_/g, ' ');
      const fieldName = match[2].replace(/_/g, ' ');
      const field = await financialService.getFieldByName(userId, fieldName);
      if (field) {
        const plot = await financialService.getOrCreatePlot(field.id, plotName);
        const response: HandlerResponse = {
          messages: [`📍 Lote *${plot.name}* creado en campo *${field.name}*`],
          suggestionKey: 'plot_created',
          sideEffects: { setPendingPlotArea: { plotId: plot.id, plotName: plot.name, fieldName: field.name } },
        };
        const items = collectResponse(response);
        const applied = applySideEffects(response.sideEffects, phone);
        if (applied.plotAreaPrompt) items.push({ type: 'text', text: applied.plotAreaPrompt });
        return items;
      }
      return [{ type: 'text', text: `No encontre el campo *${fieldName}*.` }];
    }
    return [];
  }

  // --- Confirm delete field ---
  if (callbackId.startsWith('confirm_delete_field_')) {
    const fieldName = callbackId.replace('confirm_delete_field_', '').replace(/_/g, ' ');
    const deleted = await financialService.deleteField(userId, fieldName);
    if (deleted) {
      const response: HandlerResponse = {
        messages: [`🗑️ Campo *${fieldName}* eliminado.\nLos gastos/ingresos asociados quedan sin asignar.\n\n_Para restaurarlo: "restaurar campo ${fieldName}"_`],
        suggestionKey: 'field_deleted',
      };
      return collectResponse(response);
    }
    return [{ type: 'text', text: `No se pudo eliminar el campo *${fieldName}*.` }];
  }

  // --- Confirm delete plot ---
  if (callbackId.startsWith('confirm_delete_plot_')) {
    const match = callbackId.match(/^confirm_delete_plot_(.+)_in_(.+)$/);
    if (match) {
      const plotName = match[1].replace(/_/g, ' ');
      const fieldName = match[2].replace(/_/g, ' ');
      const field = await financialService.getFieldByName(userId, fieldName);
      if (field) {
        const plots = await financialService.findPlotByNameAcrossFields(userId, plotName);
        const plot = plots.find((p: any) => p.field_id === field.id);
        if (plot) {
          await financialService.deletePlot(plot.id, userId);
          const response: HandlerResponse = {
            messages: [`🗑️ Lote *${plotName}* eliminado del campo *${fieldName}*.\nLos registros asociados quedan sin lote.\n\n_Para restaurarlo: "restaurar lote ${plotName}"_`],
            suggestionKey: 'plot_deleted',
          };
          return collectResponse(response);
        }
        return [{ type: 'text', text: `No encontre el lote *${plotName}* en campo *${fieldName}*.` }];
      }
      return [{ type: 'text', text: `No encontre el campo *${fieldName}*.` }];
    }
    return [];
  }

  // --- Stock entry suggestion (from insumo expense) ---
  if (callbackId.startsWith('stock_entry_yes_') || callbackId.startsWith('stock_entry_no_')) {
    const accepted = callbackId.startsWith('stock_entry_yes_');
    if (accepted) {
      try {
        const pendingEntry = pendingStockEntryStore.get(phone);
        if (pendingEntry) {
          const { StockPurchaseService } = await import('../domain/stock/stock-purchase.service.js');
          const purchaseService = new StockPurchaseService();
          const { item } = await purchaseService.applyStockEntry(userId, pendingEntry as any);
          pendingStockEntryStore.delete(phone);
          return [{ type: 'text', text: `📦 Stock actualizado: *${item.name}* → ${item.current_quantity} ${item.unit}` }];
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al cargar stock';
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    }
    pendingStockEntryStore.delete(phone);
    return [{ type: 'text', text: accepted ? '📦 Stock cargado.' : '👍 OK, no se cargó al stock.' }];
  }

  // --- Stock deduction suggestion (from activity) ---
  if (callbackId.startsWith('stock_deduct_yes_') || callbackId.startsWith('stock_deduct_no_')) {
    const accepted = callbackId.startsWith('stock_deduct_yes_');
    if (accepted) {
      try {
        const pendingDeduct = pendingStockDeductionStore.get(phone) as Record<string, unknown> | undefined;
        if (pendingDeduct) {
          if (!pendingDeduct.totalQuantity || (pendingDeduct.totalQuantity as number) <= 0) {
            (pendingDeduct as any).awaitingQuantity = true;
            pendingStockDeductionStore.set(phone, pendingDeduct);
            return [{ type: 'text', text: `¿Cuántos ${pendingDeduct.unit || 'lt'} de *${pendingDeduct.product}* usaste?` }];
          }
          const { StockDeductionService } = await import('../domain/stock/stock-deduction.service.js');
          const deductionService = new StockDeductionService();
          const { item } = await deductionService.applyDeduction(userId, pendingDeduct as any);
          pendingStockDeductionStore.delete(phone);
          return [{ type: 'text', text: `📤 Stock descontado: *${item.name}* → ${item.current_quantity} ${item.unit}` }];
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al descontar stock';
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    } else {
      // Decline path: persist the user's NO so the activity isn't re-asked.
      const pendingDeduct = pendingStockDeductionStore.get(phone) as Record<string, unknown> | undefined;
      if (pendingDeduct?.domainEventId) {
        try {
          const { StockDeductionService } = await import('../domain/stock/stock-deduction.service.js');
          const svc = new StockDeductionService();
          await svc.declineDeduction(pendingDeduct.domainEventId as number);
        } catch (err) {
          console.error(`[${ctx.channel}] declineDeduction failed:`, err);
        }
      }
    }
    pendingStockDeductionStore.delete(phone);
    return [{ type: 'text', text: accepted ? '📤 Stock descontado.' : '👍 OK, no se descontó del stock.' }];
  }

  // --- Grain stock entry suggestion (from harvest) ---
  if (callbackId.startsWith('stock_grain_yes_') || callbackId.startsWith('stock_grain_no_')) {
    const accepted = callbackId.startsWith('stock_grain_yes_');
    if (accepted) {
      try {
        const pendingGrain = pendingStockEntryStore.get(phone);
        if (pendingGrain && (pendingGrain as any).type === 'grain') {
          const { StockPurchaseService } = await import('../domain/stock/stock-purchase.service.js');
          const svc = new StockPurchaseService();
          const { item, movement } = await svc.applyStockEntry(userId, pendingGrain as any);
          pendingStockEntryStore.delete(phone);
          return [{ type: 'text', text: `📦 Stock actualizado: +${formatQuantityHuman(movement.quantity, item.unit)} de ${item.name} (${formatQuantityHuman(item.current_quantity, item.unit)} total)` }];
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al cargar al silo';
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    }
    pendingStockEntryStore.delete(phone);
    return [{ type: 'text', text: accepted ? '📦 Grano cargado al silo.' : '👍 OK, no se cargó al stock.' }];
  }

  // --- Grain sale stock deduction (income → stock) ---
  if (callbackId.startsWith('stock_grain_sale_yes_') || callbackId.startsWith('stock_grain_sale_no_')) {
    const accepted = callbackId.startsWith('stock_grain_sale_yes_');
    if (accepted) {
      try {
        const pendingSale = pendingStockDeductionStore.get(phone);
        if (pendingSale) {
          const { StockService } = await import('../domain/stock/stock.service.js');
          const svc = new StockService();
          const { item } = await svc.removeStock(userId, pendingSale.product as string, pendingSale.totalQuantity as number, pendingSale.unit as string, {
            reason: 'Venta de grano',
          });
          pendingStockDeductionStore.delete(phone);
          return [{ type: 'text', text: `📦 Stock descontado: *${item.name}* → ${item.current_quantity}${item.unit} restante` }];
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al descontar stock';
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    }
    pendingStockDeductionStore.delete(phone);
    return [{ type: 'text', text: accepted ? '📦 Stock descontado.' : '👍 OK, no se descontó del stock.' }];
  }

  // --- Campaign close suggestion (after activity on harvested campaign) ---
  if (callbackId.startsWith('campaign_close_yes_') || callbackId.startsWith('campaign_close_no_')) {
    const accepted = callbackId.startsWith('campaign_close_yes_');
    if (accepted) {
      const pendingClose = pendingCampaignCloseStore.get(phone);
      if (pendingClose) {
        const { CropService } = await import('../domain/plots/crop.service.js');
        await new CropService().closeCampaign(pendingClose.plotCropId);
        pendingCampaignCloseStore.delete(phone);
        return [{ type: 'text', text: `✅ Campaña de *${pendingClose.crop}* en *${pendingClose.plotName}* cerrada.` }];
      }
    }
    pendingCampaignCloseStore.delete(phone);
    return [{ type: 'text', text: '👌 La campaña sigue abierta.' }];
  }

  // --- Generic interactive routing ---
  const intent = interactiveRouter.route(callbackId);
  if (intent && intent.type === 'command') {
    const response = await domainRouter.routeCommand(intent.data, userId, user, settings);
    if (response) return collectResponse(response);
  }
  return [];
}
