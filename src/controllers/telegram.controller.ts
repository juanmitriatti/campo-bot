/**
 * telegram controller — webhook de Telegram. El procesamiento de mensajes vive
 * en src/services/message-pipeline.ts y el de documentos en
 * src/services/document-pipeline.ts (ambos compartidos con whatsapp/test-bot).
 * Acá solo queda lo específico del canal: parseo del update, deep-link de
 * verificación, gate de canal, audio (descarga + transcripción), recepción de
 * fotos/PDF, ubicación compartida y render de los BotResponseItem vía la API
 * de Telegram.
 */
import express from 'express';
import type { Request, Response } from 'express';
import { MessageDedup } from '../middleware/dedup.js';
import { getSetting } from '../services/settings.service.js';
import { ChannelVerificationService, VerificationError } from '../domain/auth/channel-verification.service.js';
import { logError } from '../services/error-logger.js';
import { getOrCreateUserByTelegramId, saveAudioTranscriptionLog } from '../services/expenses.js';
import { normalizeTranscript } from '../utils/text-normalizer.js';
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
import { DocumentError } from '../domain/documents/document.service.js';
import { asUserId } from '../types/index.js';
import type { SpeechToTextProvider } from '../services/audio/providers/speech-provider.interface.js';
import { withUserLock } from '../middleware/user-lock.js';
import {
  processTextMessage,
  handleInteractiveReply,
  hydratePendingStores,
  userRepository,
  featureGate,
  conversationLogger,
  pendingFieldLocationStore,
  pendingDocUploadStore,
} from '../services/message-pipeline.js';
import type { BotResponseItem, ChannelContext } from '../services/message-pipeline.js';
import {
  documentService,
  processDocumentWithIntent,
  makeDocCallbackHandler,
} from '../services/document-pipeline.js';

const dedup = new MessageDedup();
const handleTgDocCallback = makeDocCallbackHandler(downloadTelegramFile);

// --- Telegram-specific key for in-memory stores ---

function tgPhone(chatId: string | number): string {
  return `tg_${chatId}`;
}

