/**
 * ai-quota.service.ts — cuota diaria de llamadas a Claude por usuario.
 *
 * FUENTE ÚNICA de la regla "¿cuántas consultas de IA puede hacer hoy?".
 * Antes vivía copiada en agent.service, intent-extractor y
 * conversational-fallback (tres `getAiDailyLimit` idénticos); el tab
 * "Análisis de datos" del dashboard hubiera sido la cuarta copia.
 *
 * Qué cuenta: cada fila de `ai_usage` de hoy (la escribe `saveAiUsage`), así
 * que bot y dashboard comparten el mismo tope — decisión de producto, Sep 2026.
 *
 * Límite: `plans.daily_ai_limit` del plan del usuario; si el plan no lo fija,
 * `user_settings.claude_daily_limit`; si tampoco, 50.
 */

import { PlanRepository } from '../domain/billing/plan.repository.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { limitNotifier } from './limit-notifier.service.js';
import type { UserId, UserSettings } from '../types/index.js';

export interface AiQuota {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  planName: string | null;
}

export class AiQuotaExceededError extends Error {
  readonly status = 429;
  readonly code = 'AI_QUOTA_EXCEEDED';
  constructor(public readonly quota: AiQuota) {
    super(`Llegaste al tope diario de consultas de IA de tu plan (${quota.limit}). Se renueva mañana.`);
    this.name = 'AiQuotaExceededError';
  }
}

const DEFAULT_LIMIT = 50;

let planRepo: PlanRepository | null = null;
let userRepo: UserRepository | null = null;
function repos(): { plans: PlanRepository; users: UserRepository } {
  if (!planRepo) planRepo = new PlanRepository();
  if (!userRepo) userRepo = new UserRepository();
  return { plans: planRepo, users: userRepo };
}

/** Test seam: inyectar repos falsos (los tests de agent.service ya mockean PlanRepository por su lado). */
export function setAiQuotaReposForTests(fake: { plans?: PlanRepository; users?: UserRepository } | null): void {
  planRepo = fake?.plans ?? null;
  userRepo = fake?.users ?? null;
}

/**
 * Tope diario. `settings` es opcional: los callers del pipeline ya lo tienen
 * cargado y evitan una query; el dashboard lo deja que se lea acá.
 */
export async function getAiDailyLimit(userId: UserId, settings?: UserSettings | null): Promise<number> {
  const { plans, users } = repos();
  try {
    const fromPlan = await plans.getUserPlanAiLimit(userId);
    if (fromPlan != null) return fromPlan;
  } catch {
    // Plan lookup failed — use fallback
  }
  let s = settings ?? null;
  if (!s) {
    try { s = await users.getSettings(userId); } catch { s = null; }
  }
  return s?.claude_daily_limit || DEFAULT_LIMIT;
}

export async function getAiQuota(userId: UserId, settings?: UserSettings | null): Promise<AiQuota> {
  const { plans, users } = repos();
  const [limit, used] = await Promise.all([
    getAiDailyLimit(userId, settings),
    users.getDailyClaudeCount(userId),
  ]);
  let planName: string | null = null;
  try { planName = (await plans.getUserPlan(userId))?.name ?? null; } catch { /* solo para el log */ }
  return { used, limit, remaining: Math.max(0, limit - used), exhausted: used >= limit, planName };
}

/**
 * Lanza AiQuotaExceededError (status 429) si el usuario ya no tiene cupo hoy.
 * Avisa por el canal del bot UNA vez por día (limitNotifier dedupea), igual
 * que cuando el tope lo alcanza el bot: el usuario tiene que enterarse de por
 * qué no le contestan, venga de donde venga la consulta.
 */
export async function assertAiQuota(userId: UserId, settings?: UserSettings | null): Promise<AiQuota> {
  const quota = await getAiQuota(userId, settings);
  if (quota.exhausted) {
    void limitNotifier.maybeNotifyHit({
      userId: Number(userId),
      used: quota.used,
      limit: quota.limit,
      planName: quota.planName,
    });
    throw new AiQuotaExceededError(quota);
  }
  return quota;
}
