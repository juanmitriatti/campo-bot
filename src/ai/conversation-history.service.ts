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
   *
   * IMPORTANT: rows where `response_text` is empty/NULL are SKIPPED. Otherwise
   * the agent sees a user message with no paired assistant turn and assumes
   * the request is still outstanding — it then re-fires tool calls for prior
   * unanswered messages on the next turn (real prod bug: a 55k maíz call
   * triggered an extra 40k soja call for a registration the user had typed
   * 3 min earlier that silently failed). Including only completed pairs
   * gives the agent clean context with zero ambiguity.
   */
  async getRecentTurns(userId: UserId, maxChars = 4000): Promise<ConversationTurn[]> {
    if (maxChars <= 0) return [];

    // LIMIT 40: el budget de 4000 chars nunca necesita más filas que eso, y sin
    // límite la query traía TODO el historial del usuario para tirarlo después.
    const { rows } = await pool.query(
      `SELECT message_text, response_text, tool_calls
       FROM conversation_logs
       WHERE user_id = $1
         AND message_text IS NOT NULL
         AND response_text IS NOT NULL
         AND response_text <> ''
       ORDER BY created_at DESC
       LIMIT 40`,
      [userId],
    );

    if (rows.length === 0) return [];

    // Build turns in chronological order (oldest first). Defense-in-depth:
    // skip any row with missing fields even if the SQL filter let it through
    // (avoids the null.length crash downstream).
    const turns: ConversationTurn[] = [];
    const reversed = rows.reverse();

    for (const row of reversed) {
      if (!row.message_text || !row.response_text) continue;
      turns.push({ role: 'user', content: row.message_text });
      // Append a compact summary of the tools the agent fired on that turn so
      // the NEXT turn knows WHAT got registered, not just what the bot said.
      // Without this, "y otro de 30 mil" relies on the response prose alone —
      // frágil cuando la respuesta no nombra la herramienta usada.
      turns.push({
        role: 'assistant',
        content: row.response_text + this.toolCallSuffix(row.tool_calls),
      });
    }

    // Truncate from the front (oldest) to stay within char budget. Always
    // drop in pairs so we never feed a user message without its response.
    let totalChars = turns.reduce((sum, t) => sum + t.content.length, 0);
    while (totalChars > maxChars && turns.length > 0) {
      const removedUser = turns.shift()!;
      totalChars -= removedUser.content.length;
      if (turns.length > 0 && turns[0].role === 'assistant') {
        const removedAssistant = turns.shift()!;
        totalChars -= removedAssistant.content.length;
      }
    }

    return turns;
  }

  /**
   * Compact "[acciones: tool1, tool2]" suffix from the stored tool_calls JSON.
   * Best-effort: any parse problem returns '' so history never breaks on a
   * malformed row. Names only — inputs would blow the char budget.
   */
  private toolCallSuffix(toolCalls: unknown): string {
    try {
      const parsed = typeof toolCalls === 'string' ? JSON.parse(toolCalls) : toolCalls;
      if (!Array.isArray(parsed) || parsed.length === 0) return '';
      const names = parsed
        .map((tc: { toolName?: string; name?: string }) => tc?.toolName ?? tc?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
      if (names.length === 0) return '';
      return `\n[acciones ejecutadas: ${names.join(', ')}]`;
    } catch {
      return '';
    }
  }
}
