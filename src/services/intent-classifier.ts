import { ParserService } from './parser.service.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { stripFillerPhrases } from '../utils/text-normalizer.js';
import { getSettingNumber, getSettingBool } from './settings.service.js';
import { pool } from '../config/db.js';
import { logError } from '../services/error-logger.js';
import type { IntentExtractor } from '../ai/intent-extractor.js';
import type { AgentService } from '../ai/agent.service.js';
import type { AgentResponseMapper } from '../ai/agent-response-mapper.js';
import type { UserId, UserSettings, ParseResult } from '../types/index.js';

/**
 * Detects compound messages with multiple actions joined by "y" + action verb.
 * Example: "agregar lote mdp y agregarle un gasto de 100mil en gasoil"
 * These should go to the AI agent, not regex (which can only handle one action).
 */
const COMPOUND_ACTION_PATTERN = /\by\b\s+(?:(?:también|además|después|luego)\s+)?(?:agreg|cre[aeé]|registr|gast[éeoa]|compr[éeoa]|vend[íieoa]|cobr|pagu[ée]|fumig|sembr|cosech|fertiliz|reg[oó]|ar[eé]|llov|anot|poné|pon[eé]|met[eéi]|carg)/i;

/**
 * Commands that are trivial to detect via regex and don't need LLM.
 * These bypass the AI extractor entirely to save cost/latency.
 */
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
  // Field/plot CRUD — regex handles these precisely, AI would misclassify
  'add_field', 'add_plot', 'add_plots_batch', 'delete_field', 'delete_plot',
  'rename_field', 'field_info', 'plot_info',
  'set_field_city', 'add_field_city',
  'set_plot_area', 'restore_field',
  'set_city', 'set_name', 'set_budget',
  'show_alerts', 'set_rain_threshold',
  'enable_rain_alerts', 'disable_rain_alerts',
  'enable_budget_alerts', 'disable_budget_alerts',
  'enable_weekly_summary', 'disable_weekly_summary',
  'export_csv',
  'delete_last', 'delete_last_income', 'delete_specific', 'edit_specific', 'edit_last',
  'prompt_rainfall', 'prompt_add_field', 'prompt_add_plot',
  'query_plot_history',
]);

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

  constructor(
    parser?: ParserService,
    userRepo?: UserRepository,
    extractor?: IntentExtractor,
    agentService?: AgentService,
    responseMapper?: AgentResponseMapper,
  ) {
    this.parser = parser ?? new ParserService();
    this.userRepo = userRepo ?? new UserRepository();
    this.extractor = extractor ?? null;
    this.agentService = agentService ?? null;
    this.responseMapper = responseMapper ?? null;
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
   * Lightweight check: does this text parse as an income or expense?
   * Regex-only, no AI. Used by flow interruption logic to detect financial
   * intents that should cancel an active flow.
   */
  detectsFinancialIntent(text: string): boolean {
    const cleaned = stripFillerPhrases(text);
    const preprocessed = this.parser.preprocess(cleaned);
    return !!(this.parser.parseIncome(preprocessed) || this.parser.parseIncome(cleaned) ||
              this.parser.parseExpense(preprocessed) || this.parser.parseExpense(cleaned));
  }

  async classify(
    text: string,
    userId: UserId,
    settings: UserSettings
  ): Promise<ParseResult> {
    // 0. Strip audio transcription filler phrases + preprocess
    const cleaned = stripFillerPhrases(text);
    const preprocessed = this.parser.preprocess(cleaned);

    // =========================================================================
    // STEP 1 — HARD RULE: Observation prefix ALWAYS wins, bypasses everything
    // =========================================================================
    if (OBSERVATION_PREFIX.test(cleaned)) {
      const obs = this.parser.parseObservation(cleaned) || this.parser.parseObservation(preprocessed);
      if (obs) {
        return {
          intent: {
            type: 'command',
            data: {
              command: 'log_observation',
              fieldName: obs.fieldName,
              plotName: obs.plotName,
              observation: obs.observationText,
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
      const strippedText = cleaned.replace(OBSERVATION_PREFIX, '').trim();
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
    if (trivialCmd) return trivialCmd;

    // =========================================================================
    // STEP 3a — AI Agent (tool_use) — runs when AGENT_ENABLED=true
    // =========================================================================
    const agentEnabled = await getSettingBool('AGENT_ENABLED');
    if (agentEnabled && this.agentService && this.responseMapper) {
      try {
        const minConfidence = (await getSettingNumber('AI_INTENT_MIN_CONFIDENCE')) ?? 0.70;
        const agentResult = await this.agentService.extract(text, preprocessed, userId, settings);
        if (agentResult) {
          const parseResults = this.responseMapper.mapToParseResults(agentResult, text);
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

            if (primary.confidence >= minConfidence || (primary as any)._conversationalResponse) {
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
   * Full regex chain: commands → observation (structural fallback).
   * Income/expense parsing removed — handled by AI primary path.
   * Observation detection runs after command checks.
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
