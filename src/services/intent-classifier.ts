import { ParserService } from './parser.service.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { stripFillerPhrases } from '../utils/text-normalizer.js';
import { looksLikeNewActionOrQuery } from '../middleware/conversation-guards.js';
import { getSettingNumber, getSettingBool } from './settings.service.js';
import { isSafeFallbackCommand } from './intent-safety.js';
import { getUserAccessMode } from './access-gate.service.js';
import { pool } from '../config/db.js';
import { logError } from '../services/error-logger.js';
import type { IntentExtractor } from '../ai/intent-extractor.js';
import type { AgentService } from '../ai/agent.service.js';
import type { AgentResponseMapper } from '../ai/agent-response-mapper.js';
import type { UserContextService } from '../ai/user-context.service.js';
import { detectCorrection } from '../ai/correction-classifier.js';
import { extractReferencedAmountCorrection, extractLastRecordDateCorrection, extractActivityQuantityCorrection } from '../middleware/conversation-engine.js';
import { expandPronouns } from '../utils/pronoun-expander.js';
import { resolveSelfCorrection } from '../utils/self-correction.js';
import { getConversationState } from './expenses.js';
import type { UserId, UserSettings, ParseResult } from '../types/index.js';

/**
 * Detects compound messages with multiple actions joined by "y" + action verb.
 * Example: "agregar lote mdp y agregarle un gasto de 100mil en gasoil"
 * These should go to the AI agent, not regex (which can only handle one action).
 */
// Separadores aceptados: "y", "e" (fumigué e hice...), coma y punto y coma —
// "fumigué lote norte, después registrá 50mil en gasoil" esquivaba el detector
// (solo aceptaba "y") y el bypass trivial se robaba la primera mitad. El verbo
// de acción inmediatamente después del separador evita falsos positivos con
// comas descriptivas ("gasté 50 mil, en gasoil" no matchea).
const COMPOUND_ACTION_PATTERN = /(?:\by\b|\be\b|,|;)\s*(?:(?:tambi[eé]n|adem[aá]s|despu[eé]s|luego|aparte|encima)\s+)?(?:agreg|cre[aeé]|registr|gast[éeoa]|compr[éeoa]|vend[íieoa]|cobr|pagu[ée]|fumig|sembr|cosech|fertiliz|reg[oó]|ar[eé]|llov|anot|poné|pon[eé]|met[eéi]|carg)/i;

/**
 * Commands that bypass the agent entirely. The regex parser already produces
 * a high-confidence answer for these — sending them to the LLM only adds
 * latency and cost without improving quality.
 *
 * Rule of thumb (revisited May 28):
 *   - Stable canonical phrases (1-3 dominant fraseos, regex catches them
 *     precisely) → keep in trivial bypass. The agent already has equivalent
 *     tools for when users phrase it differently (the regex MISS path falls
 *     through to the agent, which now has the full edit/delete/CRUD surface).
 *   - Multi-fraseo expressions where users vary wildly (e.g. "borrame el de
 *     X" vs "saca el de X" vs "eliminá ese gasto") → DON'T put in trivial,
 *     let the agent handle. The agent's edit_last_* / delete_specific_*
 *     tools (May 28) cover these.
 *
 * Net effect: agent surface fully covers what regex covers (and more). Regex
 * is a fast path, not a gatekeeper. When regex misses, the agent picks up.
 */
// Comandos que un usuario con trial VENCIDO puede seguir usando: costo cero
// (sin IA) y read-only o inocuos. Subset estricto de TRIVIAL_COMMANDS.
const EXPIRED_ALLOWED_COMMANDS = new Set([
  'greeting', 'thanks', 'ack', 'menu', 'help', 'dollar',
  'cancel', 'confirm',
  'list_fields', 'list_plots',
]);

const TRIVIAL_COMMANDS = new Set([
  'confirm', 'cancel',
  'greeting', 'thanks', 'ack',
  'menu', 'help', 'dollar',
  'list_fields', 'list_plots',
  'show_expense_menu', 'show_income_menu', 'show_agro_menu',
  'show_fields_menu', 'show_rain_menu', 'show_reports_menu',
  'start_expense_flow', 'start_income_flow',
  'request_more_messages',
  'start_document_upload',
  // Field/plot CRUD — regex handles the canonical phrasings; agent has parallel
  // tools (add_field, delete_field, rename_field, set_field_city, etc.) for
  // when the regex misses.
  'add_field', 'add_plot', 'add_plots_batch', 'delete_field', 'delete_plot',
  'rename_field', 'field_info', 'plot_info',
  'set_field_city', 'add_field_city',
  'set_plot_area', 'set_plot_grupo', 'restore_field',
  'set_city', 'set_name', 'set_budget',
  'show_alerts', 'set_rain_threshold',
  'enable_rain_alerts', 'disable_rain_alerts',
  'enable_budget_alerts', 'disable_budget_alerts',
  'enable_weekly_summary', 'disable_weekly_summary',
  '_toggle_alert',
  'export_csv',
  // Edit/delete — canonical "borrar ultimo gasto" / "editar gasto X a Y" go
  // through regex. Variations like "borrame el de 0.5" / "saca ese gasto"
  // miss the regex and fall through to the agent (which now has
  // delete_specific_expense + edit_last_expense covering them — May 28).
  'delete_last', 'delete_last_income', 'delete_specific', 'edit_specific', 'edit_last',
  'prompt_rainfall', 'prompt_add_field', 'prompt_add_plot',
  'query_plot_history',
  'active_crop', 'list_livestock', 'check_stock',
]);

