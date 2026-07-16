/**
 * pipeline-harness.ts — helpers para testear processTextMessage / el pipeline
 * COMPLETO (interceptores → clasificador → FakeAgent → mapper → validator →
 * handlers → DB) sin API de Anthropic. Requiere DB (Docker local o CI).
 *
 * Patrón:
 *   const h = await createPipelineHarness('mi-test');
 *   h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'La Loma' });
 *   const items = await h.send('sembré soja en La Loma');
 *   ... asserts sobre items + DB ...
 *   await h.cleanup();
 */
import { pool } from '../../config/db.js';
import {
  processTextMessage,
  handleInteractiveReply,
  hydratePendingStores,
  intentClassifier,
  userRepository,
} from '../../services/message-pipeline.js';
import type { ChannelContext, BotResponseItem } from '../../services/message-pipeline.js';
import { invalidateUserContext } from '../../ai/user-context.service.js';
import { asUserId } from '../../types/index.js';
import type { UserId } from '../../types/index.js';
import { FakeAgentService } from './fake-agent.js';

export interface PipelineHarness {
  userId: UserId;
  phone: string;
  fakeAgent: FakeAgentService;
  /** Manda un texto por el pipeline completo. */
  send(text: string): Promise<BotResponseItem[]>;
  /** Simula un tap de botón. */
  tap(callbackId: string): Promise<BotResponseItem[]>;
  /** SQL directo (setup/asserts). */
  q(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Junta el texto de todos los items (incl. cuerpos interactivos). */
  allText(items: BotResponseItem[]): string;
  /** Junta los botones de todos los items. */
  allButtons(items: BotResponseItem[]): Array<{ id: string; title: string }>;
  /** Borra al usuario de prueba y todos sus datos. */
  cleanup(): Promise<void>;
}

// Settings que definen el CAMINO del pipeline — el harness los fija en
// paridad con producción para que los tests ejerciten las mismas capas en
// cualquier entorno (la DB fresca de CI trae AGENT_ENABLED apagado y sin esto
// el classifier ni llama al FakeAgent: los tests pasan/fallan por el motivo
// equivocado). El cache de settings (5 min) no molesta: el upsert corre en
// beforeAll, antes de la primera lectura del proceso vitest.
const HARNESS_SETTINGS: Record<string, string> = {
  AGENT_ENABLED: 'true',
  AGENT_OUTPUT_VALIDATION_ENABLED: 'true',
  AGENT_VALIDATE_CROP: 'true',
  AGENT_VALIDATE_PLOT_FIELD: 'true',
  AGENT_CORRECTION_PRE_CLASSIFIER_ENABLED: 'true',
  SUPPORT_CONTACT: 'soporte@test.local',
};

export async function createPipelineHarness(slug: string): Promise<PipelineHarness> {
  const email = `it-${slug}@pipeline-harness.test.local`;
  for (const [key, value] of Object.entries(HARNESS_SETTINGS)) {
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }
  // Usuario limpio, plan enterprise (features completas), SIN fila de
  // subscription → grandfathered → el access gate lo deja pasar.
  await deleteUserByEmail(email);
  const u = await pool.query(
    `INSERT INTO users (name, email, password_hash, plan_id) VALUES ($1, $2, 'x', 4) RETURNING id`,
    [`IT ${slug}`, email],
  );
  const userId = asUserId(u.rows[0].id as number);
  const phone = `testbot_${userId}`;
  await pool.query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);

  const fakeAgent = new FakeAgentService();
  intentClassifier.setAgentServiceForTests(fakeAgent);

  const buildCtx = async (): Promise<ChannelContext> => {
    const settings = await userRepository.getSettings(userId);
    return {
      channel: 'testbot',
      phone,
      userId,
      user: { id: userId, phone_number: phone, name: `IT ${slug}`, city: null },
      settings,
      startTime: 0,
    } as ChannelContext;
  };

