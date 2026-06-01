import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
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
import { logError } from '../services/error-logger.js';
import { formatQuantityHuman } from '../utils/format-quantity.js';
import { isPlotAnswerToFlow } from '../utils/plot-intent.js';
import { PendingTransactionStore, describeReplacedPending } from '../middleware/pending-transactions.js';
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
import { getSettingNumber, getSettingBool } from '../services/settings.service.js';
import { pool } from '../config/db.js';
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
import { getSuggestions, resolveSuggestionKey } from '../middleware/contextual-suggestions.js';
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
import { createSpeechProvider } from '../services/audio/providers/provider-factory.js';
import type { ParsedExpense, ParsedIncome, HandlerResponse, Intent, FlowState, ParseResult, InteractiveMessage, InteractiveButton, InteractiveListSection, UserId, PendingTransaction } from '../types/index.js';
import { asUserId } from '../types/index.js';
import type { SpeechToTextProvider } from '../services/audio/providers/speech-provider.interface.js';

// --- Response item type ---

interface BotResponseItem {
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

// --- Wire up dependencies (separate instances from webhook) ---

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

const pendingStore = new PendingTransactionStore();
const pendingObsStore = new PendingObservationStore();
const pendingActStore = new PendingActivityStore();
const pendingCityStore = new PendingFieldCityStore();
const pendingPlotAreaStore = new PendingPlotAreaStore();
const pendingStockEntryStore = new Map<string, Record<string, unknown>>();
const pendingStockDeductionStore = new Map<string, Record<string, unknown>>();
const pendingFieldLocationStore = new PendingFieldLocationStore();
import { pendingCampaignCloseStore } from '../middleware/pending-campaign-close.js';
import type { PendingCampaignClose } from '../middleware/pending-campaign-close.js';
const plotDiscovery = new PlotDiscoveryService();
const learningService = new LearningService();
const contextResolver = new ContextResolver();

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

// No-fields block response for flows
function buildNoFieldsBlockItems(actionLabel: string): BotResponseItem[] {
  return [
    { type: 'text', text: `Para ${actionLabel} primero necesitás crear un campo.\n\n📍 Escribí *agregar campo [nombre]*` },
    interactiveButtons(`Necesitás un campo para ${actionLabel}.`, [
      { id: 'cmd_agregar_campo', title: 'Crear Campo' },
    ]),
  ];
}

function buildNoPlotBlockItems(actionLabel: string, fieldName: string): BotResponseItem[] {
  return [
    { type: 'text', text: `Para ${actionLabel} necesitás al menos un lote.\n\n📍 Escribí *agregar lote [nombre] en campo ${fieldName}*` },
    interactiveButtons(`Necesitás un lote para ${actionLabel}.`, [
      { id: 'cmd_agregar_lote', title: 'Crear Lote' },
    ]),
  ];
}

async function hasNoPrerequisites(userId: UserId): Promise<{ blocked: boolean; items?: BotResponseItem[] }> {
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

const DESTRUCTIVE_COMMANDS = new Set([
  'delete_last', 'delete_last_income', 'delete_specific',
]);

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

// --- Convert HandlerResponse → BotResponseItem[] ---

function collectResponse(response: HandlerResponse): BotResponseItem[] {
  const items: BotResponseItem[] = [];

  for (const msg of response.messages) {
    items.push({ type: 'text', text: msg });
  }

  // Attachment: send as text note (no binary in JSON)
  if (response.attachment) {
    items.push({ type: 'text', text: `[Archivo adjunto: ${response.attachment.filename}]` });
  }

  if (response.interactive) {
    if (response.interactive.type === 'buttons') {
      items.push({
        type: 'interactive',
        interactive: {
          type: 'buttons',
          body: response.interactive.body,
          buttons: response.interactive.buttons,
        },
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
        interactive: {
          type: 'buttons',
          body: suggestion.body,
          buttons: suggestion.buttons,
        },
      });
    }
  }

  return items;
}

function interactiveButtons(body: string, buttons: InteractiveButton[]): BotResponseItem {
  return {
    type: 'interactive',
    interactive: { type: 'buttons', body, buttons },
  };
}

// --- Synthetic phone for in-memory stores ---

function syntheticPhone(userId: number): string {
  return `testbot_${userId}`;
}

// --- Router ---

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// POST /api/test-bot — text + interactive replies
router.post('/', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const userId = req.auth!.userId;
    const numericUserId = asUserId(typeof userId === 'string' ? parseInt(userId, 10) : userId);
    const { message: inputText, interactiveReplyId } = req.body as { message?: string; interactiveReplyId?: string };
    const phone = syntheticPhone(numericUserId);

    // Get user from DB — build a User-compatible object
    const userRow = await pool.query('SELECT id, phone_number, name, city FROM users WHERE id = $1', [numericUserId]);
    if (userRow.rows.length === 0) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    const row = userRow.rows[0];
    const user = {
      id: numericUserId,
      phone_number: row.phone_number || phone,
      name: row.name ?? null,
      city: row.city ?? null,
    };

    // Ensure user_settings row exists (auth-only users may not have one)
    await pool.query(
      'INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [numericUserId],
    );
    const settings = await userRepository.getSettings(numericUserId);

    // --- Interactive reply handling ---
    if (interactiveReplyId) {
      const items = await handleInteractiveReply(interactiveReplyId, numericUserId, user, settings, phone, startTime);
      res.json({ messages: items });
      return;
    }

    // --- Text message ---
    if (!inputText || !inputText.trim()) {
      res.json({ messages: [] });
      return;
    }

    const text = inputText.trim();
    const items = await processTextMessage(text, numericUserId, user, settings, phone, startTime);
    res.json({ messages: items });
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[test-bot] ERROR:', err.stack || err.message);
    logError('test-bot', 'WEBHOOK_ERROR', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

// POST /api/test-bot/audio — multipart audio upload
router.post('/audio', upload.single('audio'), async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const userId = req.auth!.userId;
    const numericUserId = asUserId(typeof userId === 'string' ? parseInt(userId, 10) : userId);
    const phone = syntheticPhone(numericUserId);

    if (!req.file) {
      res.status(400).json({ error: 'No se recibió archivo de audio' });
      return;
    }

    const userRow2 = await pool.query('SELECT id, phone_number, name, city FROM users WHERE id = $1', [numericUserId]);
    if (userRow2.rows.length === 0) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    const row2 = userRow2.rows[0];
    const user = {
      id: numericUserId,
      phone_number: row2.phone_number || phone,
      name: row2.name ?? null,
      city: row2.city ?? null,
    };
    await pool.query(
      'INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [numericUserId],
    );
    const settings = await userRepository.getSettings(numericUserId);

    // Transcribe audio directly (bypass WhatsApp download)
    const provider = createSpeechProvider() as SpeechToTextProvider;
    const result = await provider.transcribe(req.file.buffer, req.file.mimetype);
    let transcript = result.text;
    transcript = normalizeTranscript(transcript);

    console.log('[test-bot] AUDIO TRANSCRIBED:', transcript);

    // Process through the same text pipeline
    const items = await processTextMessage(transcript, numericUserId, user, settings, phone, startTime);
    res.json({ transcript, messages: items });
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[test-bot] AUDIO ERROR:', err.message);
    logError('test-bot', 'AUDIO_PROCESSING', err);
    res.status(500).json({ error: 'No pude entender el audio. Intentá de nuevo.' });
  }
});

// POST /api/test-bot/text-with-attachment — same as /api/test-bot but returns
// any attachment (PDF, image) as base64 so test scripts can parse the binary.
router.post('/text-with-attachment', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const userId = req.auth!.userId;
    const numericUserId = asUserId(typeof userId === 'string' ? parseInt(userId, 10) : userId);
    const { message: inputText } = req.body as { message?: string };
    const phone = syntheticPhone(numericUserId);
    const userRow = await pool.query('SELECT id, phone_number, name, city FROM users WHERE id = $1', [numericUserId]);
    if (userRow.rows.length === 0) { res.status(404).json({ error: 'no user' }); return; }
    const row = userRow.rows[0];
    const user = { id: numericUserId, phone_number: row.phone_number || phone, name: row.name ?? null, city: row.city ?? null };
    await pool.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [numericUserId]);
    const settings = await userRepository.getSettings(numericUserId);
    if (!inputText || !inputText.trim()) { res.json({ messages: [], attachment: null }); return; }
    const text = inputText.trim();
    // Intercept: call the agronomy report path directly so we capture attachment.
    // For simplicity reuse processTextMessage but ALSO query the last domain
    // event/report buffer if it was created. We re-implement a slim version:
    const items = await processTextMessage(text, numericUserId, user, settings, phone, startTime);
    // Look for "Archivo adjunto" marker; if found, re-run via the agronomy handler
    // to get the binary. Cheaper: pass back items + a separate flag.
    res.json({ messages: items });
  } catch (error: unknown) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// --- Interactive reply handler ---

async function handleInteractiveReply(
  callbackId: string,
  userId: UserId,
  user: any,
  settings: any,
  phone: string,
  startTime: number,
): Promise<BotResponseItem[]> {
  console.log('[test-bot] INTERACTIVE:', callbackId);

  // Log interactive message for analytics
  conversationObserver.logMessageReceived(userId, { phone, messageType: 'interactive', messageLength: callbackId.length });

  // --- Flow callbacks ---
  if (callbackId.startsWith('flow_')) {
    const flowCtx = await conversationEngine.getFlowContext(userId);

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
      if (result.response.sideEffects?.setPendingFieldLocation) {
        const loc = result.response.sideEffects.setPendingFieldLocation;
        pendingFieldLocationStore.set(phone, { fieldId: loc.fieldId, fieldName: loc.fieldName });
      }
      return collectResponse(result.response);
    }
    if (callbackId === 'flow_cancel') {
      await conversationEngine.clearFlow(userId);
      const menuResponse = await systemHandler.handleCommand({ command: 'menu' }, userId, user, settings);
      return [
        { type: 'text', text: '\u274c Operacion cancelada.' },
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
      const result = await conversationEngine.startFlow(userId, flowName as FlowState);
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
          if (result.response.sideEffects?.setPendingStockEntry) {
            pendingStockEntryStore.set(phone, result.response.sideEffects.setPendingStockEntry);
          }
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
    conversationLogger.log(userId, phone, `[${callbackId}]`, 'Operacion cancelada.', 'command', 'cancel').catch(() => {});
    return [{ type: 'text', text: '\u274c Operacion cancelada.' }];
  }

  // --- Confirm pending financial transaction (buttons) ---
  if (callbackId === 'confirm_pending') {
    const pendingTx = pendingStore.get(phone);
    if (!pendingTx) {
      conversationLogger.log(userId, phone, '[confirm_pending]', 'No hay nada pendiente para confirmar.', 'command', 'confirm').catch(() => {});
      return [{ type: 'text', text: 'No hay nada pendiente para confirmar.' }];
    }
    pendingStore.clear(phone);
    const response = await financialHandler.handleConfirm(userId, pendingTx, settings, user);
    if (response.sideEffects?.setPendingStockEntry) {
      pendingStockEntryStore.set(phone, response.sideEffects.setPendingStockEntry as Record<string, unknown>);
    }
    if (response.sideEffects?.setPendingStockDeduction) {
      pendingStockDeductionStore.set(phone, response.sideEffects.setPendingStockDeduction as Record<string, unknown>);
    }
    conversationLogger.log(userId, phone, '[confirm_pending]', response.messages[0] ?? response.interactive?.body ?? null, 'command', 'confirm').catch(() => {});
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
      const prefill: Record<string, unknown> = { _channel: 'testbot', _channelId: phone };
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
    return [{ type: 'text', text: '\u274c Operacion cancelada.' }];
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
          messages: [`\ud83d\udccd Lote *${plot.name}* creado en campo *${field.name}*`],
          suggestionKey: 'plot_created',
          sideEffects: { setPendingPlotArea: { plotId: plot.id, plotName: plot.name, fieldName: field.name } },
        };
        const items = collectResponse(response);
        const prompt = storePlotAreaSideEffects(phone, pendingPlotAreaStore, response.sideEffects);
        if (prompt) items.push({ type: 'text', text: prompt });
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
        messages: [`\ud83d\uddd1\ufe0f Campo *${fieldName}* eliminado.\nLos gastos/ingresos asociados quedan sin asignar.\n\n_Para restaurarlo: "restaurar campo ${fieldName}"_`],
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
            messages: [`\ud83d\uddd1\ufe0f Lote *${plotName}* eliminado del campo *${fieldName}*.\nLos registros asociados quedan sin lote.\n\n_Para restaurarlo: "restaurar lote ${plotName}"_`],
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
        const pending = pendingStockEntryStore.get(phone);
        if (pending) {
          const { StockPurchaseService } = await import('../domain/stock/stock-purchase.service.js');
          const purchaseService = new StockPurchaseService();
          const { item } = await purchaseService.applyStockEntry(userId, pending as any);
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
        const pending = pendingStockDeductionStore.get(phone) as Record<string, unknown> | undefined;
        if (pending) {
          if (!pending.totalQuantity || (pending.totalQuantity as number) <= 0) {
            (pending as any).awaitingQuantity = true;
            pendingStockDeductionStore.set(phone, pending);
            return [{ type: 'text', text: `¿Cuántos ${pending.unit || 'lt'} de *${pending.product}* usaste?` }];
          }
          const { StockDeductionService } = await import('../domain/stock/stock-deduction.service.js');
          const deductionService = new StockDeductionService();
          const { item } = await deductionService.applyDeduction(userId, pending as any);
          pendingStockDeductionStore.delete(phone);
          return [{ type: 'text', text: `📤 Stock descontado: *${item.name}* → ${item.current_quantity} ${item.unit}` }];
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al descontar stock';
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    } else {
      // Decline path: persist the user's NO so the activity isn't re-asked.
      // Mirrors the whatsapp.controller behavior — was missing here.
      const pending = pendingStockDeductionStore.get(phone) as Record<string, unknown> | undefined;
      if (pending?.domainEventId) {
        try {
          const { StockDeductionService } = await import('../domain/stock/stock-deduction.service.js');
          const svc = new StockDeductionService();
          await svc.declineDeduction(pending.domainEventId as number);
        } catch (err) {
          console.error('[test-bot] declineDeduction failed:', err);
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
        const pending = pendingStockEntryStore.get(phone);
        if (pending && (pending as any).type === 'grain') {
          const { StockPurchaseService } = await import('../domain/stock/stock-purchase.service.js');
          const svc = new StockPurchaseService();
          const { item, movement } = await svc.applyStockEntry(userId, pending as any);
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
        const pending = pendingStockDeductionStore.get(phone);
        if (pending) {
          const { StockService } = await import('../domain/stock/stock.service.js');
          const svc = new StockService();
          const { item } = await svc.removeStock(userId, pending.product as string, pending.totalQuantity as number, pending.unit as string, {
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
      const pending = pendingCampaignCloseStore.get(phone);
      if (pending) {
        const { CropService } = await import('../domain/plots/crop.service.js');
        await new CropService().closeCampaign(pending.plotCropId);
        pendingCampaignCloseStore.delete(phone);
        return [{ type: 'text', text: `✅ Campaña de *${pending.crop}* en *${pending.plotName}* cerrada.` }];
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

// --- Main text message pipeline ---

async function processTextMessage(
  text: string,
  userId: UserId,
  user: any,
  settings: any,
  phone: string,
  startTime: number,
): Promise<BotResponseItem[]> {
  console.log('[test-bot] TEXT:', text);

  // Track last activity
  pool.query('UPDATE users SET last_message_at = NOW() WHERE id = $1', [userId]).catch(() => {});

  // Log message received for analytics
  const sessionId = `testbot_${userId}_${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })}`;
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
        return [{ type: 'text' as const, text: '❌ Operación cancelada.' }];
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
          { type: 'text', text: '\u274c Operacion cancelada.' },
          ...collectResponse(menuResponse),
        ];
      }
      const lower = text.toLowerCase().trim();
      if (['volver', 'atras', 'atr\u00e1s', 'back'].includes(lower) && flowCtx.step > 0) {
        const result = await conversationEngine.goBack(userId, flowCtx);
        if (result.nextContext) await conversationEngine.setFlowContext(userId, result.nextContext);
        return collectResponse(result.response);
      }

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
        await conversationEngine.clearFlow(userId);
        // Fall through to normal intent processing below
      } else {
        // No intent detected → process within active flow
        const result = await conversationEngine.processFlowMessage(userId, text, flowCtx);
        if (result.nextContext) {
          await conversationEngine.setFlowContext(userId, result.nextContext);
        } else {
          await conversationEngine.clearFlow(userId);
        }
        if (result.response.sideEffects?.setPendingStockEntry) {
          pendingStockEntryStore.set(phone, result.response.sideEffects.setPendingStockEntry);
        }
        return collectResponse(result.response);
      }
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
      return [{ type: 'text', text: '\u274c Observacion cancelada.' }];
    }
    // Escape hatch: if the message looks like a known command, clear pending and fall through
    const obsInterruptCmd = intentClassifier.parseCommandOnly(text);
    if (obsInterruptCmd || intentClassifier.detectsFinancialIntent(text)) {
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
        && (pendingAct.command === 'log_income' || pendingAct.command === 'log_expense')
        && pendingAct.missing.some(s => s === 'amount' || s === 'quantity' || s === 'unit_price' || s === 'unit');
      if (!expectsFinancialSlot && (actInterruptCmd || intentClassifier.detectsFinancialIntent(text))) {
      pendingActStore.clear(phone);
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
        // The previous logic re-merged with no-overwrite, which silently
        // discarded slots the processor had explicitly overwritten — e.g.
        // currency 'ARS' → 'USD' when the user clarified "100 mil dólares"
        // after a partial that defaulted ARS.
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
        // financial, etc.) can be re-executed via the unified pending path —
        // not just agronomy.
        const routed = await domainRouter.routeCommand(merged, userId, user, settings);
        const cmdResult = routed ?? { messages: ['No pude completar el registro. Probá de nuevo.'] };
        const { advanceQueueAfterCompletion } = await import('../middleware/pending-queue-advancer.js');
        const advanced = advanceQueueAfterCompletion(pendingActStore, phone, pendingAct, cmdResult);
        // Forward sideEffects from the re-routed command. Without this, a
        // re-routed log_income / log_expense returns a confirmation pending
        // (setPending) but the test-bot never registers it — the user's
        // confirm tap then says "no hay nada pendiente" and data is dropped.
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
            missing: (next as { missing?: string[] }).missing,
            askPrompt: (next as { askPrompt?: string }).askPrompt,
            nextInQueue: (next as { nextInQueue?: Array<{ command: string; data: Record<string, unknown>; missing?: string[]; askPrompt?: string }> }).nextInQueue,
          });
        }
        if (result.sideEffects?.setPendingCampaignClose) {
          pendingCampaignCloseStore.set(phone, result.sideEffects.setPendingCampaignClose);
        }
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
        if (result.sideEffects?.setPendingCampaignClose) {
          pendingCampaignCloseStore.set(phone, result.sideEffects.setPendingCampaignClose);
        }
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
      conversationLogger.log(userId, phone, text, corr.body!, 'command', 'correction_applied', null, null, false, Date.now() - startTime, true, 1.0).catch(() => {});
      return [
        { type: 'text', text: corr.body! },
        { type: 'interactive', interactive: { type: 'buttons', body: '¿Confirmás?', buttons: corr.buttons! } } as BotResponseItem,
      ];
    }
  }

  const lowConfidenceThreshold = (await getSettingNumber('CONFIDENCE_LOW_CONFIRM')) ?? 0.70;
  const unknownFallbackThreshold = (await getSettingNumber('CONFIDENCE_UNKNOWN_FALLBACK')) ?? 0.50;

  await enrichWithContext(text, userId);

  // Classify intent
  const parseResult: ParseResult = await intentClassifier.classify(text, userId, settings);
  const { intent: rawIntent, aiUsed, confidence } = parseResult;
  const agentMode = (parseResult as any)._agentMode as string | undefined;
  const toolCallsData = (parseResult as any)._toolCalls as object[] | undefined;

  // Handle conversational response from Agent
  if ((parseResult as any)._conversationalResponse) {
    const convResponse = (parseResult as any)._conversationalResponse as string;
    conversationLogger.log(userId, phone, text, convResponse, 'conversational', null, null, null, true, Date.now() - startTime, false, confidence, toolCallsData, agentMode).catch(() => {});
    return [{ type: 'text' as const, text: convResponse }];
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
            missing: (act as { missing?: string[] }).missing,
            askPrompt: (act as { askPrompt?: string }).askPrompt,
            nextInQueue: (act as { nextInQueue?: Array<{ command: string; data: Record<string, unknown>; missing?: string[]; askPrompt?: string }> }).nextInQueue,
          });
        }
        if (result.lastSideEffects.setPendingFieldCity) {
          pendingCityStore.set(phone, { fieldName: result.lastSideEffects.setPendingFieldCity.fieldName, timestamp: Date.now() });
        }
        const plotAreaPrompt = storePlotAreaSideEffects(phone, pendingPlotAreaStore, result.lastSideEffects);
        if (plotAreaPrompt) items.push({ type: 'text', text: plotAreaPrompt });
        if (result.lastSideEffects.setFieldDuplicate) {
          const dup = result.lastSideEffects.setFieldDuplicate;
          pendingStore.set(phone, {
            type: 'expense', data: { type: 'expense', amount: 0, category: '', description: '', currency: 'ARS' },
            fieldId: null, fieldName: null, plotId: null, plotName: null,
            timestamp: Date.now(), _fieldDuplicate: dup,
          } as any);
        }
        if (result.lastSideEffects.setPendingStockEntry) {
          pendingStockEntryStore.set(phone, result.lastSideEffects.setPendingStockEntry as Record<string, unknown>);
        }
        if (result.lastSideEffects.setPendingStockDeduction) {
          pendingStockDeductionStore.set(phone, result.lastSideEffects.setPendingStockDeduction as Record<string, unknown>);
        }
        if (result.lastSideEffects.setPendingCampaignClose) {
          pendingCampaignCloseStore.set(phone, result.lastSideEffects.setPendingCampaignClose);
        }
      }
      if (result.lastInteractive) {
        items.push({ type: 'interactive', interactive: result.lastInteractive } as BotResponseItem);
      } else if (result.lastSuggestionKey) {
        const suggestion = getSuggestions(result.lastSuggestionKey);
        if (suggestion && suggestion.type === 'buttons') {
          items.push({ type: 'interactive', interactive: { type: 'buttons', body: suggestion.body, buttons: suggestion.buttons } } as BotResponseItem);
        }
      }
      conversationLogger.log(userId, phone, text, result.messages.join('\n\n') || null, 'command', 'compound', null, null, aiUsed, Date.now() - startTime, !!result.lastInteractive, confidence, toolCallsData, agentMode).catch(() => {});
      return items;
    }
  }

