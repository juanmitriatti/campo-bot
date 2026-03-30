import express from 'express';
import type { Request, Response } from 'express';
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
import { PendingFieldCityStore } from '../middleware/pending-field-city.js';
import { PendingPlotAreaStore } from '../middleware/pending-plot-area.js';
import { LearningService } from '../domain/learning/learning.service.js';
import { ContextResolver } from '../domain/learning/context-resolver.js';
import { FeatureGate } from '../domain/billing/feature-gate.js';
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
import { getSuggestions, resolveSuggestionKey } from '../middleware/contextual-suggestions.js';
import { enrichWithContext } from '../middleware/context-reuse.js';
import { getOrCreateUserByTelegramId, updateConversationMiniMemory } from '../services/expenses.js';
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
import { isLikelyQuestion } from '../utils/guards.js';
import { saveObservation, SAVE_REJECTED_DUPLICATE } from '../services/observations.js';
import { PlotDiscoveryService } from '../domain/plots/plot-discovery.service.js';
import { formatObservationResponse } from '../middleware/response-formatter.js';
import { createSpeechProvider } from '../services/audio/providers/provider-factory.js';
import {
  sendTelegramMessage,
  sendTelegramButtons,
  sendTelegramList,
  sendTelegramDocument,
  answerCallbackQuery,
  downloadTelegramFile,
} from '../services/telegram.js';
import type { ParsedExpense, ParsedIncome, HandlerResponse, Intent, FlowState, ParseResult, InteractiveButton, InteractiveListSection, UserId } from '../types/index.js';
import { asUserId } from '../types/index.js';
import type { SpeechToTextProvider } from '../services/audio/providers/speech-provider.interface.js';

// --- Response item type (same as test-bot) ---

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

// --- Wire up dependencies (separate instances from webhook/test-bot) ---

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
const dedup = new MessageDedup();

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
const intentClassifier = new IntentClassifier(undefined, undefined, intentExtractor, agentService, agentResponseMapper);
const conversationalFallback = new ConversationalFallbackService(userRepository);

const pendingStore = new PendingTransactionStore();
const pendingObsStore = new PendingObservationStore();
const pendingCityStore = new PendingFieldCityStore();
const pendingPlotAreaStore = new PendingPlotAreaStore();
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

// --- Telegram-specific key for in-memory stores ---

function tgPhone(chatId: string | number): string {
  return `tg_${chatId}`;
}

// --- Helper functions (same as test-bot) ---

function buildNoFieldsBlockItems(actionLabel: string): BotResponseItem[] {
  return [
    { type: 'text', text: `Para ${actionLabel} primero necesitás crear un campo.\n\n📍 Escribí *agregar campo [nombre]*` },
    interactiveButtonsItem(`Necesitás un campo para ${actionLabel}.`, [
      { id: 'cmd_agregar_campo', title: 'Crear Campo' },
    ]),
  ];
}

