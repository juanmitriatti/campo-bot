import { LearningRepository } from './learning.repository.js';
import { normalizeText } from '../../utils/parser.js';
import type { UserId, Intent, LearningContext, VocabularyEntry } from '../../types/index.js';

/**
 * ContextResolver enriches parsed intents using learned farmer vocabulary.
 *
 * It runs AFTER the IntentClassifier and BEFORE the DomainRouter,
 * adding contextual information the parser couldn't detect.
 *
 * Key principle: never overrides existing parsed data, only fills gaps.
 */
export class ContextResolver {
  private repo: LearningRepository;

  constructor(repo?: LearningRepository) {
    this.repo = repo ?? new LearningRepository();
  }

  /**
   * Load all learned vocabulary for a user, grouped by category.
   */
  async loadContext(userId: UserId): Promise<LearningContext> {
    const [lots, crops, products, slang] = await Promise.all([
      this.repo.getVocabulary(userId, 'lot_name'),
      this.repo.getVocabulary(userId, 'crop'),
      this.repo.getVocabulary(userId, 'product'),
      this.repo.getVocabulary(userId, 'slang'),
    ]);
    return { lots, crops, products, slang };
  }

  /**
   * Enrich an intent with learned vocabulary context.
   * Only fills in missing fields — never overwrites parser results.
   */
  async enrichIntent(
    userId: UserId,
    text: string,
    intent: Intent,
  ): Promise<Intent> {
    // Only enrich commands (agronomy activities, etc.) — expenses/incomes are already complete
    if (intent.type !== 'command') return intent;

    const normalized = normalizeText(text);
    const data = intent.data;
    const command = data.command as string;

    // Only enrich agronomy and field-related commands
    const enrichableCommands = new Set([
      'log_spraying', 'log_fertilization', 'log_tillage', 'log_irrigation',
      'sow_crop', 'harvest_crop', 'log_rainfall',
    ]);

    if (!enrichableCommands.has(command)) return intent;

    const context = await this.loadContext(userId);

    const enriched = { ...data };
    let changed = false;

    // Resolve lot name from vocabulary if not already set
    if (!enriched.plotName && !enriched.fieldName) {
      const lotMatch = this._findBestLotMatch(normalized, context.lots);
      if (lotMatch) {
        enriched.plotName = lotMatch.phrase;
        changed = true;
      }
    }

    // Resolve crop from vocabulary if not already set
    if (!enriched.crop) {
      const cropMatch = this._findBestMatch(normalized, context.crops);
      if (cropMatch) {
        enriched.crop = cropMatch.phrase;
        changed = true;
      }
    }

    // Resolve product from vocabulary if not already set
    if (!enriched.product) {
      const productMatch = this._findBestMatch(normalized, context.products);
      if (productMatch) {
        enriched.product = productMatch.phrase;
        changed = true;
      }
    }

    if (!changed) return intent;

    return { type: 'command', data: enriched };
  }

  /**
   * Find the best matching lot name in text.
   * Lot names are special: we look for them in location-indicating phrases.
   */
  private _findBestLotMatch(
    normalizedText: string,
    lots: VocabularyEntry[],
  ): VocabularyEntry | null {
    // Sort by phrase length desc (prefer longer matches) then confidence
    const sorted = [...lots].sort((a, b) => {
      const lenDiff = b.normalized_phrase.length - a.normalized_phrase.length;
      if (lenDiff !== 0) return lenDiff;
      return b.confidence - a.confidence;
    });

    for (const entry of sorted) {
      if (entry.confidence < 0.4) continue;
      if (normalizedText.includes(entry.normalized_phrase)) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Find the best matching vocabulary entry in text.
   */
  private _findBestMatch(
    normalizedText: string,
    entries: VocabularyEntry[],
  ): VocabularyEntry | null {
    // Only use entries with decent confidence
    const sorted = [...entries]
      .filter(e => e.confidence >= 0.5)
      .sort((a, b) => {
        const lenDiff = b.normalized_phrase.length - a.normalized_phrase.length;
        if (lenDiff !== 0) return lenDiff;
        return b.confidence - a.confidence;
      });

    for (const entry of sorted) {
      if (normalizedText.includes(entry.normalized_phrase)) {
        return entry;
      }
    }
    return null;
  }
}
