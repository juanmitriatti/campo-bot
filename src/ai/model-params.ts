/**
 * Diferencias de la API entre modelos: fuente ÚNICA, para que cambiar el modelo
 * desde /admin no rompa ninguna llamada.
 *
 * Claude Haiku 5.5 (y los modelos nuevos en general) devuelven 400 si reciben
 * `temperature`, piensan por defecto (los bloques de razonamiento cuentan contra
 * `max_tokens` y llegan ANTES del texto) y cuentan ~30% más de tokens para el
 * mismo texto. Haiku 4.5 y anteriores se llaman exactamente igual que siempre.
 */
import type Anthropic from '@anthropic-ai/sdk';

const ACCEPTS_SAMPLING = /^claude-(3|haiku-4-5|sonnet-4|opus-4(-[0-6](?!\d)|-\d{8}))/;
/** Tokenizador nuevo: el mismo texto cuenta ~30% más (en %, para evitar el redondeo flotante). */
const TOKEN_PERCENT = 135;
/** Piso para respuestas de texto: el razonamiento sale del mismo tope. */
const MIN_TEXT_MAX_TOKENS = 1024;

export function acceptsSampling(model: string): boolean {
  return ACCEPTS_SAMPLING.test(model);
}

export interface RequestParams {
  max_tokens: number;
  temperature?: number;
  output_config?: { effort: 'low' };
}

/**
 * `max_tokens` / `temperature` / `effort` para una llamada. `forcedTool` = la
 * llamada obliga a usar una tool (`tool_choice: any`): ahí el modelo no razona.
 */
export function requestParams(
  model: string,
  maxTokens: number,
  opts: { temperature?: number; forcedTool?: boolean } = {},
): RequestParams {
  if (acceptsSampling(model)) {
    return { max_tokens: maxTokens, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) };
  }
  const scaled = Math.ceil((maxTokens * TOKEN_PERCENT) / 100);
  if (opts.forcedTool) return { max_tokens: scaled };
  return {
    max_tokens: Math.max(scaled, MIN_TEXT_MAX_TOKENS),
    // Estas llamadas son extracción y respuestas cortas: razonamiento mínimo.
    ...(/^claude-haiku-5/.test(model) ? { output_config: { effort: 'low' as const } } : {}),
  };
}

/** Texto de la respuesta leído por TIPO de bloque (el primero puede ser razonamiento). */
export function responseText(response: { content: Anthropic.ContentBlock[] }): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
