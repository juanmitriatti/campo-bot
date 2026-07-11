/**
 * Phase 2 — safe fallback restrictivo.
 *
 * When the AI pipeline cannot run (rate-limit hit, timeout, error, low
 * confidence), the regex fallback in IntentClassifier kicks in. This module
 * defines which intents are safe to execute via regex alone.
 *
 * Rule: a fallback intent is SAFE when (a) the regex parser can determine
 * it deterministically with very low ambiguity, AND (b) executing it does
 * NOT mutate user data in ways that are hard to detect/undo if mis-parsed.
 *
 * Anything that doesn't meet BOTH conditions is AI-required and must be
 * blocked when the AI is unavailable. Prefer false negatives (the user
 * resends tomorrow) over silent corruption (a wrong record is saved).
 */

/**
 * Whitelisted regex-fallback commands. Anything NOT in this set is blocked
 * with a `fallback_blocked` intent when the AI is unavailable.
 *
 * The set is intentionally narrow:
 * - read-only / query commands (list, info, show, weather)
 * - conversation control (confirm, cancel, greeting, ack, thanks, help, menu)
 * - text-only writes whose mis-parse cost is bounded (log_observation —
 *   stores user's own text, no structured fields to corrupt)
 *
 * It does NOT include any data CRUD (add_field/plot, delete, rename,
 * set_*, edit_*), expense/income flows, agronomy, livestock, stock, OCR,
 * audio. Those require AI (or trivial bypass via STEP 2 of the pipeline,
 * which is unaffected here — Phase 2 only gates STEP 4 / fallback).
 */
export const SAFE_FALLBACK_INTENTS = new Set<string>([
  // Conversation control
  'confirm',
  'cancel',
  'greeting',
  'thanks',
  'ack',
  'help',
  'menu',
  'request_more_messages',

  // Read-only listings & info
  'list_fields',
  'list_plots',
  'field_info',
  'plot_info',
  'show_alerts',
  'show_expense_menu',
  'show_income_menu',
  'show_agro_menu',
  'show_fields_menu',
  'show_rain_menu',
  'show_reports_menu',
  'query_plot_history',

  // Read-only external lookups
  'dollar',
  'weather_all',
  'weather_field',
  'weather_forecast',
  'weather_full',

  // Text-only writes (low-corruption-risk: stores user's literal text)
  'log_observation',
]);

/**
 * Whether `command` is allowed to run when the AI was not used to extract
 * the intent. Returns false for any command not explicitly allowlisted —
 * blocking is the safe default.
 */
export function isSafeFallbackCommand(command: string | null | undefined): boolean {
  if (!command || typeof command !== 'string') return false;
  return SAFE_FALLBACK_INTENTS.has(command);
}

/**
 * Documented rationale for callers that want to surface why a command was
 * blocked. Since Jul 2026 (ronda 3) the classifier distinguishes la CAUSA
 * real de que la IA no corriera, y el copy es honesto por causa:
 * - ai_error: la llamada al agente falló (timeout / 5xx / créditos) — problema
 *   NUESTRO, se le dice al usuario que pruebe en unos minutos.
 * - ai_rate_limited: tope diario del plan alcanzado (única causa de null con
 *   el agente habilitado).
 * - ai_required: la IA corrió pero no interpretó con confianza (o no aplicó)
 *   — NUNCA culpar al tope acá: antes este copy decía "alcanzaste tu tope
 *   diario" para TODAS las causas, mintiendo cuando el agente simplemente
 *   había fallado (auditoría Jul 2026).
 * - unparseable_complex: mensaje complejo con la IA pausada por kill switch.
 */
export type FallbackBlockReason = 'ai_required' | 'unparseable_complex' | 'ai_error' | 'ai_rate_limited';

/**
 * User-facing copy for the fallback_blocked intent. Bot controllers call
 * this when they receive `intent.type === 'fallback_blocked'`. The copy is
 * intentionally non-technical (no "tokens", "credits", "quota" — terms
 * that don't translate to a productor agropecuario's mental model).
 */
export function fallbackBlockedCopy(reason: FallbackBlockReason, attemptedCommand?: string): string {
  // attemptedCommand is informative for logs but we don't surface it in copy.
  void attemptedCommand;
  switch (reason) {
    case 'ai_error':
      return (
        '🤖 Estoy con un problema técnico para procesar mensajes en este momento. ' +
        'No es tu mensaje — es un problema mío.\n\n' +
        'Probá de nuevo en unos minutos. Tus datos están guardados y no se pierde nada.'
      );
    case 'ai_rate_limited':
      return (
        '🤖 No pude procesar ese mensaje porque requiere análisis avanzado y ' +
        'hoy alcanzaste tu tope diario.\n\n' +
        'Probá de nuevo mañana, o pasame algo simple por ahora ' +
        '(ej. "menú", "lluvia esta semana", "lote norte").'
      );
    case 'ai_required':
      return (
        '🤖 No pude interpretar ese mensaje con confianza.\n\n' +
        'Probá reformularlo más simple o en partes (ej. "gasté 50 mil en gasoil", ' +
        '"sembré soja en lote norte").'
      );
    case 'unparseable_complex':
      return (
        '🤖 No pude entender ese mensaje sin análisis avanzado y la IA está ' +
        'pausada. Volvé a intentar más tarde o probá una versión más simple.'
      );
  }
}
