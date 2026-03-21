import express from 'express';
import type { Request, Response } from 'express';
import { sendMessage, uploadMedia, sendDocument, sendInteractiveButtons, sendInteractiveList } from '../services/whatsapp.js';
import { IntentClassifier } from '../services/intent-classifier.js';
import { DomainRouter } from '../domain/router.js';
import { InteractiveRouter } from '../domain/interactive/interactive.router.js';
import { FinancialHandler } from '../domain/financial/financial.handler.js';
import { FinancialService } from '../domain/financial/financial.service.js';
import { FinancialRepository } from '../domain/financial/financial.repository.js';
import { AgronomyHandler } from '../domain/agronomy/agronomy.handler.js';
import { AgronomyRepository } from '../domain/agronomy/agronomy.repository.js';
import { SystemHandler } from '../domain/system/system.handler.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { MessageDedup } from '../middleware/dedup.js';
import { PendingTransactionStore } from '../middleware/pending-transactions.js';
import { PendingObservationStore } from '../middleware/pending-observations.js';
import { LearningService } from '../domain/learning/learning.service.js';
import { ContextResolver } from '../domain/learning/context-resolver.js';
import { FeatureGate } from '../domain/billing/feature-gate.js';
import { TranscriptionService, AudioTooLongError } from '../services/audio/transcription.service.js';
import { getAudioConfig } from '../services/audio/audio.types.js';
import { saveAudioTranscriptionLog, getHourlyAudioCount } from '../services/expenses.js';
import { getSettingNumber } from '../services/settings.service.js';
import { pool } from '../config/db.js';
import { ConversationStateRepository } from '../middleware/conversation-state.repository.js';
import { ConversationEngine } from '../middleware/conversation-engine.js';
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
import { ConversationalFallbackService } from '../ai/conversational-fallback.service.js';
import { normalizeTranscript } from '../utils/text-normalizer.js';
import { saveObservation, SAVE_REJECTED_DUPLICATE } from '../services/observations.js';
import { PlotDiscoveryService } from '../domain/plots/plot-discovery.service.js';
import { formatObservationResponse } from '../middleware/response-formatter.js';
import type { ParsedExpense, ParsedIncome, HandlerResponse, Intent, FlowState, ParseResult } from '../types/index.js';

// --- Wire up dependencies ---

const financialRepository = new FinancialRepository();
const financialService = new FinancialService(financialRepository);
const userRepository = new UserRepository();

const financialHandler = new FinancialHandler(financialService);
const agronomyRepository = new AgronomyRepository();
const agronomyHandler = new AgronomyHandler(agronomyRepository);
const systemHandler = new SystemHandler(userRepository);

const featureGate = new FeatureGate();
const domainRouter = new DomainRouter(financialHandler, agronomyHandler, systemHandler, featureGate);
const interactiveRouter = new InteractiveRouter();

// --- AI Intent Extraction ---
const entityValidator = new EntityValidator();
const userContextService = new UserContextService(entityValidator);
const promptBuilder = new PromptBuilder();
const intentValidator = new IntentValidator();
const intentExtractor = new IntentExtractor(promptBuilder, intentValidator, userContextService, userRepository);
const intentClassifier = new IntentClassifier(undefined, undefined, intentExtractor);
const conversationalFallback = new ConversationalFallbackService(userRepository);

const dedup = new MessageDedup();
const pendingStore = new PendingTransactionStore();
const pendingObsStore = new PendingObservationStore();
const plotDiscovery = new PlotDiscoveryService();
const learningService = new LearningService();
const contextResolver = new ContextResolver();
const transcriptionService = new TranscriptionService();

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

// Destructive commands that require confirmation (delete_field/delete_plot handled by their own handler)
const DESTRUCTIVE_COMMANDS = new Set([
  'delete_last', 'delete_last_income', 'delete_specific',
]);

// Safe interruption commands: read-only commands that can be answered mid-flow without canceling

