import { LearningRepository } from './learning.repository.js';
import { normalizeText } from '../../utils/parser.js';
import type { UserId, Intent, VocabularyCategory } from '../../types/index.js';
import { logError } from '../../services/error-logger.js';

/** Words too common to learn as vocabulary. */
const STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'en', 'al', 'a', 'por', 'con', 'para', 'y', 'o',
  'que', 'se', 'me', 'le', 'lo', 'te', 'nos', 'les',
  'mi', 'tu', 'su', 'hoy', 'ayer', 'ya',
  'no', 'si', 'mas', 'muy', 'hay',
  'fue', 'ser', 'son', 'era', 'sos',
]);

/** Known crop names (normalized). Matches parser.js CULTIVOS. */
const KNOWN_CROPS = new Set([
  'soja', 'soya', 'maiz', 'trigo', 'girasol', 'sorgo',
  'cebada', 'avena', 'centeno', 'alfalfa',
]);

/** Known product names (normalized). Matches parser.js PRODUCTOS_AGRO. */
const KNOWN_PRODUCTS = new Set([
  'glifosato', 'glifo', 'roundup', 'atrazina', '2,4-d', '24d',
  'metsulfuron', 'dicamba', 'paraquat', 'imazetapir', 'cletodim', 'haloxifop',
  'cipermetrina', 'clorpirifos', 'fipronil', 'imidacloprid', 'dimetoato',
  'azoxistrobina', 'carbendazim', 'tebuconazol',
  'urea', 'fosfato', 'dap', 'map', 'superfosfato', 'sulfato', 'nitrato',
  'can', 'uan', 'potasio',
]);

/** Known fuel/energy words. */
const KNOWN_FUEL = new Set([
  'gasoil', 'nafta', 'diesel', 'combustible', 'gas oil', 'gas-oil',
]);

/** Known expense categories (normalized). */
const KNOWN_CATEGORIES = new Set([
  'combustible', 'fertilizantes', 'semillas', 'agroquimicos',
  'sueldos', 'maquinaria', 'arrendamiento', 'impuestos',
]);

export class LearningService {
  private repo: LearningRepository;

  constructor(repo?: LearningRepository) {
    this.repo = repo ?? new LearningRepository();
  }

  /**
   * Learn from a successfully processed message.
   * Called AFTER the message has been parsed and routed.
   * Non-blocking — errors are logged but don't break the pipeline.
   */
  async learnFromMessage(
    userId: UserId,
    originalText: string,
    intent: Intent,
    aiUsed: boolean,
  ): Promise<void> {
    try {
      const normalized = normalizeText(originalText);
      const source = aiUsed ? 'claude' : 'parser';

      // Store the pattern
      const entities = this._extractEntities(intent);
      await this.repo.savePattern(userId, originalText, normalized, intent.type, entities, source);

      // Extract and learn vocabulary
      await this._learnVocabulary(userId, normalized, intent);
    } catch (err) {
      console.error('LearningService.learnFromMessage error:', err);
      logError('learning', 'LEARN_MESSAGE', err as Error, { userId });
    }
  }

