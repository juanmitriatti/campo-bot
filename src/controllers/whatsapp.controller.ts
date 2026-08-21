/**
 * whatsapp controller — webhook de WhatsApp Cloud API. El procesamiento de
 * mensajes vive en src/services/message-pipeline.ts y el de documentos en
 * src/services/document-pipeline.ts (compartidos con telegram/test-bot).
 * Acá solo queda lo específico del canal: verificación del webhook, parseo del
 * payload, gate de canal (OTP), audio (rate-limit + transcripción), recepción
 * de imágenes/PDF, ubicación compartida y render de los BotResponseItem vía la
 * Cloud API.
 *
 * Histórico: este controller tenía ~2000 líneas de pipeline inline en modo push
 * (sendMessage por branch). Convertido a modo collect (items → render al final)
 * al unificar con el message-pipeline, Jun 2026.
 */
import express from 'express';
import type { Request, Response } from 'express';
import { sendMessage, uploadMedia, sendDocument, sendInteractiveButtons, sendInteractiveList, sendFlow, downloadMedia } from '../services/whatsapp.js';
import { MessageDedup } from '../middleware/dedup.js';
import { TranscriptionService, AudioTooLongError } from '../services/audio/transcription.service.js';
import { getAudioConfig } from '../services/audio/audio.types.js';
import { saveAudioTranscriptionLog } from '../services/expenses.js';
import { getSetting } from '../services/settings.service.js';
import { logError } from '../services/error-logger.js';
import { normalizeTranscript } from '../utils/text-normalizer.js';
import { DocumentError } from '../domain/documents/document.service.js';
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
const transcriptionService = new TranscriptionService();
const handleWaDocCallback = makeDocCallbackHandler(downloadMedia);

// --- Send bot response items via WhatsApp Cloud API ---

