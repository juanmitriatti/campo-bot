import Anthropic from '@anthropic-ai/sdk';
import { getSetting, getSettingNumber, getSettingBool } from '../services/settings.service.js';
import { saveAiUsage } from '../services/expenses.js';
import { logError } from '../services/error-logger.js';

/**
 * AgronomyKnowledgeService — respuestas educativas de agronomía/ganadería.
 *
 * Llamada dedicada a Claude SIN tools: este servicio es estructuralmente
 * read-only (no importa el DB layer de escritura, no emite side-effects, no
 * setea pendings). La decisión de CUÁNDO usarlo la toma el agente principal
 * vía la tool `agronomy_question` (disambiguación semántica: conocimiento
 * general vs datos del propio campo).
 *
 * Punto de enchufe futuro para RAG (INTA/CREA/manuales): reemplazar el
 * interior de answer() — la interfaz tool/handler no cambia.
 */

const SYSTEM_PROMPT =
  'Sos un ingeniero agrónomo y asesor ganadero argentino con años de campo. Tu trabajo es EDUCAR productores por chat.\n\n' +
  'FORMATO: español argentino (vos/tenés/podés), respuesta breve y práctica (máx 5-6 oraciones o una lista corta), *negrita* para términos clave. Sin saludos ni cierres.\n\n' +
  'REGLAS:\n' +
  '- NUNCA inventes datos. Si no estás seguro, decilo explícitamente.\n' +
  '- Si la respuesta depende de zona, clima, suelo o fecha, aclaralo y distinguí recomendación GENERAL de recomendación para SU campo (que requiere un asesor local).\n' +
  '- DOSIS DE AGROQUÍMICOS: NUNCA des una dosis concreta. La dosis depende del producto comercial, formulación, cultivo, maleza/plaga y regulación local → siempre remití al marbete/etiqueta del producto y a un ingeniero agrónomo matriculado.\n' +
  '- Medicamentos veterinarios: misma regla — prospecto + veterinario.\n' +
  '- NUNCA digas que registraste, guardaste o vas a hacer algo: solo informás. No tenés acceso a los datos del usuario y NUNCA asumís nada de su campo.\n' +
  '- Si la pregunta no es agro/ganadera, decí en una oración que solo ayudás con temas de campo.';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 600;
const DEFAULT_TIMEOUT_MS = 10000;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
  return client;
}

export class AgronomyKnowledgeService {
  /** Test seam (paridad con intentClassifier.setAgentServiceForTests). */
  setClientForTests(fake: unknown): void {
    client = fake as Anthropic;
  }

  /**
   * Responde una pregunta de conocimiento general. Devuelve null si la
   * feature está apagada o la llamada falla — el handler arma el fallback
   * honesto (nunca silencio; invariante 1).
   */
  async answer(userId: number, question: string): Promise<string | null> {
    if (await getSettingBool('AGRONOMY_QA_ENABLED') === false) {
      console.log(`[agronomy-qa] [INTERCEPT] pregunta salteada para user ${userId} (AGRONOMY_QA_ENABLED=false)`);
      return null;
    }
    const q = (question || '').trim();
    if (!q) return null;

    const model = (await getSetting('AGRONOMY_QA_MODEL')) || DEFAULT_MODEL;
    const maxTokens = (await getSettingNumber('AGRONOMY_QA_MAX_TOKENS')) ?? DEFAULT_MAX_TOKENS;
    const timeoutMs = (await getSettingNumber('AGRONOMY_QA_TIMEOUT_MS')) ?? DEFAULT_TIMEOUT_MS;

    try {
      const response = await getClient().messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: q }],
        },
        { timeout: timeoutMs },
      );

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      try {
        await saveAiUsage(userId, {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_tokens: response.usage.cache_read_input_tokens || 0,
          cache_write_tokens: response.usage.cache_creation_input_tokens || 0,
        });
      } catch { /* best-effort: el log de uso jamás bloquea la respuesta */ }

      console.log(`[agronomy-qa] user ${userId}: "${q.slice(0, 60)}" → ${text.length} chars`);
      return text || null;
    } catch (err) {
      console.error('[agronomy-qa] ERROR:', (err as Error).message);
      logError('agronomy-qa', 'KNOWLEDGE_CALL_FAILED', err as Error, { userId, context: { question: q.slice(0, 120) } });
      return null;
    }
  }
}

export const agronomyKnowledgeService = new AgronomyKnowledgeService();
