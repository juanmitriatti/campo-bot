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

  async classify(
    text: string,
    userId: UserId,
    settings: UserSettings
  ): Promise<ParseResult> {
    // 0. Strip audio transcription filler phrases + preprocess
    const cleaned = stripFillerPhrases(text);
    const preprocessed = this.parser.preprocess(cleaned);

    // 1. Trivial command bypass — cheap regex, no API call needed
    const trivialCmd = this.classifyTrivial(cleaned, preprocessed);
    if (trivialCmd) return trivialCmd;

    // 2. Full regex chain — handles commands, income, expense
    const regexResult = await this.classifyWithRegex(text, cleaned, preprocessed, userId);

    // If regex matched with high confidence, skip AI entirely
    const highConfidenceThreshold = (await getSettingNumber('CONFIDENCE_HIGH_SKIP_AI')) ?? 0.75;
    if (regexResult.confidence >= highConfidenceThreshold) {
      return regexResult;
    }

    // 3. AI extraction — only for partial (0.60) or unknown (0.0)
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

    // 4. Return regex result (partial or unknown)
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
   * Full regex chain: commands → income → expense → partial detection.
   * No Claude fallback — that's now handled by the AI extractor.
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

    // Partial parse detection
    const partial = this.detectPartialParse(preprocessed, cleaned);
    if (partial) {
      this.logParserError(userId, text, preprocessed, partial, partial.confidence, 'partial').catch(() => {});
      return partial;
    }

    // Try observation — message references a plot/field but isn't expense/income/command
    // Skip if message has agronomic activity keywords that should go to AI for structured extraction
    const hasAgroActivity = /fumig|pulveriz|aplic[aóo]|herbicid|insecticid|fungicid|glifosato|fertiliz|nutri(?:mos|r|eron)|abono|urea|fósfor|fosforo|sembr|siembr|cosech|labran|arar|rastr|riego|reg[aué]/i.test(cleaned);
    const hasReportIntent = /(?:^|\s)(?:reporte|informe|resumen|estado|info(?:rmacion)?|datos|como\s+viene|actividad(?:es)?)\b/i.test(cleaned);
    const obs = (hasAgroActivity || hasReportIntent) ? null : (this.parser.parseObservation(cleaned) || this.parser.parseObservation(preprocessed));
    if (obs) {
      return {
        intent: {
          type: 'command',
          data: {
            command: 'log_observation',
            fieldName: obs.fieldName,
            plotName: obs.plotName,
            observation: text,
          },
        },
        confidence: 0.80,
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

    // Check for expense signals
    const amount = this.parser.normalizeAmount(textToCheck);
    const expenseCategory = this.parser.detectExpenseCategory(textToCheck);
    const hasExpenseVerb = /(?:pagu[eé]|gast[eé]|compr[eé]|pague|gaste|compre)\b/.test(textToCheck);

    // Has amount + verb but no category → expense partial
    if (amount && hasExpenseVerb && !expenseCategory) {
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

    // Has category + verb but no amount → expense partial
    if (!amount && expenseCategory && hasExpenseVerb) {
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
