import { query } from '../config/database.js';
import type Anthropic from '@anthropic-ai/sdk';

interface TrainingExample {
  id: number;
  input: string;
  expected_output: Record<string, unknown>;
  intent: string;
}

export class FewShotService {
  /**
   * Load active training examples from DB. Order is **deterministic per day**
   * so the cached prefix (tools + system + few-shot) stays stable within a
   * day — random ordering was invalidating the cache on every call, paying
   * 125% cache-write pricing each time.
   *
   * Pseudo-randomness per day is preserved via md5(id || CURRENT_DATE) so
   * Haiku sees different example rotations over time without thrashing cache.
   */
  async getExamples(limit = 5): Promise<TrainingExample[]> {
    return query<TrainingExample>(
      `SELECT id, input, expected_output, intent
       FROM ai_training_examples
       WHERE is_active = true
       ORDER BY md5(id::text || CURRENT_DATE::text)
       LIMIT $1`,
      [limit],
    );
  }

  /**
   * Format examples as alternating user/assistant message pairs
   * for injection into the Anthropic messages array.
   */
  formatAsMessages(examples: TrainingExample[]): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];
    for (const ex of examples) {
      messages.push({ role: 'user', content: ex.input });
      messages.push({
        role: 'assistant',
        content: JSON.stringify(ex.expected_output),
      });
    }
    return messages;
  }

  /**
   * Format examples as tool_use message triplets for the Agent pipeline.
   * Each example becomes:
   *   1. user: "gasté 50mil en gasoil"
   *   2. assistant: [{ type: 'tool_use', name: 'log_expense', input: {...} }]
   *   3. user: [{ type: 'tool_result', tool_use_id: '...', content: 'OK' }]
   *
   * The expected_output JSONB has { intent, amount, category, ... } —
   * 'intent' becomes the tool name, the rest becomes tool input.
   */
  formatAsToolUseMessages(examples: TrainingExample[]): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];
    for (const ex of examples) {
      const { intent, confidence: _c, ...toolInput } = ex.expected_output as Record<string, unknown>;
      const toolName = (typeof intent === 'string' ? intent : ex.intent) || 'unknown';
      const fakeId = `fewshot_${ex.id}`;

      messages.push({ role: 'user', content: ex.input });
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: fakeId,
          name: toolName,
          input: toolInput,
        }],
      });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: fakeId,
          content: 'OK',
        }],
      });
    }
    return messages;
  }
}
