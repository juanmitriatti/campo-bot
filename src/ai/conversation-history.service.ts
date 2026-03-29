import { pool } from '../config/db.js';
import type { UserId } from '../types/index.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export class ConversationHistoryService {
  /**
   * Get recent conversation turns for multi-turn AI context.
   * Returns oldest-first order, trimmed from oldest to fit within maxChars.
   */
  async getRecentTurns(userId: UserId, maxChars = 4000): Promise<ConversationTurn[]> {
    if (maxChars <= 0) return [];

    const { rows } = await pool.query(
      `SELECT message_text, response_text
       FROM conversation_logs
       WHERE user_id = $1 AND message_text IS NOT NULL
       ORDER BY created_at DESC`,
      [userId],
    );

    if (rows.length === 0) return [];

    // Build turns in chronological order (oldest first)
    const turns: ConversationTurn[] = [];
    const reversed = rows.reverse();

    for (const row of reversed) {
      if (row.message_text) {
        turns.push({ role: 'user', content: row.message_text });
      }
      if (row.response_text) {
        turns.push({ role: 'assistant', content: row.response_text });
      }
    }

    // Truncate from the front (oldest) to stay within char budget
    let totalChars = turns.reduce((sum, t) => sum + t.content.length, 0);
    while (totalChars > maxChars && turns.length > 0) {
      const removed = turns.shift()!;
      totalChars -= removed.content.length;
      // If we removed a user message, also remove the following assistant message
      // to keep pairs intact
      if (removed.role === 'user' && turns.length > 0 && turns[0].role === 'assistant') {
        const removedAssistant = turns.shift()!;
        totalChars -= removedAssistant.content.length;
      }
    }

    return turns;
  }
}