/**
 * Saludo de apertura + nombre/muletilla opcional, para PELARLO del mensaje y
 * ver si lo que queda es una acción real ("buenas anotame 150k de soja" → la
 * parte tras "buenas" es la acción). Las variantes largas ("buenas tardes")
 * van PRIMERO en la alternancia para que matcheen antes que "buenas" sola.
 * El nombre del bot / muletillas ("mia", "che", "capo") también se pelan.
 */
const GREETING_LEAD_RE = /^(?:buenas\s+(?:tardes|noches|d[ií]as?)|buen(?:os)?\s+d[ií]as?|que\s+tal|buenas|buenos|hola|hey|holis|wenas)\b[\s,.!¡]*(?:mia|che|capo|maestro|crack|genio|amigo|señor|señora)?[\s,.!¡]*/i;

/**
 * Observation prefix pattern — matches "observación:", "obs:", "nota:" etc.
 * Supports with or without colon/dash, case-insensitive.
 */
const OBSERVATION_PREFIX = /^(?:observaci[oó]n|obs|nota)\s*[:\-\u2014]?\s+/i;

export class IntentClassifier {
  private parser: ParserService;
  private userRepo: UserRepository;
  private extractor: IntentExtractor | null;
  private agentService: AgentService | null;
  private responseMapper: AgentResponseMapper | null;
  private userContextService: UserContextService | null;

  constructor(
    parser?: ParserService,
    userRepo?: UserRepository,
    extractor?: IntentExtractor,
    agentService?: AgentService,
    responseMapper?: AgentResponseMapper,
    userContextService?: UserContextService,
  ) {
    this.parser = parser ?? new ParserService();
    this.userRepo = userRepo ?? new UserRepository();
    this.extractor = extractor ?? null;
    this.agentService = agentService ?? null;
    this.responseMapper = responseMapper ?? null;
    this.userContextService = userContextService ?? null;
  }

  /**
   * TEST-ONLY seam: reemplaza el agente por un doble determinístico
   * (FakeAgentService) para testear el pipeline COMPLETO — interceptores,
   * mapper, validator, handlers, DB — sin pegarle a la API de Anthropic.
   * Ver src/testing/integration/. NO usar fuera de tests.
   */
  setAgentServiceForTests(svc: Pick<AgentService, 'extract'>): void {
    this.agentService = svc as AgentService;
  }

  /**
   * Lightweight command-only parse. Returns ParsedCommand if the text matches a known command, null otherwise.
   * Does NOT run income/expense parsers or AI extraction.
   */
  parseCommandOnly(text: string): import('../types/index.js').ParsedCommand | null {
    const cleaned = stripFillerPhrases(text);
    const preprocessed = this.parser.preprocess(cleaned);
    return this.parser.parseCommand(cleaned) || this.parser.parseCommand(preprocessed) || null;
  }