const DEFAULT_MAX_AUDIO_PER_HOUR = 10;

const SAFE_INTERRUPTION_COMMANDS = new Set([
  'list_fields', 'list_plots', 'field_info', 'help', 'menu',
  'weather_full', 'monthly_report', 'weekly_report', 'rainfall_report',
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
  for (const msg of response.messages) {
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
            await sendResponse(phone, result.response);
            conversationLogger.log(userId, phone, '[confirm]', result.response.messages[0] ?? null, 'flow', 'flow_confirm', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
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
            conversationLogger.log(userId, phone, '[skip]', result.response.messages[0] ?? null, 'flow', 'flow_skip', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
          } else if (callbackId === 'flow_back') {
            const result = await conversationEngine.goBack(userId, flowCtx);
            if (result.nextContext) {
              await conversationEngine.setFlowContext(userId, result.nextContext);
            }
            await sendResponse(phone, result.response);
            conversationLogger.log(userId, phone, '[back]', result.response.messages[0] ?? null, 'flow', 'flow_back', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
          } else if (callbackId.startsWith('flow_new_')) {
            // Start a new flow: flow_new_expense → expense_flow
            const flowName = callbackId.replace('flow_new_', '') + '_flow';
            const result = await conversationEngine.startFlow(userId, flowName as FlowState);
            conversationObserver.logFlowStarted(userId, flowName, { trigger: 'interactive_button' });
            await sendResponse(phone, result.response);
            conversationLogger.log(userId, phone, `[start:${flowName}]`, result.response.messages[0] ?? null, 'flow', 'flow_start', flowName, 0, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
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
              conversationLogger.log(userId, phone, `[cat:${value}]`, result.response.messages[0] ?? null, 'flow', 'flow_cat', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
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
              conversationLogger.log(userId, phone, `[field:${value}]`, result.response.messages[0] ?? null, 'flow', 'flow_field', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
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
              conversationLogger.log(userId, phone, `[activity:${value}]`, result.response.messages[0] ?? null, 'flow', 'flow_activity', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
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
              conversationLogger.log(userId, phone, `[confirm_destructive]`, response.messages[0] ?? null, 'command', pendingAction._destructiveCommand.command, null, null, false, Date.now() - startTime, !!response.interactive).catch(() => {});
            }
          }
          res.sendStatus(200);
          return;
        }

        if (callbackId === 'cancel_destructive') {
          pendingStore.clear(phone);
          await sendMessage(phone, '\u274c Operaci\u00f3n cancelada.');
          res.sendStatus(200);
          return;
        }

        // --- Cancel action (field/plot delete confirmation) ---
        if (callbackId === 'cancel_action') {
          await sendMessage(phone, '\u274c Operaci\u00f3n cancelada.');
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

        // --- Existing interactive routing ---
        const intent = interactiveRouter.route(callbackId);
        if (intent && intent.type === 'command') {
          const user = await userRepository.getOrCreate(phone);
          const settings = await userRepository.getSettings(user.id);
          const response = await domainRouter.routeCommand(intent.data, user.id, user, settings);
          if (response) {
            await sendResponse(phone, response);
            conversationLogger.log(user.id, phone, `[interactive:${callbackId}]`, response.messages[0] ?? null, 'command', intent.data.command, null, null, false, Date.now() - startTime, !!response.interactive).catch(() => {});
          }
        }
        res.sendStatus(200);
        return;
      }
    }

    // --- Audio message handling ---
    if (!text && message.type === 'audio' && message.audio?.id) {
      const user = await userRepository.getOrCreate(phone);
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
        }
      } catch (err: unknown) {
        const error = err as Error;
        console.error('[audio] error:', error.message);
        if (err instanceof AudioTooLongError) {
          await sendMessage(phone, '\u26a0\ufe0f El audio es demasiado largo. Envi\u00e1 un audio m\u00e1s corto o escrib\u00ed el mensaje.');
        } else {
          await sendMessage(phone, 'No pude entender el audio. \u00bfPodr\u00edas escribirlo o enviar otro audio?');
        }
        res.sendStatus(200);
        return;
      }
    }

    if (!text) {
      res.sendStatus(200);
      return;
    }

    console.log('FROM:', phone, 'TEXT:', text);

    // Get user and settings
    const user = await userRepository.getOrCreate(phone);
    const userId = user.id;
    const settings = await userRepository.getSettings(userId);
    const sessionId = `${phone}_${new Date().toISOString().slice(0, 10)}`;
    const messageType = message.type === 'audio' ? 'audio' : 'text';
    conversationObserver.logMessageReceived(userId, { phone, messageType, messageLength: text.length }, sessionId);

    // Track last activity for user management
    pool.query('UPDATE users SET last_message_at = NOW() WHERE id = $1', [userId]).catch(() => {});

    // --- Check active conversation flow ---
    const flowCtx = await conversationEngine.getFlowContext(userId);

    if (flowCtx.state !== 'idle') {
      if (conversationEngine.isExpired(flowCtx)) {
        const durationMs = flowCtx.startedAt ? Date.now() - new Date(flowCtx.startedAt).getTime() : undefined;
        conversationObserver.logFlowAbandoned(userId, flowCtx.state, flowCtx.step, 'expired', { durationMs, filledFields: Object.keys(flowCtx.data) });
        conversationLogger.logError(userId, 'flow_expired', 'Flow expired, clearing state', text, flowCtx.state, flowCtx.step).catch(() => {});
        await conversationEngine.clearFlow(userId);
        // Fall through to normal processing
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
          conversationLogger.log(userId, phone, text, result.response.messages[0] ?? null, 'flow', 'back', flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
          res.sendStatus(200);
          return;
        }

        // Smart interruption: check if the user typed a safe read-only command mid-flow
        const interruptCmd = intentClassifier.parseCommandOnly(text);
        if (interruptCmd && SAFE_INTERRUPTION_COMMANDS.has(interruptCmd.command)) {
          // Execute the command without canceling the flow
          const cmdResponse = await domainRouter.routeCommand(interruptCmd, userId, user, settings);
          if (cmdResponse) {
            await sendResponse(phone, cmdResponse);
          }
          // Re-prompt the current flow step so the user knows the flow is still active
          const reprompt = await conversationEngine.getCurrentStepPrompt(flowCtx, userId);
          if (reprompt) {
            await sendResponse(phone, reprompt);
          }
          conversationLogger.log(userId, phone, text, cmdResponse?.messages[0] ?? null, 'command', interruptCmd.command, flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!(cmdResponse?.interactive)).catch(() => {});
          res.sendStatus(200);
          return;
        }

        // Process within active flow
        const result = await conversationEngine.processFlowMessage(userId, text, flowCtx);
        if (result.nextContext) {
          await conversationEngine.setFlowContext(userId, result.nextContext);
        } else {
          await conversationEngine.clearFlow(userId);
        }
        await sendResponse(phone, result.response);
        conversationLogger.log(userId, phone, text, result.response.messages[0] ?? null, 'flow', null, flowCtx.state, flowCtx.step, false, Date.now() - startTime, !!result.response.interactive).catch(() => {});
        res.sendStatus(200);
        return;
      }
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
      const plotList = userPlots.map(p => `• ${p.name} (${p.field_name})`).join('\n');
      await sendMessage(phone, `No encontré ese lote. ¿En qué lote?\n\nTus lotes:\n${plotList}`);
      console.log(`[PENDING_OBS] Could not resolve plot from "${text}", asking again for user ${userId}`);
      res.sendStatus(200);
      return;
    }

    // --- Check pending confirmation first ---
    const pending = pendingStore.get(phone);

    // Load confidence thresholds from settings (cached 5 min)
    const lowConfidenceThreshold = (await getSettingNumber('CONFIDENCE_LOW_CONFIRM')) ?? 0.70;
    const unknownFallbackThreshold = (await getSettingNumber('CONFIDENCE_UNKNOWN_FALLBACK')) ?? 0.50;

    // Check for follow-up context before classification
    const enriched = await enrichWithContext(text, userId);

    // Classify intent (now returns ParseResult with confidence)
    const parseResult: ParseResult = await intentClassifier.classify(text, userId, settings);
    const { intent: rawIntent, aiUsed, confidence } = parseResult;
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
        res.sendStatus(200);
        return;
      }
      pendingStore.clear(phone);
      const response = await financialHandler.handleConfirm(userId, pending, settings, user);
      await sendResponse(phone, response);
      conversationLogger.log(userId, phone, text, response.messages[0] ?? null, 'command', 'confirm', null, null, aiUsed, Date.now() - startTime).catch(() => {});
      res.sendStatus(200);
      return;
    }

    if (intent.type === 'command' && intent.data.command === 'cancel') {
      if (!pending) {
        await sendMessage(phone, 'No hay nada pendiente para cancelar.');
        res.sendStatus(200);
        return;
      }
      pendingStore.clear(phone);
      await sendMessage(phone, '\u274c Operaci\u00f3n cancelada.');
      conversationLogger.log(userId, phone, text, 'Operaci\u00f3n cancelada.', 'command', 'cancel', null, null, aiUsed, Date.now() - startTime).catch(() => {});
      res.sendStatus(200);
      return;
    }

    // If there was a pending but user sent something else, clear it
    if (pending) {
      pendingStore.clear(phone);
    }

    // --- Handle partial parse → redirect to conversation flow ---
    if (intent.type === 'expense_partial') {
      const hasExpenses = await featureGate.hasFeature(userId, 'expenses');
      if (!hasExpenses) {
        await sendMessage(phone, '\ud83d\udd12 El registro de gastos no est\u00e1 disponible en tu plan actual.\n\nEscrib\u00ed *plan* para ver las opciones.');
        res.sendStatus(200);
        return;
      }
      const prefillData: Record<string, unknown> = {};
      if (intent.data.amount) prefillData.amount = intent.data.amount;
      if (intent.data.currency) prefillData.currency = intent.data.currency;
      if (intent.data.category) prefillData.category = intent.data.category;
      const result = await conversationEngine.startFlow(userId, 'expense_flow', prefillData);
      conversationObserver.logFlowStarted(userId, 'expense_flow', { trigger: 'partial_parse', prefillFields: Object.keys(prefillData) });
      await sendResponse(phone, result.response);
      conversationLogger.log(userId, phone, text, result.response.messages[0] ?? null, 'flow', 'expense_partial', 'expense_flow', 0, aiUsed, Date.now() - startTime, !!result.response.interactive).catch(() => {});
      res.sendStatus(200);
      return;
    }

    if (intent.type === 'income_partial') {
      const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
      if (!hasIncomes) {
        await sendMessage(phone, '\ud83d\udd12 El registro de ingresos no est\u00e1 disponible en tu plan actual.\n\nEscrib\u00ed *plan* para ver las opciones.');
        res.sendStatus(200);
        return;
      }
      const prefillData: Record<string, unknown> = {};
      if (intent.data.amount) prefillData.amount = intent.data.amount;
      if (intent.data.currency) prefillData.currency = intent.data.currency;
      if (intent.data.category) prefillData.category = intent.data.category;
      const result = await conversationEngine.startFlow(userId, 'income_flow', prefillData);
      conversationObserver.logFlowStarted(userId, 'income_flow', { trigger: 'partial_parse', prefillFields: Object.keys(prefillData) });
      await sendResponse(phone, result.response);
      conversationLogger.log(userId, phone, text, result.response.messages[0] ?? null, 'flow', 'income_partial', 'income_flow', 0, aiUsed, Date.now() - startTime, !!result.response.interactive).catch(() => {});
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
      conversationLogger.log(userId, phone, text, 'Disambiguation', 'ambiguous', null, null, null, aiUsed, Date.now() - startTime, true).catch(() => {});
      res.sendStatus(200);
      return;
    }

    // --- Route commands ---
    if (intent.type === 'command') {
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
        conversationLogger.log(userId, phone, text, `Confirmación: ${label}`, 'command', intent.data.command, null, null, aiUsed, Date.now() - startTime, true).catch(() => {});
        res.sendStatus(200);
        return;
      }

      const response = await domainRouter.routeCommand(intent.data, userId, user, settings);
      if (response) {
        // Safety: ensure we never send an empty response (silent failure)
        if (response.messages.length === 0 && !response.attachment && !response.interactive) {
          console.warn(`[SILENT_FAILURE] Command "${intent.data.command}" returned empty response for user ${userId}`);
          response.messages = ['No pude procesar ese comando. Escribí *ayuda* para ver las opciones.'];
        }
        // Ensure every command gets a suggestion (no dead ends)
        response.suggestionKey = resolveSuggestionKey(intent.data.command, response.suggestionKey);
        // Store pending observation for plot disambiguation follow-up
        if (response.sideEffects?.setPendingObservation) {
          const obs = response.sideEffects.setPendingObservation;
          pendingObsStore.set(phone, { text: obs.text, category: obs.category, timestamp: Date.now() });
          console.log(`[PENDING_OBS] Stored pending observation for user ${userId}: "${obs.text}"`);
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
        conversationLogger.log(userId, phone, text, response.messages[0] ?? null, 'command', intent.data.command, null, null, aiUsed, Date.now() - startTime, !!response.interactive).catch(() => {});
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

      const claudeField = aiUsed ? (intent.data as ParsedExpense & { field?: string }).field : undefined;
      const response = await financialHandler.handleExpense(userId, intent.data, text, effectiveSettings, user, claudeField);
      if (response.sideEffects?.setPending) {
        pendingStore.set(phone, response.sideEffects.setPending);
      }
      // Learn from successful expense (fire-and-forget)
      learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
      await sendResponse(phone, response);
      conversationLogger.log(userId, phone, text, response.messages[0] ?? null, 'expense', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive).catch(() => {});
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

      const claudeField = aiUsed ? (intent.data as ParsedIncome & { field?: string }).field : undefined;
      const response = await financialHandler.handleIncome(userId, intent.data, text, effectiveSettings, claudeField);
      if (response.sideEffects?.setPending) {
        pendingStore.set(phone, response.sideEffects.setPending);
      }
      // Learn from successful income (fire-and-forget)
      learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
      await sendResponse(phone, response);
      conversationLogger.log(userId, phone, text, response.messages[0] ?? null, 'income', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive).catch(() => {});
      res.sendStatus(200);
      return;
    }

    // --- Unknown → Conversational fallback → Menu ---
    if (intent.type === 'unknown' || confidence < unknownFallbackThreshold) {
      await financialService.saveUnparsedMessage(userId, text);

      const fallbackResult = await conversationalFallback.respond(text, userId, settings);

      if (fallbackResult.aiUsed) {
        await sendMessage(phone, fallbackResult.response);
        conversationLogger.log(userId, phone, text, fallbackResult.response, 'conversational', null, null, null, true, Date.now() - startTime).catch(() => {});
      } else {
        // Rate limited or disabled — show menu
        await sendMessage(phone, fallbackResult.response);
        const menuResponse = await systemHandler.handleCommand({ command: 'menu' }, userId, user, settings);
        await sendResponse(phone, menuResponse);
        conversationObserver.logMenuOpened(userId, { trigger: 'unknown_fallback' });
        conversationLogger.log(userId, phone, text, fallbackResult.response, 'unknown', null, null, null, false, Date.now() - startTime, true).catch(() => {});
      }
    }

    res.sendStatus(200);
  } catch (error: unknown) {
    const err = error as Error & { response?: { data?: unknown } };
    console.error('ERROR:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

export default router;
