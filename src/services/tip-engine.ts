/**
 * tip-engine.ts — Motor de tips contextuales de primera vez.
 *
 * Se engancha en DomainRouter tras CADA comando exitoso (cubre los 3 canales,
 * pendings re-ruteados y botones con un solo hook). Reglas:
 *
 *   1. Solo tras acciones EXITOSAS: nunca sobre errores, preguntas abiertas
 *      ("¿en qué lote?"), confirmaciones pendientes ni pasos de compound
 *      (bulkMode ya tiene bastante ruido propio).
 *   2. Tope diario (TIPS_MAX_PER_DAY, default 1) y cada tip UNA sola vez en
 *      la vida del usuario (user_settings.tips_shown).
 *   3. Configurable: kill switch global TIPS_ENABLED (admin) + opt-out por
 *      usuario ("no me des más tips" → user_settings.tips_enabled=false).
 *   4. Tips de features gateadas (stock/livestock/docs) se muestran solo si
 *      el plan del usuario las tiene (FeatureGate) — nunca invitar a una
 *      puerta cerrada.
 *   5. Usuarios de test (phone testbot_*) quedan EXCLUIDOS — un tip extra en
 *      medio de una aserción rompería eval/QA sin aportar nada.
 *
 * Fail-open silencioso: cualquier error acá se loguea y el mensaje del
 * usuario sale igual — un tip jamás puede romper una respuesta.
 */
import { pool } from '../config/db.js';
import { getSettingBool, getSettingNumber } from './settings.service.js';
import { getTodayISO } from '../utils/date.js';
import { TIPS_CATALOG, type Tip } from './tips-catalog.js';
import { FeatureGate } from '../domain/billing/feature-gate.js';
import { asUserId } from '../types/index.js';
import type { ParsedCommand, HandlerResponse, User } from '../types/index.js';

// Índice comando → tips (en orden de catálogo), precomputado una vez.
const TRIGGER_INDEX: Map<string, Tip[]> = (() => {
  const idx = new Map<string, Tip[]>();
  for (const tip of TIPS_CATALOG) {
    for (const cmd of tip.triggerCommands) {
      const list = idx.get(cmd) ?? [];
      list.push(tip);
      idx.set(cmd, list);
    }
  }
  return idx;
})();

const OPT_OUT_FOOTER = '\n_(si no querés estos consejos, decime "no más tips")_';

/** ¿La respuesta representa una acción completada (no un error/pregunta)? */
function looksSuccessful(response: HandlerResponse): boolean {
  const fx = response.sideEffects;
  if (fx?.setPending || fx?.setPendingActivity || fx?.startFlow || fx?.setPendingObservation) return false;
  const first = response.messages?.[0];
  if (!first && !response.interactive) return false;
  if (first) {
    const head = first.slice(0, 60);
    if (/^[❌⚠️🔍]/u.test(head)) return false;
    if (head.includes('¿')) return false; // pregunta abierta = acción incompleta
    if (/^no\s/i.test(head.trim())) return false; // "No encontré...", "No pude..."
  }
  return true;
}

export class TipEngine {
  constructor(private featureGate: FeatureGate) {}

  /**
   * Devuelve el texto del tip a anexar (y lo marca como visto), o null.
   * NUNCA tira: los errores se loguean y devuelven null.
   */
  async maybeGetTip(
    cmd: ParsedCommand,
    response: HandlerResponse,
    userId: number,
    user: User | null | undefined,
  ): Promise<string | null> {
    try {
      const candidates = TRIGGER_INDEX.get(cmd.command as string);
      if (!candidates || candidates.length === 0) return null;
      if ((cmd as ParsedCommand & { _bulkMode?: boolean })._bulkMode === true) return null;
      if (!looksSuccessful(response)) return null;
      // Usuarios de test-bot: los tips romperían aserciones de eval/QA.
      if (user?.phone_number?.startsWith('testbot_')) return null;

      if (await getSettingBool('TIPS_ENABLED') !== true) return null;
      const maxPerDay = (await getSettingNumber('TIPS_MAX_PER_DAY')) || 1;

      const { rows } = await pool.query(
        `SELECT tips_enabled, tips_shown, last_tip_date::text, last_tip_count
         FROM user_settings WHERE user_id = $1`,
        [userId],
      );
      // Sin fila de settings → sin estado de tips; no mostramos (la fila se
      // crea en buildContext de los controllers, así que esto es raro).
      if (rows.length === 0) return null;
      const st = rows[0] as { tips_enabled: boolean; tips_shown: string[]; last_tip_date: string | null; last_tip_count: number };
      if (st.tips_enabled === false) return null;

      const today = getTodayISO();
      const todayCount = st.last_tip_date === today ? (st.last_tip_count ?? 0) : 0;
      if (todayCount >= maxPerDay) return null;

      const shown = new Set<string>(Array.isArray(st.tips_shown) ? st.tips_shown : []);
      let picked: Tip | null = null;
      for (const tip of candidates) {
        if (shown.has(tip.key)) continue;
        if (tip.requiresFeature && !(await this.featureGate.hasFeature(asUserId(userId), tip.requiresFeature))) continue;
        if (tip.condition) {
          try {
            if (!(await tip.condition(userId))) continue;
          } catch { continue; /* best-effort: condición rota = tip salteado */ }
        }
        picked = tip;
        break;
      }
      if (!picked) return null;

      await pool.query(
        `UPDATE user_settings
         SET tips_shown = tips_shown || to_jsonb($2::text),
             last_tip_date = $3::date,
             last_tip_count = CASE WHEN last_tip_date = $3::date THEN last_tip_count + 1 ELSE 1 END
         WHERE user_id = $1`,
        [userId, picked.key, today],
      );
      console.log(`[tips] shown key=${picked.key} user=${userId} trigger=${cmd.command}`);

      // El primer tip de la vida del usuario lleva el pie de opt-out.
      return shown.size === 0 ? picked.text + OPT_OUT_FOOTER : picked.text;
    } catch (err) {
      console.warn('[tips] maybeGetTip failed (fail-open):', (err as Error).message);
      return null;
    }
  }
}

// Singleton compartido: un solo estado de FeatureGate-cache para el router y
// los sitios de confirmación del pipeline (que bypasean routeCommand).
export const tipEngine = new TipEngine(new FeatureGate());