// Copy único del onboarding para chats no verificados (texto Y callbacks).
async function buildUnverifiedOnboardingMessage(): Promise<string> {
  const publicUrl = (await getSetting('PUBLIC_URL')) || 'https://campo-bot-production.up.railway.app';
  return `Hola 👋 Bienvenido a Campo Bot.\n\nPara empezar a usarme, seguí estos 2 pasos en orden:\n\n*1.* Creá tu cuenta acá 👉 ${publicUrl}/register\n*2.* Desde la app, andá a *Mi cuenta* → *Vincular Telegram* y vas a recibir un link mágico. Tocalo y este chat queda vinculado.\n\nUna vez vinculado, escribime de nuevo y ya podés cargar gastos, lluvias, hacienda, cosechas y más.`;
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
        } else {
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

// --- Router ---

const router = express.Router();

// POST /telegram — Telegram webhook
router.post('/', (req: Request, res: Response) => {
  // Telegram expects 200 quickly; process async
  res.sendStatus(200);

  // Serialización por usuario + hidratación de pendings desde DB. Mensajes del
  // mismo chat se procesan en orden (dos updates rápidos pisaban el pending del
  // primero); chats distintos siguen en paralelo. La hidratación repuebla los
  // pending stores tras un restart (tabla pending_states).
  const lockChatId: string | number | undefined =
    req.body?.callback_query?.message?.chat?.id ?? req.body?.message?.chat?.id;
  if (lockChatId == null) {
    void handleTelegramUpdate(req);
    return;
  }
  void withUserLock(`tg:${lockChatId}`, async () => {
    await hydratePendingStores(tgPhone(lockChatId));
    await handleTelegramUpdate(req);
  }).catch((err) => console.error('TG LOCK ERROR:', (err as Error).message));
});

async function handleTelegramUpdate(req: Request): Promise<void> {
  const startTime = Date.now();
  // Para el catch final: si ya sabemos a quién responder, avisamos del fallo.
  let notifyChatId: string | number | null = null;
  try {
    const update = req.body;

    // --- Callback query (button press) ---
    if (update.callback_query) {
      const cbQuery = update.callback_query;
      const chatId = cbQuery.message?.chat?.id;
      const callbackId = cbQuery.data;

      if (!chatId || !callbackId) return;
      notifyChatId = chatId;

      // Dedup on callback query id
      if (dedup.isDuplicate(`cb_${cbQuery.id}`)) return;

      // Acknowledge button press
      answerCallbackQuery(cbQuery.id).catch(() => {});

      // Ignore noop (section titles)
      if (callbackId === 'noop') return;

      // --- Channel verification gate (paridad con WhatsApp, Jul 2026) ---
      // Antes el gate solo cubría los mensajes de texto: un chat NO verificado
      // que tocaba un botón viejo se procesaba igual e incluso auto-creaba un
      // usuario anónimo — exactamente lo que REQUIRE_VERIFIED_CHANNEL impide.
      const verifiedCbUser = await userRepository.findVerifiedByTelegramId(String(chatId));
      if (!verifiedCbUser && (await userRepository.isVerificationRequired())) {
        await sendTelegramMessage(chatId, await buildUnverifiedOnboardingMessage());
        return;
      }

      const phone = tgPhone(chatId);
      const userRow = verifiedCbUser
        ? { id: verifiedCbUser.id, phone_number: verifiedCbUser.phone_number, name: verifiedCbUser.name, city: verifiedCbUser.city }
        : await getOrCreateUserByTelegramId(String(chatId), cbQuery.from?.first_name);
      const userId = asUserId(userRow.id);
      const user = {
        id: userId,
        phone_number: userRow.phone_number || phone,
        name: userRow.name ?? null,
        city: userRow.city ?? null,
      };
      const settings = await userRepository.getSettings(userId);

      const ctx: ChannelContext = {
        channel: 'telegram', phone, userId, user, settings, startTime,
        handleDocCallback: handleTgDocCallback,
      };
      const items = await handleInteractiveReply(callbackId, ctx);
      await sendBotResponse(chatId, items);
      return;
    }

    // --- Text message ---
    const message = update.message;
    if (!message) return;

    const chatId = message.chat?.id;
    if (!chatId) return;
    notifyChatId = chatId;

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
        // Bienvenida consciente del estado (fricción real del primer usuario,
        // Jul 2026): al recién registrado SIN campos el copy viejo le sugería
        // "gasté 50 mil en gasoil" — que rebota inmediatamente con "primero
        // necesitás crear un campo". El bot se contradecía en sus primeros dos
        // mensajes. Sin campos → el primer paso es contar el campo (el agente
        // soporta el alta completa en UN mensaje).
        let hasFields = true;
        try {
          const { pool } = await import('../config/db.js');
          const { rows } = await pool.query(
            'SELECT 1 FROM fields WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1',
            [r.user_id],
          );
          hasFields = rows.length > 0;
        } catch { /* ante la duda, el copy genérico */ }
        // Copys configurables desde admin (grupo "Mensajes del Bot").
        const { interpolate } = await import('../utils/template.js');
        const botName = (await getSetting('BOT_NAME')) || 'MIA';
        const template = hasFields
          ? await getSetting('TG_LINKED_WELCOME_MESSAGE')
          : await getSetting('TG_LINKED_WELCOME_NO_FIELDS_MESSAGE');
        const greeting = r.already_linked
          ? '✅ Tu cuenta ya estaba vinculada. ¡Listo para operar!'
          : interpolate(template || '✅ *Cuenta vinculada*', { botName });
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
      await sendTelegramMessage(chatId, await buildUnverifiedOnboardingMessage());
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

    const ctx: ChannelContext = {
      channel: 'telegram', phone, userId, user, settings, startTime,
      handleDocCallback: handleTgDocCallback,
    };

    // --- Voice/audio message ---
    if (message.voice || message.audio) {
      // Phase 3 — block audio processing when the trial expired.
      const { getUserAccessMode, trialExpiredCopy } = await import('../services/access-gate.service.js');
      if (await getUserAccessMode(Number(userId)) === 'trial_expired_readonly') {
        console.log(`[TRIAL_EXPIRED] user=${userId} channel=audio source=telegram`);
        await sendTelegramMessage(chatId, await trialExpiredCopy());
        return;
      }
      const hasAudio = await featureGate.hasFeature(userId, 'audio');
      if (!hasAudio) {
        await sendTelegramMessage(chatId, '🔒 El procesamiento de audios no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.');
        return;
      }

      // Rate-limit horario + largo máximo (paridad con WhatsApp, Jul 2026).
      // Telegram trae la duración exacta en el update — se corta ANTES de
      // descargar/transcribir (Whisper cuesta por minuto).
      const { checkAudioGuards } = await import('../services/audio/audio-guards.js');
      const guard = await checkAudioGuards(
        Number(userId),
        message.voice?.duration || message.audio?.duration,
      );
      if (!guard.ok) {
        await sendTelegramMessage(chatId, guard.message);
        return;
      }

      const fileId = message.voice?.file_id || message.audio?.file_id;
      if (fileId) {
        try {
          const buffer = await downloadTelegramFile(fileId);
          const provider = createSpeechProvider() as SpeechToTextProvider;
          const result = await provider.transcribe(buffer, 'audio/ogg');
          const transcript = normalizeTranscript(result.text);
          console.log('[telegram] AUDIO TRANSCRIBED:', transcript);

          // Log audio transcription cost (precio configurable en admin, grupo audio)
          try {
            const durationSeconds = message.voice?.duration || message.audio?.duration || 0;
            const durationMinutes = durationSeconds / 60;
            const { getSettingNumber } = await import('../services/settings.service.js');
            const pricePerMinute = (await getSettingNumber('WHISPER_PRICE_PER_MINUTE')) ?? 0.006;
            const costUsd = durationMinutes * pricePerMinute;
            const audioConfig = getAudioConfig();
            await saveAudioTranscriptionLog(userId, {
              durationSeconds,
              provider: provider.name || audioConfig.provider,
              model: (result as { model?: string }).model || audioConfig.openaiWhisperModel,
              costUsd,
            });
            console.log(`[telegram] audio logged: ${durationSeconds}s, $${costUsd.toFixed(6)} USD`);
          } catch (logErr: unknown) {
            console.error('[telegram] failed to log audio:', (logErr as Error).message);
            logError('telegram', 'AUDIO_LOG_FAILED', logErr as Error, { userId });
          }

          if (transcript.trim()) {
            // Eco de transcripción (configurable): el usuario ve qué entendió
            // el STT y puede corregir — antes una transcripción mala era invisible.
            try {
              const { buildTranscriptEcho } = await import('../services/audio/transcript-echo.js');
              const echo = await buildTranscriptEcho(transcript);
              if (echo) await sendTelegramMessage(chatId, echo);
            } catch { /* best-effort: el eco jamás bloquea el procesamiento */ }

            const items = await processTextMessage(transcript, ctx);
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

          const { allowed, limit } = await documentService.checkDailyLimit(userId);
          if (!allowed) {
            await sendTelegramMessage(chatId, `⚠️ Alcanzaste el límite diario de ${limit} documentos. Intentá mañana.`);
            return;
          }

          // Check if user already chose a document type (State A: menu → waiting for image)
          const pendingUpload = pendingDocUploadStore.get(phone);
          if (pendingUpload?.intent) {
            const docIntent = pendingUpload.intent;
            pendingDocUploadStore.clear(phone);
            await sendTelegramMessage(chatId, '🔍 Procesando documento...');
            const buffer = await downloadTelegramFile(fileId);
            const items = await processDocumentWithIntent(ctx, buffer, mediaMime, filename, caption, docIntent);
            await sendBotResponse(chatId, items);
            return;
          }

          // Unprompted image (State B): store mediaRef, ask what to do
          pendingDocUploadStore.set(phone, {
            mediaRef: { mediaId: fileId, mimeType: mediaMime, filename, caption },
            timestamp: Date.now(),
          });
          await sendTelegramButtons(chatId, '📷 Recibí una imagen. ¿Es una factura (para gastos) o un remito (para stock)?', [
            { id: 'doc_classify_factura', title: '🧾 Factura (gastos)' },
            { id: 'doc_classify_remito', title: '📋 Remito (stock)' },
            { id: 'doc_classify_skip', title: 'No procesar' },
          ]);

          conversationLogger.log(userId, phone, `[image_received:${mediaMime}]`, 'Awaiting document intent', 'command', 'document_intent_prompt', null, null, false, Date.now() - startTime, true, null, null, null, 'telegram').catch(() => {});
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

    const items = await processTextMessage(text.trim(), ctx);
    await sendBotResponse(chatId, items);
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[telegram] ERROR:', err.stack || err.message);
    logError('telegram', 'WEBHOOK_ERROR', err);
    // NEVER-SILENT (Jul 2026): avisar el fallo en vez de dejar al usuario
    // mirando el chat — un silencio es indistinguible de un registro exitoso.
    if (notifyChatId != null) {
      try {
        let failMsg = '⚠️ Algo falló procesando tu mensaje y *no guardé nada*. Probá de nuevo en un momento.';
        try {
          const { getSupportLine } = await import('../services/support-contact.js');
          const support = await getSupportLine();
          if (support) failMsg += `\n\n${support}`;
        } catch { /* sin línea de soporte */ }
        await sendTelegramMessage(notifyChatId, failMsg);
      } catch { /* el canal también falló */ }
    }
  }
}

export default router;
