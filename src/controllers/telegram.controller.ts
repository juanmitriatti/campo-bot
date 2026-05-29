import express from 'express';
import type { Request, Response } from 'express';
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
import { MessageDedup } from '../middleware/dedup.js';
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
import { getSetting, getSettingNumber, getSettingBool } from '../services/settings.service.js';
import { ChannelVerificationService, VerificationError } from '../domain/auth/channel-verification.service.js';
import { pool } from '../config/db.js';
import { logError } from '../services/error-logger.js';
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
import { getOrCreateUserByTelegramId, updateConversationMiniMemory, saveAudioTranscriptionLog, getHourlyAudioCount } from '../services/expenses.js';
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
import { getAudioConfig } from '../services/audio/audio.types.js';
import {
  sendTelegramMessage,
  sendTelegramButtons,
  sendTelegramList,
  sendTelegramDocument,
  answerCallbackQuery,
  downloadTelegramFile,
} from '../services/telegram.js';
import { DocumentService, DocumentError } from '../domain/documents/document.service.js';
import { PendingDocumentStore } from '../middleware/pending-documents.js';
import { PendingDocumentUploadStore } from '../middleware/pending-document-upload.js';
import type { DocumentUploadIntent } from '../middleware/pending-document-upload.js';
import { formatExtractionSummary, buildSuggestedExpenses, buildPostExtractionButtons } from '../domain/documents/document.helpers.js';
import type { ParsedExpense, ParsedIncome, HandlerResponse, Intent, FlowState, ParseResult, InteractiveButton, InteractiveListSection, UserId, PendingTransaction } from '../types/index.js';
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
const intentClassifier = new IntentClassifier(undefined, undefined, intentExtractor, agentService, agentResponseMapper, userContextService);
const conversationalFallback = new ConversationalFallbackService(userRepository);

const pendingStore = new PendingTransactionStore();
const pendingObsStore = new PendingObservationStore();
const pendingActStore = new PendingActivityStore();
const pendingCityStore = new PendingFieldCityStore();
const pendingPlotAreaStore = new PendingPlotAreaStore();
const pendingStockEntryStore = new Map<string, Record<string, unknown>>();
const pendingStockDeductionStore = new Map<string, Record<string, unknown>>();
const documentServiceTg = new DocumentService();
const pendingDocumentStoreTg = new PendingDocumentStore();
const pendingDocUploadStoreTg = new PendingDocumentUploadStore();
const pendingFieldLocationStore = new PendingFieldLocationStore();
import { pendingCampaignCloseStore } from '../middleware/pending-campaign-close.js';
const plotDiscovery = new PlotDiscoveryService();
const learningService = new LearningService();
const contextResolver = new ContextResolver();

/**
 * Resolve field/plot for document expense saving.
 * Returns { fieldId, plotId } if auto-resolved, or { plots } if user must pick.
 */
