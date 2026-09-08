/**
 * data-analysis.routes.ts — POST /api/auth/data-analysis (+ GET .../quota).
 *
 * El tab "Análisis de datos" del dashboard: el usuario elige campo, lote(s) y
 * campaña, escribe una pregunta y recibe un análisis de Claude sobre SUS
 * datos. Montado en app.ts bajo el mismo prefijo que auth.routes para que el
 * front use apiRequest('/data-analysis').
 *
 * Flujo: validar body → alcance (campo propio o compartido, lotes de esos
 * campos) → cuota diaria (compartida con el bot) → JSON de datos → Claude.
 * Cada salida anómala tiene su código y su mensaje en castellano; nada
 * termina en un 500 mudo.
 *
 * `createDataAnalysisRouter(deps)` existe para testear la ruta in-process con
 * fakes (sin Anthropic ni DB); el default usa las implementaciones reales.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import { getSettingNumber } from '../services/settings.service.js';
import { resolveFieldIds } from '../services/overview.service.js';
import { resolveCampaign, type CampaignRange } from '../utils/campaign-range.js';
import {
  buildAnalysisContext, resolvePlotIds, ScopeError,
  type AnalysisContext, type AnalysisLimits, type AnalysisScope,
} from '../services/data-analysis-context.service.js';
import { dataAnalysisService, type AnalysisResult, type AnalysisTurn } from '../ai/data-analysis.service.js';
import { assertAiQuota, getAiQuota, AiQuotaExceededError, type AiQuota } from '../services/ai-quota.service.js';
import { logError } from '../services/error-logger.js';
import type { UserId } from '../types/index.js';

export interface DataAnalysisDeps {
  buildContext: (scope: AnalysisScope, limits: AnalysisLimits) => Promise<{ context: AnalysisContext; json: string }>;
  analyze: (userId: number, args: { question: string; history: AnalysisTurn[]; dataJson: string; truncation: AnalysisContext['truncation']; scopeLabel?: string }) => Promise<AnalysisResult | null>;
  assertQuota: (userId: UserId) => Promise<AiQuota>;
  getQuota: (userId: UserId) => Promise<AiQuota>;
  resolvePlots: (userId: number, fieldIds: number[], plotIds: number[]) => Promise<number[]>;
  /** Campo propio o compartido con el usuario. */
  fieldAccessible: (userId: number, fieldId: number) => Promise<boolean>;
  resolveFields: (userId: number, fieldId: number | null) => Promise<number[]>;
  /** Middlewares: reemplazables en tests in-process. */
  auth: (req: Request, res: Response, next: NextFunction) => void;
  feature: (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
}

const DEFAULT_MAX_QUESTION_CHARS = 1000;
const DEFAULT_MAX_HISTORY_TURNS = 6;
const DEFAULT_MAX_ROWS = 150;
const DEFAULT_MAX_CHARS = 60000;
const MAX_PLOTS = 50;
const MAX_TURN_CHARS = 4000;

