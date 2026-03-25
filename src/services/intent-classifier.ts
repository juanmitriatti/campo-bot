import { ParserService } from './parser.service.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { stripFillerPhrases } from '../utils/text-normalizer.js';
import { getSettingNumber } from './settings.service.js';
import { pool } from '../config/db.js';
import type { IntentExtractor } from '../ai/intent-extractor.js';
import type { UserId, UserSettings, ParsedExpense, ParsedIncome, ParseResult } from '../types/index.js';

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

  constructor(parser?: ParserService, userRepo?: UserRepository, extractor?: IntentExtractor) {
    this.parser = parser ?? new ParserService();
    this.userRepo = userRepo ?? new UserRepository();
    this.extractor = extractor ?? null;
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
    // STEP 3 — Full regex chain: commands → income → expense
    // =========================================================================
    const regexResult = await this.classifyWithRegex(text, cleaned, preprocessed, userId);

    // If regex matched with high confidence, skip AI entirely
    const highConfidenceThreshold = (await getSettingNumber('CONFIDENCE_HIGH_SKIP_AI')) ?? 0.75;
    if (regexResult.confidence >= highConfidenceThreshold) {
      return regexResult;
    }

    // =========================================================================
    // STEP 4 — AI extraction (only for partial/unknown with low confidence)
    // =========================================================================
    if (this.extractor) {
      try {
        const minConfidence = (await getSettingNumber('AI_INTENT_MIN_CONFIDENCE')) ?? 0.70;
        const aiResult = await this.extractor.extract(text, preprocessed, userId, settings);
        if (aiResult && aiResult.confidence >= minConfidence) {
          return aiResult;
        }
        // Low confidence or null → use regex result
      } catch {
        // AI extraction failed — use regex result
      }
    }

    // 5. Return regex result (partial or unknown)
    return regexResult;
  }

  /**
   * Fast regex for trivial commands that never need LLM.
   */
  private classifyTrivial(cleaned: string, preprocessed: string): ParseResult | null {
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
   * Full regex chain: commands → income → expense → observation (structural).
   * Observation detection runs unconditionally after financial/command checks.
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

    // Try local income parser
    const income = this.parser.parseIncome(preprocessed) || this.parser.parseIncome(cleaned);
    if (income) {
      const conf = income.category === 'Otros' ? 0.75 : 0.90;
      return {
        intent: { type: 'income', data: income },
        confidence: conf,
        aiUsed: false,
        source: 'income_parser',
        missingFields: [],
      };
    }

    // Try local expense parser
    const expense = this.parser.parseExpense(preprocessed) || this.parser.parseExpense(cleaned);
    if (expense) {
      const conf = expense.category === 'Otros' ? 0.75 : 0.85;
      return {
        intent: { type: 'expense', data: expense },
        confidence: conf,
        aiUsed: false,
        source: 'expense_parser',
        missingFields: [],
      };
    }

    // Financial intent guard — prevent financial messages from becoming observations
    const financialIntent = this.parser.hasFinancialIntent(cleaned);
    if (financialIntent) {
      const finAmount = this.parser.extractAmount(cleaned);
      if (finAmount) {
        const finCategory = this.parser.detectExpenseCategory(cleaned);
        if (finCategory) {
          return {
            intent: { type: 'expense', data: { type: 'expense', amount: finAmount, category: finCategory, description: text, currency: 'ARS' } },
            confidence: 0.85,
            aiUsed: false,
            source: 'expense_parser',
            missingFields: [],
          };
        } else {
          return {
            intent: {
              type: 'expense_partial',
              data: { type: 'expense', amount: finAmount, currency: (cleaned.includes('dolar') || cleaned.includes('usd') ? 'USD' : 'ARS') as 'ARS' | 'USD' },
            },
            confidence: 0.60,
            aiUsed: false,
            source: 'expense_parser',
            missingFields: ['category'],
          };
        }
      }
    }

    // Partial parse detection (financial signals without full parse)
    const partial = this.detectPartialParse(preprocessed, cleaned);
    if (partial) {
      this.logParserError(userId, text, preprocessed, partial, partial.confidence, 'partial').catch(() => {});
      return partial;
    }

    // =========================================================================
    // OBSERVATION DETECTION — runs after command/financial checks
    // Only guard: agronomic ACTIVITY keywords (spraying, fertilization, etc.)
    // that need AI for structured extraction. Observation/report keywords
    // are NOT guarded — they already had a chance to match as commands above.
    // =========================================================================
    const hasAgroActivity = /fumig|pulveriz|aplic[aóo]|herbicid|insecticid|fungicid|glifosato|fertiliz|nutri(?:mos|r|eron)|abono|urea|fósfor|fosforo|sembr|siembr|cosech|labran|arar|rastr/i.test(cleaned);
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
    // Confidence 0.70 (below CONFIDENCE_HIGH_SKIP_AI=0.75) so AI extractor still gets a chance.
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
   * Detect partial parses — message has some expense/income signals but not enough for full parse.
   */
  private detectPartialParse(preprocessed: string, cleaned: string): ParseResult | null {
    const textToCheck = preprocessed || cleaned;

    // Check for expense signals (verb-independent)
    const amount = this.parser.extractAmount(textToCheck);
    const expenseCategory = this.parser.detectExpenseCategory(textToCheck);
    const hasFinancial = this.parser.hasFinancialIntent(textToCheck);

    // Has amount + financial intent but no category → expense partial
    if (amount && hasFinancial && !expenseCategory) {
      return {
        intent: {
          type: 'expense_partial',
          data: { type: 'expense', amount, currency: textToCheck.includes('dolar') || textToCheck.includes('usd') ? 'USD' as const : 'ARS' as const },
        },
        confidence: 0.60,
        aiUsed: false,
        source: 'expense_parser',
        missingFields: ['category'],
      };
    }

    // Has category + financial intent but no amount → expense partial
    if (!amount && expenseCategory && hasFinancial) {
      return {
        intent: {
          type: 'expense_partial',
          data: { type: 'expense', category: expenseCategory },
        },
        confidence: 0.60,
        aiUsed: false,
        source: 'expense_parser',
        missingFields: ['amount'],
      };
    }

    // Check for income signals
    const incomeCategory = this.parser.detectIncomeCategory(textToCheck);
    const hasIncomeVerb = /(?:vend[ií]|cobr[eé]|ingres[eéo]|entr[oó]|factur[eé]|vendi|cobre)\b/.test(textToCheck);

    // Has amount + verb but no category → income partial
    if (amount && hasIncomeVerb && !incomeCategory) {
      return {
        intent: {
          type: 'income_partial',
          data: { type: 'income', amount, currency: textToCheck.includes('dolar') || textToCheck.includes('usd') ? 'USD' as const : 'ARS' as const },
        },
        confidence: 0.60,
        aiUsed: false,
        source: 'income_parser',
        missingFields: ['category'],
      };
    }

    // Has category + verb but no amount → income partial
    if (!amount && incomeCategory && hasIncomeVerb) {
      return {
        intent: {
          type: 'income_partial',
          data: { type: 'income', category: incomeCategory },
        },
        confidence: 0.60,
        aiUsed: false,
        source: 'income_parser',
        missingFields: ['amount'],
      };
    }

    return null;
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