  /**
   * Extract vocabulary from a processed message based on its intent.
   */
  private async _learnVocabulary(
    userId: UserId,
    normalized: string,
    intent: Intent,
  ): Promise<void> {
    if (intent.type === 'unknown') return;

    // Learn lot names from commands
    if (intent.type === 'command') {
      const data = intent.data;
      const plotName = data.plotName as string | null;
      const fieldName = data.fieldName as string | null;

      if (plotName) {
        await this._learnPhrase(userId, plotName, normalizeText(plotName), 'lot_name', 0.6);
      }
      if (fieldName) {
        await this._learnPhrase(userId, fieldName, normalizeText(fieldName), 'lot_name', 0.6);
      }

      // Learn product from agronomy commands
      const product = data.product as string | null;
      if (product && !KNOWN_PRODUCTS.has(normalizeText(product))) {
        await this._learnPhrase(userId, product, normalizeText(product), 'product', 0.5);
      }

      // Learn crop from agronomy commands
      const crop = data.crop as string | null;
      if (crop && !KNOWN_CROPS.has(normalizeText(crop))) {
        await this._learnPhrase(userId, crop, normalizeText(crop), 'crop', 0.5);
      }
    }

    // Learn from expense categories
    if (intent.type === 'expense') {
      const desc = intent.data.description;
      const category = intent.data.category;

      // Extract meaningful words from description that map to this category
      const words = normalizeText(desc).split(/\s+/);
      for (const word of words) {
        if (word.length < 3 || STOP_WORDS.has(word)) continue;
        if (KNOWN_CATEGORIES.has(word) || KNOWN_PRODUCTS.has(word)) continue;
        if (KNOWN_FUEL.has(word)) {
          await this._learnPhrase(userId, word, word, 'fuel', 0.6);
          continue;
        }
        // New words in expense descriptions might be slang
        if (!STOP_WORDS.has(word) && word.length >= 4) {
          await this._learnPhrase(userId, word, word, 'slang', 0.3);
        }
      }

      // Learn fuel words specifically
      if (category === 'Combustible') {
        for (const word of words) {
          if (word.length >= 3 && !STOP_WORDS.has(word) && !KNOWN_FUEL.has(word)) {
            await this._learnPhrase(userId, word, word, 'fuel', 0.4);
          }
        }
      }
    }

    // Learn from income categories (crop names)
    if (intent.type === 'income') {
      const category = intent.data.category;
      if (category && !KNOWN_CROPS.has(normalizeText(category))) {
        await this._learnPhrase(userId, category, normalizeText(category), 'crop', 0.5);
      }
    }

    // Learn lot names from raw text patterns
    await this._detectAndLearnLotNames(userId, normalized);
  }

  /**
   * Detect potential lot names from text patterns like "en el [name]", "al [name]".
   * Only learns if the name doesn't match known crops/products.
   */
  private async _detectAndLearnLotNames(userId: UserId, normalized: string): Promise<void> {
    // Match patterns: "en el/la [word]", "al [word]", "del [word]"
    // Capture one or two words that form a place name
    const lotPatterns = [
      /(?:en el|en la|al|del)\s+([a-z]+(?:\s+[a-z]+)?)(?:\s+(?:con|de|del|en|al|por|para|a)\b|$)/g,
    ];

    for (const pattern of lotPatterns) {
      let match;
      while ((match = pattern.exec(normalized)) !== null) {
        const candidate = match[1].trim();
        if (candidate.length < 2) continue;
        if (STOP_WORDS.has(candidate)) continue;
        if (KNOWN_CROPS.has(candidate)) continue;
        if (KNOWN_PRODUCTS.has(candidate)) continue;
        if (KNOWN_FUEL.has(candidate)) continue;
        if (KNOWN_CATEGORIES.has(candidate)) continue;
        // Numeric lot references are handled by parser already
        if (/^\d+$/.test(candidate)) continue;

        // Check if it's already known to the parser (e.g., "lote 3" → skip)
        if (candidate.startsWith('lote ') || candidate.startsWith('campo ')) continue;

        await this._learnPhrase(userId, candidate, candidate, 'lot_name', 0.4);
      }
    }
  }

  private async _learnPhrase(
    userId: UserId,
    phrase: string,
    normalizedPhrase: string,
    category: VocabularyCategory,
    confidence: number,
  ): Promise<void> {
    await this.repo.upsertVocabulary(
      userId,
      phrase,
      normalizedPhrase,
      `${category}:${normalizedPhrase}`,
      category,
      confidence,
    );
  }

  /** Extract entities from an intent for pattern storage. */
  private _extractEntities(intent: Intent): Record<string, unknown> {
    switch (intent.type) {
      case 'expense':
        return {
          amount: intent.data.amount,
          category: intent.data.category,
          currency: intent.data.currency,
        };
      case 'income':
        return {
          amount: intent.data.amount,
          category: intent.data.category,
          currency: intent.data.currency,
          quantity: intent.data.quantity,
          unit: intent.data.unit,
        };
      case 'command':
        return { command: intent.data.command };
      case 'unknown':
        return {};
      default:
        return {};
    }
  }
}
