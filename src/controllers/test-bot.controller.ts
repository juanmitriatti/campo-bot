/**
 * test-bot controller — endpoint de testing autenticado por JWT que ejercita el
 * MISMO pipeline que WhatsApp/Telegram (message-pipeline compartido), más
 * endpoints de QA (reset, query-db) protegidos por testEndpointGate.
 *
 * Todo el procesamiento de mensajes vive en src/services/message-pipeline.ts.
 * Acá solo queda: auth, armado del ChannelContext, transporte JSON, audio
 * (transcripción directa) y los endpoints de QA.
 */
import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { logError } from '../services/error-logger.js';
import { pool } from '../config/db.js';
import { asUserId } from '../types/index.js';
import type { SpeechToTextProvider } from '../services/audio/providers/speech-provider.interface.js';
import { createSpeechProvider } from '../services/audio/providers/provider-factory.js';
import { normalizeTranscript } from '../utils/text-normalizer.js';
import { withUserLock } from '../middleware/user-lock.js';
import {
  processTextMessage,
  handleInteractiveReply,
  hydratePendingStores,
  userRepository,
  pendingStore,
  pendingObsStore,
  pendingActStore,
  pendingCityStore,
  pendingPlotAreaStore,
  pendingFieldLocationStore,
  pendingStockEntryStore,
  pendingStockDeductionStore,
  pendingCampaignCloseStore,
} from '../services/message-pipeline.js';
import type { ChannelContext } from '../services/message-pipeline.js';

// --- Synthetic phone for in-memory stores ---

function syntheticPhone(userId: number): string {
  return `testbot_${userId}`;
}

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