  /**
   * Lightweight check: does this text look like a NEW income/expense intent?
   * Used by flow interruption logic to escape a pending flow when the user
   * sends a fresh financial action mid-flow.
   *
   * IMPORTANT: this MUST tolerate compound messages that the structured parser
   * rejects as "esComplejo" (e.g. "vendí 25 tn de maíz a 900 USD y 10 tn de
   * soja a 1000 USD"). Otherwise the pending flow eats the compound, the
   * agent never sees it, and the user gets stuck in a single-field "¿cuánto?"
   * loop. We accept any income/expense verb + a number as enough signal to
   * cancel the pending flow and let the AI agent re-route.
   */
  detectsFinancialIntent(text: string): boolean {
    const cleaned = stripFillerPhrases(text);
    const preprocessed = this.parser.preprocess(cleaned);
    if (
      this.parser.parseIncome(preprocessed) || this.parser.parseIncome(cleaned) ||
      this.parser.parseExpense(preprocessed) || this.parser.parseExpense(cleaned)
    ) {
      return true;
    }
    // Compound / complex fallback: income or expense verb + any number.
    const lower = cleaned.toLowerCase();
    const hasIncomeVerb = /\b(vend[ií]|cobr[eé]|ingres[eéo]|entr[oó]|factur[eé]|me\s+pagaron|me\s+pag[oó]|salieron?\s+a|sali[oó]\s+a)\b/.test(lower);
    const hasExpenseVerb = /\b(gast[eé]|pagu[eé]|compr[eé]|abon[eé])\b/.test(lower);
    // "Action verbs" that signal the user is RE-asserting / correcting a financial
    // record they already mentioned (e.g. "eran 25 toneladas no kilos" / "lo que
    // te cargué eran X"). Without these the pending flow eats the correction.
    const hasCorrectionVerb = /\b(cargu[eé]|registr[eé]|anot[eé]|cambi[eé]|corrij[oa]|corregi)\b/.test(lower);
    const hasCorrectionPattern = /\b(eran?|fue(?:ron)?|en\s+realidad|perd[oó]n)\b.*\d/.test(lower);
    const hasUnitWithNumber = /\d+\s*(?:kilos?|kg|toneladas?|tn|litros?|lt|cc|bolsas?|qq)\b/.test(lower);
    const hasNumber = /\d/.test(lower);
    return (
      ((hasIncomeVerb || hasExpenseVerb) && hasNumber) ||
      (hasCorrectionVerb && hasUnitWithNumber) ||
      (hasCorrectionPattern && hasUnitWithNumber)
    );
  }

