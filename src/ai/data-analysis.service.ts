/**
 * data-analysis.service.ts — la llamada a Claude del tab "Análisis de datos".
 *
 * Molde: agronomy-knowledge.service.ts. Llamada dedicada SIN tools,
 * estructuralmente read-only: no escribe en la base (salvo el registro de uso),
 * no setea pendings, no emite side-effects. El modelo solo ve el JSON que armó
 * data-analysis-context.service.ts y responde en markdown.
 *
 * Cache de prompt: `system` = [reglas, DATOS] con el breakpoint al final del
 * bloque de datos. La fecha y la pregunta van en `messages` — cualquier cosa
 * que cambie entre turnos NO puede estar en system o la repregunta no pega.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSetting, getSettingNumber, getSettingBool } from '../services/settings.service.js';
import { saveAiUsage, saveAiFallbackLog } from '../services/expenses.js';
import { logError } from '../services/error-logger.js';
import { formatDateAR, getTodayISO } from '../utils/date.js';
import { estimateCostUsd } from './model-pricing.js';
import type { TruncationNote } from '../services/data-analysis-context.service.js';

export interface AnalysisTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnalysisUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface AnalysisResult {
  answer: string;
  usage: AnalysisUsage;
  model: string;
  /** stop_reason === 'max_tokens': la respuesta se cortó y lleva la nota. */
  truncated: boolean;
  stopReason: string | null;
  costUsd: number;
}

export interface AnalyzeArgs {
  question: string;
  history: AnalysisTurn[];
  dataJson: string;
  truncation: TruncationNote[];
  /** Solo para el log del admin (ai_fallback_logs). */
  scopeLabel?: string;
}

export const SYSTEM_RULES =
  'Sos un analista de gestión agropecuaria que trabaja para UN productor argentino. Te pasan un bloque DATOS (JSON) con SUS números de una campaña ' +
  '(1 sep → 31 ago): resumen de plata en ARS y USD, lotes con gasto/ingreso/rinde, estadísticas por lote y cultivo, y listas crudas de gastos, ingresos, ' +
  'actividades, cargas de cosecha, lluvias, stock y hacienda. Las filas de las listas son POSICIONALES: los nombres de columna están en meta.columns.\n\n' +
  'REGLAS DURAS:\n' +
  '- Usá SOLO el bloque DATOS. NUNCA inventes cifras, fechas, lotes ni categorías. Si un dato no está, decilo explícitamente ("no tengo cargadas las lluvias de marzo") y sugerí cargarlo por el bot.\n' +
  '- Toda cifra va con moneda y período ("$ 2.450.000 ARS en la campaña 25/26"). No mezcles ARS y USD en una misma suma.\n' +
  '- Si `truncation` no está vacío, avisá en una línea que analizaste las últimas N de M filas de esa lista.\n' +
  '- meta.notes explica el alcance (por ejemplo, que el resumen es del campo y las listas de los lotes elegidos). Respetalo.\n' +
  '- NUNCA des dosis de agroquímicos ni de medicamentos veterinarios: remití al marbete/prospecto y a un ingeniero agrónomo o veterinario matriculado.\n' +
  '- NUNCA digas que registraste, corregiste o vas a hacer algo: solo analizás.\n' +
  '- Si la pregunta no es sobre sus datos de campo, decilo en una oración y ofrecé un ejemplo de pregunta que sí puedas responder.\n\n' +
  'FORMATO: español argentino (vos/tenés/podés), markdown. Un título corto (##), párrafos breves, listas cuando enumerás, tablas markdown cuando comparás lotes, ' +
  'categorías o meses. Sin saludos ni cierres. Alrededor de 400 palabras salvo que pidan más detalle. Terminá con una línea "**Para mirar:**" con 1-3 ' +
  'acciones concretas que salen de los datos, si las hay.';

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 3000;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_EFFORT = 'medium';
const DEFAULT_MAX_HISTORY_TURNS = 6;
const MAX_TURN_CHARS = 4000;
const TRUNCATED_NOTE = '\n\n_(respuesta recortada por largo — pedí un detalle más acotado para ver el resto)_';

type Effort = 'low' | 'medium' | 'high';
function asEffort(raw: string | null | undefined): Effort {
  return raw === 'low' || raw === 'high' ? raw : 'medium';
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
  return client;
}

/**
 * Alternancia estricta user/assistant y topes. Un historial que llega del
 * front puede venir con dos `user` seguidos (reintento tras un error): se
 * conserva el último de cada racha. Devuelve a lo sumo `maxTurns` pares.
 */
