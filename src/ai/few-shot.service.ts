import { query } from '../config/database.js';
import type Anthropic from '@anthropic-ai/sdk';

interface TrainingExample {
  id: number;
  input: string;
  expected_output: Record<string, unknown>;
  intent: string;
}

interface MultiToolCall {
  tool: string;
  input?: Record<string, unknown>;
}

/**
 * `expected_output` may take two shapes:
 *   - Legacy single-tool: `{ intent, confidence?, ...toolInput }`
 *   - Multi-tool:        `{ tool_calls: [{ tool, input }, ...] }` (1..N calls,
 *                         enables compound-action demos like "vendí X y vendí Y").
 */
function isMultiToolOutput(output: Record<string, unknown>): output is { tool_calls: MultiToolCall[] } {
  const tc = output?.tool_calls;
  if (!Array.isArray(tc) || tc.length === 0) return false;
  return tc.every(
    t => t != null && typeof t === 'object' && typeof (t as MultiToolCall).tool === 'string',
  );
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
   * Legacy JSON format (used by intent-extractor when AGENT_ENABLED=false).
   * Multi-tool examples are skipped because the JSON extractor models only
   * ONE intent per assistant turn.
   */
  formatAsMessages(examples: TrainingExample[]): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];
    for (const ex of examples) {
      if (isMultiToolOutput(ex.expected_output)) continue;
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
   *
   * Single-tool example becomes:
   *   1. user: "gasté 50mil en gasoil"
   *   2. assistant: [{ type: 'tool_use', name: 'log_expense', input: {...} }]
   *   3. user: [{ type: 'tool_result', tool_use_id: '...', content: 'OK' }]
   *
   * Multi-tool example becomes ONE assistant turn with N tool_use blocks +
   * ONE matching user turn with N tool_result blocks (canonical Anthropic
   * shape for multiple tools fired in a single response). Teaches the agent
   * to emit compound actions like "vendí 25 tn de maíz a 900 USD y 10 tn de
   * soja a 1000 USD" → 2× log_income in one turn.
   */
  formatAsToolUseMessages(examples: TrainingExample[]): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];
    for (const ex of examples) {
      const toolUseBlocks: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> = [];
      const toolResultBlocks: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

      if (isMultiToolOutput(ex.expected_output)) {
        ex.expected_output.tool_calls.forEach((c, i) => {
          const id = `fewshot_${ex.id}_${i}`;
          toolUseBlocks.push({
            type: 'tool_use',
            id,
            name: c.tool,
            input: (c.input ?? {}) as Record<string, unknown>,
          });
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: id,
            content: 'OK',
          });
        });
      } else {
        const { intent, confidence: _c, ...toolInput } = ex.expected_output as Record<string, unknown>;
        const toolName = (typeof intent === 'string' ? intent : ex.intent) || 'unknown';
        const id = `fewshot_${ex.id}`;
        toolUseBlocks.push({
          type: 'tool_use',
          id,
          name: toolName,
          input: toolInput,
        });
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: id,
          content: 'OK',
        });
      }

      if (toolUseBlocks.length === 0) continue;

      messages.push({ role: 'user', content: ex.input });
      messages.push({ role: 'assistant', content: toolUseBlocks });
      messages.push({ role: 'user', content: toolResultBlocks });
    }
    return messages;
  }
}
