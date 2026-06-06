import express from 'express';
import type { Request, Response } from 'express';
import { sendMessage, uploadMedia, sendDocument, sendInteractiveButtons, sendInteractiveList } from '../services/whatsapp.js';
import { IntentClassifier } from '../services/intent-classifier.js';
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
import { isAffirmation, looksLikeNewActionOrQuery, isContentlessMessage } from '../middleware/conversation-guards.js';
import { isNewActionInterrupt } from '../middleware/pending-action-processor.js';
import { MessageDedup } from '../middleware/dedup.js';
import { PendingTransactionStore, describeReplacedPending, resolveReplacedPending } from '../middleware/pending-transactions.js';
import { PendingObservationStore } from '../middleware/pending-observations.js';
import { PendingActivityStore } from '../middleware/pending-activities.js';
import { PendingFieldCityStore } from '../middleware/pending-field-city.js';
import { PendingPlotAreaStore } from '../middleware/pending-plot-area.js';
import { PendingFieldLocationStore } from '../middleware/pending-field-location.js';
import { handlePendingCity } from '../middleware/pending-field-city-handler.js';
import { handlePendingPlotArea, storePlotAreaSideEffects } from '../middleware/pending-plot-area-handler.js';
import { LearningService } from '../domain/learning/learning.service.js';
import { ContextResolver } from '../domain/learning/context-resolver.js';
import { FeatureGate } from '../domain/billing/feature-gate.js';
import { TranscriptionService, AudioTooLongError } from '../services/audio/transcription.service.js';
import { getAudioConfig } from '../services/audio/audio.types.js';
import { saveAudioTranscriptionLog, getHourlyAudioCount } from '../services/expenses.js';
import { getSetting, getSettingNumber, getSettingBool } from '../services/settings.service.js';
import { pool } from '../config/db.js';
import { logError, logWarning } from '../services/error-logger.js';
import { ConversationStateRepository } from '../middleware/conversation-state.repository.js';
import { ConversationEngine, buildTimeoutMessage } from '../middleware/conversation-engine.js';
import { ConversationLogger } from '../middleware/conversation-logger.js';
import { FlowRegistry } from '../middleware/flows/flow-registry.js';
import { expenseFlow } from '../middleware/flows/expense.flow.js';
import { incomeFlow } from '../middleware/flows/income.flow.js';
import { fieldFlow } from '../middleware/flows/field.flow.js';
import { rainfallFlow } from '../middleware/flows/rainfall.flow.js';
import { activityFlow } from '../middleware/flows/activity.flow.js';
import { EntityValidator } from '../services/entity-validator.js';
import { getSuggestions, resolveSuggestionKey, getDefaultSuggestion } from '../middleware/contextual-suggestions.js';
import { enrichWithContext } from '../middleware/context-reuse.js';
import { updateConversationMiniMemory } from '../services/expenses.js';
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
import { normalizeTranscript } from '../utils/text-normalizer.js';
import { formatPlotListGrouped } from '../middleware/flows/field-step-helpers.js';
import { isLikelyQuestion } from '../utils/guards.js';
import { extractCropFromText } from '../utils/crops.js';
import { saveObservation, SAVE_REJECTED_DUPLICATE } from '../services/observations.js';
import { PlotDiscoveryService } from '../domain/plots/plot-discovery.service.js';
import { formatObservationResponse } from '../middleware/response-formatter.js';
import { DocumentService, DocumentError } from '../domain/documents/document.service.js';
import { PendingDocumentStore } from '../middleware/pending-documents.js';
import { PendingDocumentUploadStore } from '../middleware/pending-document-upload.js';
import type { DocumentUploadIntent } from '../middleware/pending-document-upload.js';
import { formatExtractionSummary, buildSuggestedExpenses, buildPostExtractionButtons } from '../domain/documents/document.helpers.js';
import type { ParsedExpense, ParsedIncome, HandlerResponse, Intent, FlowState, ParseResult, UserId, PendingTransaction } from '../types/index.js';

// --- Wire up dependencies ---

const financialRepository = new FinancialRepository();
const financialService = new FinancialService(financialRepository);
const userRepository = new UserRepository();

const financialHandler = new FinancialHandler(financialService);
const agronomyRepository = new AgronomyRepository();
const agronomyHandler = new AgronomyHandler(agronomyRepository);
const systemHandler = new SystemHandler(userRepository, financialService);

const featureGate = new FeatureGate();
const domainRouter = new DomainRouter(financialHandler, agronomyHandler, systemHandler, featureGate);
const interactiveRouter = new InteractiveRouter();

// --- AI Intent Extraction ---
const entityValidator = new EntityValidator();
const userContextService = new UserContextService(entityValidator);
const promptBuilder = new PromptBuilder();
const intentValidator = new IntentValidator();
const conversationHistoryService = new ConversationHistoryService();
const fewShotService = new FewShotService();
const intentExtractor = new IntentExtractor(promptBuilder, intentValidator, userContextService, userRepository, conversationHistoryService, fewShotService);
const agentPromptBuilder = new AgentPromptBuilder();
const agentService = new AgentService(agentPromptBuilder, userContextService, userRepository, conversationHistoryService, fewShotService);
const agentResponseMapper = new AgentResponseMapper();
const intentClassifier = new IntentClassifier(undefined, undefined, intentExtractor, agentService, agentResponseMapper, userContextService);
const conversationalFallback = new ConversationalFallbackService(userRepository);

const dedup = new MessageDedup();
const pendingStore = new PendingTransactionStore();
const pendingObsStore = new PendingObservationStore();
const pendingActStore = new PendingActivityStore();
const pendingCityStore = new PendingFieldCityStore();
const pendingPlotAreaStore = new PendingPlotAreaStore();
const plotDiscovery = new PlotDiscoveryService();
const learningService = new LearningService();
const contextResolver = new ContextResolver();
const transcriptionService = new TranscriptionService();
const pendingStockEntryStore = new Map<string, Record<string, unknown>>();
const pendingStockDeductionStore = new Map<string, Record<string, unknown>>();
const documentService = new DocumentService();
const pendingDocumentStore = new PendingDocumentStore();
const pendingDocUploadStore = new PendingDocumentUploadStore();
const pendingFieldLocationStore = new PendingFieldLocationStore();
import { pendingCampaignCloseStore } from '../middleware/pending-campaign-close.js';

/** Resolve field/plot for document expense saving. */
async function resolveDocPlotWa(userId: UserId): Promise<
  | { resolved: true; fieldId: number; plotId: number }
  | { resolved: false; plots: Array<{ id: number; name: string; field_name: string }> }
  | { resolved: true; fieldId: null; plotId: null }
> {
  const allPlots = await financialService.findAllUserPlots(userId);
  if (allPlots.length === 0) return { resolved: true, fieldId: null, plotId: null };
  if (allPlots.length === 1) {
    const p = allPlots[0];
    return { resolved: true, fieldId: p.field_id, plotId: p.id };
  }
  const recent = await financialService.getRecentFinancialContext(userId);
  if (recent?.plotId) return { resolved: true, fieldId: recent.fieldId, plotId: recent.plotId };
  return { resolved: false, plots: allPlots };
}

// --- Flow engine ---

const flowRegistry = new FlowRegistry();
flowRegistry.register(expenseFlow);
flowRegistry.register(incomeFlow);
flowRegistry.register(fieldFlow);
flowRegistry.register(rainfallFlow);
flowRegistry.register(activityFlow);

const conversationStateRepo = new ConversationStateRepository();
const conversationObserver = new ConversationObserver();
const conversationEngine = new ConversationEngine(conversationStateRepo, flowRegistry, conversationObserver);
const conversationLogger = new ConversationLogger();

// Prerequisite block: requires at least 1 campo, and nudges if 0 lotes
async function checkPrerequisiteBlock(userId: UserId, phone: string, actionLabel: string): Promise<boolean> {
  const fields = await financialService.getUserFields(userId);
  if (fields.length === 0) {
    await sendMessage(phone, `Para ${actionLabel} primero necesitás crear un campo.\n\n📍 Escribí *agregar campo [nombre]*`);
    await sendInteractiveButtons(phone, `Necesitás un campo para ${actionLabel}.`, [
      { id: 'cmd_agregar_campo', title: 'Crear Campo' },
    ]);
    return true;
  }
  const allPlots = await financialService.findAllUserPlots(userId);
  if (allPlots.length === 0) {
    const example = fields[0].name;
    await sendMessage(phone, `Para ${actionLabel} necesitás al menos un lote.\n\n📍 Escribí *agregar lote [nombre] en campo ${example}*`);
    await sendInteractiveButtons(phone, `Necesitás un lote para ${actionLabel}.`, [
      { id: 'cmd_agregar_lote', title: 'Crear Lote' },
    ]);
    return true;
  }
  return false;
}

// Destructive commands that require confirmation (delete_field/delete_plot handled by their own handler)
const DESTRUCTIVE_COMMANDS = new Set([
  'delete_last', 'delete_last_income', 'delete_specific',
]);

// Safe interruption commands: read-only commands that can be answered mid-flow without canceling

const DEFAULT_MAX_AUDIO_PER_HOUR = 10;

const SAFE_INTERRUPTION_COMMANDS = new Set([
  'list_fields', 'list_plots', 'field_info', 'help', 'menu',
  'weather_full', 'financial_report', 'monthly_report', 'weekly_report', 'rainfall_report',
  'greeting', 'thanks', 'dollar',
]);

function isCancelIntent(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (['cancelar', 'cancel', 'salir', 'no', 'parar', 'basta', 'chau', 'terminar'].includes(lower)) {
    return true;
  }
  if (/^no\s*(quiero|gracias|,?\s*gracias)$/i.test(lower)) {
    return true;
  }
  return false;
}

// --- Response helper ---

async function sendResponse(phone: string, response: HandlerResponse): Promise<void> {
  // Skip a plain message that duplicates the interactive body (confirmations,
  // plot prompts) — otherwise WhatsApp shows the same paragraph twice.
  const interactiveBody = response.interactive?.body?.trim();
  for (const msg of response.messages) {
    if (interactiveBody && msg.trim() === interactiveBody) continue;
    await sendMessage(phone, msg);
  }
  if (response.attachment) {
    const { buffer, filename, mime, caption } = response.attachment;
    const mediaId = await uploadMedia(buffer, filename, mime);
    await sendDocument(phone, mediaId, filename, caption);
  }
  if (response.interactive) {
    if (response.interactive.type === 'buttons') {
      await sendInteractiveButtons(phone, response.interactive.body, response.interactive.buttons);
    } else if (response.interactive.type === 'list') {
      await sendInteractiveList(phone, response.interactive.body, response.interactive.buttonText, response.interactive.sections);
    }
  }
  // Send contextual suggestions after action completion (only if no interactive already sent)
  if (!response.interactive) {
    const suggestion = response.suggestionKey
      ? getSuggestions(response.suggestionKey)
      : null;
    if (suggestion && suggestion.type === 'buttons') {
      await sendInteractiveButtons(phone, suggestion.body, suggestion.buttons);
    }
  }
}

// --- Document expense saving helpers ---

/** Save document expenses, then check for product discovery (missing products in stock). */
async function saveDocExpensesWa(
  pending: import('../middleware/pending-documents.js').PendingDocumentAction,
  userId: UserId, phone: string,
  fieldId: number | null, plotId: number | null,
): Promise<void> {
  const { saveExpense } = await import('../services/expenses.js');
  const { formatMoney } = await import('../utils/format-money.js');
  const messages: string[] = [];
  let firstExpenseId: number | null = null;
  for (const exp of pending.suggestedExpenses) {
    const saved = await saveExpense(userId, {
      amount: exp.amount!,
      category: exp.category || 'Otros',
      description: exp.description || 'Factura procesada',
      currency: exp.currency || 'ARS',
      expenseDate: exp.expenseDate || null,
      expenseType: exp.expenseType || 'varios',
      product: exp.product || null,
      quantity: exp.quantity || null,
      unit: exp.unit || null,
    }, fieldId, plotId);
    if (!firstExpenseId && saved?.id) firstExpenseId = saved.id;
    messages.push(`✅ Gasto registrado: ${formatMoney(Number(exp.amount), exp.currency || 'ARS')} - ${exp.description}`);
  }
  if (firstExpenseId) {
    await documentService.linkToExpense(pending.documentId, firstExpenseId, userId).catch(() => {});
  }
  await sendMessage(phone, messages.join('\n'));

  // Product discovery: check if any line item products are missing from stock
  try {
    const lineItems = pending.extraction.line_items;
    if (lineItems && lineItems.length > 0) {
      const { StockService } = await import('../domain/stock/stock.service.js');
      const stockService = new StockService();
      const { FeatureGate: FG } = await import('../domain/billing/feature-gate.js');
      const fg = new FG();
      const hasStock = await fg.hasFeature(userId, 'stock');
      if (hasStock) {
        const products = lineItems.map(li => ({ name: li.product, unit: li.unit, category: li.category }));
        const missing = await stockService.findMissingProducts(userId, products);
        if (missing.length > 0) {
          pending.missingProducts = missing;
          pendingDocumentStore.set(phone, pending);
          const names = missing.map(p => p.name).join(', ');
          await sendInteractiveButtons(phone,
            `Encontré ${missing.length} producto${missing.length > 1 ? 's' : ''} que no está${missing.length > 1 ? 'n' : ''} en tu stock: *${names}*. ¿Querés darlos de alta?`,
            [
              { id: `doc_create_products_yes_${pending.documentId}`, title: 'Sí, crear' },
              { id: `doc_create_products_no_${pending.documentId}`, title: 'No' },
            ],
          );
          return;
        }
      }
    }
  } catch {
    // Product discovery is best-effort
  }

  pendingDocumentStore.clear(phone);
}

