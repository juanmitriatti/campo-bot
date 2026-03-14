import { pool } from '../../config/db.js';
import type { UserId, VocabularyEntry, VocabularyCategory, MessagePatternRow } from '../../types/index.js';

export class LearningRepository {

  /** Upsert a vocabulary entry. If it already exists, bump confidence and hit_count. */
  async upsertVocabulary(
    userId: UserId,
    phrase: string,
    normalizedPhrase: string,
    resolvedValue: string,
    category: VocabularyCategory,
    confidence: number = 0.5,
  ): Promise<VocabularyEntry> {
    const result = await pool.query(
      `INSERT INTO farmer_vocabulary (user_id, phrase, normalized_phrase, resolved_value, category, confidence)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, normalized_phrase, category)
       DO UPDATE SET
         hit_count = farmer_vocabulary.hit_count + 1,
         confidence = LEAST(1.0, farmer_vocabulary.confidence + 0.1),
         updated_at = NOW()
       RETURNING *`,
      [userId, phrase, normalizedPhrase, resolvedValue, category, confidence]
    );
    return result.rows[0];
  }

  /** Get all vocabulary for a user, optionally filtered by category. */
  async getVocabulary(userId: UserId, category?: VocabularyCategory): Promise<VocabularyEntry[]> {
    if (category) {
      const result = await pool.query(
        `SELECT * FROM farmer_vocabulary
         WHERE user_id = $1 AND category = $2 AND confidence >= 0.3
         ORDER BY confidence DESC, hit_count DESC`,
        [userId, category]
      );
      return result.rows;
    }
    const result = await pool.query(
      `SELECT * FROM farmer_vocabulary
       WHERE user_id = $1 AND confidence >= 0.3
       ORDER BY confidence DESC, hit_count DESC`,
      [userId]
    );
    return result.rows;
  }

  /** Find vocabulary entries matching a specific phrase for a user. */
  async findByPhrase(userId: UserId, normalizedPhrase: string): Promise<VocabularyEntry[]> {
    const result = await pool.query(
      `SELECT * FROM farmer_vocabulary
       WHERE user_id = $1 AND normalized_phrase = $2 AND confidence >= 0.3
       ORDER BY confidence DESC`,
      [userId, normalizedPhrase]
    );
    return result.rows;
  }

  /** Find vocabulary entries where the phrase appears in the given text. */
  async findMatchesInText(userId: UserId, normalizedText: string, category?: VocabularyCategory): Promise<VocabularyEntry[]> {
    const vocab = await this.getVocabulary(userId, category);
    return vocab.filter(v => normalizedText.includes(v.normalized_phrase));
  }

  /** Save a message pattern (successful parse result). */
  async savePattern(
    userId: UserId,
    message: string,
    normalizedMessage: string,
    intent: string,
    entities: Record<string, unknown>,
    source: string = 'parser',
  ): Promise<MessagePatternRow> {
    const result = await pool.query(
      `INSERT INTO message_patterns (user_id, message, normalized_message, intent, entities, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, message, normalizedMessage, intent, JSON.stringify(entities), source]
    );
    return result.rows[0];
  }

  /** Get recent patterns for a user. */
  async getRecentPatterns(userId: UserId, limit: number = 50): Promise<MessagePatternRow[]> {
    const result = await pool.query(
      `SELECT * FROM message_patterns
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  }
}