async function buildContext(req: Request, startTime: number): Promise<{ ctx: ChannelContext; error?: never } | { ctx?: never; error: { status: number; message: string } }> {
  const userId = req.auth!.userId;
  const numericUserId = asUserId(typeof userId === 'string' ? parseInt(userId, 10) : userId);
  const phone = syntheticPhone(numericUserId);

  const userRow = await pool.query('SELECT id, phone_number, name, city FROM users WHERE id = $1', [numericUserId]);
  if (userRow.rows.length === 0) {
    return { error: { status: 404, message: 'Usuario no encontrado' } };
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

  return {
    ctx: {
      channel: 'testbot',
      phone,
      userId: numericUserId,
      user,
      settings,
      startTime,
    },
  };
}

// POST /api/test-bot — text + interactive replies
router.post('/', async (req: Request, res: Response) => {
  // Mismo lock por usuario + hidratación de pendings que WA/TG, para que el
  // test-bot ejercite el pipeline real (incluida la persistencia de pendings).
  const lockUserId = req.auth!.userId;
  const lockNumericId = asUserId(typeof lockUserId === 'string' ? parseInt(lockUserId, 10) : lockUserId);
  const lockPhone = syntheticPhone(lockNumericId);
  await withUserLock(`tb:${lockPhone}`, async () => {
    await hydratePendingStores(lockPhone);
    await handleTestBotMessage(req, res);
  });
});

async function handleTestBotMessage(req: Request, res: Response): Promise<void> {
  // Prod: el chat de prueba es solo-admin — un usuario final que descubra la
  // URL no debe poder escribir datos reales por acá. No-prod (docker/CI/eval)
  // sigue abierto: el eval usa este endpoint con usuarios de prueba.
  if (IS_PROD_RUNTIME && req.auth?.role !== 'admin') {
    console.warn(`[test-bot] blocked non-admin in prod: user=${req.auth?.userId}`);
    res.status(403).json({ error: 'Solo disponible para administradores.' });
    return;
  }
  const startTime = Date.now();
  try {
    const { message: inputText, interactiveReplyId } = req.body as { message?: string; interactiveReplyId?: string };
    const built = await buildContext(req, startTime);
    if (built.error) {
      res.status(built.error.status).json({ error: built.error.message });
      return;
    }
    const ctx = built.ctx;

    // --- Interactive reply handling ---
    if (interactiveReplyId) {
      const items = await handleInteractiveReply(interactiveReplyId, ctx);
      res.json({ messages: items.map(stripAttachment) });
      return;
    }

    // --- Text message ---
    if (!inputText || !inputText.trim()) {
      res.json({ messages: [{ type: 'text', text: '🤔 No te entendí. Contame qué querés hacer — ej: *gasté 50 mil en gasoil*, *sembré soja en el lote 1*, o escribí *menú*.' }] });
      return;
    }

    const items = await processTextMessage(inputText.trim(), ctx);
    res.json({ messages: items.map(stripAttachment) });
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[test-bot] ERROR:', err.stack || err.message);
    logError('test-bot', 'WEBHOOK_ERROR', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
}

/** El pipeline adjunta el binario en _attachment para los canales que lo
 *  renderizan (telegram/whatsapp); en el JSON del test-bot solo va el texto. */
function stripAttachment<T extends object>(item: T): T {
  if ('_attachment' in item) {
    const { _attachment, ...rest } = item as Record<string, unknown>;
    void _attachment;
    return rest as T;
  }
  return item;
}

// POST /api/test-bot/audio — multipart audio upload
router.post('/audio', upload.single('audio'), async (req: Request, res: Response) => {
  // Prod: el chat de prueba es solo-admin — un usuario final que descubra la
  // URL no debe poder escribir datos reales por acá. No-prod (docker/CI/eval)
  // sigue abierto: el eval usa este endpoint con usuarios de prueba.
  if (IS_PROD_RUNTIME && req.auth?.role !== 'admin') {
    console.warn(`[test-bot] blocked non-admin in prod: user=${req.auth?.userId}`);
    res.status(403).json({ error: 'Solo disponible para administradores.' });
    return;
  }
  const startTime = Date.now();
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No se recibió archivo de audio' });
      return;
    }
    const built = await buildContext(req, startTime);
    if (built.error) {
      res.status(built.error.status).json({ error: built.error.message });
      return;
    }
    const ctx = built.ctx;

    // Transcribe audio directly (bypass WhatsApp download)
    const provider = createSpeechProvider() as SpeechToTextProvider;
    const result = await provider.transcribe(req.file.buffer, req.file.mimetype);
    const transcript = normalizeTranscript(result.text);

    console.log('[test-bot] AUDIO TRANSCRIBED:', transcript);

    // Process through the same text pipeline
    const items = await processTextMessage(transcript, ctx);
    res.json({ transcript, messages: items.map(stripAttachment) });
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
    const { message: inputText } = req.body as { message?: string };
    const built = await buildContext(req, startTime);
    if (built.error) {
      res.status(built.error.status).json({ error: built.error.message });
      return;
    }
    const ctx = built.ctx;
    if (!inputText || !inputText.trim()) { res.json({ messages: [], attachment: null }); return; }
    const items = await processTextMessage(inputText.trim(), ctx);
    res.json({ messages: items.map(stripAttachment) });
  } catch (error: unknown) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/test-bot/reset — hard-delete ALL user data for clean QA testing
router.post('/reset', async (req: Request, res: Response) => {
  if (!testEndpointGate(req, res)) return;
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
    // corrals have FK to feedlots (corrals_feedlot_id_fkey) — delete them first.
    await client.query(
      `DELETE FROM corrals WHERE feedlot_id IN (SELECT id FROM feedlots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1))`,
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
/**
 * Gate de endpoints de testing peligrosos (query-db ejecuta SQL arbitrario
 * sin scoping por usuario; reset hace hard-delete). Antes solo pedían
 * `requireAuth` → CUALQUIER usuario logueado en PROD podía leer datos ajenos y
 * auto-upgradear su plan (hallazgo de seguridad QA Jun 2026).
 *
 * Regla:
 *  - Si `TEST_BOT_SECRET` está seteado → exigir header `x-test-secret` igual.
 *  - Si NO está seteado y estamos en Railway (prod) → BLOQUEAR (fail-safe:
 *    prod nunca queda abierto por olvidar setear la env).
 *  - Si NO está seteado y NO es prod (docker local) → permitir (conveniencia
 *    de dev; las QA locales corren contra localhost sin secreto).
 */
// Discriminador de prod CONFIABLE: el CI escribe `.deploy-sha` en el build
// (existe en Railway, ausente en docker local). RAILWAY_GIT_COMMIT_SHA NO está
// en runtime — solo en build —, por eso el primer intento de gate falló y el
// endpoint quedó abierto. Resuelto una vez al cargar el módulo.
const IS_PROD_RUNTIME: boolean = (() => {
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID) return true;
  try { return fs.existsSync(path.join(process.cwd(), '.deploy-sha')); } catch { return false; }
})();

function testEndpointGate(req: Request, res: Response): boolean {
  const secret = process.env.TEST_BOT_SECRET;
  const isProd = IS_PROD_RUNTIME;
  if (secret) {
    if (req.headers['x-test-secret'] !== secret) {
      res.status(403).json({ error: 'Forbidden: invalid test secret' });
      return false;
    }
    return true;
  }
  if (isProd) {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  return true;
}

router.post('/query-db', async (req: Request, res: Response) => {
  if (!testEndpointGate(req, res)) return;
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