/** Load remito line items into stock (optionally into a specific warehouse). */
async function loadRemitoStockWa(
  pending: import('../middleware/pending-documents.js').PendingDocumentAction,
  userId: UserId, phone: string,
  stockService: import('../domain/stock/stock.service.js').StockService,
  warehouseId?: number,
): Promise<void> {
  const messages: string[] = [];
  for (const item of pending.extraction.line_items!) {
    try {
      if (warehouseId) {
        const { item: stockItem } = await stockService.addStockToWarehouse(
          userId, warehouseId, item.product, item.category || 'otros',
          item.quantity || 1, item.unit || 'u',
          `Remito ${pending.extraction.supplier || ''}`.trim(),
        );
        messages.push(`📦 +${item.quantity || 1}${item.unit || 'u'} de ${stockItem.name} (${stockItem.current_quantity}${stockItem.unit} total)`);
      } else {
        const { item: stockItem } = await stockService.addStock(userId, item.product, item.quantity || 1, item.unit || 'u', {
          category: item.category || 'otros',
          reason: `Remito ${pending.extraction.supplier || ''}`.trim(),
        });
        messages.push(`📦 +${item.quantity || 1}${item.unit || 'u'} de ${stockItem.name} (${stockItem.current_quantity}${stockItem.unit} total)`);
      }
    } catch {
      messages.push(`⚠️ No pude cargar ${item.product} al stock`);
    }
  }
  pendingDocumentStore.clear(phone);
  await sendMessage(phone, messages.join('\n'));
}

// --- Document processing helper ---

async function processDocumentWithIntent(
  phone: string, userId: UserId, buffer: Buffer, mediaMime: string,
  filename: string | undefined, caption: string, docIntent: DocumentUploadIntent | undefined,
  startTime: number,
): Promise<void> {
  // Phase 3 — block OCR for trial-expired users. Vision API costs real money.
  const { getUserAccessMode, trialExpiredCopy } = await import('../services/access-gate.service.js');
  if (await getUserAccessMode(Number(userId)) === 'trial_expired_readonly') {
    console.log(`[TRIAL_EXPIRED] user=${userId} channel=document source=whatsapp`);
    await sendMessage(phone, trialExpiredCopy());
    return;
  }
  const { document: doc, extraction, isExisting } = await documentService.processDocument(
    userId, buffer, mediaMime, filename, 'whatsapp', caption,
  );

  if (isExisting) {
    await sendMessage(phone, `📄 Este documento ya fue procesado (#${doc.id}).`);
    return;
  }

  const summary = formatExtractionSummary(extraction, doc.id, doc.document_type || 'otro');
  await sendMessage(phone, summary);

  // Smart post-extraction buttons based on content + intent
  const hasStock = await featureGate.hasFeature(userId, 'stock');
  const buttonConfig = buildPostExtractionButtons(extraction, doc.id, docIntent, hasStock);

  if (buttonConfig) {
    // Store pending document for expense/stock callbacks
    const suggestedExpenses = buildSuggestedExpenses(extraction);
    pendingDocumentStore.set(phone, {
      documentId: doc.id,
      extraction,
      suggestedExpenses,
      timestamp: Date.now(),
    });
    await sendInteractiveButtons(phone, buttonConfig.body, buttonConfig.buttons);
  }

  conversationLogger.log(userId, phone, `[document:${mediaMime}]`, summary.slice(0, 200), 'command', 'process_document', null, null, true, Date.now() - startTime, true).catch(() => {});
}

// --- Router ---

const router = express.Router();

// GET /webhook — WhatsApp verification
router.get('/', (req: Request, res: Response) => {
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
    return;
  }
  res.sendStatus(403);
});