  async classify(
    text: string,
    userId: UserId,
    settings: UserSettings,
    opts?: {
      /** askPrompt del pending activo (si hay). Se inyecta en el prefix del
       *  agente para que sepa que hay una pregunta abierta sin responder y no
       *  conflacione el mensaje nuevo con la respuesta esperada. */
      pendingHint?: string | null;
    },
  ): Promise<ParseResult> {
    // =========================================================================
    // STEP 0 — Access gate (Phase 3). Read subscription state in real time;
    // a trial that expired 5 minutes ago is blocked NOW, not after the cron.
    // Grandfather: users without any subscription row pass as 'full'.
    // =========================================================================
    const accessMode = await getUserAccessMode(Number(userId));
    if (accessMode === 'trial_expired_readonly') {
      // El modo se llama READONLY: los comandos triviales de costo cero
      // (saludo, menú, ayuda, listar campos/lotes, dólar, cancelar) SIGUEN
      // funcionando — antes el gate bloqueaba hasta "hola", contradiciendo
      // el "tus datos siguen guardados" del propio mensaje de venta. Solo
      // se bloquea lo que cuesta plata (IA/audio/docs) o escribe datos.
      const trivialCmd = this.parseCommandOnly(text);
      const allowed = trivialCmd && EXPIRED_ALLOWED_COMMANDS.has(trivialCmd.command as string);
      if (!allowed) {
        console.log(`[TRIAL_EXPIRED] user=${userId} raw="${text.slice(0, 80)}"`);
        return {
          intent: { type: 'trial_expired', raw: text },
          confidence: 0,
          aiUsed: false,
          source: 'command',
          missingFields: [],
        };
      }
      console.log(`[TRIAL_EXPIRED] user=${userId} allow trivial="${trivialCmd.command}"`);
      // fall through — el bypass trivial (STEP 2) lo resuelve sin IA
    }

    // =========================================================================
    // STEP 0.4 — Self-correction normalizer (deterministic). MUST run BEFORE the
    // correction pre-classifiers (STEP 2.5 / 2.55c): an EMBEDDED self-correction
    // ("compré 100 lt ... no eran 120 lt", "sembré soja ... no era maíz") is
    // rewritten here ("compré 120 lt ...") so the pre-classifiers see a clean
    // fresh registration instead of misfiring it as a quantity/crop correction
    // of a PRIOR record. Standalone corrections ("no, eran 120") are left
    // untouched (no prior token to replace) → their dedicated pre-classifiers
    // still handle them. Composes with pronoun expansion (STEP 2.6) downstream.
    // =========================================================================
    try {
      const selfCorrected = resolveSelfCorrection(text);
      if (selfCorrected !== text) {
        console.log(`[intent-classifier] Self-correction: "${text}" → "${selfCorrected}"`);
        text = selfCorrected;
      }
    } catch (scErr) {
      console.warn('[intent-classifier] Self-correction skipped:', (scErr as Error).message);
    }

    // 0. Strip audio transcription filler phrases + preprocess
    const cleaned = stripFillerPhrases(text);
    const preprocessed = this.parser.preprocess(cleaned);

    // =========================================================================
    // STEP 1 — HARD RULE: Observation prefix ALWAYS wins, bypasses everything
    // =========================================================================
    if (OBSERVATION_PREFIX.test(cleaned)) {
      // Use parseObservation ONLY to detect the plot/field — its observationText
      // is plot-stripped by a fragile mid-text regex that mangled real notes
      // ("el lote Norte está muy lindo, buena humedad" → "elá muy lindo…").
      // The DISPLAY text is the user's words minus the "observación:" prefix.
      const strippedText = cleaned.replace(OBSERVATION_PREFIX, '').trim();
      const obs = this.parser.parseObservation(cleaned) || this.parser.parseObservation(preprocessed);
      if (obs && strippedText.length >= 3) {
        return {
          intent: {
            type: 'command',
            data: {
              command: 'log_observation',
              fieldName: obs.fieldName,
              plotName: obs.plotName,
              observation: strippedText,
              prefixDetected: true,  // signals handler to skip question guard
            },
          },
          confidence: 0.95,
          aiUsed: false,
          source: 'command',
          missingFields: [],
        };
      }
      // Prefix found but parser couldn't extract → treat as bare observation with full text
      if (strippedText.length >= 3) {
        const plotName = this.parser.detectPlot(strippedText);
        return {
          intent: {
            type: 'command',
            data: {
              command: 'log_observation',
              fieldName: null,
              plotName: plotName || null,
              observation: strippedText,
              prefixDetected: true,
            },
          },
          confidence: 0.95,
          aiUsed: false,
          source: 'command',
          missingFields: [],
        };
      }
    }

    // =========================================================================
    // STEP 2 — Trivial command bypass (cheap regex, no API call needed)
    // =========================================================================
    const trivialCmd = this.classifyTrivial(cleaned, preprocessed);
    if (trivialCmd) {
      // Rejoin de pregunta-de-lote huérfana: cuando el agente preguntó
      // "¿en qué lote...?" vía respond_text (sin dejar pending machine-readable)
      // y el usuario contesta "lote Norte" a secas, el bypass trivial lo
      // clasificaba como plot_info y mostraba la ficha del lote — la acción
      // original se perdía (visto live: "agregar 40 terneros" → pregunta →
      // "lote norte" → ficha del lote, terneros nunca guardados). Si la última
      // respuesta del bot (< 5 min) fue una pregunta de ubicación abierta,
      // reconstruimos "<mensaje original> en lote <X>" y re-clasificamos —
      // determinístico, mismo espíritu que el pronoun-expander.
      const td = trivialCmd.intent;
      const rejoinDepth = (opts as { _rejoinDepth?: number } | undefined)?._rejoinDepth ?? 0;
      if (
        rejoinDepth === 0 &&
        td.type === 'command' &&
        (td.data.command === 'plot_info' || td.data.command === 'field_info')
      ) {
        const reconstructed = await this.reconstructFromOpenLocationQuestion(
          userId,
          (td.data.plotName as string) ?? (td.data.fieldName as string) ?? null,
          td.data.command === 'field_info',
        );
        if (reconstructed) {
          console.log(`[intent-classifier] Open-question rejoin: "${text}" → "${reconstructed}"`);
          return this.classify(reconstructed, userId, settings, { ...(opts ?? {}), _rejoinDepth: 1 } as never);
        }
      }
      return trivialCmd;
    }

    // =========================================================================
    // STEP 2.5 — Correction pre-classifier (server-side, behind flag)
    // Detects "no, era en lote X" / "perdón fue Y" patterns and routes
    // directly to edit_last_activity, bypassing the agent. Conservative:
    // only the highest-confidence patterns trigger.
    // =========================================================================
    if (await getSettingBool('AGENT_CORRECTION_PRE_CLASSIFIER_ENABLED')) {
      const correction = detectCorrection(text);
      if (correction) {
        const data: import('../types/index.js').ParsedCommand = { command: 'edit_last_activity' };
        if (correction.newPlot) data.newPlotName = correction.newPlot;
        if (correction.newCrop) data.newCrop = correction.newCrop;
        return {
          intent: { type: 'command', data },
          confidence: 0.92,
          aiUsed: false,
          source: 'regex',
          missingFields: [],
        };
      }
    }

    // =========================================================================
    // STEP 2.55 — Referenced amount correction (deterministic, pre-agent)
    // "no, el de urea eran 99 mil" carries the referent (urea) AND the amount.
    // Haiku frequently drops the referent → edit_last_expense with no
    // categoryFilter → it silently edited the most-recent expense of a DIFFERENT
    // category. Capture both here so the handler targets the right row (or says
    // "no encontré un gasto de X").
    // =========================================================================
    {
      const refCorr = extractReferencedAmountCorrection(text);
      if (refCorr) {
        return {
          intent: {
            type: 'command',
            data: {
              command: refCorr.kind === 'income' ? 'edit_last_income' : 'edit_last_expense',
              categoryFilter: refCorr.categoryFilter,
              newAmount: refCorr.newAmount,
            } as import('../types/index.js').ParsedCommand,
          },
          confidence: 0.9,
          aiUsed: false,
          source: 'regex',
          missingFields: [],
        };
      }
    }

    // =========================================================================
    // STEP 2.55b — Relative-date correction of the last record
    // "el último era de ayer" / "no, fue anteayer" → edit_last_activity(newDate).
    // The agent treated this as a question; here we apply it deterministically.
    // =========================================================================
    {
      const newDate = extractLastRecordDateCorrection(text);
      if (newDate) {
        return {
          intent: {
            type: 'command',
            data: { command: 'edit_last_activity', newDate } as import('../types/index.js').ParsedCommand,
          },
          confidence: 0.88,
          aiUsed: false,
          source: 'regex',
          missingFields: [],
        };
      }
    }

    // =========================================================================
    // STEP 2.55c — Activity dose/quantity correction
    // "no, eran 5.5 litros" after a spray/fert → edit_last_activity(newQuantity).
    // The activity correction engine only handled lote/cultivo/fecha; the dose
    // (safety-relevant) was silently ignored (P1-B).
    // =========================================================================
    {
      const qtyCorr = extractActivityQuantityCorrection(text);
      if (qtyCorr) {
        return {
          intent: {
            type: 'command',
            data: { command: 'edit_last_activity', newQuantity: qtyCorr.quantity, newUnit: qtyCorr.unit } as import('../types/index.js').ParsedCommand,
          },
          confidence: 0.88,
          aiUsed: false,
          source: 'regex',
          missingFields: [],
        };
      }
    }

    // =========================================================================
    // STEP 2.6 — Pronoun expansion (deterministic pre-agent rewrite)
    // Swap "ahí mismo / ese lote / el mismo" → "en lote <name>" when we have
    // a recent plot in conversation_state. The agent prompt already has this
    // rule but Haiku applies it inconsistently — doing it server-side means
    // the agent gets unambiguous text and zero work to do. Pass-through when
    // no pronoun is found OR no recent plot exists.
    // =========================================================================
    let agentInputText = text;
    try {
      const convState = await getConversationState(userId);
      const lastPlotName: string | null = convState?.plot_name ?? null;

      // "el otro lote" → segundo lote del context_stack. Lookup lazy: solo
      // pagamos la query extra cuando el texto realmente dice "el otro".
      let prevPlotName: string | null = null;
      if (/\bel\s+otro\b/i.test(text)) {
        const stack: Array<{ field_id?: number; plot_id?: number }> =
          (convState as { context_stack?: Array<{ field_id?: number; plot_id?: number }> } | null)?.context_stack ?? [];
        const prevEntry = stack.find(
          (e) => e.plot_id && e.plot_id !== convState?.last_plot_id,
        );
        if (prevEntry?.plot_id) {
          const { pool } = await import('../config/db.js');
          const { rows } = await pool.query(
            'SELECT name FROM plots WHERE id = $1 AND deleted_at IS NULL',
            [prevEntry.plot_id],
          );
          prevPlotName = rows[0]?.name ?? null;
        }
      }

      // Antecedente INTRA-MENSAJE (MI02): si el propio mensaje ya nombra un lote
      // explícito ANTES del pronombre, ese es el antecedente correcto — NO el
      // contexto del turno anterior. "sembré maíz en el lote Verde y gasté ahí
      // mismo" → "ahí mismo" = Verde, no el lote del mensaje previo (que el
      // expander tomaba de conversation_state, mandando el gasto al lote viejo).
      let effectiveLastPlot = lastPlotName;
      // Lookahead en vez de \b final: \b es ASCII y la "í" de "ahí"/"allí" no es
      // word-char, así que \b después de "ahí" NUNCA matchea → la detección no
      // se disparaba y el pronombre se expandía al contexto VIEJO (bug MI02 en
      // vivo: "...en lote Verde y gasté ahí mismo" mandaba el gasto a Amarillo).
      const pronounPos = text.search(/\b(?:ah[ií]|all[íi]|all[áa]|ese|este|aquel|aquella|esa|el\s+mismo|la\s+misma)(?=\s|$|[.,;:!?])/i);
      if (pronounPos > 0) {
        const before = text.slice(0, pronounPos);
        const mentions = before.match(/\b(?:lote|potrero|parcela)\s+([A-Za-z0-9ñáéíóúÑÁÉÍÓÚ][\w-]*)/gi);
        if (mentions && mentions.length > 0) {
          const last = mentions[mentions.length - 1].match(/\b(?:lote|potrero|parcela)\s+([A-Za-z0-9ñáéíóúÑÁÉÍÓÚ][\w-]*)/i);
          if (last?.[1]) {
            effectiveLastPlot = last[1];
            console.log(`[intent-classifier] Antecedente intra-mensaje: pronombre → "${last[1]}" (de la misma frase, no contexto previo)`);
          }
        }
      }

      if (effectiveLastPlot || prevPlotName) {
        const { expanded, replaced } = expandPronouns(text, effectiveLastPlot, prevPlotName);
        if (replaced > 0) {
          console.log(`[intent-classifier] Pronoun expansion: "${text}" → "${expanded}" (${replaced} swap)`);
          agentInputText = expanded;
        }
      }
    } catch (expErr) {
      // Non-fatal: if conversation_state read fails, just send original text.
      console.warn('[intent-classifier] Pronoun expansion skipped:', (expErr as Error).message);
    }

    // =========================================================================
    // STEP 2.7 — Budget SET intent (deterministic, pre-agent)
    // The agent has NO set_budget tool, so "poné límite de $1M en fertilizante"
    // was being stolen into a recurring expense template (phantom $1M/month), and
    // budget phrasings that DID fall to regex saved a corrupt category ("De").
    // Resolve it here with the shared category map so the agent never sees it.
    // Only fires on a real SET (carries an amount); budget queries fall through.
    // =========================================================================
    const budgetCmd = this.parser.parseBudget(text) || this.parser.parseBudget(preprocessed);
    if (budgetCmd) {
      return {
        intent: { type: 'command', data: budgetCmd as import('../types/index.js').ParsedCommand },
        confidence: 0.95,
        aiUsed: false,
        source: 'regex',
        missingFields: [],
      };
    }

    // =========================================================================
    // STEP 3a — AI Agent (tool_use) — runs when AGENT_ENABLED=true
    // =========================================================================
    const agentEnabled = await getSettingBool('AGENT_ENABLED');
    if (agentEnabled && this.agentService && this.responseMapper) {
      try {
        const minConfidence = (await getSettingNumber('AI_INTENT_MIN_CONFIDENCE')) ?? 0.70;
        const agentResult = await this.agentService.extract(agentInputText, preprocessed, userId, settings, opts?.pendingHint ?? null);
        if (agentResult) {
          const validationEnabled = await getSettingBool('AGENT_OUTPUT_VALIDATION_ENABLED');
          const validateCrop = validationEnabled && (await getSettingBool('AGENT_VALIDATE_CROP'));
          const validatePlotField = validationEnabled && (await getSettingBool('AGENT_VALIDATE_PLOT_FIELD'));
          let userPlots: string[] | undefined;
          let userFields: string[] | undefined;
          if (validatePlotField && this.userContextService) {
            try {
              const ctx = await this.userContextService.loadContext(userId);
              userPlots = ctx.plotNames;
              userFields = ctx.fieldNames;
            } catch {
              // If context load fails, skip plot/field validation rather than blocking the call
            }
          }
          // IMPORTANTE: validar contra agentInputText (texto post pronoun-expander),
          // NO contra el original. "en el otro lote" se expande server-side a
          // "en lote Norte" — si validamos contra el original, el plot que NUESTRO
          // código inyectó se descarta como alucinación del agente y el handler
          // re-pregunta el lote (visto live con AGENT_VALIDATE_PLOT_FIELD=true).
          const parseResults = this.responseMapper.mapToParseResults(agentResult, agentInputText, {
            validateCrop,
            validatePlotField,
            userPlots,
            userFields,
          });
          if (parseResults.length > 0) {
            const primary = parseResults[0];
            // Attach extra tool calls for logging (compound actions)
            if (agentResult.toolCalls.length > 1) {
              (primary as any)._extraToolCalls = agentResult.toolCalls.slice(1);
            }
            // Attach all parsed results for compound execution
            if (parseResults.length > 1) {
              (primary as any)._compoundResults = parseResults;
            }
            // Attach agent metadata for logging
            (primary as any)._agentMode = 'tool_use';
            (primary as any)._toolCalls = agentResult.toolCalls;
            // Surface truncation so controllers can warn the user that not all
            // requested actions made it into the response.
            if (agentResult.truncated) {
              (primary as any)._truncated = true;
            }

            // Accept partial intents (expense_partial / income_partial) regardless
            // of confidence — they are valid "I know what you meant but need
            // more info" results that should trigger the flow, NOT the conversational
            // fallback. Their lower confidence (0.60) is by design.
            const isPartial = primary.intent.type === 'expense_partial' || primary.intent.type === 'income_partial';
            if (primary.confidence >= minConfidence || (primary as any)._conversationalResponse || isPartial) {
              return primary;
            }
          }
        }
        // Fall through to JSON extractor or regex
      } catch (agentErr) {
        console.error('[intent-classifier] Agent failed, falling back:', agentErr);
        logError('intent-classifier', 'AGENT_FAILED', agentErr as Error, { userId });
      }
    }

    // =========================================================================
    // STEP 3b — AI JSON extraction (fallback when agent disabled or unavailable)
    // Kill switch (AI_INTENT_ENABLED=false) makes extract() return null,
    // falling through to regex chain below.
    // =========================================================================
    if ((!agentEnabled || !this.agentService) && this.extractor) {
      try {
        const minConfidence = (await getSettingNumber('AI_INTENT_MIN_CONFIDENCE')) ?? 0.70;
        const aiResult = await this.extractor.extract(text, preprocessed, userId, settings);
        if (aiResult && aiResult.confidence >= minConfidence) {
          (aiResult as any)._agentMode = 'json';
          return aiResult;
        }
        // Low confidence or null → fall through to regex
      } catch (extractErr) {
        console.error('[intent-classifier] JSON extractor failed, falling back to regex:', extractErr);
        logError('intent-classifier', 'JSON_EXTRACTOR_FAILED', extractErr as Error, { userId });
      }
    }

    // =========================================================================
    // STEP 4 — Full regex chain (FALLBACK when AI disabled/failed/low-confidence)
    // =========================================================================
    return this.classifyWithRegex(text, cleaned, preprocessed, userId);
  }