async function fieldAccessibleReal(userId: number, fieldId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM fields f
      WHERE f.id = $1 AND f.deleted_at IS NULL
        AND (f.user_id = $2 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $2))
      LIMIT 1`,
    [fieldId, userId],
  );
  return rows.length > 0;
}

export const defaultDeps: DataAnalysisDeps = {
  buildContext: buildAnalysisContext,
  analyze: (userId, args) => dataAnalysisService.analyze(userId, args),
  assertQuota: assertAiQuota,
  getQuota: getAiQuota,
  resolvePlots: resolvePlotIds,
  fieldAccessible: fieldAccessibleReal,
  resolveFields: resolveFieldIds,
  auth: requireAuth,
  feature: requireFeature('data_analysis'),
};

class BadRequest extends Error {
  readonly status = 400;
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

interface ParsedBody {
  fieldId: number | null;
  plotIds: number[] | null;
  range: CampaignRange;
  question: string;
  history: AnalysisTurn[];
}

function parseBody(body: unknown, limits: { maxQuestion: number; maxTurns: number }): ParsedBody {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  let fieldId: number | null;
  if (b.field_id === 'all' || b.field_id === null || b.field_id === undefined) fieldId = null;
  else {
    const n = typeof b.field_id === 'number' ? b.field_id : parseInt(String(b.field_id), 10);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequest('FIELD_ID_INVALID', 'field_id tiene que ser un id de campo o "all".');
    fieldId = n;
  }

  let plotIds: number[] | null = null;
  if (b.plot_ids !== undefined && b.plot_ids !== null) {
    if (!Array.isArray(b.plot_ids)) throw new BadRequest('PLOT_IDS_INVALID', 'plot_ids tiene que ser una lista de ids.');
    if (fieldId == null && b.plot_ids.length > 0) throw new BadRequest('PLOT_IDS_WITHOUT_FIELD', 'Para elegir lotes primero elegí un campo.');
    const ids = [...new Set((b.plot_ids as unknown[]).map((v) => (typeof v === 'number' ? v : parseInt(String(v), 10))))];
    if (ids.some((v) => !Number.isInteger(v) || v <= 0)) throw new BadRequest('PLOT_IDS_INVALID', 'plot_ids tiene que ser una lista de ids.');
    if (ids.length > MAX_PLOTS) throw new BadRequest('PLOT_IDS_TOO_MANY', `Como mucho ${MAX_PLOTS} lotes por consulta.`);
    plotIds = ids.length > 0 ? ids : null;
  }

  // resolveCampaign entiende strings ("2025", "25/26"); del JSON llega número.
  const range = resolveCampaign(b.season == null ? undefined : String(b.season));

  const question = String(b.question ?? '').trim();
  if (!question) throw new BadRequest('QUESTION_REQUIRED', 'Escribí qué querés analizar.');
  if (question.length > limits.maxQuestion) throw new BadRequest('QUESTION_TOO_LONG', `La pregunta no puede superar ${limits.maxQuestion} caracteres.`);

  let history: AnalysisTurn[] = [];
  if (b.history !== undefined && b.history !== null) {
    if (!Array.isArray(b.history)) throw new BadRequest('HISTORY_INVALID', 'history tiene que ser una lista de turnos.');
    if (b.history.length > limits.maxTurns * 2) throw new BadRequest('HISTORY_TOO_LONG', `Como mucho ${limits.maxTurns} repreguntas por hilo. Empezá una consulta nueva.`);
    history = (b.history as unknown[]).map((t) => {
      const turn = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
      if (turn.role !== 'user' && turn.role !== 'assistant') throw new BadRequest('HISTORY_INVALID', 'Cada turno lleva role user|assistant.');
      if (typeof turn.content !== 'string' || turn.content.length > MAX_TURN_CHARS) throw new BadRequest('HISTORY_INVALID', 'Cada turno lleva content de texto (máx 4000 caracteres).');
      return { role: turn.role, content: turn.content };
    });
  }

  return { fieldId, plotIds, range, question, history };
}

export function createDataAnalysisRouter(deps: DataAnalysisDeps = defaultDeps): Router {
  const router = Router();

  router.get('/data-analysis/quota', deps.auth, deps.feature, async (req: Request, res: Response) => {
    try {
      const quota = await deps.getQuota(req.auth!.userId as unknown as UserId);
      res.json({ quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining } });
    } catch (err) {
      logError('data-analysis', 'QUOTA_ROUTE_ERROR', err as Error, { userId: req.auth?.userId });
      res.status(500).json({ error: 'No pude leer tu cupo de consultas.' });
    }
  });

  router.post('/data-analysis', deps.auth, deps.feature, async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    try {
      const [maxQuestion, maxTurns, maxRows, maxChars] = await Promise.all([
        getSettingNumber('DATA_ANALYSIS_MAX_QUESTION_CHARS'),
        getSettingNumber('DATA_ANALYSIS_MAX_HISTORY_TURNS'),
        getSettingNumber('DATA_ANALYSIS_MAX_ROWS_PER_LIST'),
        getSettingNumber('DATA_ANALYSIS_MAX_DATA_CHARS'),
      ]);
      const parsed = parseBody(req.body, {
        maxQuestion: maxQuestion ?? DEFAULT_MAX_QUESTION_CHARS,
        maxTurns: maxTurns ?? DEFAULT_MAX_HISTORY_TURNS,
      });

      if (parsed.fieldId != null && !(await deps.fieldAccessible(userId, parsed.fieldId))) {
        res.status(404).json({ error: 'No encontré ese campo.', code: 'FIELD_NOT_FOUND' });
        return;
      }
      const fieldIds = await deps.resolveFields(userId, parsed.fieldId);
      const plotIds = parsed.plotIds ? await deps.resolvePlots(userId, fieldIds, parsed.plotIds) : null;

      const quotaBefore = await deps.assertQuota(userId as unknown as UserId);

      const scope: AnalysisScope = {
        userId,
        fieldIds,
        plotIds: plotIds && plotIds.length > 0 ? plotIds : null,
        includeUnassigned: parsed.fieldId == null,
        range: parsed.range,
      };
      const { context, json } = await deps.buildContext(scope, {
        maxRowsPerList: maxRows ?? DEFAULT_MAX_ROWS,
        maxChars: maxChars ?? DEFAULT_MAX_CHARS,
      });

      const scopeLabel = `${parsed.range.label} · ${context.meta.fields.map((f) => f.name).join(', ') || 'todos'}${scope.plotIds ? ` · lotes ${context.meta.plots.map((p) => p.name).join(', ')}` : ''}`;
      const result = await deps.analyze(userId, {
        question: parsed.question,
        history: parsed.history,
        dataJson: json,
        truncation: context.truncation,
        scopeLabel,
      });
      if (!result) {
        res.status(503).json({
          error: 'El análisis con IA no está disponible en este momento. Probá de nuevo en unos minutos.',
          code: 'AI_UNAVAILABLE',
        });
        return;
      }

      // La llamada recién contada: used+1 sin volver a la base.
      const used = quotaBefore.used + 1;
      res.json({
        answer: result.answer,
        model: result.model,
        scope: {
          campaign: parsed.range.label,
          from: parsed.range.from,
          to: parsed.range.to,
          fieldIds,
          plotIds: scope.plotIds,
          fieldNames: context.meta.fields.map((f) => f.name),
          plotNames: context.meta.plots.map((p) => p.name),
        },
        truncated: context.truncation,
        quota: { used, limit: quotaBefore.limit, remaining: Math.max(0, quotaBefore.limit - used) },
        usage: result.usage,
      });
    } catch (err) {
      if (err instanceof BadRequest || err instanceof ScopeError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof AiQuotaExceededError) {
        res.status(429).json({ error: err.message, code: err.code, quota: { used: err.quota.used, limit: err.quota.limit, remaining: err.quota.remaining } });
        return;
      }
      logError('data-analysis', 'ROUTE_ERROR', err as Error, { userId });
      res.status(500).json({ error: 'No pude correr el análisis. Probá de nuevo en un rato.' });
    }
  });

  return router;
}

export default createDataAnalysisRouter();