// POST /webhook — Message handler
router.post('/', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const entry = req.body?.entry;
    const message = entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      res.sendStatus(200);
      return;
    }

    // Deduplication
    if (dedup.isDuplicate(message.id)) {
      res.sendStatus(200);
      return;
    }

    const phone: string = message.from;
    let text: string | undefined = message.text?.body;

    // --- Channel verification gate ---
    // If REQUIRE_VERIFIED_CHANNEL is on AND no verified user owns this phone,
    // refuse to auto-create an anonymous user. Send an onboarding hint and stop.
    // (When the kill switch is off — default during MVP — the controller falls
    // through and the existing getOrCreate calls handle the legacy auto-create
    // path for backwards compatibility.)
    const verifiedWaUser = await userRepository.findVerifiedByPhone(phone);
    if (!verifiedWaUser && (await userRepository.isVerificationRequired())) {
      const publicUrl = (await getSetting('PUBLIC_URL')) || 'https://campo-bot-production.up.railway.app';
      await sendMessage(
        phone,
        `Hola 👋 Bienvenido a Campo Bot.\n\nPara empezar a usarme, seguí estos 2 pasos en orden:\n\n*1.* Creá tu cuenta acá 👉 ${publicUrl}/register\n*2.* Desde la app, andá a *Mi cuenta* → *Vincular WhatsApp* y te mando un código a este número.\n\nUna vez vinculado, escribime de nuevo y ya podés cargar gastos, lluvias, hacienda, cosechas y más.`,
      );
      res.sendStatus(200);
      return;
    }

    // --- Interactive reply handling ---
    if (message.type === 'interactive') {
      const interactiveData = message.interactive;
      let callbackId: string | undefined;
      if (interactiveData?.type === 'button_reply') {
        callbackId = interactiveData.button_reply?.id;
      } else if (interactiveData?.type === 'list_reply') {
        callbackId = interactiveData.list_reply?.id;
      }

      if (callbackId) {
        console.log('FROM:', phone, 'INTERACTIVE:', callbackId);

        // --- Flow callback handling ---
        if (callbackId.startsWith('flow_')) {
          const user = await userRepository.getOrCreate(phone);
          const userId = user.id;
          const settings = await userRepository.getSettings(userId);
          const flowCtx = await conversationEngine.getFlowContext(userId);
          conversationObserver.logMessageReceived(userId, { phone, messageType: 'interactive', messageLength: callbackId.length });

          if (callbackId === 'flow_confirm') {
            const result = await conversationEngine.executeConfirm(userId, flowCtx);
            // Store pending field duplicate data if the flow detected one
            if (result.response.sideEffects?.setFieldDuplicate) {
              const dup = result.response.sideEffects.setFieldDuplicate;
              pendingStore.set(phone, {
                type: 'expense', data: { type: 'expense', amount: 0, category: '', description: '', currency: 'ARS' },
                fieldId: null, fieldName: null, plotId: null, plotName: null,
                timestamp: Date.now(), _fieldDuplicate: dup,
              } as any);
            }
            // Store pending stock entry if expense flow suggests one
            if (result.response.sideEffects?.setPendingStockEntry) {
              pendingStockEntryStore.set(phone, result.response.sideEffects.setPendingStockEntry);
            }
            // Store pending field location for share-location flow
            if (result.response.sideEffects?.setPendingFieldLocation) {
              const loc = result.response.sideEffects.setPendingFieldLocation;
              pendingFieldLocationStore.set(phone, { fieldId: loc.fieldId, fieldName: loc.fieldName });
            }
            await sendResponse(phone, result.response);
            conversationLogger.log(userId, phone, '[confirm]', result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', 'flow_confirm', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
          } else if (callbackId === 'flow_cancel') {
            const durationMs = flowCtx.startedAt ? Date.now() - new Date(flowCtx.startedAt).getTime() : undefined;
            conversationObserver.logFlowAbandoned(userId, flowCtx.state, flowCtx.step, 'cancelled', { durationMs, filledFields: Object.keys(flowCtx.data) });
            await conversationEngine.clearFlow(userId);
            await sendMessage(phone, '\u274c Operaci\u00f3n cancelada.');
            const menuResponse = await systemHandler.handleCommand({ command: 'menu' }, userId, user, settings);
            await sendResponse(phone, menuResponse);
            conversationLogger.log(userId, phone, '[cancel]', 'Operaci\u00f3n cancelada.', 'flow', 'flow_cancel', flowCtx.state, flowCtx.step, false, Date.now() - startTime).catch(() => {});
          } else if (callbackId === 'flow_skip') {
            const result = await conversationEngine.skipStep(userId, flowCtx);
            if (result.nextContext) {
              await conversationEngine.setFlowContext(userId, result.nextContext);
            }
            await sendResponse(phone, result.response);
            conversationLogger.log(userId, phone, '[skip]', result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', 'flow_skip', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
          } else if (callbackId === 'flow_back') {
            const result = await conversationEngine.goBack(userId, flowCtx);
            if (result.nextContext) {
              await conversationEngine.setFlowContext(userId, result.nextContext);
            }
            await sendResponse(phone, result.response);
            conversationLogger.log(userId, phone, '[back]', result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', 'flow_back', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
          } else if (callbackId.startsWith('flow_new_')) {
            // Start a new flow: flow_new_expense → expense_flow
            const flowName = callbackId.replace('flow_new_', '') + '_flow';
            // Block financial/rainfall/activity flows if no fields
            if (['expense_flow', 'income_flow', 'rainfall_flow', 'activity_flow'].includes(flowName)) {
              if (await checkPrerequisiteBlock(userId, phone, 'registrar')) {
                res.sendStatus(200);
                return;
              }
            }
            const prefillData = flowName === 'field_flow' ? { _channel: 'whatsapp', _channelId: phone } : undefined;
            const result = await conversationEngine.startFlow(userId, flowName as FlowState, prefillData);
            conversationObserver.logFlowStarted(userId, flowName, { trigger: 'interactive_button' });
            await sendResponse(phone, result.response);
            conversationLogger.log(userId, phone, `[start:${flowName}]`, result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', 'flow_start', flowName, 0, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
          } else if (callbackId.startsWith('flow_cat_')) {
            // Category selection within flow
            const value = callbackId.replace('flow_cat_', '');
            // Feed value into current flow step as text input
            if (flowCtx.state !== 'idle') {
              const result = await conversationEngine.processFlowMessage(userId, value, flowCtx);
              if (result.nextContext) {
                await conversationEngine.setFlowContext(userId, result.nextContext);
              } else {
                await conversationEngine.clearFlow(userId);
              }
              await sendResponse(phone, result.response);
              conversationLogger.log(userId, phone, `[cat:${value}]`, result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', 'flow_cat', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
            }
          } else if (callbackId.startsWith('flow_field_loc_')) {
            // Location method buttons → pass full ID to flow engine
            if (flowCtx.state !== 'idle') {
              const result = await conversationEngine.processFlowMessage(userId, callbackId, flowCtx);
              if (result.nextContext) {
                await conversationEngine.setFlowContext(userId, result.nextContext);
              } else {
                await conversationEngine.clearFlow(userId);
              }
              await sendResponse(phone, result.response);
              conversationLogger.log(userId, phone, `[loc:${callbackId}]`, result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', 'flow_field_loc', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
            }
          } else if (callbackId.startsWith('flow_field_')) {
            // Field selection within flow
            const value = callbackId.replace('flow_field_', '').replace(/_/g, ' ');
            if (flowCtx.state !== 'idle') {
              const result = await conversationEngine.processFlowMessage(userId, value, flowCtx);
              if (result.nextContext) {
                await conversationEngine.setFlowContext(userId, result.nextContext);
              } else {
                await conversationEngine.clearFlow(userId);
              }
              await sendResponse(phone, result.response);
              conversationLogger.log(userId, phone, `[field:${value}]`, result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', 'flow_field', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
            }
          } else if (callbackId.startsWith('flow_plot_')) {
            // Plot selection within flow
            const rawPlotPayload = callbackId.replace('flow_plot_', '');
            let value: string;
            let fieldHint: string | undefined;
            // Check for field__plot separator (duplicate plot names across fields)
            if (rawPlotPayload.includes('__')) {
              const sepIdx = rawPlotPayload.indexOf('__');
              fieldHint = rawPlotPayload.slice(0, sepIdx).replace(/_/g, ' ');
              value = rawPlotPayload.slice(sepIdx + 2).replace(/_/g, ' ');
            } else {
              value = rawPlotPayload.replace(/_/g, ' ');
            }
            if (flowCtx.state !== 'idle') {
              // Store field hint in flow data so execute() can disambiguate
              if (fieldHint) {
                flowCtx.data._resolvedFieldHint = fieldHint;
                await conversationEngine.setFlowContext(userId, flowCtx);
              }
              const result = await conversationEngine.processFlowMessage(userId, value, flowCtx);
              if (result.nextContext) {
                await conversationEngine.setFlowContext(userId, result.nextContext);
              } else {
                await conversationEngine.clearFlow(userId);
              }
              await sendResponse(phone, result.response);
              conversationLogger.log(userId, phone, `[plot:${value}]`, result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', 'flow_plot', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
            }
          } else if (callbackId.startsWith('flow_activity_')) {
            // Activity type selection within flow
            const value = callbackId.replace('flow_activity_', '');
            if (flowCtx.state !== 'idle') {
              const result = await conversationEngine.processFlowMessage(userId, value, flowCtx);
              if (result.nextContext) {
                await conversationEngine.setFlowContext(userId, result.nextContext);
              } else {
                await conversationEngine.clearFlow(userId);
              }
              await sendResponse(phone, result.response);
              conversationLogger.log(userId, phone, `[activity:${value}]`, result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', 'flow_activity', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
            }
          }
          res.sendStatus(200);
          return;
        }

        // --- Destructive command confirmation ---
        if (callbackId.startsWith('confirm_destructive_')) {
          const user = await userRepository.getOrCreate(phone);
          const userId = user.id;
          const settings = await userRepository.getSettings(userId);
          const pendingAction = pendingStore.get(phone) as any;
          pendingStore.clear(phone);
          if (pendingAction?._destructiveCommand) {
            const response = await domainRouter.routeCommand(pendingAction._destructiveCommand, userId, user, settings);
            if (response) {
              await sendResponse(phone, response);
              conversationLogger.log(userId, phone, `[confirm_destructive]`, response.messages[0] ?? response.interactive?.body ?? null, 'command', pendingAction._destructiveCommand.command, null, null, false, Date.now() - startTime, !!response.interactive).catch(() => {});
            }
          }
          res.sendStatus(200);
          return;
        }

        if (callbackId === 'cancel_destructive') {
          const user = await userRepository.getOrCreate(phone);
          pendingStore.clear(phone);
          await sendMessage(phone, '\u274c Operaci\u00f3n cancelada.');
          conversationLogger.log(user.id, phone, '[cancel_destructive]', 'Operación cancelada.', 'command', 'cancel', null, null, false, Date.now() - startTime).catch(() => {});
          res.sendStatus(200);
          return;
        }

        // --- Cancel action (field/plot delete confirmation) ---
        if (callbackId === 'cancel_action' || callbackId === 'cancel_pending') {
          const user = await userRepository.getOrCreate(phone);
          pendingStore.clear(phone);
          await sendMessage(phone, '\u274c Operaci\u00f3n cancelada.');
          conversationLogger.log(user.id, phone, `[${callbackId}]`, 'Operación cancelada.', 'command', 'cancel', null, null, false, Date.now() - startTime).catch(() => {});
          res.sendStatus(200);
          return;
        }

        // --- Confirm pending financial transaction (buttons) ---
        if (callbackId === 'confirm_pending') {
          const user = await userRepository.getOrCreate(phone);
          const userId = user.id;
          const settings = await userRepository.getSettings(userId);
          const pendingTx = pendingStore.get(phone);
          if (!pendingTx) {
            await sendMessage(phone, 'No hay nada pendiente para confirmar.');
            conversationLogger.log(userId, phone, '[confirm_pending]', 'No hay nada pendiente para confirmar.', 'command', 'confirm', null, null, false, Date.now() - startTime).catch(() => {});
            res.sendStatus(200);
            return;
          }
          pendingStore.clear(phone);
          const response = await financialHandler.handleConfirm(userId, pendingTx, settings, user);
          if (response.sideEffects?.setPendingStockEntry) {
            pendingStockEntryStore.set(phone, response.sideEffects.setPendingStockEntry as Record<string, unknown>);
          }
          await sendResponse(phone, response);
          conversationLogger.log(userId, phone, `[confirm_pending]`, response.messages[0] ?? response.interactive?.body ?? null, 'command', 'confirm', null, null, false, Date.now() - startTime, !!response.interactive).catch(() => {});
          res.sendStatus(200);
          return;
        }

        // --- Field duplicate resolution ---
        if (callbackId.startsWith('field_dup_')) {
          const user = await userRepository.getOrCreate(phone);
          const userId = user.id;
          const pendingDup = pendingStore.get(phone) as any;
          const dupData = pendingDup?._fieldDuplicate as { name: string; city: string | null } | undefined;

          if (!dupData) {
            await sendMessage(phone, 'No hay un campo pendiente. Empezá de nuevo.');
            res.sendStatus(200);
            return;
          }

          pendingStore.clear(phone);

          if (callbackId === 'field_dup_update') {
            // Update city on existing field
            if (dupData.city) {
              await financialService.setFieldCity(userId, dupData.name, dupData.city);
              await sendMessage(phone, `📍 Campo *${dupData.name}* actualizado. Nueva ubicación: *${dupData.city}*`);
            } else {
              await sendMessage(phone, `El campo *${dupData.name}* ya existe y no hay cambios que aplicar.`);
            }
          } else if (callbackId === 'field_dup_rename') {
            // Start field flow to ask for a new name (keep city if provided)
            const prefill: Record<string, unknown> = { _channel: 'whatsapp', _channelId: phone };
            if (dupData.city) prefill.city = dupData.city;
            const flowResult = await conversationEngine.startFlow(userId, 'field_flow' as FlowState, prefill);
            if (flowResult.nextContext) {
              await conversationEngine.setFlowContext(userId, flowResult.nextContext);
            }
            await sendMessage(phone, `Elegí otro nombre para el campo${dupData.city ? ` en ${dupData.city}` : ''}:`);
            await sendResponse(phone, flowResult.response);
          } else {
            // field_dup_cancel
            await sendMessage(phone, '❌ Operación cancelada.');
          }

          res.sendStatus(200);
          return;
        }

        // --- Create plot in specific field (smart lote flow) ---
        if (callbackId.startsWith('create_plot_')) {
          const match = callbackId.match(/^create_plot_(.+)_in_(.+)$/);
          if (match) {
            const plotName = match[1].replace(/_/g, ' ');
            const fieldName = match[2].replace(/_/g, ' ');
            const user = await userRepository.getOrCreate(phone);
            const userId = user.id;
            const field = await financialService.getFieldByName(userId, fieldName);
            if (field) {
              const plot = await financialService.getOrCreatePlot(field.id, plotName);
              const response: HandlerResponse = {
                messages: [`\ud83d\udccd Lote *${plot.name}* creado en campo *${field.name}*`],
                suggestionKey: 'plot_created',
              };
              const plotAreaPrompt = storePlotAreaSideEffects(phone, pendingPlotAreaStore, {
                setPendingPlotArea: { plotId: plot.id, plotName: plot.name, fieldName: field.name },
              });
              if (plotAreaPrompt) response.messages.push(plotAreaPrompt);
              await sendResponse(phone, response);
              conversationLogger.log(userId, phone, `[create_plot:${plotName}:${fieldName}]`, response.messages[0], 'command', 'add_plot', null, null, false, Date.now() - startTime, true).catch(() => {});
            } else {
              await sendMessage(phone, `No encontr\u00e9 el campo *${fieldName}*.`);
            }
          }
          res.sendStatus(200);
          return;
        }

        // --- Confirm delete field ---
        if (callbackId.startsWith('confirm_delete_field_')) {
          const fieldName = callbackId.replace('confirm_delete_field_', '').replace(/_/g, ' ');
          const user = await userRepository.getOrCreate(phone);
          const userId = user.id;
          const deleted = await financialService.deleteField(userId, fieldName);
          if (deleted) {
            const response: HandlerResponse = {
              messages: [`\ud83d\uddd1\ufe0f Campo *${fieldName}* eliminado.\nLos gastos/ingresos asociados quedan sin asignar.\n\n_Para restaurarlo: "restaurar campo ${fieldName}"_`],
              suggestionKey: 'field_deleted',
            };
            await sendResponse(phone, response);
            conversationLogger.log(userId, phone, `[delete_field:${fieldName}]`, response.messages[0], 'command', 'delete_field', null, null, false, Date.now() - startTime).catch(() => {});
          } else {
            await sendMessage(phone, `No se pudo eliminar el campo *${fieldName}*.`);
          }
          res.sendStatus(200);
          return;
        }

        // --- Confirm delete plot ---
        if (callbackId.startsWith('confirm_delete_plot_')) {
          const match = callbackId.match(/^confirm_delete_plot_(.+)_in_(.+)$/);
          if (match) {
            const plotName = match[1].replace(/_/g, ' ');
            const fieldName = match[2].replace(/_/g, ' ');
            const user = await userRepository.getOrCreate(phone);
            const userId = user.id;
            const field = await financialService.getFieldByName(userId, fieldName);
            if (field) {
              const plots = await financialService.findPlotByNameAcrossFields(userId, plotName);
              const plot = plots.find(p => p.field_id === field.id);
              if (plot) {
                await financialService.deletePlot(plot.id, userId);
                const response: HandlerResponse = {
                  messages: [`\ud83d\uddd1\ufe0f Lote *${plotName}* eliminado del campo *${fieldName}*.\nLos registros asociados quedan sin lote.\n\n_Para restaurarlo: "restaurar lote ${plotName}"_`],
                  suggestionKey: 'plot_deleted',
                };
                await sendResponse(phone, response);
                conversationLogger.log(userId, phone, `[delete_plot:${plotName}:${fieldName}]`, response.messages[0], 'command', 'delete_plot', null, null, false, Date.now() - startTime).catch(() => {});
              } else {
                await sendMessage(phone, `No encontr\u00e9 el lote *${plotName}* en campo *${fieldName}*.`);
              }
            } else {
              await sendMessage(phone, `No encontr\u00e9 el campo *${fieldName}*.`);
            }
          }
          res.sendStatus(200);
          return;
        }

        // --- Stock entry callback (purchase → stock) ---
        if (callbackId.startsWith('stock_entry_yes_') || callbackId.startsWith('stock_entry_no_')) {
          const accepted = callbackId.startsWith('stock_entry_yes_');
          const user = await userRepository.getOrCreate(phone);
          if (accepted) {
            try {
              const pending = pendingStockEntryStore.get(phone);
              if (pending) {
                const { StockPurchaseService } = await import('../domain/stock/stock-purchase.service.js');
                const svc = new StockPurchaseService();
                const result = await svc.applyStockEntry(user.id, pending as any);
                await sendMessage(phone, `📦 Stock actualizado: +${formatQuantityHuman(result.movement.quantity, result.item.unit)} de ${result.item.name} (${formatQuantityHuman(result.item.current_quantity, result.item.unit)} total)`);
              } else {
                await sendMessage(phone, '⚠️ No hay entrada de stock pendiente.');
              }
            } catch (err: any) {
              await sendMessage(phone, `❌ Error al cargar stock: ${err.message}`);
            }
          } else {
            await sendMessage(phone, '👌 Stock no modificado.');
          }
          pendingStockEntryStore.delete(phone);
          res.sendStatus(200);
          return;
        }

        // --- Stock deduction callback (activity → stock) ---
        if (callbackId.startsWith('stock_deduct_yes_') || callbackId.startsWith('stock_deduct_no_')) {
          const accepted = callbackId.startsWith('stock_deduct_yes_');
          const user = await userRepository.getOrCreate(phone);
          if (accepted) {
            try {
              const pending = pendingStockDeductionStore.get(phone) as Record<string, unknown> | undefined;
              if (pending) {
                if (!pending.totalQuantity || (pending.totalQuantity as number) <= 0) {
                  (pending as any).awaitingQuantity = true;
                  pendingStockDeductionStore.set(phone, pending);
                  await sendMessage(phone, `¿Cuántos ${pending.unit || 'lt'} de *${pending.product}* usaste?`);
                } else {
                  const { StockDeductionService } = await import('../domain/stock/stock-deduction.service.js');
                  const svc = new StockDeductionService();
                  const result = await svc.applyDeduction(user.id, pending as any);
                  pendingStockDeductionStore.delete(phone);
                  await sendMessage(phone, `📦 Stock descontado: -${formatQuantityHuman(pending.totalQuantity as number, result.item.unit)} de ${result.item.name} (${formatQuantityHuman(result.item.current_quantity, result.item.unit)} restante)`);
                }
              } else {
                await sendMessage(phone, '⚠️ No hay descuento de stock pendiente.');
              }
            } catch (err: any) {
              await sendMessage(phone, `❌ Error al descontar stock: ${err.message}`);
            }
          } else {
            const pending = pendingStockDeductionStore.get(phone);
            if (pending?.domainEventId) {
              const { StockDeductionService } = await import('../domain/stock/stock-deduction.service.js');
              const svc = new StockDeductionService();
              await svc.declineDeduction(pending.domainEventId as number);
            }
            pendingStockDeductionStore.delete(phone);
            await sendMessage(phone, '👌 Stock no modificado.');
          }
          res.sendStatus(200);
          return;
        }

        // --- Grain stock entry callback (harvest → silo) ---
        if (callbackId.startsWith('stock_grain_yes_') || callbackId.startsWith('stock_grain_no_')) {
          const accepted = callbackId.startsWith('stock_grain_yes_');
          const user = await userRepository.getOrCreate(phone);
          if (accepted) {
            try {
              const pending = pendingStockEntryStore.get(phone);
              if (pending && pending.type === 'grain') {
                const { StockPurchaseService } = await import('../domain/stock/stock-purchase.service.js');
                const svc = new StockPurchaseService();
                const result = await svc.applyStockEntry(user.id, pending as any);
                pendingStockEntryStore.delete(phone);
                await sendMessage(phone, `📦 Stock actualizado: +${formatQuantityHuman(result.movement.quantity, result.item.unit)} de ${result.item.name} (${formatQuantityHuman(result.item.current_quantity, result.item.unit)} total)`);
              } else {
                await sendMessage(phone, '⚠️ No hay cosecha pendiente para cargar.');
              }
            } catch (err: any) {
              await sendMessage(phone, `❌ Error al cargar al silo: ${err.message}`);
            }
          } else {
            pendingStockEntryStore.delete(phone);
            await sendMessage(phone, '👌 No se cargó al stock.');
          }
          res.sendStatus(200);
          return;
        }

        // --- Grain sale stock deduction callback ---
        if (callbackId.startsWith('stock_grain_sale_yes_') || callbackId.startsWith('stock_grain_sale_no_')) {
          const accepted = callbackId.startsWith('stock_grain_sale_yes_');
          const user = await userRepository.getOrCreate(phone);
          if (accepted) {
            try {
              const pending = pendingStockDeductionStore.get(phone);
              if (pending) {
                const { StockService } = await import('../domain/stock/stock.service.js');
                const svc = new StockService();
                const { item } = await svc.removeStock(user.id, pending.product as string, pending.totalQuantity as number, pending.unit as string, {
                  reason: 'Venta de grano',
                });
                pendingStockDeductionStore.delete(phone);
                await sendMessage(phone, `📦 Stock descontado: *${item.name}* → ${formatQuantityHuman(item.current_quantity, item.unit)} restante`);
              } else {
                await sendMessage(phone, '⚠️ No hay descuento de stock pendiente.');
              }
            } catch (err: any) {
              await sendMessage(phone, `❌ Error al descontar stock: ${err.message}`);
            }
          } else {
            pendingStockDeductionStore.delete(phone);
            await sendMessage(phone, '👌 Stock no modificado.');
          }
          res.sendStatus(200);
          return;
        }

        // --- Campaign close suggestion (after activity on harvested campaign) ---
        if (callbackId.startsWith('campaign_close_yes_') || callbackId.startsWith('campaign_close_no_')) {
          const accepted = callbackId.startsWith('campaign_close_yes_');
          if (accepted) {
            const pending = pendingCampaignCloseStore.get(phone);
            if (pending) {
              const { CropService } = await import('../domain/plots/crop.service.js');
              await new CropService().closeCampaign(pending.plotCropId);
              pendingCampaignCloseStore.delete(phone);
              await sendMessage(phone, `✅ Campaña de *${pending.crop}* en *${pending.plotName}* cerrada.`);
            } else {
              await sendMessage(phone, '⚠️ No hay campaña pendiente para cerrar.');
            }
          } else {
            pendingCampaignCloseStore.delete(phone);
            await sendMessage(phone, '👌 La campaña sigue abierta.');
          }
          res.sendStatus(200);
          return;
        }

        // --- Document upload intent (menu entry) ---
        if (callbackId === 'doc_upload_factura' || callbackId === 'doc_upload_remito') {
          const user = await userRepository.getOrCreate(phone);
          const userId = user.id;
          const docType = callbackId === 'doc_upload_factura' ? 'factura' : 'remito' as DocumentUploadIntent;
          const hasDocuments = await featureGate.hasFeature(userId, 'documents');
          if (!hasDocuments) {
            await sendMessage(phone, '🔒 El procesamiento de documentos no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.');
          } else {
            const label = docType === 'factura' ? '🧾 factura' : '📋 remito';
            pendingDocUploadStore.set(phone, { intent: docType, timestamp: Date.now() });
            await sendMessage(phone, `Enviame la foto o PDF del ${label} y lo proceso.`);
          }
          res.sendStatus(200);
          return;
        }

        // --- Document classify callback (unprompted image → user chose type) ---
        if (callbackId === 'doc_classify_factura' || callbackId === 'doc_classify_remito' || callbackId === 'doc_classify_skip') {
          const user = await userRepository.getOrCreate(phone);
          const userId = user.id;
          const pendingUpload = pendingDocUploadStore.get(phone);
          pendingDocUploadStore.clear(phone);

          if (callbackId === 'doc_classify_skip') {
            await sendMessage(phone, '👌 Imagen ignorada.');
            res.sendStatus(200);
            return;
          }

          if (!pendingUpload?.mediaRef) {
            await sendMessage(phone, '⚠️ La imagen expiró. Enviala de nuevo.');
            res.sendStatus(200);
            return;
          }

          const docType = callbackId === 'doc_classify_factura' ? 'factura' : 'remito' as DocumentUploadIntent;
          try {
            await sendMessage(phone, '🔍 Procesando documento...');
            const { downloadMedia } = await import('../services/whatsapp.js');
            const buffer = await downloadMedia(pendingUpload.mediaRef.mediaId);
            await processDocumentWithIntent(
              phone, userId, buffer, pendingUpload.mediaRef.mimeType,
              pendingUpload.mediaRef.filename, pendingUpload.mediaRef.caption || '',
              docType, startTime,
            );
          } catch (err: unknown) {
            const error = err as Error;
            console.error('[document] classify callback error:', error.message);
            logError('whatsapp', 'DOC_CLASSIFY_CALLBACK', error, { phone });
            if (err instanceof DocumentError) {
              await sendMessage(phone, `⚠️ ${error.message}`);
            } else {
              await sendMessage(phone, 'No pude procesar el documento. Intentá con otra imagen o PDF.');
            }
          }
          res.sendStatus(200);
          return;
        }

        // --- Document stock-only callback (remito → warehouse selection) ---
        if (callbackId.startsWith('doc_stock_yes_')) {
          const user = await userRepository.getOrCreate(phone);
          const userId = user.id;
          try {
            const pending = pendingDocumentStore.get(phone);
            if (!pending || !pending.extraction.line_items || pending.extraction.line_items.length === 0) {
              await sendMessage(phone, '⚠️ No hay items para cargar al stock.');
              res.sendStatus(200);
              return;
            }
            const { StockService } = await import('../domain/stock/stock.service.js');
            const stockService = new StockService();
            const warehouses = await stockService.listWarehouses(userId);
            if (warehouses.length <= 1) {
              await loadRemitoStockWa(pending, userId, phone, stockService);
            } else {
              const buttons = warehouses.slice(0, 3).map(w => ({
                id: `doc_warehouse_${w.id}_${pending.documentId}`,
                title: `${w.name} (${w.field_name || ''})`.slice(0, 20),
              }));
              await sendInteractiveButtons(phone, '¿En qué galpón cargamos el stock?', buttons);
            }
          } catch (err: any) {
            await sendMessage(phone, `❌ Error al cargar stock: ${err.message}`);
            logError('whatsapp', 'DOC_STOCK_CALLBACK', err, { phone });
          }
          res.sendStatus(200);
          return;
        }

        // --- Document warehouse selection callback (remito → specific warehouse) ---
        if (callbackId.startsWith('doc_warehouse_')) {
          const match = callbackId.match(/^doc_warehouse_(\d+)_(\d+)$/);
          if (match) {
            const warehouseId = parseInt(match[1], 10);
            const user = await userRepository.getOrCreate(phone);
            try {
              const pending = pendingDocumentStore.get(phone);
              if (!pending) { await sendMessage(phone, '⚠️ No hay documento pendiente.'); res.sendStatus(200); return; }
              const { StockService } = await import('../domain/stock/stock.service.js');
              const stockService = new StockService();
              await loadRemitoStockWa(pending, user.id, phone, stockService, warehouseId);
            } catch (err: any) {
              await sendMessage(phone, `❌ Error al cargar stock: ${err.message}`);
              logError('whatsapp', 'DOC_WAREHOUSE_CALLBACK', err, { phone });
            }
          }
          res.sendStatus(200);
          return;
        }

        // --- Document product discovery callbacks ---
        if (callbackId.startsWith('doc_create_products_yes_') || callbackId.startsWith('doc_create_products_no_')) {
          const accepted = callbackId.startsWith('doc_create_products_yes_');
          const user = await userRepository.getOrCreate(phone);
          if (accepted) {
            try {
              const pending = pendingDocumentStore.get(phone);
              if (!pending?.missingProducts || pending.missingProducts.length === 0) {
                pendingDocumentStore.clear(phone);
                await sendMessage(phone, '⚠️ No hay productos pendientes.');
                res.sendStatus(200);
                return;
              }
              const { StockService } = await import('../domain/stock/stock.service.js');
              const stockService = new StockService();
              const warehouse = await stockService.resolveWarehouse(user.id);
              const messages: string[] = [];
              for (const p of pending.missingProducts) {
                try {
                  await stockService.createProductOnly(user.id, warehouse.id, p.name, p.category || 'otros', p.unit || 'u');
                  messages.push(`📋 Producto creado: *${p.name}* (${p.unit || 'u'}) - qty 0`);
                } catch {
                  messages.push(`⚠️ No pude crear ${p.name}`);
                }
              }
              pendingDocumentStore.clear(phone);
              await sendMessage(phone, messages.join('\n'));
            } catch (err: any) {
              pendingDocumentStore.clear(phone);
              await sendMessage(phone, `❌ Error al crear productos: ${err.message}`);
              logError('whatsapp', 'DOC_CREATE_PRODUCTS_CALLBACK', err, { phone });
            }
          } else {
            pendingDocumentStore.clear(phone);
            await sendMessage(phone, '👌 OK, no se crearon productos en el stock.');
          }
          res.sendStatus(200);
          return;
        }

        // --- Document expense callback ---
        if (callbackId.startsWith('doc_expense_yes_') || callbackId.startsWith('doc_expense_no_')) {
          const accepted = callbackId.startsWith('doc_expense_yes_');
          const user = await userRepository.getOrCreate(phone);
          if (accepted) {
            try {
              const pending = pendingDocumentStore.get(phone);
              if (!pending) { await sendMessage(phone, '⚠️ No hay documento pendiente.'); res.sendStatus(200); return; }
              const plotRes = await resolveDocPlotWa(user.id);
              if (!plotRes.resolved) {
                pending.deferredAction = 'expense';
                pendingDocumentStore.set(phone, pending);
                const buttons = plotRes.plots.slice(0, 3).map(p => ({
                  id: `doc_plot_${p.id}`,
                  title: `${p.name} (${p.field_name})`.slice(0, 20),
                }));
                await sendInteractiveButtons(phone, '¿En qué lote registramos los gastos?', buttons);
              } else {
                await saveDocExpensesWa(pending, user.id, phone, plotRes.fieldId, plotRes.plotId);
              }
            } catch (err: any) {
              await sendMessage(phone, `❌ Error al registrar gasto: ${err.message}`);
              logError('whatsapp', 'DOC_EXPENSE_CALLBACK', err, { phone });
            }
          } else {
            pendingDocumentStore.clear(phone);
            await sendMessage(phone, '👌 Documento guardado sin registrar gasto.');
          }
          res.sendStatus(200);
          return;
        }

        // --- Document plot selection callback (deferred expense saving) ---
        if (callbackId.startsWith('doc_plot_')) {
          const plotId = parseInt(callbackId.replace('doc_plot_', ''), 10);
          if (!isNaN(plotId)) {
            const user = await userRepository.getOrCreate(phone);
            try {
              const pending = pendingDocumentStore.get(phone);
              if (!pending) { await sendMessage(phone, '⚠️ No hay documento pendiente.'); res.sendStatus(200); return; }
              const allPlots = await financialService.findAllUserPlots(user.id);
              const plot = allPlots.find(p => p.id === plotId);
              const fieldId = plot?.field_id ?? null;
              await saveDocExpensesWa(pending, user.id, phone, fieldId, plotId);
            } catch (err: any) {
              await sendMessage(phone, `❌ Error al registrar: ${err.message}`);
              logError('whatsapp', 'DOC_PLOT_CALLBACK', err, { phone });
            }
          }
          res.sendStatus(200);
          return;
        }

        // --- Existing interactive routing ---
        const intent = interactiveRouter.route(callbackId);
        if (intent && intent.type === 'command') {
          const user = await userRepository.getOrCreate(phone);
          const settings = await userRepository.getSettings(user.id);
          const response = await domainRouter.routeCommand(intent.data, user.id, user, settings);
          if (response) {
            await sendResponse(phone, response);
            conversationLogger.log(user.id, phone, `[interactive:${callbackId}]`, response.messages[0] ?? response.interactive?.body ?? null, 'command', intent.data.command, null, null, false, Date.now() - startTime, !!response.interactive).catch(() => {});
          }
        }
        res.sendStatus(200);
        return;
      }
    }

    // --- Audio message handling ---
    if (!text && message.type === 'audio' && message.audio?.id) {
      const user = await userRepository.getOrCreate(phone);
      // Phase 3 — block audio processing when the trial expired. Whisper
      // costs real money, so we can't let a trial-expired user keep
      // racking up bills.
      const { getUserAccessMode, trialExpiredCopy } = await import('../services/access-gate.service.js');
      if (await getUserAccessMode(user.id) === 'trial_expired_readonly') {
        console.log(`[TRIAL_EXPIRED] user=${user.id} channel=audio source=whatsapp`);
        await sendMessage(phone, trialExpiredCopy());
        res.sendStatus(200);
        return;
      }
      const hasAudio = await featureGate.hasFeature(user.id, 'audio');
      if (!hasAudio) {
        await sendMessage(phone, '\ud83d\udd12 El procesamiento de audios no est\u00e1 disponible en tu plan actual.\n\nEscrib\u00ed *plan* para ver las opciones.');
        res.sendStatus(200);
        return;
      }

      // Audio rate limiting
      const maxAudioPerHour = (await getSettingNumber('MAX_AUDIO_PER_HOUR')) ?? DEFAULT_MAX_AUDIO_PER_HOUR;
      const hourlyCount = await getHourlyAudioCount(user.id);
      if (hourlyCount >= maxAudioPerHour) {
        await sendMessage(phone, `\u26a0\ufe0f Alcanzaste el l\u00edmite de ${maxAudioPerHour} audios por hora. Pod\u00e9s escribir tu mensaje o intentar m\u00e1s tarde.`);
        res.sendStatus(200);
        return;
      }

      try {
        const result = await transcriptionService.processAudio(
          message.audio.id,
          message.audio.mime_type || 'audio/ogg',
        );
        text = result.transcription;
        text = normalizeTranscript(text);  // Clean STT artifacts before pipeline
        console.log('FROM:', phone, 'AUDIO TRANSCRIBED:', text);

        // Log audio transcription cost
        try {
          const durationSeconds = result.estimatedDurationSeconds || 0;
          const durationMinutes = durationSeconds / 60;
          const costUsd = durationMinutes * 0.006;
          const audioConfig = getAudioConfig();
          await saveAudioTranscriptionLog(user.id, {
            durationSeconds,
            provider: result.providerName || audioConfig.provider,
            model: audioConfig.openaiWhisperModel,
            costUsd,
          });
          console.log(`[audio] logged: ${durationSeconds}s, $${costUsd.toFixed(6)} USD`);
        } catch (logErr: unknown) {
          console.error('[audio] failed to log transcription:', (logErr as Error).message);
          logError('whatsapp', 'AUDIO_LOG_FAILED', logErr as Error, { userId: user.id });
        }
      } catch (err: unknown) {
        const error = err as Error;
        console.error('[audio] error:', error.message);
        logError('whatsapp', 'AUDIO_PROCESSING', error, { userId: user.id });
        if (err instanceof AudioTooLongError) {
          await sendMessage(phone, '\u26a0\ufe0f El audio es demasiado largo. Envi\u00e1 un audio m\u00e1s corto o escrib\u00ed el mensaje.');
        } else {
          await sendMessage(phone, 'No pude entender el audio. \u00bfPodr\u00edas escribirlo o enviar otro audio?');
        }
        res.sendStatus(200);
        return;
      }
    }

    // --- Image/document handling (invoices, receipts) ---
    if (!text && (message.type === 'image' || message.type === 'document')) {
      const mediaInfo = message.image || message.document;
      const mediaId = mediaInfo?.id;
      const mediaMime = mediaInfo?.mime_type || 'application/octet-stream';
      const caption = message.image?.caption || message.document?.caption || '';
      const filename = message.document?.filename;

      if (mediaId && (mediaMime.startsWith('image/') || mediaMime === 'application/pdf')) {
        const user = await userRepository.getOrCreate(phone);
        const userId = user.id;

        try {
          // Check feature access
          const hasDocuments = await featureGate.hasFeature(userId, 'documents');
          if (!hasDocuments) {
            await sendMessage(phone, '🔒 El procesamiento de documentos no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.');
            res.sendStatus(200);
            return;
          }

          // Check daily limit
          const { allowed, limit } = await documentService.checkDailyLimit(userId);
          if (!allowed) {
            await sendMessage(phone, `⚠️ Alcanzaste el límite diario de ${limit} documentos. Intentá mañana.`);
            res.sendStatus(200);
            return;
          }

          // Check if user already chose a document type (State A: menu → waiting for image)
          const pendingUpload = pendingDocUploadStore.get(phone);
          if (pendingUpload?.intent) {
            const docIntent = pendingUpload.intent;
            pendingDocUploadStore.clear(phone);
            await sendMessage(phone, '🔍 Procesando documento...');
            const { downloadMedia } = await import('../services/whatsapp.js');
            const buffer = await downloadMedia(mediaId);
            await processDocumentWithIntent(phone, userId, buffer, mediaMime, filename, caption, docIntent, startTime);
            res.sendStatus(200);
            return;
          }

          // Unprompted image (State B): store mediaRef, ask what to do
          pendingDocUploadStore.set(phone, {
            mediaRef: { mediaId, mimeType: mediaMime, filename, caption },
            timestamp: Date.now(),
          });
          await sendInteractiveButtons(phone, '📷 Recibí una imagen. ¿Es una factura (para gastos) o un remito (para stock)?', [
            { id: 'doc_classify_factura', title: '🧾 Factura (gastos)' },
            { id: 'doc_classify_remito', title: '📋 Remito (stock)' },
            { id: 'doc_classify_skip', title: 'No procesar' },
          ]);

          conversationLogger.log(userId, phone, `[image_received:${mediaMime}]`, 'Awaiting document intent', 'command', 'document_intent_prompt', null, null, false, Date.now() - startTime, true).catch(() => {});
        } catch (err: unknown) {
          const error = err as Error;
          console.error('[document] error:', error.message);
          logError('whatsapp', 'DOCUMENT_PROCESSING', error, { phone });
          if (err instanceof DocumentError) {
            await sendMessage(phone, `⚠️ ${error.message}`);
          } else {
            await sendMessage(phone, 'No pude procesar el documento. Intentá con otra imagen o PDF.');
          }
        }
        res.sendStatus(200);
        return;
      }
    }

    // --- Location message handling (WhatsApp shared location) ---
    if (!text && message.type === 'location' && message.location) {
      const lat = message.location.latitude;
      const lng = message.location.longitude;
      if (typeof lat === 'number' && typeof lng === 'number') {
        const pendingLoc = pendingFieldLocationStore.get(phone);
        if (pendingLoc) {
          const user = await userRepository.getOrCreate(phone);
          const { handlePendingLocation } = await import('../middleware/pending-field-location-handler.js');
          const result = await handlePendingLocation(lat, lng, pendingLoc, user.id);
          if (result.clearPending) pendingFieldLocationStore.clear(phone);
          for (const msg of result.messages) {
            await sendMessage(phone, msg);
          }
          res.sendStatus(200);
          return;
        }
        // No pending location — ignore or acknowledge
        await sendMessage(phone, '📍 Ubicación recibida, pero no hay un campo pendiente de ubicar.\n\nPara ubicar un campo, primero creá uno con *agregar campo [nombre]*.');
        res.sendStatus(200);
        return;
      }
    }

    if (!text) {
      res.sendStatus(200);
      return;
    }

    // Contentless message (only emojis/punctuation) → gentle hint, not a blank
    // reply or a full greeting.
    if (isContentlessMessage(text)) {
      await sendMessage(phone, '🤔 No te entendí. Contame qué querés hacer — ej: *gasté 50 mil en gasoil*, *sembré soja en el lote 1*, o escribí *menú*.');
      res.sendStatus(200);
      return;
    }

    console.log('FROM:', phone, 'TEXT:', text);

    // Get user and settings
    const user = await userRepository.getOrCreate(phone);
    const userId = user.id;
    const settings = await userRepository.getSettings(userId);
    const sessionId = `${phone}_${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })}`;
    const messageType = message.type === 'audio' ? 'audio' : 'text';
    conversationObserver.logMessageReceived(userId, { phone, messageType, messageLength: text.length }, sessionId);

    // Track last activity for user management
    pool.query('UPDATE users SET last_message_at = NOW() WHERE id = $1', [userId]).catch(() => {});

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
          await sendMessage(phone, '❌ Operación cancelada.');
          res.sendStatus(200);
          return;
        }
        await conversationEngine.clearFlow(userId);
        const response = await financialHandler.resumeCreateCategory(userId, text, flowData);
        await sendResponse(phone, response);
        conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'command', 'create_category', 'awaiting_new_category_name', 0, false, Date.now() - startTime, !!response.interactive).catch(() => {});
        res.sendStatus(200);
        return;
      }
    }

    // --- Check active conversation flow ---
    const flowCtx = await conversationEngine.getFlowContext(userId);

    if (flowCtx.state !== 'idle') {
      if (conversationEngine.isExpired(flowCtx)) {
        const durationMs = flowCtx.startedAt ? Date.now() - new Date(flowCtx.startedAt).getTime() : undefined;
        conversationObserver.logFlowAbandoned(userId, flowCtx.state, flowCtx.step, 'expired', { durationMs, filledFields: Object.keys(flowCtx.data) });
        conversationLogger.logError(userId, 'flow_expired', 'Flow expired, clearing state', text, flowCtx.state, flowCtx.step).catch(() => {});
        const notifyEnabled = (await getSettingBool('FLOW_TIMEOUT_NOTIFICATION_ENABLED')) ?? true;
        const expiredFlowState = flowCtx.originFlow ?? flowCtx.state;
        await conversationEngine.clearFlow(userId);
        if (notifyEnabled) {
          await sendMessage(phone, buildTimeoutMessage(expiredFlowState));
          res.sendStatus(200);
          return;
        }
        // Notification disabled — fall through to normal processing
      } else {
        // FlowGuard: validate state consistency
        const guardResult = await conversationEngine.validateFlowState(userId, flowCtx);
        if (guardResult) {
          conversationObserver.logFlowAbandoned(userId, flowCtx.state, flowCtx.step, 'guard_error');
          conversationLogger.logError(userId, 'flow_guard', 'Invalid flow state detected', text, flowCtx.state, flowCtx.step, flowCtx.data).catch(() => {});
          await sendResponse(phone, guardResult.response);
          res.sendStatus(200);
          return;
        }

        // Cancel/back detection
        const lower = text.toLowerCase().trim();
        if (isCancelIntent(text)) {
          const durationMs = flowCtx.startedAt ? Date.now() - new Date(flowCtx.startedAt).getTime() : undefined;
          conversationObserver.logFlowAbandoned(userId, flowCtx.state, flowCtx.step, 'cancelled', { durationMs, filledFields: Object.keys(flowCtx.data) });
          await conversationEngine.clearFlow(userId);
          await sendMessage(phone, '\u274c Operaci\u00f3n cancelada.');
          const menuResponse = await systemHandler.handleCommand({ command: 'menu' }, userId, user, settings);
          await sendResponse(phone, menuResponse);
          conversationLogger.log(userId, phone, text, 'Operaci\u00f3n cancelada.', 'flow', 'cancel', flowCtx.state, flowCtx.step, false, Date.now() - startTime).catch(() => {});
          res.sendStatus(200);
          return;
        }
        if (['volver', 'atras', 'atr\u00e1s', 'back'].includes(lower) && flowCtx.step > 0) {
          const result = await conversationEngine.goBack(userId, flowCtx);
          if (result.nextContext) {
            await conversationEngine.setFlowContext(userId, result.nextContext);
          }
          await sendResponse(phone, result.response);
          conversationLogger.log(userId, phone, text, result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', 'back', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
          res.sendStatus(200);
          return;
        }

        // P0-1: affirmation while awaiting the OPTIONAL plot → register at field
        // level (same as tapping Confirmar), never the global confirm handler.
        if (conversationEngine.getCurrentStepField(flowCtx) === 'plotName' && isAffirmation(text)) {
          const result = await conversationEngine.executeConfirm(userId, flowCtx);
          if (result.response.sideEffects?.setPendingStockEntry) {
            pendingStockEntryStore.set(phone, result.response.sideEffects.setPendingStockEntry);
          }
          await sendResponse(phone, result.response);
          res.sendStatus(200);
          return;
        }

        // P0-3: a clearly-different new action or query mid-flow abandons the
        // flow and gets processed normally, instead of the "estás en medio" nudge.
        if (!isPlotAnswerToFlow(flowCtx.state, text) && looksLikeNewActionOrQuery(text)) {
          await conversationEngine.clearFlow(userId);
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
            if (reprompt) await sendResponse(phone, reprompt);
            res.sendStatus(200);
            return;
          }
          // Read-only command → execute without canceling the flow, then re-prompt
          const cmdResponse = await domainRouter.routeCommand(effectiveCmd, userId, user, settings);
          if (cmdResponse) {
            await sendResponse(phone, cmdResponse);
          }
          const reprompt = await conversationEngine.getCurrentStepPrompt(flowCtx, userId);
          if (reprompt) {
            await sendResponse(phone, reprompt);
          }
          conversationLogger.log(userId, phone, text, cmdResponse?.messages[0] ?? null, 'command', effectiveCmd.command, flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!(cmdResponse?.interactive)).catch(() => {});
          res.sendStatus(200);
          return;
        }

        // Question detection: questions mid-flow get a gentle nudge + re-prompt
        if (isLikelyQuestion(text)) {
          await sendMessage(phone, 'Estás en medio de un registro. Escribí *cancelar* si querés salir y preguntar.');
          const reprompt = await conversationEngine.getCurrentStepPrompt(flowCtx, userId);
          if (reprompt) await sendResponse(phone, reprompt);
          res.sendStatus(200);
          return;
        }

        // Intent-first interruption: any non-safe command OR financial intent cancels the flow
        // — UNLESS the flow is asking for a plot and the user answered with one.
        if (!isPlotAnswerToFlow(flowCtx.state, text) && (effectiveCmd || intentClassifier.detectsFinancialIntent(text))) {
          const durationMs = flowCtx.startedAt ? Date.now() - new Date(flowCtx.startedAt).getTime() : undefined;
          console.log(`[FLOW_INTERRUPT] User ${userId} flow ${flowCtx.state} interrupted by ${effectiveCmd?.command ?? 'financial_intent'}`);
          conversationObserver.logFlowAbandoned(userId, flowCtx.state, flowCtx.step, 'intent_interrupt', {
            durationMs,
            filledFields: Object.keys(flowCtx.data),
          });
          await conversationEngine.clearFlow(userId);
          await sendMessage(phone, '\u21a9\ufe0f Se cancel\u00f3 el flujo anterior.');
          // Fall through to normal intent processing below
        } else {
          // No intent detected → process within active flow
          const result = await conversationEngine.processFlowMessage(userId, text, flowCtx);
          if (result.nextContext) {
            await conversationEngine.setFlowContext(userId, result.nextContext);
          } else {
            await conversationEngine.clearFlow(userId);
          }
          // Store pending stock entry if expense flow suggests one
          if (result.response.sideEffects?.setPendingStockEntry) {
            pendingStockEntryStore.set(phone, result.response.sideEffects.setPendingStockEntry);
          }
          await sendResponse(phone, result.response);
          conversationLogger.log(userId, phone, text, result.response.messages[0] ?? result.response.interactive?.body ?? null, 'flow', null, flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
          res.sendStatus(200);
          return;
        }
        } // end P0-3 else (message was not a new action/query)
      }
    }

    // --- Check pending field city assignment ---
    const pendingCity = pendingCityStore.get(phone);
    if (pendingCity) {
      if (isCancelIntent(text)) {
        pendingCityStore.clear(phone);
        await sendMessage(phone, '👍 Podés asignar la ubicación después.');
        res.sendStatus(200);
        return;
      }
      const cityResult = await handlePendingCity(text, pendingCity, userId, financialService);
      if (cityResult.clearPending) pendingCityStore.clear(phone);
      for (const msg of cityResult.messages) {
        await sendMessage(phone, msg);
      }
      res.sendStatus(200);
      return;
    }

    // --- Check pending plot area assignment ---
    const plotAreaResult = await handlePendingPlotArea(text, phone, pendingPlotAreaStore, financialService);
    if (plotAreaResult.handled) {
      for (const msg of plotAreaResult.messages) {
        await sendMessage(phone, msg);
      }
      res.sendStatus(200);
      return;
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
          await sendMessage(phone, `📤 Stock descontado: *${item.name}* → ${formatQuantityHuman(item.current_quantity, item.unit)}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Error al descontar stock';
          pendingStockDeductionStore.delete(phone);
          await sendMessage(phone, `❌ ${msg}`);
        }
      } else if (/cancel|no|salir/i.test(text.trim())) {
        pendingStockDeductionStore.delete(phone);
        await sendMessage(phone, '👍 OK, no se descontó del stock.');
      } else {
        await sendMessage(phone, `Decime la cantidad en ${pendingDeduction.unit || 'lt'}. Ej: *3*`);
      }
      res.sendStatus(200);
      return;
    }

    // --- Check pending observation (plot disambiguation follow-up) ---
    const pendingObs = pendingObsStore.get(phone);
    if (pendingObs) {
      // Cancel intent clears pending observation
      if (isCancelIntent(text)) {
        pendingObsStore.clear(phone);
        await sendMessage(phone, '\u274c Observación cancelada.');
        res.sendStatus(200);
        return;
      }

      // Escape hatch: if the message looks like a known command, clear pending and fall through
      const obsInterruptCmd = intentClassifier.parseCommandOnly(text);
      if (obsInterruptCmd || intentClassifier.detectsFinancialIntent(text) || looksLikeNewActionOrQuery(text)) {
        pendingObsStore.clear(phone);
        // Fall through to normal processing below
      } else {
        // RESOLUTION MODE: resolve EXISTING plot only — NEVER auto-create
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
            await sendMessage(phone, 'Observación duplicada detectada');
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
            await sendResponse(phone, response);
          } else {
            await sendMessage(phone, 'No se pudo guardar la observación. Intentá de nuevo.');
          }
          console.log(`[PENDING_OBS] Resolved plot_id=${obsResolved.plotId} for pending observation, user ${userId}`);
          conversationLogger.log(userId, phone, text, 'Observación registrada (follow-up)', 'command', 'log_observation', null, null, false, Date.now() - startTime).catch(() => {});
          res.sendStatus(200);
          return;
        }

        // HARD STOP: no plot found — re-ask. NEVER fall through to classifier.
        const userPlots = await agronomyRepository.findAllUserPlots(userId);
        await sendMessage(phone, `No encontré ese lote. ¿En qué lote?\n\n${formatPlotListGrouped(userPlots)}`);
        console.log(`[PENDING_OBS] Could not resolve plot from "${text}", asking again for user ${userId}`);
        res.sendStatus(200);
        return;
      }
    }

    // --- Check pending activity (plot disambiguation for agro activities) ---
    const pendingAct = pendingActStore.get(phone);
    if (pendingAct) {
      if (isCancelIntent(text)) {
        pendingActStore.clear(phone);
        await sendMessage(phone, '❌ Actividad cancelada.');
        res.sendStatus(200);
        return;
      }
      const actInterruptCmd = intentClassifier.parseCommandOnly(text);
      // Guard: if the pending is for a financial action (log_income/log_expense)
      // and it's WAITING for amount/price/quantity, the user's reply WILL look
      // like a financial intent ("550 USD por tonelada"). Don't escape — let
      // the pending-action processor merge the slots. Without this guard the
      // pending gets silently cleared and the partial saves as $0.
      const expectsFinancialSlot = pendingAct.missing
        && (pendingAct.command === 'log_income' || pendingAct.command === 'log_expense')
        && pendingAct.missing.some(s => s === 'amount' || s === 'quantity' || s === 'unit_price' || s === 'unit');
      // A NEW action with its own verb or a query (looksLikeNewActionOrQuery)
      // escapes even a financial-slot pending — only a BARE answer like
      // "800 USD" should fill the slot. Without pulling it out of the
      // !expectsFinancialSlot guard, "vendí 10 novillos a 800 USD" donated
      // its 800 to a stuck "¿cuánto fue?" soja pending (silent data loss).
      const _escapePending = looksLikeNewActionOrQuery(text)
        || (!expectsFinancialSlot && (isNewActionInterrupt(actInterruptCmd) || intentClassifier.detectsFinancialIntent(text)));
      if (_escapePending) {
        pendingActStore.clear(phone);
        // Fall through to normal processing
      } else if (pendingAct.missing && pendingAct.missing.length > 0) {
        // Unified multi-slot completion (replicated from test-bot controller).
        const { processPendingAction } = await import('../middleware/pending-action-processor.js');
        const result = processPendingAction(text, pendingAct);
        if (result.next === null) {
          // Use processor's finalData (already merged + overwrites applied).
          // See test-bot.controller for the rationale — currency etc. need to
          // overwrite the agent's default.
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
          // Route through DomainRouter so any tool (agronomy, stock, livestock,
          // financial, etc.) can be re-executed via the unified pending path.
          const routed = await domainRouter.routeCommand(merged, userId, user, settings);
          const cmdResult = routed ?? { messages: ['No pude completar el registro. Probá de nuevo.'] };
          // Advance the serial pending queue if there were more items waiting
          // (e.g. "vendi vaca y compre X" left both as queued pendings — when
          // the vaca completes, the gasto's askPrompt fires next).
          const { advanceQueueAfterCompletion } = await import('../middleware/pending-queue-advancer.js');
          const advanced = advanceQueueAfterCompletion(pendingActStore, phone, pendingAct, cmdResult);
          // Forward sideEffects from the re-routed command. Without this, a
          // re-routed log_income / log_expense returns a confirmation pending
          // (setPending) but the controller never registers it — the user's
          // confirm tap then says "no hay nada pendiente" and data drops.
          if (cmdResult.sideEffects?.setPending) {
            pendingStore.set(phone, cmdResult.sideEffects.setPending);
          }
          if (cmdResult.sideEffects?.setPendingActivity) {
            const next = cmdResult.sideEffects.setPendingActivity;
            pendingActStore.set(phone, {
              command: next.command,
              data: next.data,
              timestamp: Date.now(),
              missing: (next as { missing?: string[] }).missing,
              askPrompt: (next as { askPrompt?: string }).askPrompt,
            });
          }
          if (cmdResult.sideEffects?.setPendingObservation) {
            const obs = cmdResult.sideEffects.setPendingObservation;
            pendingObsStore.set(phone, { text: obs.text, category: obs.category, timestamp: Date.now() });
          }
          if (cmdResult.sideEffects?.setPendingCampaignClose) {
            pendingCampaignCloseStore.set(phone, cmdResult.sideEffects.setPendingCampaignClose);
          }
          // sendResponse handles both text messages and interactive buttons —
          // critical for the confirmation prompt that follows a re-route.
          await sendResponse(phone, cmdResult);
          if (advanced.askPrompt) await sendMessage(phone, advanced.askPrompt);
          res.sendStatus(200);
          return;
        }
        pendingActStore.set(phone, result.next);
        await sendMessage(phone, result.next.askPrompt || 'Me falta algún dato. ¿Me lo pasás?');
        res.sendStatus(200);
        return;
      } else if (pendingAct.data._needs === 'crop') {
        const crop = extractCropFromText(text);
        if (crop) {
          pendingActStore.clear(phone);
          const merged = { ...pendingAct.data, crop } as ParsedCommand;
          delete (merged as Record<string, unknown>)._needs;
          // Carry the pending's command into merged so routeCommand can dispatch.
          // Partial intents (income_partial / expense_partial) never put a
          // `command` in `data` — it lives only on the pending itself. Without
          // this, every multi-turn financial completion routed to undefined →
          // "No pude completar el registro" + silent data drop.
          if (!(merged as Record<string, unknown>).command) {
            (merged as Record<string, unknown>).command = pendingAct.command;
          }
          const result = await agronomyHandler.handleCommand(merged, userId, user, settings);
          if (result.sideEffects?.setPendingActivity) {
            const next = result.sideEffects.setPendingActivity;
            pendingActStore.set(phone, {
              command: next.command,
              data: next.data,
              timestamp: Date.now(),
              missing: next.missing,
              askPrompt: next.askPrompt,
              nextInQueue: next.nextInQueue,
            });
          }
          if (result.sideEffects?.setPendingCampaignClose) {
            pendingCampaignCloseStore.set(phone, result.sideEffects.setPendingCampaignClose);
          }
          await sendResponse(phone, result);
          console.log(`[PENDING_CROP] Resolved crop="${crop}" for pending ${pendingAct.command}, user ${userId}`);
          conversationLogger.log(userId, phone, text, result.messages[0] ?? result.interactive?.body ?? null, 'command', pendingAct.command, null, null, false, Date.now() - startTime).catch(() => {});
          res.sendStatus(200);
          return;
        }
        await sendMessage(phone, `No reconocí ese cultivo. ¿Qué cultivo? (ej: soja, maíz, trigo, girasol)`);
        console.log(`[PENDING_CROP] Could not resolve crop from "${text}", asking again for user ${userId}`);
        res.sendStatus(200);
        return;
      } else {
        const actResolved = await plotDiscovery.resolveExisting(userId, text);
        if (actResolved.plotId) {
          pendingActStore.clear(phone);
          const actResult = await agronomyHandler.savePendingActivity(
            userId, pendingAct, actResolved.plotId,
            actResolved.fieldId, actResolved.plotName, actResolved.fieldName,
          );
          if (actResult.sideEffects?.setPendingCampaignClose) {
            pendingCampaignCloseStore.set(phone, actResult.sideEffects.setPendingCampaignClose);
          }
          await sendResponse(phone, actResult);
          console.log(`[PENDING_ACT] Resolved plot_id=${actResolved.plotId} for pending ${pendingAct.command}, user ${userId}`);
          conversationLogger.log(userId, phone, text, actResult.messages[0] ?? actResult.interactive?.body ?? null, 'command', pendingAct.command, null, null, false, Date.now() - startTime).catch(() => {});
          res.sendStatus(200);
          return;
        }
        const userPlots = await agronomyRepository.findAllUserPlots(userId);
        await sendMessage(phone, `No encontré ese lote. ¿En qué lote?\n\n${formatPlotListGrouped(userPlots)}`);
        console.log(`[PENDING_ACT] Could not resolve plot from "${text}", asking again for user ${userId}`);
        res.sendStatus(200);
        return;
      }
    }

    // --- Check pending confirmation first ---
    const pending = pendingStore.get(phone);

    // --- Pending correction intercept (category / amount mid-confirmation) ---
    // If there's a pending gasto/ingreso and the user's text is a category or
    // amount correction ("no, era en sueldos" / "no, eran 75 mil"), patch the
    // pending in-place and re-render the confirmation without hitting the agent
    // (CR02 fix — previously the message fell through to the agent which
    // sometimes replied with "¿en qué lote?" instead of fixing the field).
    if (pending && (pending.type === 'expense' || pending.type === 'income')) {
      const { tryApplyPendingCorrection } = await import('../middleware/pending-correction-interceptor.js');
      const corr = tryApplyPendingCorrection(text, pending as any);
      if (corr.applied) {
        pendingStore.set(phone, corr.updatedPending as any);
        await sendMessage(phone, corr.body!);
        await sendInteractiveButtons(phone, '¿Confirmás?', corr.buttons!);
        conversationLogger.log(userId, phone, text, corr.body!, 'command', 'correction_applied', null, null, false, Date.now() - startTime, true, 1.0).catch(() => {});
        res.sendStatus(200);
        return;
      }
    }

    // Load confidence thresholds from settings (cached 5 min)
    const lowConfidenceThreshold = (await getSettingNumber('CONFIDENCE_LOW_CONFIRM')) ?? 0.70;
    const unknownFallbackThreshold = (await getSettingNumber('CONFIDENCE_UNKNOWN_FALLBACK')) ?? 0.50;

    // Check for follow-up context before classification
    const enriched = await enrichWithContext(text, userId);

    // Classify intent (now returns ParseResult with confidence)
    const parseResult: ParseResult = await intentClassifier.classify(text, userId, settings);
    const { intent: rawIntent, aiUsed, confidence } = parseResult;
    const agentMode = (parseResult as any)._agentMode as string | undefined;
    const toolCallsData = (parseResult as any)._toolCalls as object[] | undefined;

    // Handle conversational response from Agent (no tool call — agent replied directly)
    if ((parseResult as any)._conversationalResponse) {
      const convResponse = (parseResult as any)._conversationalResponse as string;
      await sendMessage(phone, convResponse);
      conversationLogger.log(userId, phone, text, convResponse, 'conversational', null, null, null, true, Date.now() - startTime, false, confidence, toolCallsData, agentMode).catch(() => {});
      res.sendStatus(200);
      return;
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
        // Build a combined HandlerResponse and send it
        const combined: HandlerResponse = {
          messages: result.messages,
          interactive: result.lastInteractive,
          attachment: result.lastAttachment,
          suggestionKey: result.lastSuggestionKey,
        };
        // Handle sideEffects
        if (result.stoppedAtFlow && result.lastSideEffects?.startFlow) {
          const { state, data } = result.lastSideEffects.startFlow;
          if (state === 'field_flow') {
            const flowData = data ?? {};
            flowData._channel = 'whatsapp';
            flowData._channelId = phone;
          }
          const flowResult = await conversationEngine.startFlow(userId, state, data);
          if (flowResult.nextContext) await conversationEngine.setFlowContext(userId, flowResult.nextContext);
          await sendResponse(phone, combined);
          await sendResponse(phone, flowResult.response);
        } else {
          if (result.lastSideEffects) {
            if (result.lastSideEffects.setPendingObservation) {
              const obs = result.lastSideEffects.setPendingObservation;
              pendingObsStore.set(phone, { text: obs.text, category: obs.category, timestamp: Date.now() });
            }
            if (result.lastSideEffects.setPendingActivity) {
              const act = result.lastSideEffects.setPendingActivity;
              pendingActStore.set(phone, {
                command: act.command,
                data: act.data,
                timestamp: Date.now(),
                missing: act.missing,
                askPrompt: act.askPrompt,
                nextInQueue: act.nextInQueue,
              });
            }
            if (result.lastSideEffects.setPendingFieldCity) {
              pendingCityStore.set(phone, { fieldName: result.lastSideEffects.setPendingFieldCity.fieldName, timestamp: Date.now() });
            }
            const plotAreaPrompt = storePlotAreaSideEffects(phone, pendingPlotAreaStore, result.lastSideEffects);
            if (plotAreaPrompt) combined.messages.push(plotAreaPrompt);
            if (result.lastSideEffects.setFieldDuplicate) {
              const dup = result.lastSideEffects.setFieldDuplicate;
              pendingStore.set(phone, {
                type: 'expense', data: { type: 'expense', amount: 0, category: '', description: '', currency: 'ARS' },
                fieldId: null, fieldName: null, plotId: null, plotName: null,
                timestamp: Date.now(), _fieldDuplicate: dup,
              } as any);
            }
            if (result.lastSideEffects.setPendingFieldLocation) {
              const loc = result.lastSideEffects.setPendingFieldLocation;
              pendingFieldLocationStore.set(phone, { fieldId: loc.fieldId, fieldName: loc.fieldName });
            }
            if (result.lastSideEffects.setPendingCampaignClose) {
              pendingCampaignCloseStore.set(phone, result.lastSideEffects.setPendingCampaignClose);
            }
          }
          await sendResponse(phone, combined);
        }
        conversationLogger.log(userId, phone, text, result.messages.join('\n\n') || null, 'command', 'compound', null, null, aiUsed, Date.now() - startTime, !!result.lastInteractive, confidence, toolCallsData, agentMode).catch(() => {});
        res.sendStatus(200);
        return;
      }
      // result is null or empty → fall through to normal single-action path
    }

    const intentCommand = rawIntent.type === 'command' ? rawIntent.data.command : null;
    conversationObserver.logIntentDetected(userId, rawIntent.type, intentCommand, confidence, parseResult.source, { aiUsed, missingFields: parseResult.missingFields.length > 0 ? parseResult.missingFields : undefined });
    if (aiUsed) {
      conversationObserver.logFallbackUsed(userId, { inputText: text, resultType: rawIntent.type });
    }

    // Enrich intent with learned vocabulary (fills gaps, never overwrites)
    const intent: Intent = await contextResolver.enrichIntent(userId, text, rawIntent);

    // If follow-up detected and we have memory, inject context into command data
    if (enriched.enriched && enriched.memory && intent.type === 'command') {
      const mem = enriched.memory;
      const data = intent.data as Record<string, unknown>;
      // Fill missing plot/field context from memory
      if (!data.plotName && mem.plotName) data.plotName = mem.plotName;
      if (!data.fieldName && mem.fieldName) data.fieldName = mem.fieldName;
      // Fill missing activity filter from last conversation
      if (!data.activityFilter && mem.lastActivityType) data.activityFilter = mem.lastActivityType;
      // Fill missing time reference from last conversation
      if (!data.timeRef && mem.lastTimeReference) {
        data._inheritedTimeLabel = mem.lastTimeReference;
      }
    }

    // Handle confirm/cancel for pending transactions
    if (intent.type === 'command' && intent.data.command === 'confirm') {
      if (!pending) {
        await sendMessage(phone, 'No hay nada pendiente para confirmar.');
        conversationLogger.log(userId, phone, text, 'No hay nada pendiente para confirmar.', 'command', 'confirm', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode).catch(() => {});
        res.sendStatus(200);
        return;
      }
      pendingStore.clear(phone);
      const response = await financialHandler.handleConfirm(userId, pending, settings, user);
      await sendResponse(phone, response);
      conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'command', 'confirm', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode).catch(() => {});
      res.sendStatus(200);
      return;
    }

    if (intent.type === 'command' && intent.data.command === 'cancel') {
      const { clearMultiTurnState } = await import('../middleware/multi-turn-state.js');
      await clearMultiTurnState(userId);
      if (!pending) {
        await sendMessage(phone, 'Listo, contexto limpio. ¿Qué hacemos?');
        conversationLogger.log(userId, phone, text, 'Listo, contexto limpio.', 'command', 'cancel', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode).catch(() => {});
        res.sendStatus(200);
        return;
      }
      pendingStore.clear(phone);
      await sendMessage(phone, '\u274c Operaci\u00f3n cancelada.');
      conversationLogger.log(userId, phone, text, 'Operaci\u00f3n cancelada.', 'command', 'cancel', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode).catch(() => {});
      res.sendStatus(200);
      return;
    }

    // If there was a pending but user sent something else, clear it
    if (pending) {
      pendingStore.clear(phone);
    }

    // --- Phase 3: trial expired (access-gate blocked AI / writes) ---
    if (intent.type === 'trial_expired') {
      const { trialExpiredCopy } = await import('../services/access-gate.service.js');
      const reply = trialExpiredCopy();
      await sendMessage(phone, reply);
      conversationLogger.log(userId, phone, text, reply, 'trial_expired', null, null, null, aiUsed, Date.now() - startTime, false, 0, toolCallsData, agentMode).catch(() => {});
      res.sendStatus(200);
      return;
    }

    // --- Phase 2: regex fallback refused to parse a complex intent ---
    if (intent.type === 'fallback_blocked') {
      const { fallbackBlockedCopy } = await import('../services/intent-safety.js');
      const reply = fallbackBlockedCopy(intent.reason, intent.attemptedCommand);
      await sendMessage(phone, reply);
      conversationLogger.log(userId, phone, text, reply, 'fallback_blocked', intent.attemptedCommand ?? null, null, null, aiUsed, Date.now() - startTime, false, 0, toolCallsData, agentMode).catch(() => {});
      res.sendStatus(200);
      return;
    }

    // --- Handle partial parse → slot-extractor pending (May 28 fix) ---
    // Was: rigid expense_flow / income_flow that escaped when the user
    // answered out of order ("Lote a2" while flow was asking for amount
    // → routed to plot_info, income lost — user 4 incident 2026-05-28).
    // Now: slot-extractor pending accepts any slot at any time.
    if (intent.type === 'expense_partial') {
      if (await checkPrerequisiteBlock(userId, phone, 'registrar un gasto')) {
        res.sendStatus(200);
        return;
      }
      const hasExpenses = await featureGate.hasFeature(userId, 'expenses');
      if (!hasExpenses) {
        await sendMessage(phone, '\ud83d\udd12 El registro de gastos no est\u00e1 disponible en tu plan actual.\n\nEscrib\u00ed *plan* para ver las opciones.');
        res.sendStatus(200);
        return;
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
      await sendMessage(phone, planExp.askPrompt);
      conversationLogger.log(userId, phone, text, planExp.askPrompt, 'pending', 'expense_partial', null, 0, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode).catch(() => {});
      res.sendStatus(200);
      return;
    }

    if (intent.type === 'income_partial') {
      if (await checkPrerequisiteBlock(userId, phone, 'registrar un ingreso')) {
        res.sendStatus(200);
        return;
      }
      const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
      if (!hasIncomes) {
        await sendMessage(phone, '\ud83d\udd12 El registro de ingresos no est\u00e1 disponible en tu plan actual.\n\nEscrib\u00ed *plan* para ver las opciones.');
        res.sendStatus(200);
        return;
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
      await sendMessage(phone, planInc.askPrompt);
      conversationLogger.log(userId, phone, text, planInc.askPrompt, 'pending', 'income_partial', null, 0, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode).catch(() => {});
      res.sendStatus(200);
      return;
    }

    // --- Handle ambiguous intent → show disambiguation buttons ---
    if (intent.type === 'ambiguous') {
      const buttons = intent.candidates.slice(0, 3).map((c, i) => ({
        id: `disambig_${i}`,
        title: c.label.slice(0, 20),
      }));
      await sendInteractiveButtons(phone, '\u00bfQu\u00e9 quer\u00e9s hacer?', buttons);
      conversationLogger.log(userId, phone, text, 'Disambiguation', 'ambiguous', null, null, null, aiUsed, Date.now() - startTime, true, confidence, toolCallsData, agentMode).catch(() => {});
      res.sendStatus(200);
      return;
    }

    // --- Route commands ---
    if (intent.type === 'command') {
      // Start document upload → store intent, prompt for image
      if (intent.data.command === 'start_document_upload') {
        const hasDocuments = await featureGate.hasFeature(userId, 'documents');
        if (!hasDocuments) {
          await sendMessage(phone, '🔒 El procesamiento de documentos no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.');
          res.sendStatus(200);
          return;
        }
        const docType = (intent.data.documentType as DocumentUploadIntent) || 'factura';
        const label = docType === 'factura' ? '🧾 factura' : docType === 'remito' ? '📋 remito' : '🎫 ticket';
        pendingDocUploadStore.set(phone, { intent: docType, timestamp: Date.now() });
        await sendMessage(phone, `Enviame la foto o PDF del ${label} y lo proceso.`);
        conversationLogger.log(userId, phone, text, `Start document upload: ${docType}`, 'command', 'start_document_upload', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode).catch(() => {});
        res.sendStatus(200);
        return;
      }

      // Start flow commands → launch flow directly
      if (intent.data.command === 'start_expense_flow') {
        if (await checkPrerequisiteBlock(userId, phone, 'registrar un gasto')) {
          res.sendStatus(200);
          return;
        }
        const result = await conversationEngine.startFlow(userId, 'expense_flow' as FlowState);
        if (result.nextContext) await conversationEngine.setFlowContext(userId, result.nextContext);
        await sendResponse(phone, result.response);
        res.sendStatus(200);
        return;
      }
      if (intent.data.command === 'start_income_flow') {
        if (await checkPrerequisiteBlock(userId, phone, 'registrar un ingreso')) {
          res.sendStatus(200);
          return;
        }
        const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
        if (!hasIncomes) {
          await sendMessage(phone, '\ud83d\udd12 El registro de ingresos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.');
          res.sendStatus(200);
          return;
        }
        const result = await conversationEngine.startFlow(userId, 'income_flow' as FlowState);
        if (result.nextContext) await conversationEngine.setFlowContext(userId, result.nextContext);
        await sendResponse(phone, result.response);
        res.sendStatus(200);
        return;
      }

      // Destructive command confirmation
      if (DESTRUCTIVE_COMMANDS.has(intent.data.command)) {
        const actionLabels: Record<string, string> = {
          delete_last: 'eliminar el \u00faltimo gasto',
          delete_last_income: 'eliminar el \u00faltimo ingreso',
          delete_specific: 'eliminar un registro',
        };
        const label = actionLabels[intent.data.command] || 'realizar esta acci\u00f3n';
        await sendInteractiveButtons(phone,
          `\u00bfSeguro que quer\u00e9s ${label}?\nEsto no se puede deshacer.`,
          [
            { id: `confirm_destructive_${intent.data.command}`, title: 'Confirmar' },
            { id: 'cancel_destructive', title: 'Cancelar' },
          ]
        );
        // Store the full command data for later execution
        pendingStore.set(phone, {
          type: 'expense', // placeholder type to reuse store
          data: { type: 'expense', amount: 0, category: '', description: '', currency: 'ARS' },
          fieldId: null, fieldName: null, plotId: null, plotName: null,
          timestamp: Date.now(),
          _destructiveCommand: intent.data,
        } as any);
        conversationLogger.log(userId, phone, text, `Confirmación: ${label}`, 'command', intent.data.command, null, null, aiUsed, Date.now() - startTime, true, confidence, toolCallsData, agentMode).catch(() => {});
        res.sendStatus(200);
        return;
      }

      // Attach original text so handlers can check if fields were explicitly mentioned
      intent.data.originalText = text;

      const response = await domainRouter.routeCommand(intent.data, userId, user, settings);
      if (response) {
        // Safety: ensure we never send an empty response (silent failure)
        if (response.messages.length === 0 && !response.attachment && !response.interactive) {
          console.warn(`[SILENT_FAILURE] Command "${intent.data.command}" returned empty response for user ${userId}`);
          logWarning('whatsapp', 'SILENT_FAILURE', `Command "${intent.data.command}" returned empty response`, { userId, context: { command: intent.data.command } });
          response.messages = ['No pude procesar ese comando. Escribí *ayuda* para ver las opciones.'];
        }
        // Ensure every command gets a suggestion (no dead ends)
        response.suggestionKey = resolveSuggestionKey(intent.data.command, response.suggestionKey);
        // Start a flow if the handler requested it (e.g. add_field_city → field_flow)
        if (response.sideEffects?.startFlow) {
          const { state, data } = response.sideEffects.startFlow;
          // Inject channel info for field_flow map/share location options
          if (state === 'field_flow') {
            const flowData = data ?? {};
            flowData._channel = 'whatsapp';
            flowData._channelId = phone;
          }
          const flowResult = await conversationEngine.startFlow(userId, state, data);
          if (flowResult.nextContext) {
            await conversationEngine.setFlowContext(userId, flowResult.nextContext);
          }
          conversationObserver.logFlowStarted(userId, state, { trigger: 'command', prefillFields: data ? Object.keys(data) : [] });
          await sendResponse(phone, flowResult.response);
          conversationLogger.log(userId, phone, text, flowResult.response.messages[0] ?? flowResult.response.interactive?.body ?? null, 'flow', 'flow_start', state, 0, aiUsed, Date.now() - startTime, !!flowResult.response.interactive, confidence, toolCallsData, agentMode).catch(() => {});
          res.sendStatus(200);
          return;
        }
        // Store pending observation for plot disambiguation follow-up
        if (response.sideEffects?.setPendingObservation) {
          const obs = response.sideEffects.setPendingObservation;
          pendingObsStore.set(phone, { text: obs.text, category: obs.category, timestamp: Date.now() });
          console.log(`[PENDING_OBS] Stored pending observation for user ${userId}: "${obs.text}"`);
        }
        // Store pending activity for plot disambiguation follow-up
        if (response.sideEffects?.setPendingActivity) {
          const act = response.sideEffects.setPendingActivity;
          pendingActStore.set(phone, {
            command: act.command,
            data: act.data,
            timestamp: Date.now(),
            missing: act.missing,
            askPrompt: act.askPrompt,
            nextInQueue: act.nextInQueue,
          });
          console.log(`[PENDING_ACT] Stored pending ${act.command} for user ${userId}`);
        }
        // Store pending field city for next-message assignment
        if (response.sideEffects?.setPendingFieldCity) {
          pendingCityStore.set(phone, {
            fieldName: response.sideEffects.setPendingFieldCity.fieldName,
            timestamp: Date.now(),
          });
        }
        // Store pending plot area (single or queue)
        const plotAreaPromptCmd = storePlotAreaSideEffects(phone, pendingPlotAreaStore, response.sideEffects);
        if (plotAreaPromptCmd) response.messages.push(plotAreaPromptCmd);
        // Store pending field duplicate data for resolution buttons
        if (response.sideEffects?.setFieldDuplicate) {
          const dup = response.sideEffects.setFieldDuplicate;
          pendingStore.set(phone, {
            type: 'expense', data: { type: 'expense', amount: 0, category: '', description: '', currency: 'ARS' },
            fieldId: null, fieldName: null, plotId: null, plotName: null,
            timestamp: Date.now(), _fieldDuplicate: dup,
          } as any);
        }
        // Store pending stock deduction for activity → stock callback
        if (response.sideEffects?.setPendingStockDeduction) {
          pendingStockDeductionStore.set(phone, response.sideEffects.setPendingStockDeduction as Record<string, unknown>);
        }
        // Store pending field location for next location message
        if (response.sideEffects?.setPendingFieldLocation) {
          const loc = response.sideEffects.setPendingFieldLocation;
          pendingFieldLocationStore.set(phone, { fieldId: loc.fieldId, fieldName: loc.fieldName });
        }
        if (response.sideEffects?.setPendingCampaignClose) {
          pendingCampaignCloseStore.set(phone, response.sideEffects.setPendingCampaignClose);
        }
        // Learn from successful command (fire-and-forget)
        learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
        conversationObserver.logCommandExecuted(userId, intent.data.command, { aiUsed, confidence });
        // Save mini conversational memory (fire-and-forget)
        updateConversationMiniMemory(userId, {
          lastIntent: intent.data.command,
          lastActivityType: (intent.data.activityFilter as string) ?? (intent.data.activityType as string) ?? null,
          lastQueryType: intent.data.command.startsWith('query_') ? intent.data.command : null,
          lastTimeReference: (intent.data.timeLabel as string) ?? null,
        }).catch(() => {});
        await sendResponse(phone, response);
        conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'command', intent.data.command, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence, toolCallsData, agentMode).catch(() => {});
        res.sendStatus(200);
        return;
      }
    }

    // --- Handle expense ---
    if (intent.type === 'expense') {
      const hasExpenses = await featureGate.hasFeature(userId, 'expenses');
      if (!hasExpenses) {
        await sendMessage(phone, '\ud83d\udd12 El registro de gastos no est\u00e1 disponible en tu plan actual.\n\nEscrib\u00ed *plan* para ver las opciones.');
        res.sendStatus(200);
        return;
      }

      // Low confidence → force confirmation regardless of user setting
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
        conversationObserver.logFlowStarted(userId, state, { trigger: 'expense_plot_selection', prefillFields: data ? Object.keys(data) : [] });
        await sendResponse(phone, response);
        await sendResponse(phone, flowResult.response);
        conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'flow', 'expense_flow_start', state, 0, aiUsed, Date.now() - startTime, !!flowResult.response.interactive, confidence, toolCallsData, agentMode).catch(() => {});
        res.sendStatus(200);
        return;
      }
      let replacedPendingExpense: PendingTransaction | null = null;
      if (response.sideEffects?.setPending) {
        replacedPendingExpense = pendingStore.set(phone, response.sideEffects.setPending);
      }
      if (response.sideEffects?.setPendingStockEntry) {
        pendingStockEntryStore.set(phone, response.sideEffects.setPendingStockEntry as Record<string, unknown>);
      }
      // Learn from successful expense (fire-and-forget)
      learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
      updateConversationMiniMemory(userId, { lastIntent: 'expense' }).catch(() => {});
      if (replacedPendingExpense) {
        // Auto-commit the previous pending if complete (don't discard data),
        // else warn it was cancelled.
        await sendMessage(phone, await resolveReplacedPending(replacedPendingExpense, p => financialHandler.handleConfirm(userId, p, settings, user).then(() => {})));
      }
      await sendResponse(phone, response);
      conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'expense', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence, toolCallsData, agentMode).catch(() => {});
      res.sendStatus(200);
      return;
    }

    // --- Handle income ---
    if (intent.type === 'income') {
      const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
      if (!hasIncomes) {
        await sendMessage(phone, '\ud83d\udd12 El registro de ingresos no est\u00e1 disponible en tu plan actual.\n\nEscrib\u00ed *plan* para ver las opciones.');
        res.sendStatus(200);
        return;
      }

      // Low confidence → force confirmation
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
        conversationObserver.logFlowStarted(userId, state, { trigger: 'income_plot_selection', prefillFields: data ? Object.keys(data) : [] });
        await sendResponse(phone, response);
        await sendResponse(phone, flowResult.response);
        conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'flow', 'income_flow_start', state, 0, aiUsed, Date.now() - startTime, !!flowResult.response.interactive, confidence, toolCallsData, agentMode).catch(() => {});
        res.sendStatus(200);
        return;
      }
      let replacedPendingIncome: PendingTransaction | null = null;
      if (response.sideEffects?.setPending) {
        replacedPendingIncome = pendingStore.set(phone, response.sideEffects.setPending);
      }
      if (response.sideEffects?.setPendingStockDeduction) {
        pendingStockDeductionStore.set(phone, response.sideEffects.setPendingStockDeduction as Record<string, unknown>);
      }
      // Learn from successful income (fire-and-forget)
      learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
      updateConversationMiniMemory(userId, { lastIntent: 'income' }).catch(() => {});
      if (replacedPendingIncome) {
        await sendMessage(phone, await resolveReplacedPending(replacedPendingIncome, p => financialHandler.handleConfirm(userId, p, settings, user).then(() => {})));
      }
      await sendResponse(phone, response);
      conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'income', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence, toolCallsData, agentMode).catch(() => {});
      res.sendStatus(200);
      return;
    }

    // --- Unknown → Conversational fallback → Menu ---
    // Note: when AGENT_ENABLED=true, the agent handles conversational responses directly
    // (caught above via _conversationalResponse). This fallback only runs for regex-only
    // or JSON-path unknowns.
    if (intent.type === 'unknown' || confidence < unknownFallbackThreshold) {
      await financialService.saveUnparsedMessage(userId, text);

      const fallbackResult = await conversationalFallback.respond(text, userId, settings);

      if (fallbackResult.aiUsed) {
        await sendMessage(phone, fallbackResult.response);
        conversationLogger.log(userId, phone, text, fallbackResult.response, 'conversational', null, null, null, true, Date.now() - startTime, false, confidence, toolCallsData, agentMode).catch(() => {});
      } else {
        // Rate limited or disabled — show menu with upgrade hint if limit hit
        await sendMessage(phone, fallbackResult.response);
        if (fallbackResult.rateLimited) {
          await sendMessage(phone, 'Si necesitás más mensajes con IA, escribí *más mensajes* para solicitar una ampliación.');
        }
        const menuResponse = await systemHandler.handleCommand({ command: 'menu' }, userId, user, settings);
        await sendResponse(phone, menuResponse);
        conversationObserver.logMenuOpened(userId, { trigger: 'unknown_fallback' });
        conversationLogger.log(userId, phone, text, fallbackResult.response, 'unknown', null, null, null, false, Date.now() - startTime, true, confidence, toolCallsData, agentMode).catch(() => {});
      }
    }

    res.sendStatus(200);
  } catch (error: unknown) {
    const err = error as Error & { response?: { data?: unknown } };
    console.error('ERROR:', err.response?.data || err.message);
    logError('whatsapp', 'WEBHOOK_ERROR', err, { context: { responseData: err.response?.data } });
    res.sendStatus(500);
  }
});

export default router;