  /**
   * Fast regex for trivial commands that never need LLM.
   */
  private classifyTrivial(cleaned: string, preprocessed: string): ParseResult | null {
    // Compound messages (e.g. "agregar lote X y registrar gasto") must go to AI agent
    if (COMPOUND_ACTION_PATTERN.test(cleaned)) return null;

    const cmd = this.parser.parseCommand(cleaned) || this.parser.parseCommand(preprocessed);
    if (cmd && TRIVIAL_COMMANDS.has(cmd.command as string)) {
      // GUARD anti-saludo-goloso: el regex de greeting/thanks matchea cualquier
      // mensaje que EMPIECE con "buenas/hola/gracias" sin mirar qué sigue. Visto
      // live (Martin, Jun 2026): "buenas anotame 150000 dolares de soja..." →
      // greeting → el ingreso se perdió. Si tras quitar el saludo queda contenido
      // real (número, intención financiera, o comando NO trivial), no es un
      // saludo: devolvemos null para que lo agarre el agente.
      if (cmd.command === 'greeting' || cmd.command === 'thanks') {
        const remainder = cleaned.replace(GREETING_LEAD_RE, '').trim();
        if (remainder) {
          const sub = this.parser.parseCommand(remainder);
          const carriesAction =
            /\d/.test(remainder) ||
            this.detectsFinancialIntent(remainder) ||
            looksLikeNewActionOrQuery(remainder) ||
            (sub != null && !TRIVIAL_COMMANDS.has(sub.command as string));
          if (carriesAction) {
            console.log(`[intent-classifier] greeting+action detected — "${cleaned.slice(0, 50)}" → al agente (no greeting)`);
            return null;
          }
        }
      }
      return {
        intent: { type: 'command', data: cmd },
        confidence: 0.95,
        aiUsed: false,
        source: 'command',
        missingFields: [],
      };
    }
    return null;
  }