async function sendBotResponse(phone: string, items: BotResponseItem[]): Promise<void> {
  for (const item of items) {
    try {
      if (item.type === 'text' && item.text) {
        // Check for attachment marker (PDF/imagen del pipeline)
        const attachment = (item as any)._attachment;
        if (attachment?.buffer) {
          const mediaId = await uploadMedia(attachment.buffer, attachment.filename, attachment.mime);
          await sendDocument(phone, mediaId, attachment.filename, attachment.caption);
        } else {
          await sendMessage(phone, item.text);
        }
      } else if (item.type === 'interactive' && item.interactive) {
        if (item.interactive.type === 'buttons' && item.interactive.buttons) {
          await sendInteractiveButtons(phone, item.interactive.body, item.interactive.buttons);
        } else if (item.interactive.type === 'list' && item.interactive.sections) {
          await sendInteractiveList(phone, item.interactive.body, item.interactive.buttonText, item.interactive.sections);
        } else if (item.interactive.type === 'flow' && item.interactive.flow) {
          await sendFlow(phone, item.interactive.body, item.interactive.flow);
        }
      }
    } catch (err) {
      // Mismo contrato que telegram: un fallo de envío NUNCA es silencioso —
      // intentamos un fallback en texto plano para que el usuario vea algo.
      const errMsg = String((err as any)?.message || err || 'unknown');
      console.error('[whatsapp] Error sending response item:', err, '— attempting fallback');
      logError('whatsapp', 'SEND_RESPONSE', err as Error, {
        context: { phone, itemType: item.type, errMsg },
      });
      try {
        const bodyText = item.type === 'interactive' && item.interactive?.body
          ? item.interactive.body
          : (item.text || '');
        if (bodyText) {
          const plain = bodyText.replace(/[*_`]/g, '');
          await sendMessage(phone, plain);
        } else {
          await sendMessage(phone, '⚠️ Hubo un problema mostrando esta respuesta. Probá de nuevo o pedímelo de otra forma.');
        }
      } catch (fallbackErr) {
        console.error('[whatsapp] Fallback message also failed:', fallbackErr);
        logError('whatsapp', 'SEND_RESPONSE_FALLBACK', fallbackErr as Error, { context: { phone } });
      }
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

// POST /webhook — Message handler.
// Serializado por usuario: mensajes del mismo número se procesan en orden
// (dos mensajes rápidos pisaban el pending del primero); usuarios distintos
// siguen en paralelo. Antes de procesar se hidratan los pending stores desde
// DB para que un restart no pierda los pendings en vuelo.
router.post('/', (req: Request, res: Response) => {
  const lockPhone: string | undefined = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
  if (!lockPhone) {
    void handleWhatsAppWebhook(req, res);
    return;
  }
  void withUserLock(`wa:${lockPhone}`, async () => {
    await hydratePendingStores(lockPhone);
    await handleWhatsAppWebhook(req, res);
  }).catch((err) => {
    console.error('WA LOCK ERROR:', (err as Error).message);
    if (!res.headersSent) res.sendStatus(500);
  });
});

async function handleWhatsAppWebhook(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  // Para el catch final: si ya sabemos a quién responder, avisamos del fallo.
  let notifyPhone: string | null = null;
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
    notifyPhone = phone;
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
      } else if ((interactiveData as { type?: string })?.type === 'nfm_reply') {
        // WhatsApp Flow response (DARK: aún no se envían Flows; si llega algo, entra
        // por el MISMO path de submit que la Mini App — invariante 1: se loguea).
        try {
          const raw = (interactiveData as { nfm_reply?: { response_json?: string } }).nfm_reply?.response_json;
          const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : null;
          const flowToken = parsed?.flow_token as string | undefined;
          console.log('[FORM] nfm_reply recibido, flow_token presente:', !!flowToken);
          if (flowToken && parsed) {
            const { submitForm } = await import('../forms/form-submit.service.js');
            const result = await submitForm(flowToken, parsed);
            if (!result.ok) await sendMessage(phone, result.error);
            // En éxito submitForm ya mandó la confirmación al chat.
          }
        } catch (err) {
          console.error('[FORM] nfm_reply inválido:', err);
        }
        res.sendStatus(200);
        return;
      }

      if (callbackId) {
        console.log('FROM:', phone, 'INTERACTIVE:', callbackId);
        const user = await userRepository.getOrCreate(phone);
        const userId = user.id;
        const settings = await userRepository.getSettings(userId);
        const ctx: ChannelContext = {
          channel: 'whatsapp', phone, userId, user, settings, startTime,
          handleDocCallback: handleWaDocCallback,
        };
        const items = await handleInteractiveReply(callbackId, ctx);
        await sendBotResponse(phone, items);
      }
      res.sendStatus(200);
      return;
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
        await sendMessage(phone, await trialExpiredCopy());
        res.sendStatus(200);
        return;
      }
      const hasAudio = await featureGate.hasFeature(user.id, 'audio');
      if (!hasAudio) {
        await sendMessage(phone, '🔒 El procesamiento de audios no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.');
        res.sendStatus(200);
        return;
      }

      // Rate-limit horario (guard compartido con Telegram). WhatsApp no conoce
      // la duración antes de descargar — el largo lo corta TranscriptionService
      // (AudioTooLongError) con la estimación por tamaño.
      const { checkAudioGuards } = await import('../services/audio/audio-guards.js');
      const guard = await checkAudioGuards(user.id);
      if (!guard.ok) {
        await sendMessage(phone, guard.message);
        res.sendStatus(200);
        return;
      }

      try {
        const result = await transcriptionService.processAudio(
          message.audio.id,
          message.audio.mime_type || 'audio/ogg',
        );
        text = normalizeTranscript(result.transcription);  // Clean STT artifacts before pipeline
        console.log('FROM:', phone, 'AUDIO TRANSCRIBED:', text);

        // Eco de transcripción (configurable): el usuario ve qué entendió el
        // STT y puede corregir — sin esto una transcripción mala era invisible.
        try {
          const { buildTranscriptEcho } = await import('../services/audio/transcript-echo.js');
          const echo = await buildTranscriptEcho(text);
          if (echo) await sendMessage(phone, echo);
        } catch { /* best-effort: el eco jamás bloquea el procesamiento */ }

        // Log audio transcription cost (precio configurable en admin, grupo audio)
        try {
          const durationSeconds = result.estimatedDurationSeconds || 0;
          const durationMinutes = durationSeconds / 60;
          const { getSettingNumber } = await import('../services/settings.service.js');
          const pricePerMinute = (await getSettingNumber('WHISPER_PRICE_PER_MINUTE')) ?? 0.006;
          const costUsd = durationMinutes * pricePerMinute;
          const audioConfig = getAudioConfig();
          await saveAudioTranscriptionLog(user.id, {
            durationSeconds,
            provider: result.providerName || audioConfig.provider,
            model: (result as { model?: string }).model || audioConfig.openaiWhisperModel,
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
          await sendMessage(phone, '⚠️ El audio es demasiado largo. Enviá un audio más corto o escribí el mensaje.');
        } else {
          await sendMessage(phone, 'No pude entender el audio. ¿Podrías escribirlo o enviar otro audio?');
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
        const settings = await userRepository.getSettings(userId);
        const ctx: ChannelContext = {
          channel: 'whatsapp', phone, userId, user, settings, startTime,
          handleDocCallback: handleWaDocCallback,
        };

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
            const buffer = await downloadMedia(mediaId);
            const items = await processDocumentWithIntent(ctx, buffer, mediaMime, filename, caption, docIntent);
            await sendBotResponse(phone, items);
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

          conversationLogger.log(userId, phone, `[image_received:${mediaMime}]`, 'Awaiting document intent', 'command', 'document_intent_prompt', null, null, false, Date.now() - startTime, true, null, null, null, 'whatsapp').catch(() => {});
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

    console.log('FROM:', phone, 'TEXT:', text);

    const user = await userRepository.getOrCreate(phone);
    const userId = user.id;
    const settings = await userRepository.getSettings(userId);
    const ctx: ChannelContext = {
      channel: 'whatsapp', phone, userId, user, settings, startTime,
      handleDocCallback: handleWaDocCallback,
    };

    const items = await processTextMessage(text.trim(), ctx);
    await sendBotResponse(phone, items);
    res.sendStatus(200);
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[whatsapp] ERROR:', err.stack || err.message);
    logError('whatsapp', 'WEBHOOK_ERROR', err);
    // NEVER-SILENT (Jul 2026): este catch era la única grieta del principio —
    // cualquier throw de un handler dejaba al usuario SIN respuesta, y un
    // silencio es indistinguible de un registro exitoso. Best-effort.
    if (notifyPhone) {
      try {
        let failMsg = '⚠️ Algo falló procesando tu mensaje y *no guardé nada*. Probá de nuevo en un momento.';
        try {
          const { getSupportLine } = await import('../services/support-contact.js');
          const support = await getSupportLine();
          if (support) failMsg += `\n\n${support}`;
        } catch { /* sin línea de soporte */ }
        await sendMessage(notifyPhone, failMsg);
      } catch { /* el canal también falló — nada más que hacer */ }
    }
    if (!res.headersSent) res.sendStatus(200);
  }
}

export default router;