  const send = async (text: string): Promise<BotResponseItem[]> => {
    // Los tests crean entidades por SQL directo — el caché de 60s del
    // UserContextService no se entera; invalidamos como haría el router.
    invalidateUserContext(userId);
    await hydratePendingStores(phone);
    const ctx = await buildCtx();
    return processTextMessage(text, ctx);
  };

  const tap = async (callbackId: string): Promise<BotResponseItem[]> => {
    invalidateUserContext(userId);
    await hydratePendingStores(phone);
    const ctx = await buildCtx();
    return handleInteractiveReply(callbackId, ctx);
  };

  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  const allText = (items: BotResponseItem[]): string =>
    items
      .map(i => [i.text, i.interactive?.body].filter(Boolean).join('\n'))
      .join('\n');

  const allButtons = (items: BotResponseItem[]): Array<{ id: string; title: string }> => {
    const out: Array<{ id: string; title: string }> = [];
    for (const i of items) {
      if (i.interactive?.buttons) out.push(...i.interactive.buttons);
      if (i.interactive?.sections) for (const s of i.interactive.sections) out.push(...(s.rows ?? []));
    }
    return out;
  };

  const cleanup = async () => deleteUserByEmail(email);

  return { userId, phone, fakeAgent, send, tap, q, allText, allButtons, cleanup };
}

/**
 * Hard-delete del usuario de prueba y TODOS sus datos. Dinámico: descubre las
 * tablas con columna user_id vía information_schema y borra en multi-pass
 * (3 pasadas resuelven el orden FK sin enumerar 50 tablas a mano). Las tablas
 * hijas SIN user_id (plots, corrals, harvest_loads, etc.) se borran primero.
 * Si al final el usuario sigue existiendo, TIRA — un cleanup silenciosamente
 * roto deja emails duplicados que rompen la próxima corrida.
 */
async function deleteUserByEmail(email: string): Promise<void> {
  const r = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (r.rows.length === 0) return;
  const uid = r.rows[0].id;
  const run = (sql: string) => pool.query(sql, [uid]).catch(() => {});

  // Hijas SIN user_id directo — van ADENTRO del multi-pass: pueden estar
  // bloqueadas por tablas con user_id que se borran en la misma pasada (ej:
  // livestock_groups.corral_id bloquea corrals hasta que se borre el grupo).
  const childDeletes = [
    `DELETE FROM observation_history WHERE observation_id IN (SELECT id FROM agro_observations WHERE user_id = $1)`,
    `DELETE FROM harvest_loads WHERE domain_event_id IN (SELECT id FROM domain_events WHERE user_id = $1)`,
    `DELETE FROM corrals WHERE feedlot_id IN (SELECT id FROM feedlots WHERE user_id = $1)`,
    `DELETE FROM stock_items WHERE warehouse_id IN (SELECT id FROM warehouses WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1))`,
    `DELETE FROM warehouses WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`,
    `DELETE FROM plot_aliases WHERE plot_id IN (SELECT p.id FROM plots p JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1)`,
    `DELETE FROM plot_crops WHERE plot_id IN (SELECT p.id FROM plots p JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1)`,
    `DELETE FROM crop_stages WHERE plot_id IN (SELECT p.id FROM plots p JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1)`,
    `DELETE FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`,
    `DELETE FROM payment_events WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = $1)`,
    `DELETE FROM pending_states WHERE phone = 'testbot_' || $1::text`,
  ];

  const tablesR = await pool.query(
    `SELECT DISTINCT table_name FROM information_schema.columns
     WHERE column_name = 'user_id' AND table_schema = 'public' AND table_name <> 'users'`,
  );
  const tables: string[] = tablesR.rows.map((x: { table_name: string }) => x.table_name);
  for (let pass = 0; pass < 3; pass++) {
    for (const sql of childDeletes) await run(sql);
    for (const t of tables) await run(`DELETE FROM "${t}" WHERE user_id = $1`);
  }

  await pool.query(`DELETE FROM users WHERE id = $1`, [uid]); // sin catch: si falla, que se vea
  const left = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [uid]);
  if (left.rows.length > 0) throw new Error(`pipeline-harness: no pude borrar el usuario de prueba ${email} (#${uid})`);
}