  // Log intent for analytics
  const intentCommand = rawIntent.type === 'command' ? rawIntent.data.command : null;
  conversationObserver.logIntentDetected(userId, rawIntent.type, intentCommand, confidence, parseResult.source, { aiUsed, missingFields: parseResult.missingFields.length > 0 ? parseResult.missingFields : undefined });

  // Enrich with learned vocabulary
  const intent: Intent = await contextResolver.enrichIntent(userId, text, rawIntent);

  // Handle confirm/cancel for pending
  if (intent.type === 'command' && intent.data.command === 'confirm') {
    if (!pending) {
      return [{ type: 'text', text: 'No hay nada pendiente para confirmar.' }];
    }
    pendingStore.clear(phone);
    const response = await financialHandler.handleConfirm(userId, pending, settings, user);
    if (response.sideEffects?.setPendingStockEntry) {
      pendingStockEntryStore.set(phone, response.sideEffects.setPendingStockEntry as Record<string, unknown>);
    }
    conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'command', 'confirm', null, null, aiUsed, Date.now() - startTime, false, confidence).catch(() => {});
    return collectResponse(response);
  }
  if (intent.type === 'command' && intent.data.command === 'cancel') {
    const { clearMultiTurnState } = await import('../middleware/multi-turn-state.js');
    await clearMultiTurnState(userId);
    if (!pending) {
      return [{ type: 'text', text: 'Listo, contexto limpio. ¿Qué hacemos?' }];
    }
    pendingStore.clear(phone);
    conversationLogger.log(userId, phone, text, 'Operacion cancelada.', 'command', 'cancel', null, null, aiUsed, Date.now() - startTime, false, confidence).catch(() => {});
    return [{ type: 'text', text: '\u274c Operacion cancelada.' }];
  }

  // Note: we used to blanket-clear here, but that fought with the auto-cancel
  // path in pendingStore.set() which needs to see the previous pending so it can
  // warn the user 'cancelé el anterior'. The store auto-expires after 5 min and
  // set() overwrites; nothing else needs this preemptive clear.

  // --- Phase 3: trial expired (access-gate blocked AI / writes) ---
  if (intent.type === 'trial_expired') {
    const { trialExpiredCopy } = await import('../services/access-gate.service.js');
    const reply = trialExpiredCopy();
    conversationLogger.log(userId, phone, text, reply, 'trial_expired', null, null, null, aiUsed, Date.now() - startTime, false, 0).catch(() => {});
    return [{ type: 'text', text: reply }];
  }

  // --- Phase 2: regex fallback refused to parse a complex intent ---
  if (intent.type === 'fallback_blocked') {
    const { fallbackBlockedCopy } = await import('../services/intent-safety.js');
    const reply = fallbackBlockedCopy(intent.reason, intent.attemptedCommand);
    conversationLogger.log(userId, phone, text, reply, 'fallback_blocked', intent.attemptedCommand ?? null, null, null, aiUsed, Date.now() - startTime, false, 0).catch(() => {});
    return [{ type: 'text', text: reply }];
  }

  // --- Partial parse → flow ---
  if (intent.type === 'expense_partial') {
    { const prereq = await hasNoPrerequisites(userId); if (prereq.blocked) return prereq.items!; }
    const hasExpenses = await featureGate.hasFeature(userId, 'expenses');
    if (!hasExpenses) {
      return [{ type: 'text', text: '\ud83d\udd12 El registro de gastos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
    }
    // Slot-extractor pending (May 28) — replaces rigid expense_flow.
    const { planExpensePartialPending } = await import('../middleware/financial-partial-pending.js');
    const planExp = planExpensePartialPending(intent.data as any);
    pendingActStore.set(phone, {
      command: planExp.command,
      data: planExp.data,
      timestamp: Date.now(),
      missing: planExp.missing,
      askPrompt: planExp.askPrompt,
    });
    conversationLogger.log(userId, phone, text, planExp.askPrompt, 'pending', 'expense_partial', null, 0, aiUsed, Date.now() - startTime, false, confidence).catch(() => {});
    return [{ type: 'text', text: planExp.askPrompt }];
  }

  if (intent.type === 'income_partial') {
    { const prereq = await hasNoPrerequisites(userId); if (prereq.blocked) return prereq.items!; }
    const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
    if (!hasIncomes) {
      return [{ type: 'text', text: '\ud83d\udd12 El registro de ingresos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
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
    conversationLogger.log(userId, phone, text, planInc.askPrompt, 'pending', 'income_partial', null, 0, aiUsed, Date.now() - startTime, false, confidence).catch(() => {});
    return [{ type: 'text', text: planInc.askPrompt }];
  }

    // --- Ambiguous → disambiguation buttons ---
  if (intent.type === 'ambiguous') {
    const buttons = intent.candidates.slice(0, 3).map((c, i) => ({
      id: `disambig_${i}`,
      title: c.label.slice(0, 20),
    }));
    conversationLogger.log(userId, phone, text, 'Disambiguation', 'ambiguous', null, null, null, aiUsed, Date.now() - startTime, true, confidence).catch(() => {});
    return [interactiveButtons('\u00bfQue queres hacer?', buttons)];
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
        return [{ type: 'text', text: '\ud83d\udd12 El registro de ingresos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
      }
      const result = await conversationEngine.startFlow(userId, 'income_flow' as FlowState);
      if (result.nextContext) await conversationEngine.setFlowContext(userId, result.nextContext);
      return collectResponse(result.response);
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
        `\u00bfSeguro que queres ${label}?\nEsto no se puede deshacer.`,
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
        if (state === 'field_flow') {
          const flowData = data ?? {};
          flowData._channel = 'testbot';
          flowData._channelId = phone;
        }
        const flowResult = await conversationEngine.startFlow(userId, state, data);
        if (flowResult.nextContext) {
          await conversationEngine.setFlowContext(userId, flowResult.nextContext);
        }
        return collectResponse(flowResult.response);
      }
      if (response.sideEffects?.setPendingObservation) {
        const obs = response.sideEffects.setPendingObservation;
        pendingObsStore.set(phone, { text: obs.text, category: obs.category, timestamp: Date.now() });
      }
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
      }
      if (response.sideEffects?.setPendingFieldCity) {
        pendingCityStore.set(phone, {
          fieldName: response.sideEffects.setPendingFieldCity.fieldName,
          timestamp: Date.now(),
        });
      }
      const plotAreaPromptCmd = storePlotAreaSideEffects(phone, pendingPlotAreaStore, response.sideEffects);
      if (response.sideEffects?.setFieldDuplicate) {
        const dup = response.sideEffects.setFieldDuplicate;
        pendingStore.set(phone, {
          type: 'expense', data: { type: 'expense', amount: 0, category: '', description: '', currency: 'ARS' },
          fieldId: null, fieldName: null, plotId: null, plotName: null,
          timestamp: Date.now(), _fieldDuplicate: dup,
        } as any);
      }
      if (response.sideEffects?.setPendingStockDeduction) {
        pendingStockDeductionStore.set(phone, response.sideEffects.setPendingStockDeduction as Record<string, unknown>);
      }
      if (response.sideEffects?.setPendingStockEntry) {
        pendingStockEntryStore.set(phone, response.sideEffects.setPendingStockEntry as Record<string, unknown>);
      }
      if (response.sideEffects?.setPendingFieldLocation) {
        const loc = response.sideEffects.setPendingFieldLocation;
        pendingFieldLocationStore.set(phone, { fieldId: loc.fieldId, fieldName: loc.fieldName });
      }
      if (response.sideEffects?.setPendingCampaignClose) {
        pendingCampaignCloseStore.set(phone, response.sideEffects.setPendingCampaignClose);
      }
      learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
      updateConversationMiniMemory(userId, {
        lastIntent: intent.data.command,
        lastActivityType: (intent.data.activityFilter as string) ?? (intent.data.activityType as string) ?? null,
        lastQueryType: intent.data.command.startsWith('query_') ? intent.data.command : null,
        lastTimeReference: (intent.data.timeLabel as string) ?? null,
      }).catch(() => {});
      conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'command', intent.data.command, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence).catch(() => {});
      const items = collectResponse(response);
      if (plotAreaPromptCmd) items.push({ type: 'text', text: plotAreaPromptCmd });
      return items;
    }
  }

  // --- Handle expense ---
  if (intent.type === 'expense') {
    const hasExpenses = await featureGate.hasFeature(userId, 'expenses');
    if (!hasExpenses) {
      return [{ type: 'text', text: '\ud83d\udd12 El registro de gastos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
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
    let replacedPendingExpense: PendingTransaction | null = null;
    if (response.sideEffects?.setPending) {
      replacedPendingExpense = pendingStore.set(phone, response.sideEffects.setPending);
    }
    if (response.sideEffects?.setPendingStockEntry) {
      pendingStockEntryStore.set(phone, response.sideEffects.setPendingStockEntry as Record<string, unknown>);
    }
    learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
    updateConversationMiniMemory(userId, { lastIntent: 'expense' }).catch(() => {});
    conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'expense', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence).catch(() => {});
    const itemsExp = collectResponse(response);
    if (replacedPendingExpense) itemsExp.unshift({ type: 'text', text: describeReplacedPending(replacedPendingExpense) });
    return itemsExp;
  }

  // --- Handle income ---
  if (intent.type === 'income') {
    const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
    if (!hasIncomes) {
      return [{ type: 'text', text: '\ud83d\udd12 El registro de ingresos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
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
    let replacedPendingIncome: PendingTransaction | null = null;
    if (response.sideEffects?.setPending) {
      replacedPendingIncome = pendingStore.set(phone, response.sideEffects.setPending);
    }
    if (response.sideEffects?.setPendingStockDeduction) {
      pendingStockDeductionStore.set(phone, response.sideEffects.setPendingStockDeduction as Record<string, unknown>);
    }
    learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
    updateConversationMiniMemory(userId, { lastIntent: 'income' }).catch(() => {});
    conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'income', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence).catch(() => {});
    const itemsInc = collectResponse(response);
    if (replacedPendingIncome) itemsInc.unshift({ type: 'text', text: describeReplacedPending(replacedPendingIncome) });
    return itemsInc;
  }

  // --- Unknown → Conversational fallback ---
  if (intent.type === 'unknown' || confidence < unknownFallbackThreshold) {
    await financialService.saveUnparsedMessage(userId, text);
    const fallbackResult = await conversationalFallback.respond(text, userId, settings);
    const items: BotResponseItem[] = [{ type: 'text', text: fallbackResult.response }];
    if (fallbackResult.aiUsed) {
      conversationLogger.log(userId, phone, text, fallbackResult.response, 'conversational', null, null, null, true, Date.now() - startTime, false, confidence).catch(() => {});
    } else {
      const menuResponse = await systemHandler.handleCommand({ command: 'menu' }, userId, user, settings);
      items.push(...collectResponse(menuResponse));
      conversationLogger.log(userId, phone, text, fallbackResult.response, 'unknown', null, null, null, false, Date.now() - startTime, true, confidence).catch(() => {});
    }
    return items;
  }

  return [];
}

// POST /api/test-bot/reset — hard-delete ALL user data for clean QA testing
router.post('/reset', async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const userId = req.auth!.userId;
    const numericUserId = asUserId(typeof userId === 'string' ? parseInt(userId, 10) : userId);
    const phone = syntheticPhone(numericUserId);

    // 1. Clear ALL in-memory stores
    pendingStore.clear(phone);
    pendingObsStore.clear(phone);
    pendingActStore.clear(phone);
    pendingCityStore.clear(phone);
    pendingStockEntryStore.delete(phone);
    pendingStockDeductionStore.delete(phone);
    pendingFieldLocationStore.clear(phone);
    pendingCampaignCloseStore.delete(phone);
    pendingPlotAreaStore.clear(phone);

    // 2. Hard-delete all DB records in a transaction (FK-safe order)
    await client.query('BEGIN');

    // Layer 1: tables with FK to agro_observations (CASCADE, but be explicit)
    await client.query(
      `DELETE FROM observation_history WHERE observation_id IN (SELECT id FROM agro_observations WHERE user_id = $1)`,
      [numericUserId],
    );

    // Layer 2: tables with FK to fields/plots (non-cascade)
    await client.query(
      `DELETE FROM harvest_loads WHERE domain_event_id IN (SELECT id FROM domain_events WHERE user_id = $1)`,
      [numericUserId],
    );
    await client.query(`DELETE FROM alert_history WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM agronomic_reports WHERE user_id = $1`, [numericUserId]);
    // stock_movements has FK to expenses (expense_id) and domain_events (domain_event_id)
    // and livestock_movements has FK to expenses/incomes too. Delete movements BEFORE
    // their parent rows.
    await client.query(
      `DELETE FROM stock_movements WHERE user_id = $1`,
      [numericUserId],
    );
    await client.query(
      `DELETE FROM livestock_movements WHERE user_id = $1`,
      [numericUserId],
    );
    await client.query(`DELETE FROM domain_events WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM agro_observations WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM expenses WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM incomes WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM rainfall WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM crop_scoutings WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM expense_templates WHERE user_id = $1`, [numericUserId]);
    // Livestock + stock + feedlots (FK to fields)
    await client.query(
      `DELETE FROM livestock_groups WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`,
      [numericUserId],
    );
    await client.query(
      `DELETE FROM stock_items WHERE warehouse_id IN (SELECT id FROM warehouses WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1))`,
      [numericUserId],
    );
    await client.query(
      `DELETE FROM warehouses WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`,
      [numericUserId],
    );
    await client.query(
      `DELETE FROM feedlots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`,
      [numericUserId],
    );
    await client.query(
      `DELETE FROM field_members WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`,
      [numericUserId],
    );
    await client.query(
      `DELETE FROM field_invites WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`,
      [numericUserId],
    );
    await client.query(
      `DELETE FROM map_tokens WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`,
      [numericUserId],
    );

    // Layer 3: conversation state (FK to fields/plots as SET NULL)
    await client.query(`DELETE FROM conversation_state WHERE user_id = $1`, [numericUserId]);

    // Layer 4: fields — CASCADE deletes plots → plot_aliases, plot_crops
    await client.query(`DELETE FROM fields WHERE user_id = $1`, [numericUserId]);

    // Layer 5: non-FK user data
    await client.query(`DELETE FROM user_categories WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM budgets WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM unparsed_messages WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM ai_usage WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM ai_fallback_logs WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM conversation_events WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM conversation_logs WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM parser_errors WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM deletion_log WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM farmer_vocabulary WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM message_patterns WHERE user_id = $1`, [numericUserId]);
    await client.query(`DELETE FROM audio_transcription_logs WHERE user_id = $1`, [numericUserId]);

    // Verification: confirm zero records in core tables
    const verify = await client.query(
      `SELECT
        (SELECT COUNT(*) FROM fields WHERE user_id = $1)::int AS fields,
        (SELECT COUNT(*) FROM expenses WHERE user_id = $1)::int AS expenses,
        (SELECT COUNT(*) FROM incomes WHERE user_id = $1)::int AS incomes,
        (SELECT COUNT(*) FROM agro_observations WHERE user_id = $1)::int AS observations,
        (SELECT COUNT(*) FROM conversation_state WHERE user_id = $1)::int AS conv_state`,
      [numericUserId],
    );
    const counts = verify.rows[0];
    const total = counts.fields + counts.expenses + counts.incomes + counts.observations + counts.conv_state;
    if (total > 0) {
      await client.query('ROLLBACK');
      console.error(`[test-bot/reset] Verification failed: ${JSON.stringify(counts)}`);
      res.status(500).json({ error: 'Reset verification failed — records remain', counts });
      return;
    }

    await client.query('COMMIT');
    console.log(`[test-bot/reset] Hard-deleted all data for user ${numericUserId}`);
    res.json({ ok: true, message: 'Full reset complete — zero records verified' });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    const err = error as Error;
    console.error('[test-bot/reset] ERROR:', err.stack || err.message);
    res.status(500).json({ error: err.message || 'Error resetting session' });
  } finally {
    client.release();
  }
});

// Query DB endpoint for test assertions (SELECT + UPDATE for test setup)
router.post('/query-db', async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const { sql, params } = req.body;
  if (!sql || typeof sql !== 'string') {
    res.status(400).json({ error: 'Missing sql' });
    return;
  }
  // Safety: only allow SELECT, UPDATE and INSERT (test seeding for plans,
  // settings, etc.). DELETE / DROP / TRUNCATE / ALTER stay blocked.
  const trimmed = sql.trim().toLowerCase();
  if (!trimmed.startsWith('select') && !trimmed.startsWith('update') && !trimmed.startsWith('insert')) {
    res.status(403).json({ error: 'Only SELECT, UPDATE and INSERT queries allowed' });
    return;
  }
  try {
    const result = await pool.query(sql, params || []);
    res.json({ rows: result.rows || [] });
  } catch (error: unknown) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

export default router;