function buildNoPlotBlockItems(actionLabel: string, fieldName: string): BotResponseItem[] {
  return [
    { type: 'text', text: `Para ${actionLabel} necesitás al menos un lote.\n\n📍 Escribí *agregar lote [nombre] en campo ${fieldName}*` },
    interactiveButtonsItem(`Necesitás un lote para ${actionLabel}.`, [
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

// --- Convert HandlerResponse → BotResponseItem[] ---

function collectResponse(response: HandlerResponse): BotResponseItem[] {
  const items: BotResponseItem[] = [];

  for (const msg of response.messages) {
    items.push({ type: 'text', text: msg });
  }

  if (response.attachment) {
    // We'll handle attachments as documents in sendBotResponse
    items.push({ type: 'text', text: `__attachment__:${response.attachment.filename}`, ...({ _attachment: response.attachment } as any) });
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

function interactiveButtonsItem(body: string, buttons: InteractiveButton[]): BotResponseItem {
  return {
    type: 'interactive',
    interactive: { type: 'buttons', body, buttons },
  };
}

// --- Send bot response items via Telegram ---

async function sendBotResponse(chatId: string | number, items: BotResponseItem[]): Promise<void> {
  for (const item of items) {
    try {
      if (item.type === 'text' && item.text) {
        // Check for attachment marker
        const attachment = (item as any)._attachment;
        if (attachment?.buffer) {
          await sendTelegramDocument(chatId, attachment.buffer, attachment.filename, attachment.caption);
        } else if (!item.text.startsWith('__attachment__:')) {
          await sendTelegramMessage(chatId, item.text);
        }
      } else if (item.type === 'interactive' && item.interactive) {
        if (item.interactive.type === 'buttons' && item.interactive.buttons) {
          await sendTelegramButtons(chatId, item.interactive.body, item.interactive.buttons);
        } else if (item.interactive.type === 'list' && item.interactive.sections) {
          await sendTelegramList(chatId, item.interactive.body, item.interactive.sections);
        }
      }
    } catch (err) {
      console.error('[telegram] Error sending response item:', err);
    }
  }
}

// --- Router ---

const router = express.Router();

// POST /telegram — Telegram webhook
router.post('/', async (req: Request, res: Response) => {
  // Telegram expects 200 quickly; process async
  res.sendStatus(200);

  const startTime = Date.now();
  try {
    const update = req.body;

    // --- Callback query (button press) ---
    if (update.callback_query) {
      const cbQuery = update.callback_query;
      const chatId = cbQuery.message?.chat?.id;
      const callbackId = cbQuery.data;

      if (!chatId || !callbackId) return;

      // Dedup on callback query id
      if (dedup.isDuplicate(`cb_${cbQuery.id}`)) return;

      // Acknowledge button press
      answerCallbackQuery(cbQuery.id).catch(() => {});

      // Ignore noop (section titles)
      if (callbackId === 'noop') return;

      const phone = tgPhone(chatId);
      const userRow = await getOrCreateUserByTelegramId(String(chatId), cbQuery.from?.first_name);
      const userId = asUserId(userRow.id);
      const user = {
        id: userId,
        phone_number: userRow.phone_number || phone,
        name: userRow.name ?? null,
        city: userRow.city ?? null,
      };
      const settings = await userRepository.getSettings(userId);

      const items = await handleInteractiveReply(callbackId, userId, user, settings, phone, startTime);
      await sendBotResponse(chatId, items);
      return;
    }

    // --- Text message ---
    const message = update.message;
    if (!message) return;

    const chatId = message.chat?.id;
    if (!chatId) return;

    // Dedup on update_id
    if (dedup.isDuplicate(String(update.update_id))) return;

    const phone = tgPhone(chatId);
    const userRow = await getOrCreateUserByTelegramId(String(chatId), message.from?.first_name);
    const userId = asUserId(userRow.id);
    const user = {
      id: userId,
      phone_number: userRow.phone_number || phone,
      name: userRow.name ?? null,
      city: userRow.city ?? null,
    };
    const settings = await userRepository.getSettings(userId);

    // --- Voice/audio message ---
    if (message.voice || message.audio) {
      const fileId = message.voice?.file_id || message.audio?.file_id;
      if (fileId) {
        try {
          const buffer = await downloadTelegramFile(fileId);
          const provider = createSpeechProvider() as SpeechToTextProvider;
          const result = await provider.transcribe(buffer, 'audio/ogg');
          let transcript = result.text;
          transcript = normalizeTranscript(transcript);
          console.log('[telegram] AUDIO TRANSCRIBED:', transcript);

          if (transcript.trim()) {
            const items = await processTextMessage(transcript, userId, user, settings, phone, startTime);
            await sendBotResponse(chatId, items);
          }
        } catch (err) {
          console.error('[telegram] Audio error:', err);
          await sendTelegramMessage(chatId, 'No pude entender el audio. Intentá de nuevo.');
        }
      }
      return;
    }

    // --- Text ---
    let text = message.text || '';

    // Handle /start command
    if (text === '/start') {
      text = 'hola';
    } else if (text.startsWith('/')) {
      // Strip leading slash for other commands (e.g., /menu → menu)
      text = text.slice(1);
    }

    if (!text.trim()) return;

    const items = await processTextMessage(text.trim(), userId, user, settings, phone, startTime);
    await sendBotResponse(chatId, items);
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[telegram] ERROR:', err.stack || err.message);
  }
});

// --- Interactive reply handler (same logic as test-bot) ---

async function handleInteractiveReply(
  callbackId: string,
  userId: UserId,
  user: any,
  settings: any,
  phone: string,
  startTime: number,
): Promise<BotResponseItem[]> {
  console.log('[telegram] INTERACTIVE:', callbackId);

  conversationObserver.logMessageReceived(userId, { phone, messageType: 'interactive', messageLength: callbackId.length });

  // --- Flow callbacks ---
  if (callbackId.startsWith('flow_')) {
    const flowCtx = await conversationEngine.getFlowContext(userId);

    if (callbackId === 'flow_confirm') {
      const result = await conversationEngine.executeConfirm(userId, flowCtx);
      if (result.response.sideEffects?.setFieldDuplicate) {
        const dup = result.response.sideEffects.setFieldDuplicate;
        pendingStore.set(phone, {
          type: 'expense', data: { type: 'expense', amount: 0, category: '', description: '', currency: 'ARS' },
          fieldId: null, fieldName: null, plotId: null, plotName: null,
          timestamp: Date.now(), _fieldDuplicate: dup,
        } as any);
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
      if (['expense_flow', 'income_flow', 'rainfall_flow', 'activity_flow'].includes(flowName)) {
        const prereq = await hasNoPrerequisites(userId);
        if (prereq.blocked) return prereq.items!;
      }
      const result = await conversationEngine.startFlow(userId, flowName as FlowState);
      return collectResponse(result.response);
    }
    // flow_cat_, flow_field_, flow_plot_, flow_activity_ → feed into flow
    const prefixes = ['flow_cat_', 'flow_field_', 'flow_plot_', 'flow_activity_'] as const;
    for (const prefix of prefixes) {
      if (callbackId.startsWith(prefix)) {
        let value = callbackId.replace(prefix, '');
        if (prefix === 'flow_plot_') {
          const doubleSepIdx = value.indexOf('__');
          if (doubleSepIdx > 0) {
            const fieldHint = value.slice(0, doubleSepIdx).replace(/_/g, ' ');
            value = value.slice(doubleSepIdx + 2).replace(/_/g, ' ');
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
    return [{ type: 'text', text: '\u274c Operacion cancelada.' }];
  }

  // --- Confirm pending financial transaction ---
  if (callbackId === 'confirm_pending') {
    const pendingTx = pendingStore.get(phone);
    if (!pendingTx) {
      return [{ type: 'text', text: 'No hay nada pendiente para confirmar.' }];
    }
    pendingStore.clear(phone);
    const response = await financialHandler.handleConfirm(userId, pendingTx, settings, user);
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
      const prefill: Record<string, unknown> = {};
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
          messages: [`📍 Lote *${plot.name}* creado en campo *${field.name}*`],
          suggestionKey: 'plot_created',
        };
        return collectResponse(response);
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

  // --- Generic interactive routing ---
  const intent = interactiveRouter.route(callbackId);
  if (intent && intent.type === 'command') {
    const response = await domainRouter.routeCommand(intent.data, userId, user, settings);
    if (response) return collectResponse(response);
  }
  return [];
}

// --- Main text message pipeline (same logic as test-bot) ---

async function processTextMessage(
  text: string,
  userId: UserId,
  user: any,
  settings: any,
  phone: string,
  startTime: number,
): Promise<BotResponseItem[]> {
  console.log('[telegram] TEXT:', text);

  pool.query('UPDATE users SET last_message_at = NOW() WHERE id = $1', [userId]).catch(() => {});

  const sessionId = `tg_${userId}_${new Date().toISOString().slice(0, 10)}`;
  conversationObserver.logMessageReceived(userId, { phone, messageType: 'text', messageLength: text.length }, sessionId);

  // --- Check active conversation flow ---
  const flowCtx = await conversationEngine.getFlowContext(userId);

  if (flowCtx.state !== 'idle') {
    if (conversationEngine.isExpired(flowCtx)) {
      await conversationEngine.clearFlow(userId);
    } else {
      const guardResult = await conversationEngine.validateFlowState(userId, flowCtx);
      if (guardResult) {
        return collectResponse(guardResult.response);
      }

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

      const interruptCmd = intentClassifier.parseCommandOnly(text);
      const isFlowNameStep = flowCtx.state === 'field_flow' && flowCtx.step === 0;
      const effectiveCmd = (isFlowNameStep && interruptCmd?.command === 'field_info') ? null : interruptCmd;
      if (effectiveCmd && SAFE_INTERRUPTION_COMMANDS.has(effectiveCmd.command)) {
        if (effectiveCmd.command === 'greeting' || effectiveCmd.command === 'thanks') {
          const reprompt = await conversationEngine.getCurrentStepPrompt(flowCtx, userId);
          if (reprompt) return collectResponse(reprompt);
          return [];
        }
        const cmdItems: BotResponseItem[] = [];
        const cmdResponse = await domainRouter.routeCommand(effectiveCmd, userId, user, settings);
        if (cmdResponse) cmdItems.push(...collectResponse(cmdResponse));
        const reprompt = await conversationEngine.getCurrentStepPrompt(flowCtx, userId);
        if (reprompt) cmdItems.push(...collectResponse(reprompt));
        return cmdItems;
      }

      if (isLikelyQuestion(text)) {
        const reprompt = await conversationEngine.getCurrentStepPrompt(flowCtx, userId);
        const items: BotResponseItem[] = [
          { type: 'text', text: 'Estás en medio de un registro. Escribí *cancelar* si querés salir y preguntar.' },
        ];
        if (reprompt) items.push(...collectResponse(reprompt));
        return items;
      }

      if (effectiveCmd || intentClassifier.detectsFinancialIntent(text)) {
        await conversationEngine.clearFlow(userId);
      } else {
        const result = await conversationEngine.processFlowMessage(userId, text, flowCtx);
        if (result.nextContext) {
          await conversationEngine.setFlowContext(userId, result.nextContext);
        } else {
          await conversationEngine.clearFlow(userId);
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
    let city = text.trim()
      .replace(/^(?:esta|está|queda|ubicad[oa])\s+(?:en\s+)?/i, '')
      .replace(/^en\s+/i, '')
      .trim();
    city = city.charAt(0).toUpperCase() + city.slice(1);
    await financialService.setFieldCity(userId, pendingCity.fieldName, city);
    pendingCityStore.clear(phone);
    return [{ type: 'text', text: `📍 Campo *${pendingCity.fieldName}* ubicado en *${city}*` }];
  }

  // --- Check pending plot area assignment ---
  const pendingArea = pendingPlotAreaStore.get(phone);
  if (pendingArea) {
    if (isCancelIntent(text)) {
      pendingPlotAreaStore.clear(phone);
      return [{ type: 'text', text: '👍 Podés asignar las hectáreas después.' }];
    }
    const hectares = parseFloat(text.replace(/,/g, '.').replace(/\s*ha\s*/i, '').trim());
    if (!isNaN(hectares) && hectares > 0 && hectares < 100000) {
      await financialService.setPlotArea(pendingArea.plotId, hectares);
      pendingPlotAreaStore.clear(phone);
      return [{ type: 'text', text: `📍 Lote *${pendingArea.plotName}*: superficie actualizada a *${hectares} ha*` }];
    }
    pendingPlotAreaStore.clear(phone);
  }

  // --- Check pending observation ---
  const pendingObs = pendingObsStore.get(phone);
  if (pendingObs) {
    if (isCancelIntent(text)) {
      pendingObsStore.clear(phone);
      return [{ type: 'text', text: '\u274c Observacion cancelada.' }];
    }
    const obsInterruptCmd = intentClassifier.parseCommandOnly(text);
    if (obsInterruptCmd || intentClassifier.detectsFinancialIntent(text)) {
      pendingObsStore.clear(phone);
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
      const plotList = userPlots.map((p: any) => `\u2022 ${p.name} (${p.field_name})`).join('\n');
      return [{ type: 'text', text: `No encontre ese lote. \u00bfEn que lote?\n\nTus lotes:\n${plotList}` }];
    }
  }

  // --- Check pending confirmation ---
  const pending = pendingStore.get(phone);

  const lowConfidenceThreshold = (await getSettingNumber('CONFIDENCE_LOW_CONFIRM')) ?? 0.70;
  const unknownFallbackThreshold = (await getSettingNumber('CONFIDENCE_UNKNOWN_FALLBACK')) ?? 0.50;

  await enrichWithContext(text, userId);

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

  const intentCommand = rawIntent.type === 'command' ? rawIntent.data.command : null;
  conversationObserver.logIntentDetected(userId, rawIntent.type, intentCommand, confidence, parseResult.source, { aiUsed, missingFields: parseResult.missingFields.length > 0 ? parseResult.missingFields : undefined });

  const intent: Intent = await contextResolver.enrichIntent(userId, text, rawIntent);

  // Handle confirm/cancel for pending
  if (intent.type === 'command' && intent.data.command === 'confirm') {
    if (!pending) {
      return [{ type: 'text', text: 'No hay nada pendiente para confirmar.' }];
    }
    pendingStore.clear(phone);
    const response = await financialHandler.handleConfirm(userId, pending, settings, user);
    conversationLogger.log(userId, phone, text, response.messages[0] ?? null, 'command', 'confirm', null, null, aiUsed, Date.now() - startTime, false, confidence).catch(() => {});
    return collectResponse(response);
  }
  if (intent.type === 'command' && intent.data.command === 'cancel') {
    if (!pending) {
      return [{ type: 'text', text: 'No hay nada pendiente para cancelar.' }];
    }
    pendingStore.clear(phone);
    conversationLogger.log(userId, phone, text, 'Operacion cancelada.', 'command', 'cancel', null, null, aiUsed, Date.now() - startTime, false, confidence).catch(() => {});
    return [{ type: 'text', text: '\u274c Operacion cancelada.' }];
  }

  if (pending) pendingStore.clear(phone);

  // --- Partial parse → flow ---
  if (intent.type === 'expense_partial') {
    { const prereq = await hasNoPrerequisites(userId); if (prereq.blocked) return prereq.items!; }
    const hasExpenses = await featureGate.hasFeature(userId, 'expenses');
    if (!hasExpenses) {
      return [{ type: 'text', text: '🔒 El registro de gastos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
    }
    const prefillData: Record<string, unknown> = {};
    if (intent.data.amount) prefillData.amount = intent.data.amount;
    if (intent.data.currency) prefillData.currency = intent.data.currency;
    if (intent.data.category) prefillData.category = intent.data.category;
    const result = await conversationEngine.startFlow(userId, 'expense_flow', prefillData);
    conversationLogger.log(userId, phone, text, result.response.messages[0] ?? null, 'flow', 'expense_partial', 'expense_flow', 0, aiUsed, Date.now() - startTime, !!result.response.interactive, confidence).catch(() => {});
    return collectResponse(result.response);
  }

  if (intent.type === 'income_partial') {
    { const prereq = await hasNoPrerequisites(userId); if (prereq.blocked) return prereq.items!; }
    const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
    if (!hasIncomes) {
      return [{ type: 'text', text: '🔒 El registro de ingresos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
    }
    const prefillData: Record<string, unknown> = {};
    if (intent.data.amount) prefillData.amount = intent.data.amount;
    if (intent.data.currency) prefillData.currency = intent.data.currency;
    if (intent.data.category) prefillData.category = intent.data.category;
    const result = await conversationEngine.startFlow(userId, 'income_flow', prefillData);
    conversationLogger.log(userId, phone, text, result.response.messages[0] ?? null, 'flow', 'income_partial', 'income_flow', 0, aiUsed, Date.now() - startTime, !!result.response.interactive, confidence).catch(() => {});
    return collectResponse(result.response);
  }

  // --- Ambiguous → disambiguation buttons ---
  if (intent.type === 'ambiguous') {
    const buttons = intent.candidates.slice(0, 3).map((c, i) => ({
      id: `disambig_${i}`,
      title: c.label.slice(0, 20),
    }));
    conversationLogger.log(userId, phone, text, 'Disambiguation', 'ambiguous', null, null, null, aiUsed, Date.now() - startTime, true, confidence).catch(() => {});
    return [interactiveButtonsItem('\u00bfQue queres hacer?', buttons)];
  }

  // --- Route commands ---
  if (intent.type === 'command') {
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
      return [interactiveButtonsItem(
        `\u00bfSeguro que queres ${label}?\nEsto no se puede deshacer.`,
        [
          { id: `confirm_destructive_${intent.data.command}`, title: 'Confirmar' },
          { id: 'cancel_destructive', title: 'Cancelar' },
        ],
      )];
    }

    intent.data.originalText = text;

    const response = await domainRouter.routeCommand(intent.data, userId, user, settings);
    if (response) {
      if (response.messages.length === 0 && !response.attachment && !response.interactive) {
        response.messages = ['No pude procesar ese comando. Escribi *ayuda* para ver las opciones.'];
      }
      response.suggestionKey = resolveSuggestionKey(intent.data.command, response.suggestionKey);
      if (response.sideEffects?.startFlow) {
        const { state, data } = response.sideEffects.startFlow;
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
      if (response.sideEffects?.setPendingFieldCity) {
        pendingCityStore.set(phone, {
          fieldName: response.sideEffects.setPendingFieldCity.fieldName,
          timestamp: Date.now(),
        });
      }
      if (response.sideEffects?.setPendingPlotArea) {
        const pa = response.sideEffects.setPendingPlotArea;
        pendingPlotAreaStore.set(phone, {
          plotId: pa.plotId, plotName: pa.plotName, fieldName: pa.fieldName,
          timestamp: Date.now(),
        });
      }
      if (response.sideEffects?.setFieldDuplicate) {
        const dup = response.sideEffects.setFieldDuplicate;
        pendingStore.set(phone, {
          type: 'expense', data: { type: 'expense', amount: 0, category: '', description: '', currency: 'ARS' },
          fieldId: null, fieldName: null, plotId: null, plotName: null,
          timestamp: Date.now(), _fieldDuplicate: dup,
        } as any);
      }
      learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
      updateConversationMiniMemory(userId, {
        lastIntent: intent.data.command,
        lastActivityType: (intent.data.activityFilter as string) ?? (intent.data.activityType as string) ?? null,
        lastQueryType: intent.data.command.startsWith('query_') ? intent.data.command : null,
        lastTimeReference: (intent.data.timeLabel as string) ?? null,
      }).catch(() => {});
      conversationLogger.log(userId, phone, text, response.messages[0] ?? null, 'command', intent.data.command, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence).catch(() => {});
      return collectResponse(response);
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
    if (response.sideEffects?.setPending) {
      pendingStore.set(phone, response.sideEffects.setPending);
    }
    learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
    updateConversationMiniMemory(userId, { lastIntent: 'expense' }).catch(() => {});
    conversationLogger.log(userId, phone, text, response.messages[0] ?? null, 'expense', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence).catch(() => {});
    return collectResponse(response);
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
    if (response.sideEffects?.setPending) {
      pendingStore.set(phone, response.sideEffects.setPending);
    }
    learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
    updateConversationMiniMemory(userId, { lastIntent: 'income' }).catch(() => {});
    conversationLogger.log(userId, phone, text, response.messages[0] ?? null, 'income', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence).catch(() => {});
    return collectResponse(response);
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

export default router;