async function resolveDocPlot(userId: UserId): Promise<
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
  // Check recent financial context
  const recent = await financialService.getRecentFinancialContext(userId);
  if (recent?.plotId) return { resolved: true, fieldId: recent.fieldId, plotId: recent.plotId };
  // Multiple plots, no recent context → user must pick
  return { resolved: false, plots: allPlots };
}

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
      // Critical: a failed sendTelegram* call here used to be COMPLETELY silent
      // (just console.error + logError). Result: the bot generated a response,
      // logged it in conversation_logs, but the user never saw anything. This
      // bit user 30 (Juan, May 27) when callback_data exceeded Telegram's
      // 64-byte limit on category-picker buttons — bot said "¿En qué
      // categoría?" in the admin panel but the user got nothing.
      //
      // Now we try to send a fallback plaintext message so the user at least
      // sees SOMETHING and isn't left in the dark. If even that fails, we
      // surface the original error to the user with a generic apology.
      const errAny = err as any;
      const errMsg = String(errAny?.message || err || 'unknown');
      console.error('[telegram] Error sending response item:', err, '— attempting fallback');
      logError('telegram', 'SEND_RESPONSE', err as Error, {
        context: { chatId, itemType: item.type, errMsg },
      });
      try {
        // Extract the body text if we have it, so the user at least sees the
        // message even without the buttons.
        const bodyText = item.type === 'interactive' && item.interactive?.body
          ? item.interactive.body
          : (item.text || '');
        if (bodyText) {
          // Strip markdown that might have caused the original error
          const plain = bodyText.replace(/[*_`]/g, '');
          await sendTelegramMessage(chatId, plain);
        } else {
          await sendTelegramMessage(chatId, '⚠️ Hubo un problema mostrando esta respuesta. Probá de nuevo o pedímelo de otra forma.');
        }
      } catch (fallbackErr) {
        console.error('[telegram] Fallback message also failed:', fallbackErr);
        logError('telegram', 'SEND_RESPONSE_FALLBACK', fallbackErr as Error, { context: { chatId } });
      }
    }
  }
}

// --- Document processing helper ---

async function processDocumentWithIntentTg(
  chatId: string | number, userId: UserId, buffer: Buffer, mediaMime: string,
  filename: string | undefined, caption: string, docIntent: DocumentUploadIntent | undefined,
  phone: string, startTime: number,
): Promise<BotResponseItem[]> {
  // Phase 3 — block OCR for trial-expired users.
  const { getUserAccessMode, trialExpiredCopy } = await import('../services/access-gate.service.js');
  if (await getUserAccessMode(Number(userId)) === 'trial_expired_readonly') {
    console.log(`[TRIAL_EXPIRED] user=${userId} channel=document source=telegram`);
    return [{ type: 'text', text: trialExpiredCopy() }];
  }
  const { document: doc, extraction, isExisting } = await documentServiceTg.processDocument(
    userId, buffer, mediaMime, filename, 'telegram', caption,
  );

  if (isExisting) {
    return [{ type: 'text', text: `📄 Este documento ya fue procesado (#${doc.id}).` }];
  }

  const summary = formatExtractionSummary(extraction, doc.id, doc.document_type || 'otro');
  const items: BotResponseItem[] = [{ type: 'text', text: summary }];

  const hasStock = await featureGate.hasFeature(userId, 'stock');
  const buttonConfig = buildPostExtractionButtons(extraction, doc.id, docIntent, hasStock);

  if (buttonConfig) {
    const suggestedExpenses = buildSuggestedExpenses(extraction);
    pendingDocumentStoreTg.set(phone, {
      documentId: doc.id,
      extraction,
      suggestedExpenses,
      timestamp: Date.now(),
    });
    items.push(interactiveButtonsItem(buttonConfig.body, buttonConfig.buttons));
  }

  conversationLogger.log(userId, phone, `[document:${mediaMime}]`, summary.slice(0, 200), 'command', 'process_document', null, null, true, Date.now() - startTime, true).catch(() => {});
  return items;
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
    const startText = (message.text || '').trim();

    // --- Telegram deep-link verification ---
    // Format: "/start verify_<token>" — links this Telegram chat to a web user.
    if (startText.startsWith('/start verify_')) {
      const token = startText.slice('/start verify_'.length).trim();
      const verifSvc = new ChannelVerificationService();
      try {
        const r = await verifSvc.redeemTelegramToken(
          token,
          String(chatId),
          message.from?.first_name ?? null,
        );
        const greeting = r.already_linked
          ? '✅ Tu cuenta ya estaba vinculada. ¡Listo para operar!'
          : '✅ *Cuenta vinculada*\n\nYa podés usar Campo Bot por Telegram. Probá con *menu* o escribí algo como "gasté 50 mil en gasoil".';
        await sendTelegramMessage(chatId, greeting);
      } catch (err) {
        if (err instanceof VerificationError) {
          await sendTelegramMessage(chatId, `❌ ${err.message}`);
        } else {
          console.error('[telegram] redeemTelegramToken failed:', err);
          logError('telegram', 'VERIFY_REDEEM', err as Error);
          await sendTelegramMessage(chatId, '❌ No pude vincular la cuenta. Volvé a generar el link desde la app y probá de nuevo.');
        }
      }
      return;
    }

    // --- Channel verification gate ---
    // If REQUIRE_VERIFIED_CHANNEL is on and this Telegram chat isn't linked to a
    // verified web user, refuse to auto-create. Otherwise fall through to legacy.
    const verifiedTgUser = await userRepository.findVerifiedByTelegramId(String(chatId));
    if (!verifiedTgUser && (await userRepository.isVerificationRequired())) {
      const publicUrl = (await getSetting('PUBLIC_URL')) || 'https://campo-bot-production.up.railway.app';
      await sendTelegramMessage(
        chatId,
        `Hola 👋 Bienvenido a Campo Bot.\n\nPara empezar a usarme, seguí estos 2 pasos en orden:\n\n*1.* Creá tu cuenta acá 👉 ${publicUrl}/register\n*2.* Desde la app, andá a *Mi cuenta* → *Vincular Telegram* y vas a recibir un link mágico. Tocalo y este chat queda vinculado.\n\nUna vez vinculado, escribime de nuevo y ya podés cargar gastos, lluvias, hacienda, cosechas y más.`,
      );
      return;
    }

    const userRow = verifiedTgUser
      ? { id: verifiedTgUser.id, phone_number: verifiedTgUser.phone_number, name: verifiedTgUser.name, city: verifiedTgUser.city }
      : await getOrCreateUserByTelegramId(String(chatId), message.from?.first_name);
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
      // Phase 3 — block audio processing when the trial expired.
      const { getUserAccessMode, trialExpiredCopy } = await import('../services/access-gate.service.js');
      if (await getUserAccessMode(Number(userId)) === 'trial_expired_readonly') {
        console.log(`[TRIAL_EXPIRED] user=${userId} channel=audio source=telegram`);
        await sendTelegramMessage(chatId, trialExpiredCopy());
        return;
      }
      const hasAudio = await featureGate.hasFeature(userId, 'audio');
      if (!hasAudio) {
        await sendTelegramMessage(chatId, '🔒 El procesamiento de audios no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.');
        return;
      }

      const fileId = message.voice?.file_id || message.audio?.file_id;
      if (fileId) {
        try {
          const buffer = await downloadTelegramFile(fileId);
          const provider = createSpeechProvider() as SpeechToTextProvider;
          const result = await provider.transcribe(buffer, 'audio/ogg');
          let transcript = result.text;
          transcript = normalizeTranscript(transcript);
          console.log('[telegram] AUDIO TRANSCRIBED:', transcript);

          // Log audio transcription cost
          try {
            const durationSeconds = message.voice?.duration || message.audio?.duration || 0;
            const durationMinutes = durationSeconds / 60;
            const costUsd = durationMinutes * 0.006;
            const audioConfig = getAudioConfig();
            await saveAudioTranscriptionLog(userId, {
              durationSeconds,
              provider: provider.name || audioConfig.provider,
              model: audioConfig.openaiWhisperModel,
              costUsd,
            });
            console.log(`[telegram] audio logged: ${durationSeconds}s, $${costUsd.toFixed(6)} USD`);
          } catch (logErr: unknown) {
            console.error('[telegram] failed to log audio:', (logErr as Error).message);
            logError('telegram', 'AUDIO_LOG_FAILED', logErr as Error, { userId });
          }

          if (transcript.trim()) {
            const items = await processTextMessage(transcript, userId, user, settings, phone, startTime);
            await sendBotResponse(chatId, items);
          }
        } catch (err) {
          console.error('[telegram] Audio error:', err);
          logError('telegram', 'AUDIO_PROCESSING', err as Error, { userId });
          await sendTelegramMessage(chatId, 'No pude entender el audio. Intentá de nuevo.');
        }
      }
      return;
    }

    // --- Photo/document handling (invoices, receipts) ---
    if (message.photo || (message.document && (message.document.mime_type || '').match(/^(image\/|application\/pdf)/))) {
      const isPhoto = !!message.photo;
      const fileId = isPhoto
        ? message.photo[message.photo.length - 1].file_id  // highest resolution
        : message.document?.file_id;
      const mediaMime = isPhoto ? 'image/jpeg' : (message.document?.mime_type || 'application/octet-stream');
      const caption = message.caption || '';
      const filename = message.document?.file_name;

      if (fileId && (mediaMime.startsWith('image/') || mediaMime === 'application/pdf')) {
        try {
          const hasDocuments = await featureGate.hasFeature(userId, 'documents');
          if (!hasDocuments) {
            await sendTelegramMessage(chatId, '🔒 El procesamiento de documentos no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.');
            return;
          }

          const { allowed, limit } = await documentServiceTg.checkDailyLimit(userId);
          if (!allowed) {
            await sendTelegramMessage(chatId, `⚠️ Alcanzaste el límite diario de ${limit} documentos. Intentá mañana.`);
            return;
          }

          // Check if user already chose a document type (State A: menu → waiting for image)
          const pendingUpload = pendingDocUploadStoreTg.get(phone);
          if (pendingUpload?.intent) {
            const docIntent = pendingUpload.intent;
            pendingDocUploadStoreTg.clear(phone);
            await sendTelegramMessage(chatId, '🔍 Procesando documento...');
            const buffer = await downloadTelegramFile(fileId);
            const items = await processDocumentWithIntentTg(chatId, userId, buffer, mediaMime, filename, caption, docIntent, phone, startTime);
            await sendBotResponse(chatId, items);
            return;
          }

          // Unprompted image (State B): store mediaRef, ask what to do
          pendingDocUploadStoreTg.set(phone, {
            mediaRef: { mediaId: fileId, mimeType: mediaMime, filename, caption },
            timestamp: Date.now(),
          });
          await sendTelegramButtons(chatId, '📷 Recibí una imagen. ¿Es una factura (para gastos) o un remito (para stock)?', [
            { id: 'doc_classify_factura', title: '🧾 Factura (gastos)' },
            { id: 'doc_classify_remito', title: '📋 Remito (stock)' },
            { id: 'doc_classify_skip', title: 'No procesar' },
          ]);

          conversationLogger.log(userId, phone, `[image_received:${mediaMime}]`, 'Awaiting document intent', 'command', 'document_intent_prompt', null, null, false, Date.now() - startTime, true).catch(() => {});
        } catch (err: unknown) {
          const error = err as Error;
          console.error('[telegram] document error:', error.message);
          logError('telegram', 'DOCUMENT_PROCESSING', error, { userId });
          if (err instanceof DocumentError) {
            await sendTelegramMessage(chatId, `⚠️ ${error.message}`);
          } else {
            await sendTelegramMessage(chatId, 'No pude procesar el documento. Intentá con otra imagen o PDF.');
          }
        }
        return;
      }
    }

    // --- Location message handling (Telegram shared location) ---
    if (message.location) {
      const lat = message.location.latitude;
      const lng = message.location.longitude;
      if (typeof lat === 'number' && typeof lng === 'number') {
        const pendingLoc = pendingFieldLocationStore.get(phone);
        if (pendingLoc) {
          const { handlePendingLocation } = await import('../middleware/pending-field-location-handler.js');
          const result = await handlePendingLocation(lat, lng, pendingLoc, userId);
          if (result.clearPending) pendingFieldLocationStore.clear(phone);
          for (const msg of result.messages) {
            await sendTelegramMessage(chatId, msg);
          }
          return;
        }
        // No pending location
        await sendTelegramMessage(chatId, '📍 Ubicación recibida, pero no hay un campo pendiente de ubicar.\n\nPara ubicar un campo, primero creá uno con *agregar campo [nombre]*.');
        return;
      }
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
    logError('telegram', 'WEBHOOK_ERROR', err);
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
      // Store pending stock entry if expense flow suggests one
      if (result.response.sideEffects?.setPendingStockEntry) {
        pendingStockEntryStore.set(phone, result.response.sideEffects.setPendingStockEntry);
      }
      // Store pending field location for share-location flow
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
      if (['expense_flow', 'income_flow', 'rainfall_flow', 'activity_flow'].includes(flowName)) {
        const prereq = await hasNoPrerequisites(userId);
        if (prereq.blocked) return prereq.items!;
      }
      const prefillData = flowName === 'field_flow' ? { _channel: 'telegram', _channelId: phone } : undefined;
      const result = await conversationEngine.startFlow(userId, flowName as FlowState, prefillData);
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
    conversationLogger.log(userId, phone, `[${callbackId}]`, 'Operacion cancelada.', 'command', 'cancel', null, null, false, null, false, null, null, null, 'telegram').catch(() => {});
    return [{ type: 'text', text: '\u274c Operacion cancelada.' }];
  }

  // --- Confirm pending financial transaction ---
  if (callbackId === 'confirm_pending') {
    const pendingTx = pendingStore.get(phone);
    if (!pendingTx) {
      conversationLogger.log(userId, phone, '[confirm_pending]', 'No hay nada pendiente para confirmar.', 'command', 'confirm', null, null, false, null, false, null, null, null, 'telegram').catch(() => {});
      return [{ type: 'text', text: 'No hay nada pendiente para confirmar.' }];
    }
    pendingStore.clear(phone);
    const response = await financialHandler.handleConfirm(userId, pendingTx, settings, user);
    if (response.sideEffects?.setPendingStockEntry) {
      pendingStockEntryStore.set(phone, response.sideEffects.setPendingStockEntry as Record<string, unknown>);
    }
    conversationLogger.log(userId, phone, '[confirm_pending]', response.messages[0] ?? response.interactive?.body ?? null, 'command', 'confirm', null, null, false, null, !!response.interactive, null, null, null, 'telegram').catch(() => {});
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
      const prefill: Record<string, unknown> = { _channel: 'telegram', _channelId: phone };
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
    const resultItems: BotResponseItem[] = [];
    if (accepted) {
      try {
        const pending = pendingStockEntryStore.get(phone);
        if (pending) {
          const { StockPurchaseService } = await import('../domain/stock/stock-purchase.service.js');
          const purchaseService = new StockPurchaseService();
          const { item } = await purchaseService.applyStockEntry(userId, pending as any);
          resultItems.push({ type: 'text', text: `📦 Stock actualizado: *${item.name}* → ${item.current_quantity} ${item.unit}` });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al cargar stock';
        resultItems.push({ type: 'text', text: `❌ ${msg}` });
      }
    } else {
      resultItems.push({ type: 'text', text: '👍 OK, no se cargó al stock.' });
    }
    pendingStockEntryStore.delete(phone);
    return resultItems;
  }

  // --- Stock deduction suggestion (from activity) ---
  if (callbackId.startsWith('stock_deduct_yes_') || callbackId.startsWith('stock_deduct_no_')) {
    const accepted = callbackId.startsWith('stock_deduct_yes_');
    if (accepted) {
      try {
        const pending = pendingStockDeductionStore.get(phone) as Record<string, unknown> | undefined;
        if (pending) {
          // If no quantity specified, ask the user
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
          console.error('[telegram] declineDeduction failed:', err);
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
        if (pending && pending.type === 'grain') {
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

  // --- Document upload intent (menu entry) ---
  if (callbackId === 'doc_upload_factura' || callbackId === 'doc_upload_remito') {
    const docType = callbackId === 'doc_upload_factura' ? 'factura' : 'remito' as DocumentUploadIntent;
    const hasDocuments = await featureGate.hasFeature(userId, 'documents');
    if (!hasDocuments) {
      return [{ type: 'text', text: '🔒 El procesamiento de documentos no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.' }];
    }
    const label = docType === 'factura' ? '🧾 factura' : '📋 remito';
    pendingDocUploadStoreTg.set(phone, { intent: docType, timestamp: Date.now() });
    return [{ type: 'text', text: `Enviame la foto o PDF del ${label} y lo proceso.` }];
  }

  // --- Document classify callback (unprompted image → user chose type) ---
  if (callbackId === 'doc_classify_factura' || callbackId === 'doc_classify_remito' || callbackId === 'doc_classify_skip') {
    const pendingUpload = pendingDocUploadStoreTg.get(phone);
    pendingDocUploadStoreTg.clear(phone);

    if (callbackId === 'doc_classify_skip') {
      return [{ type: 'text', text: '👌 Imagen ignorada.' }];
    }

    if (!pendingUpload?.mediaRef) {
      return [{ type: 'text', text: '⚠️ La imagen expiró. Enviala de nuevo.' }];
    }

    const docType = callbackId === 'doc_classify_factura' ? 'factura' : 'remito' as DocumentUploadIntent;
    try {
      const buffer = await downloadTelegramFile(pendingUpload.mediaRef.mediaId);
      const items: BotResponseItem[] = [{ type: 'text', text: '🔍 Procesando documento...' }];
      // Extract chatId from phone (tg_XXXXX)
      const chatIdStr = phone.replace('tg_', '');
      const result = await processDocumentWithIntentTg(
        chatIdStr, userId, buffer, pendingUpload.mediaRef.mimeType,
        pendingUpload.mediaRef.filename, pendingUpload.mediaRef.caption || '',
        docType, phone, startTime,
      );
      items.push(...result);
      return items;
    } catch (err: unknown) {
      const error = err as Error;
      console.error('[telegram] doc classify error:', error.message);
      logError('telegram', 'DOC_CLASSIFY_CALLBACK', error, { userId });
      if (err instanceof DocumentError) {
        return [{ type: 'text', text: `⚠️ ${error.message}` }];
      }
      return [{ type: 'text', text: 'No pude procesar el documento. Intentá con otra imagen o PDF.' }];
    }
  }

  // --- Document stock-only callback (remito → warehouse selection) ---
  if (callbackId.startsWith('doc_stock_yes_')) {
    try {
      const pending = pendingDocumentStoreTg.get(phone);
      if (!pending || !pending.extraction.line_items || pending.extraction.line_items.length === 0) {
        return [{ type: 'text', text: '⚠️ No hay items para cargar al stock.' }];
      }
      const { StockService } = await import('../domain/stock/stock.service.js');
      const stockService = new StockService();
      const warehouses = await stockService.listWarehouses(userId);
      if (warehouses.length <= 1) {
        // 0 or 1 warehouse → auto-resolve and load
        return await loadRemitoStockTg(pending, userId, phone, stockService);
      }
      // Multiple warehouses → ask user to pick
      const buttons = warehouses.slice(0, 3).map(w => ({
        id: `doc_warehouse_${w.id}_${pending.documentId}`,
        title: `${w.name} (${w.field_name || ''})`.slice(0, 20),
      }));
      return [interactiveButtonsItem('¿En qué galpón cargamos el stock?', buttons)];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al cargar stock';
      return [{ type: 'text', text: `❌ ${msg}` }];
    }
  }

  // --- Document warehouse selection callback (remito → specific warehouse) ---
  if (callbackId.startsWith('doc_warehouse_')) {
    const match = callbackId.match(/^doc_warehouse_(\d+)_(\d+)$/);
    if (match) {
      const warehouseId = parseInt(match[1], 10);
      try {
        const pending = pendingDocumentStoreTg.get(phone);
        if (!pending) return [{ type: 'text', text: '⚠️ No hay documento pendiente.' }];
        const { StockService } = await import('../domain/stock/stock.service.js');
        const stockService = new StockService();
        return await loadRemitoStockTg(pending, userId, phone, stockService, warehouseId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al cargar stock';
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    }
  }

  // --- Document product discovery callbacks ---
  if (callbackId.startsWith('doc_create_products_yes_') || callbackId.startsWith('doc_create_products_no_')) {
    const accepted = callbackId.startsWith('doc_create_products_yes_');
    if (accepted) {
      try {
        const pending = pendingDocumentStoreTg.get(phone);
        if (!pending?.missingProducts || pending.missingProducts.length === 0) {
          pendingDocumentStoreTg.clear(phone);
          return [{ type: 'text', text: '⚠️ No hay productos pendientes.' }];
        }
        const { StockService } = await import('../domain/stock/stock.service.js');
        const stockService = new StockService();
        const warehouse = await stockService.resolveWarehouse(userId);
        const messages: string[] = [];
        for (const p of pending.missingProducts) {
          try {
            await stockService.createProductOnly(userId, warehouse.id, p.name, p.category || 'otros', p.unit || 'u');
            messages.push(`📋 Producto creado: *${p.name}* (${p.unit || 'u'}) - qty 0`);
          } catch {
            messages.push(`⚠️ No pude crear ${p.name}`);
          }
        }
        pendingDocumentStoreTg.clear(phone);
        return [{ type: 'text', text: messages.join('\n') }];
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al crear productos';
        pendingDocumentStoreTg.clear(phone);
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    }
    pendingDocumentStoreTg.clear(phone);
    return [{ type: 'text', text: '👌 OK, no se crearon productos en el stock.' }];
  }

  // --- Document expense callback ---
  if (callbackId.startsWith('doc_expense_yes_') || callbackId.startsWith('doc_expense_no_')) {
    const accepted = callbackId.startsWith('doc_expense_yes_');
    if (accepted) {
      try {
        const pending = pendingDocumentStoreTg.get(phone);
        if (!pending) return [{ type: 'text', text: '⚠️ No hay documento pendiente.' }];
        // Resolve plot before saving
        const plotRes = await resolveDocPlot(userId);
        if (!plotRes.resolved) {
          pending.deferredAction = 'expense';
          pendingDocumentStoreTg.set(phone, pending);
          const buttons = plotRes.plots.slice(0, 3).map(p => ({
            id: `doc_plot_${p.id}`,
            title: `${p.name} (${p.field_name})`.slice(0, 20),
          }));
          return [interactiveButtonsItem('¿En qué lote registramos los gastos?', buttons)];
        }
        return await saveDocExpensesTg(pending, userId, phone, plotRes.fieldId, plotRes.plotId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al registrar gasto';
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    }
    pendingDocumentStoreTg.clear(phone);
    return [{ type: 'text', text: '👌 Documento guardado sin registrar gasto.' }];
  }

  // --- Document plot selection callback (deferred expense saving) ---
  if (callbackId.startsWith('doc_plot_')) {
    const plotId = parseInt(callbackId.replace('doc_plot_', ''), 10);
    if (!isNaN(plotId)) {
      try {
        const pending = pendingDocumentStoreTg.get(phone);
        if (!pending) return [{ type: 'text', text: '⚠️ No hay documento pendiente.' }];
        const allPlots = await financialService.findAllUserPlots(userId);
        const plot = allPlots.find(p => p.id === plotId);
        const fieldId = plot?.field_id ?? null;
        return await saveDocExpensesTg(pending, userId, phone, fieldId, plotId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al registrar';
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    }
  }

  // --- Generic interactive routing ---
  const intent = interactiveRouter.route(callbackId);
  if (intent && intent.type === 'command') {
    const response = await domainRouter.routeCommand(intent.data, userId, user, settings);
    if (response) return collectResponse(response);
  }
  return [];
}

/** Save document expenses, then check for product discovery (missing products in stock). */
async function saveDocExpensesTg(
  pending: import('../middleware/pending-documents.js').PendingDocumentAction,
  userId: UserId, phone: string,
  fieldId: number | null, plotId: number | null,
): Promise<BotResponseItem[]> {
  const { saveExpense } = await import('../services/expenses.js');
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
    messages.push(`✅ Gasto registrado: $${exp.amount?.toLocaleString('es-AR')} - ${exp.description}`);
  }
  if (firstExpenseId) {
    await documentServiceTg.linkToExpense(pending.documentId, firstExpenseId, userId).catch(() => {});
  }
  const items: BotResponseItem[] = [{ type: 'text', text: messages.join('\n') }];

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
          pendingDocumentStoreTg.set(phone, pending);
          const names = missing.map(p => p.name).join(', ');
          items.push(interactiveButtonsItem(
            `Encontré ${missing.length} producto${missing.length > 1 ? 's' : ''} que no está${missing.length > 1 ? 'n' : ''} en tu stock: *${names}*. ¿Querés darlos de alta?`,
            [
              { id: `doc_create_products_yes_${pending.documentId}`, title: 'Sí, crear' },
              { id: `doc_create_products_no_${pending.documentId}`, title: 'No' },
            ],
          ));
          return items;
        }
      }
    }
  } catch {
    // Product discovery is best-effort, don't fail the expense save
  }

  pendingDocumentStoreTg.clear(phone);
  return items;
}

/** Load remito line items into stock (optionally into a specific warehouse). */
async function loadRemitoStockTg(
  pending: import('../middleware/pending-documents.js').PendingDocumentAction,
  userId: UserId, phone: string,
  stockService: import('../domain/stock/stock.service.js').StockService,
  warehouseId?: number,
): Promise<BotResponseItem[]> {
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
  pendingDocumentStoreTg.clear(phone);
  return [{ type: 'text', text: messages.join('\n') }];
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

  const sessionId = `tg_${userId}_${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })}`;
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
        // financial, etc.) can be re-executed via the unified pending path —
        // not just agronomy.
        const routed = await domainRouter.routeCommand(merged, userId, user, settings);
        const cmdResult = routed ?? { messages: ['No pude completar el registro. Probá de nuevo.'] };
        // Advance the serial pending queue (multi-item compounds — see whatsapp
        // controller for full comment).
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
        const items = collectResponse(cmdResult);
        if (advanced.askPrompt) items.push({ type: 'text', text: advanced.askPrompt });
        return items;
      }
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
            missing: next.missing,
            askPrompt: next.askPrompt,
            nextInQueue: next.nextInQueue,
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
    conversationLogger.log(userId, phone, text, convResponse, 'conversational', null, null, null, true, Date.now() - startTime, false, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
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
      // Handle sideEffects from the execution
      if (result.stoppedAtFlow && result.lastSideEffects?.startFlow) {
        const { state, data } = result.lastSideEffects.startFlow;
        if (state === 'field_flow') {
          const flowData = data ?? {};
          flowData._channel = 'telegram';
          flowData._channelId = phone;
        }
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
            missing: act.missing,
            askPrompt: act.askPrompt,
            nextInQueue: act.nextInQueue,
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
        if (result.lastSideEffects.setPendingFieldLocation) {
          const loc = result.lastSideEffects.setPendingFieldLocation;
          pendingFieldLocationStore.set(phone, { fieldId: loc.fieldId, fieldName: loc.fieldName });
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
      conversationLogger.log(userId, phone, text, result.messages.join('\n\n') || null, 'command', 'compound', null, null, aiUsed, Date.now() - startTime, !!result.lastInteractive, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
      return items;
    }
    // result is null or empty → fall through to normal single-action path
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
    conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'command', 'confirm', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
    return collectResponse(response);
  }
  if (intent.type === 'command' && intent.data.command === 'cancel') {
    const { clearMultiTurnState } = await import('../middleware/multi-turn-state.js');
    await clearMultiTurnState(userId);
    if (!pending) {
      return [{ type: 'text', text: 'Listo, contexto limpio. ¿Qué hacemos?' }];
    }
    pendingStore.clear(phone);
    conversationLogger.log(userId, phone, text, 'Operacion cancelada.', 'command', 'cancel', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
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
    conversationLogger.log(userId, phone, text, reply, 'trial_expired', null, null, null, aiUsed, Date.now() - startTime, false, 0, toolCallsData, agentMode, 'telegram').catch(() => {});
    return [{ type: 'text', text: reply }];
  }

  // --- Phase 2: regex fallback refused to parse a complex intent ---
  if (intent.type === 'fallback_blocked') {
    const { fallbackBlockedCopy } = await import('../services/intent-safety.js');
    const reply = fallbackBlockedCopy(intent.reason, intent.attemptedCommand);
    conversationLogger.log(userId, phone, text, reply, 'fallback_blocked', intent.attemptedCommand ?? null, null, null, aiUsed, Date.now() - startTime, false, 0, toolCallsData, agentMode, 'telegram').catch(() => {});
    return [{ type: 'text', text: reply }];
  }

  // --- Partial parse → flow ---
  if (intent.type === 'expense_partial') {
    { const prereq = await hasNoPrerequisites(userId); if (prereq.blocked) return prereq.items!; }
    const hasExpenses = await featureGate.hasFeature(userId, 'expenses');
    if (!hasExpenses) {
      return [{ type: 'text', text: '🔒 El registro de gastos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
    }
    // Slot-extractor pending (May 28 fix) — REPLACES the rigid expense_flow.
    // The flow only accepted slots in a fixed order and escaped to plot_info /
    // similar when the user provided data out of order. The slot-extractor
    // pending accepts any slot at any time and asks for whatever's missing.
    const { planExpensePartialPending } = await import('../middleware/financial-partial-pending.js');
    const plan = planExpensePartialPending(intent.data as any);
    pendingActStore.set(phone, {
      command: plan.command,
      data: plan.data,
      timestamp: Date.now(),
      missing: plan.missing,
      askPrompt: plan.askPrompt,
    });
    conversationLogger.log(userId, phone, text, plan.askPrompt, 'pending', 'expense_partial', null, 0, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
    return [{ type: 'text', text: plan.askPrompt }];
  }

  if (intent.type === 'income_partial') {
    { const prereq = await hasNoPrerequisites(userId); if (prereq.blocked) return prereq.items!; }
    const hasIncomes = await featureGate.hasFeature(userId, 'incomes');
    if (!hasIncomes) {
      return [{ type: 'text', text: '🔒 El registro de ingresos no esta disponible en tu plan actual.\n\nEscribi *plan* para ver las opciones.' }];
    }
    // Slot-extractor pending — see expense_partial comment for rationale.
    const { planIncomePartialPending } = await import('../middleware/financial-partial-pending.js');
    const incPlan = planIncomePartialPending(intent.data as any);
    pendingActStore.set(phone, {
      command: incPlan.command,
      data: incPlan.data,
      timestamp: Date.now(),
      missing: incPlan.missing,
      askPrompt: incPlan.askPrompt,
    });
    conversationLogger.log(userId, phone, text, incPlan.askPrompt, 'pending', 'income_partial', null, 0, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
    return [{ type: 'text', text: incPlan.askPrompt }];
  }

  // --- Ambiguous → disambiguation buttons ---
  if (intent.type === 'ambiguous') {
    const buttons = intent.candidates.slice(0, 3).map((c, i) => ({
      id: `disambig_${i}`,
      title: c.label.slice(0, 20),
    }));
    conversationLogger.log(userId, phone, text, 'Disambiguation', 'ambiguous', null, null, null, aiUsed, Date.now() - startTime, true, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
    return [interactiveButtonsItem('\u00bfQue queres hacer?', buttons)];
  }

  // --- Route commands ---
  if (intent.type === 'command') {
    // Start document upload → store intent, prompt for image
    if (intent.data.command === 'start_document_upload') {
      const hasDocuments = await featureGate.hasFeature(userId, 'documents');
      if (!hasDocuments) {
        return [{ type: 'text', text: '🔒 El procesamiento de documentos no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.' }];
      }
      const docType = (intent.data.documentType as DocumentUploadIntent) || 'factura';
      const label = docType === 'factura' ? '🧾 factura' : docType === 'remito' ? '📋 remito' : '🎫 ticket';
      pendingDocUploadStoreTg.set(phone, { intent: docType, timestamp: Date.now() });
      conversationLogger.log(userId, phone, text, `Start document upload: ${docType}`, 'command', 'start_document_upload', null, null, aiUsed, Date.now() - startTime, false, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
      return [{ type: 'text', text: `Enviame la foto o PDF del ${label} y lo proceso.` }];
    }

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
        if (state === 'field_flow') {
          const flowData = data ?? {};
          flowData._channel = 'telegram';
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
      conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'command', intent.data.command, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
      const items = collectResponse(response);
      if (plotAreaPromptCmd) items.push({ type: 'text', text: plotAreaPromptCmd });
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
    let replacedPendingExpense: PendingTransaction | null = null;
    if (response.sideEffects?.setPending) {
      replacedPendingExpense = pendingStore.set(phone, response.sideEffects.setPending);
    }
    if (response.sideEffects?.setPendingStockEntry) {
      pendingStockEntryStore.set(phone, response.sideEffects.setPendingStockEntry as Record<string, unknown>);
    }
    learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
    updateConversationMiniMemory(userId, { lastIntent: 'expense' }).catch(() => {});
    conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'expense', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
    const itemsExp = collectResponse(response);
    if (replacedPendingExpense) {
      // Prepend a warning so the user knows the older "¿Confirmo?" card is dead.
      itemsExp.unshift({ type: 'text', text: describeReplacedPending(replacedPendingExpense) });
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
    let replacedPendingIncome: PendingTransaction | null = null;
    if (response.sideEffects?.setPending) {
      replacedPendingIncome = pendingStore.set(phone, response.sideEffects.setPending);
    }
    if (response.sideEffects?.setPendingStockDeduction) {
      pendingStockDeductionStore.set(phone, response.sideEffects.setPendingStockDeduction as Record<string, unknown>);
    }
    learningService.learnFromMessage(userId, text, intent, aiUsed).catch(() => {});
    updateConversationMiniMemory(userId, { lastIntent: 'income' }).catch(() => {});
    conversationLogger.log(userId, phone, text, response.messages[0] ?? response.interactive?.body ?? null, 'income', null, null, null, aiUsed, Date.now() - startTime, !!response.interactive, confidence, toolCallsData, agentMode, 'telegram').catch(() => {});
    const itemsInc = collectResponse(response);
    if (replacedPendingIncome) {
      itemsInc.unshift({ type: 'text', text: describeReplacedPending(replacedPendingIncome) });
    }
    return itemsInc;
  }

  // --- Unknown → Conversational fallback ---
  if (intent.type === 'unknown' || confidence < unknownFallbackThreshold) {
    await financialService.saveUnparsedMessage(userId, text);
    const fallbackResult = await conversationalFallback.respond(text, userId, settings);
    const items: BotResponseItem[] = [{ type: 'text', text: fallbackResult.response }];
    if (fallbackResult.aiUsed) {
      conversationLogger.log(userId, phone, text, fallbackResult.response, 'conversational', null, null, null, true, Date.now() - startTime, false, confidence, null, null, 'telegram').catch(() => {});
    } else {
      const menuResponse = await systemHandler.handleCommand({ command: 'menu' }, userId, user, settings);
      items.push(...collectResponse(menuResponse));
      conversationLogger.log(userId, phone, text, fallbackResult.response, 'unknown', null, null, null, false, Date.now() - startTime, true, confidence, null, null, 'telegram').catch(() => {});
    }
    return items;
  }

  return [];
}

export default router;