export function normalizeHistory(history: AnalysisTurn[] | null | undefined, maxTurns: number): AnalysisTurn[] {
  const out: AnalysisTurn[] = [];
  for (const t of history ?? []) {
    if (!t || (t.role !== 'user' && t.role !== 'assistant')) continue;
    const content = String(t.content ?? '').trim().slice(0, MAX_TURN_CHARS);
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) out[out.length - 1] = { role: t.role, content };
    else out.push({ role: t.role, content });
  }
  // Tiene que empezar en user y terminar en assistant (la pregunta actual va después).
  while (out.length > 0 && out[0].role !== 'user') out.shift();
  while (out.length > 0 && out[out.length - 1].role !== 'assistant') out.pop();
  const maxItems = Math.max(0, maxTurns) * 2;
  return out.length > maxItems ? out.slice(out.length - maxItems) : out;
}

export class DataAnalysisService {
  /** Test seam (paridad con agronomyKnowledgeService.setClientForTests). */
  setClientForTests(fake: unknown): void {
    client = fake as Anthropic;
  }

  /**
   * null = feature apagada, pregunta vacía, refusal o fallo. La ruta arma la
   * respuesta honesta (503), nunca silencio.
   */
  async analyze(userId: number, args: AnalyzeArgs): Promise<AnalysisResult | null> {
    if (await getSettingBool('DATA_ANALYSIS_ENABLED') === false) {
      console.log(`[data-analysis] [INTERCEPT] consulta salteada para user ${userId} (DATA_ANALYSIS_ENABLED=false)`);
      return null;
    }
    const question = (args.question || '').trim();
    if (!question) return null;

    const model = (await getSetting('DATA_ANALYSIS_MODEL')) || DEFAULT_MODEL;
    const maxTokens = (await getSettingNumber('DATA_ANALYSIS_MAX_TOKENS')) ?? DEFAULT_MAX_TOKENS;
    const timeoutMs = (await getSettingNumber('DATA_ANALYSIS_TIMEOUT_MS')) ?? DEFAULT_TIMEOUT_MS;
    const effort = asEffort((await getSetting('DATA_ANALYSIS_EFFORT')) || DEFAULT_EFFORT);
    const maxTurns = (await getSettingNumber('DATA_ANALYSIS_MAX_HISTORY_TURNS')) ?? DEFAULT_MAX_HISTORY_TURNS;

    const history = normalizeHistory(args.history, maxTurns);
    const truncationLine = args.truncation.length > 0
      ? ` Nota: listas recortadas — ${args.truncation.map((t) => `${t.list}: ${t.kept} de ${t.total} filas`).join('; ')}.`
      : '';
    const userMessage = `Hoy es ${formatDateAR(getTodayISO())}.${truncationLine}\n\nPregunta: ${question}`;

    try {
      const response = await getClient().messages.create(
        {
          model,
          max_tokens: maxTokens,
          output_config: { effort },
          system: [
            { type: 'text', text: SYSTEM_RULES },
            { type: 'text', text: `DATOS DEL USUARIO (JSON):\n${args.dataJson}`, cache_control: { type: 'ephemeral' } },
          ],
          messages: [
            ...history.map((t) => ({ role: t.role, content: t.content })),
            { role: 'user', content: userMessage },
          ],
        },
        { timeout: timeoutMs },
      );

      const stopReason = (response.stop_reason as string | null) ?? null;
      if (stopReason === 'refusal') {
        console.log(`[data-analysis] refusal para user ${userId}: "${question.slice(0, 80)}"`);
        return null;
      }

      let answer = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const truncated = stopReason === 'max_tokens';
      if (truncated) answer += TRUNCATED_NOTE;

      const usage: AnalysisUsage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_tokens: response.usage.cache_read_input_tokens || 0,
        cache_write_tokens: response.usage.cache_creation_input_tokens || 0,
      };
      const costUsd = estimateCostUsd(model, usage);

      try {
        await saveAiUsage(userId, usage, costUsd);
        await saveAiFallbackLog(
          userId,
          JSON.stringify({ type: 'data_analysis', question: question.slice(0, 500), scope: args.scopeLabel ?? null, turns: history.length / 2 }),
          { type: 'data_analysis', model, answer: answer.slice(0, 4000), stopReason },
          usage,
          costUsd,
        );
      } catch { /* best-effort: el registro de uso jamás bloquea la respuesta */ }

      console.log(
        `[data-analysis] user ${userId} model=${model} effort=${effort} "${question.slice(0, 60)}" → ${answer.length} chars ` +
        `TOKENS: ${usage.input_tokens}in/${usage.output_tokens}out CACHE: ${usage.cache_read_tokens}read/${usage.cache_write_tokens}write ` +
        `COST: $${costUsd.toFixed(4)} STOP: ${stopReason}`,
      );
      return answer ? { answer, usage, model, truncated, stopReason, costUsd } : null;
    } catch (err) {
      console.error('[data-analysis] ERROR:', (err as Error).message);
      logError('data-analysis', 'ANALYSIS_CALL_FAILED', err as Error, { userId, context: { question: question.slice(0, 120), model } });
      return null;
    }
  }
}

export const dataAnalysisService = new DataAnalysisService();
