import { describe, it, expect } from 'vitest';
import { FewShotService } from '../few-shot.service.js';

const svc = new FewShotService();

function legacy(id: number, intent: string, input: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    input,
    intent,
    expected_output: { intent, confidence: 0.95, ...extras },
  };
}

function multiTool(id: number, input: string, calls: Array<{ tool: string; input: Record<string, unknown> }>) {
  return {
    id,
    input,
    intent: calls.map(c => c.tool).join(','),
    expected_output: { tool_calls: calls },
  };
}

describe('FewShotService.formatAsToolUseMessages', () => {
  it('emits a 3-message triplet for legacy single-tool example', () => {
    const ex = legacy(1, 'log_expense', 'gasté 50mil en gasoil', {
      amount: 50000,
      category: 'combustible',
      currency: 'ARS',
    });
    const msgs = svc.formatAsToolUseMessages([ex]);
    expect(msgs).toHaveLength(3);

    expect(msgs[0]).toEqual({ role: 'user', content: 'gasté 50mil en gasoil' });

    expect(msgs[1].role).toBe('assistant');
    const useBlocks = msgs[1].content as Array<{ type: string; name: string; input: Record<string, unknown>; id: string }>;
    expect(useBlocks).toHaveLength(1);
    expect(useBlocks[0].type).toBe('tool_use');
    expect(useBlocks[0].name).toBe('log_expense');
    expect(useBlocks[0].input).toEqual({ amount: 50000, category: 'combustible', currency: 'ARS' });
    expect(useBlocks[0].input).not.toHaveProperty('intent');
    expect(useBlocks[0].input).not.toHaveProperty('confidence');

    expect(msgs[2].role).toBe('user');
    const resultBlocks = msgs[2].content as Array<{ type: string; tool_use_id: string }>;
    expect(resultBlocks).toHaveLength(1);
    expect(resultBlocks[0].type).toBe('tool_result');
    expect(resultBlocks[0].tool_use_id).toBe(useBlocks[0].id);
  });

  it('emits ONE assistant message with N tool_use blocks for multi-tool example (2 calls)', () => {
    const ex = multiTool(7, 'vendí 25 tn de maíz a 900 USD y 10 tn de soja a 1000 USD', [
      { tool: 'log_income', input: { category: 'Maíz', quantity: 25, unit: 'tn', unit_price: 900, currency: 'USD' } },
      { tool: 'log_income', input: { category: 'Soja', quantity: 10, unit: 'tn', unit_price: 1000, currency: 'USD' } },
    ]);
    const msgs = svc.formatAsToolUseMessages([ex]);
    expect(msgs).toHaveLength(3);

    const useBlocks = msgs[1].content as Array<{ type: string; name: string; input: Record<string, unknown>; id: string }>;
    expect(useBlocks).toHaveLength(2);
    expect(useBlocks[0]).toMatchObject({ type: 'tool_use', name: 'log_income' });
    expect(useBlocks[1]).toMatchObject({ type: 'tool_use', name: 'log_income' });
    expect(useBlocks[0].input.category).toBe('Maíz');
    expect(useBlocks[1].input.category).toBe('Soja');
    expect(useBlocks[0].id).not.toBe(useBlocks[1].id);

    const resultBlocks = msgs[2].content as Array<{ type: string; tool_use_id: string }>;
    expect(resultBlocks).toHaveLength(2);
    expect(resultBlocks.map(r => r.tool_use_id).sort()).toEqual(useBlocks.map(u => u.id).sort());
  });

  it('handles 3+ tool calls (add_field + add_plot + sow_crop)', () => {
    const ex = multiTool(8, 'agregá campo La Esperanza en Pergamino, lote A de 50 has y sembré soja en A', [
      { tool: 'add_field', input: { name: 'La Esperanza', city: 'Pergamino' } },
      { tool: 'add_plot', input: { plotName: 'A', hectares: 50, field: 'La Esperanza' } },
      { tool: 'sow_crop', input: { crop: 'soja', plot: 'A', field: 'La Esperanza' } },
    ]);
    const msgs = svc.formatAsToolUseMessages([ex]);
    const useBlocks = msgs[1].content as Array<{ name: string }>;
    expect(useBlocks).toHaveLength(3);
    expect(useBlocks.map(u => u.name)).toEqual(['add_field', 'add_plot', 'sow_crop']);
  });

  it('mixes legacy and multi-tool examples in a single batch', () => {
    const msgs = svc.formatAsToolUseMessages([
      legacy(1, 'log_expense', 'gasté 50mil en gasoil', { amount: 50000 }),
      multiTool(2, 'vendí maíz y soja', [
        { tool: 'log_income', input: { category: 'Maíz' } },
        { tool: 'log_income', input: { category: 'Soja' } },
      ]),
      legacy(3, 'sow_crop', 'sembré soja en A1', { crop: 'soja', plot: 'A1' }),
    ]);
    // 3 examples × 3 messages each = 9
    expect(msgs).toHaveLength(9);
    expect((msgs[1].content as Array<{ name: string }>)).toHaveLength(1);
    expect((msgs[4].content as Array<{ name: string }>)).toHaveLength(2);
    expect((msgs[7].content as Array<{ name: string }>)).toHaveLength(1);
  });

  it('uses unique tool_use_ids across multi-tool blocks', () => {
    const ex = multiTool(99, 'tres lluvias', [
      { tool: 'log_rainfall', input: { amount: 20 } },
      { tool: 'log_rainfall', input: { amount: 35 } },
      { tool: 'log_rainfall', input: { amount: 12 } },
    ]);
    const msgs = svc.formatAsToolUseMessages([ex]);
    const useBlocks = msgs[1].content as Array<{ id: string }>;
    const ids = useBlocks.map(u => u.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('falls back to ex.intent when expected_output.intent is missing (legacy edge case)', () => {
    const ex = {
      id: 4,
      input: 'hola',
      intent: 'greeting',
      expected_output: { confidence: 1.0 } as Record<string, unknown>,
    };
    const msgs = svc.formatAsToolUseMessages([ex]);
    const useBlocks = msgs[1].content as Array<{ name: string }>;
    expect(useBlocks[0].name).toBe('greeting');
  });

  it('rejects malformed multi-tool shape and falls back to legacy parsing', () => {
    // tool_calls without `tool` field → not a valid multi-tool shape → treated as legacy
    const ex = {
      id: 5,
      input: 'borked',
      intent: 'fallback_intent',
      expected_output: { intent: 'fallback_intent', tool_calls: [{ noTool: true }] } as Record<string, unknown>,
    };
    const msgs = svc.formatAsToolUseMessages([ex]);
    const useBlocks = msgs[1].content as Array<{ name: string; input: Record<string, unknown> }>;
    expect(useBlocks).toHaveLength(1);
    expect(useBlocks[0].name).toBe('fallback_intent');
    expect(useBlocks[0].input).toEqual({ tool_calls: [{ noTool: true }] });
  });
});

describe('FewShotService.formatAsMessages (legacy JSON path)', () => {
  it('emits user/assistant pairs for legacy examples', () => {
    const msgs = svc.formatAsMessages([
      legacy(1, 'log_expense', 'gasté 50mil', { amount: 50000 }),
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'gasté 50mil' });
    expect(msgs[1].role).toBe('assistant');
    const parsed = JSON.parse(msgs[1].content as string);
    expect(parsed.intent).toBe('log_expense');
    expect(parsed.amount).toBe(50000);
  });

  it('skips multi-tool examples (JSON extractor only models one intent per turn)', () => {
    const msgs = svc.formatAsMessages([
      legacy(1, 'log_expense', 'gasté 50mil', { amount: 50000 }),
      multiTool(2, 'vendí maíz y soja', [
        { tool: 'log_income', input: { category: 'Maíz' } },
        { tool: 'log_income', input: { category: 'Soja' } },
      ]),
      legacy(3, 'sow_crop', 'sembré soja en A1', { crop: 'soja', plot: 'A1' }),
    ]);
    // Multi-tool dropped → 2 examples × 2 messages = 4
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toEqual({ role: 'user', content: 'gasté 50mil' });
    expect(msgs[2]).toEqual({ role: 'user', content: 'sembré soja en A1' });
  });
});