  /**
   * Si la ÚLTIMA respuesta del bot (< 5 min) fue una pregunta de ubicación
   * abierta ("¿En qué lote querés agregar...?") emitida por respond_text —
   * o sea, SIN pending machine-readable — y el usuario contesta solo con el
   * lote/campo, reconstruye el comando completo: "<mensaje original> en lote X".
   * Devuelve null cuando no aplica (caso normal: la referencia pelada a un
   * lote sigue siendo plot_info).
   */
  private async reconstructFromOpenLocationQuestion(
    userId: UserId,
    locName: string | null,
    isField: boolean,
  ): Promise<string | null> {
    if (!locName) return null;
    try {
      const { pool } = await import('../config/db.js');
      const { rows } = await pool.query(
        `SELECT message_text, response_text, created_at
         FROM conversation_logs
         WHERE user_id = $1 AND message_text IS NOT NULL AND response_text IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      if (rows.length === 0) return null;
      const { message_text: lastMsg, response_text: lastResp, created_at: ts } = rows[0];
      if (Date.now() - new Date(ts).getTime() > 5 * 60 * 1000) return null;
      const askedLocation = /[¿?]\s*(?:en\s+)?qu[eé]\s+(?:lote|campo|potrero|ubicaci[oó]n)/i.test(lastResp ?? '');
      if (!askedLocation) return null;
      if (!lastMsg || lastMsg.length > 200) return null;
      // El mensaje original tiene que parecer una acción, no otra consulta de lote.
      if (/^\s*(?:lote|campo|potrero)\b/i.test(lastMsg)) return null;
      return `${lastMsg} en ${isField ? 'campo' : 'lote'} ${locName}`;
    } catch {
      return null;
    }
  }

  /**
   * Full regex chain: commands → observation (structural fallback).
   * Income/expense parsing removed — handled by AI primary path.
   * Observation detection runs after command checks.
   *
   * Phase 2 guard: this path only runs when the AI pipeline was unavailable
   * (rate-limit, timeout, low confidence). Any command that isn't in
   * SAFE_FALLBACK_INTENTS is blocked here and returned as a
   * `fallback_blocked` intent so the controller can respond with a
   * user-friendly "no pude procesar esto sin IA" message instead of letting
   * a half-parsed write hit the DB.
   */
  private async classifyWithRegex(
    text: string,
    cleaned: string,
    preprocessed: string,
    userId: UserId,
  ): Promise<ParseResult> {
    // Try all structured commands (including non-trivial ones)
    const cmd = this.parser.parseCommand(cleaned) || this.parser.parseCommand(preprocessed);
    if (cmd) {
      // Phase 2: only allow safe commands through the regex fallback. Anything
      // that mutates structured data or requires AI to disambiguate is blocked.
      if (!isSafeFallbackCommand(cmd.command as string)) {
        console.log(`[FALLBACK_BLOCKED] user=${userId} command=${cmd.command} reason=ai_required raw="${text.slice(0, 80)}"`);
        return {
          intent: {
            type: 'fallback_blocked',
            reason: 'ai_required',
            raw: text,
            attemptedCommand: cmd.command as string,
          },
          confidence: 0,
          aiUsed: false,
          source: 'command',
          missingFields: [],
        };
      }
      console.log(`[FALLBACK_SAFE] user=${userId} command=${cmd.command} source=regex`);
      return {
        intent: { type: 'command', data: cmd },
        confidence: 0.95,
        aiUsed: false,
        source: 'command',
        missingFields: [],
      };
    }

    // =========================================================================
    // OBSERVATION DETECTION — runs after command checks
    // Only guard: agronomic ACTIVITY keywords (spraying, fertilization, etc.)
    // that need AI for structured extraction.
    // =========================================================================
    const hasAgroActivity = /fumig|pulveriz|aplic[aóo]|herbicid|insecticid|fungicid|glifosato|fertiliz|nutri(?:mos|r|eron)|abono|urea|fósfor|fosforo|sembr|siembr|cosech|labran|arar|rastr|disco|disqu|cincel|rieg|reg[ué]/i.test(cleaned);
    const obs = hasAgroActivity ? null : (this.parser.parseObservation(cleaned) || this.parser.parseObservation(preprocessed));
    if (obs) {
      const obsConfidence = obs.type === 'bare' ? 0.78 : 0.85;
      return {
        intent: {
          type: 'command',
          data: {
            command: 'log_observation',
            fieldName: obs.fieldName,
            plotName: obs.plotName,
            observation: obs.observationText,
          },
        },
        confidence: obsConfidence,
        aiUsed: false,
        source: 'command',
        missingFields: [],
      };
    }

    // Intelligent fallback: detect bare plot/field references and route to info commands.
    const plotRef = this.parser.detectPlot(preprocessed) || this.parser.detectPlot(cleaned);
    if (plotRef && plotRef !== '__last__') {
      return {
        intent: { type: 'command', data: { command: 'plot_info', plotName: plotRef } },
        confidence: 0.70,
        aiUsed: false,
        source: 'command',
        missingFields: [],
      };
    }
    const fieldRef = this.parser.detectCampo(preprocessed) || this.parser.detectCampo(cleaned);
    if (fieldRef) {
      return {
        intent: { type: 'command', data: { command: 'field_info', entityKeyword: 'campo', fieldName: fieldRef } },
        confidence: 0.70,
        aiUsed: false,
        source: 'command',
        missingFields: [],
      };
    }

    // Nothing matched
    const unknownResult: ParseResult = {
      intent: { type: 'unknown', raw: text },
      confidence: 0,
      aiUsed: false,
      source: 'command',
      missingFields: [],
    };
    this.logParserError(userId, text, preprocessed, unknownResult, 0, 'no_match').catch(() => {});
    return unknownResult;
  }

  /**
   * Log parser errors for analytics and training data.
   */
  private async logParserError(
    userId: UserId,
    message: string,
    normalizedMessage: string,
    parseResult: ParseResult,
    confidence: number,
    errorReason: string,
  ): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO parser_errors (user_id, message, normalized_message, parser_output, error_reason, confidence, resolved_intent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          message,
          normalizedMessage,
          JSON.stringify({ intent: parseResult.intent, source: parseResult.source }),
          errorReason,
          confidence,
          parseResult.intent.type,
        ]
      );
    } catch {
      // Fire-and-forget — don't crash on logging failure
    }
  }
}
