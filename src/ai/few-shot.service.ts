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
   * Load active training examples from DB, random sample.
   */
  async getExamples(limit = 5): Promise<TrainingExample[]> {
    return query<TrainingExample>(
      `SELECT id, input, expected_output, intent
       FROM ai_training_examples
       WHERE is_active = true
       ORDER BY RANDOM()
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
}
