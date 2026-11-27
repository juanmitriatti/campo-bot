// La caravana electrónica llega como `new_visual_tag` (Haiku 5.5): se corrige.
import { describe, it, expect } from 'vitest';
import { AgentResponseMapper } from '../agent-response-mapper.js';

const run = (toolName: string, toolInput: Record<string, unknown>, text: string) => {
  const [first] = new AgentResponseMapper().mapToParseResults({
    toolCalls: [{ toolName, toolInput, toolUseId: 't1' }], conversationalText: null,
    usage: { input_tokens: 0, output_tokens: 0 }, truncated: false,
  }, text);
  return (first.intent as { data: Record<string, unknown> }).data;
};

describe('tipo de caravana según el número', () => {
  it('un CII en new_visual_tag es la caravana electrónica nueva', () => {
    const data = run('identify_animal', { animal_ref: '0000000077', new_visual_tag: '032 01 0000000078' },
      'la vaca 0000000077 perdió la caravana, le puse la 032 01 0000000078');
    expect(data.newRfid).toBe('032 01 0000000078');
    expect(data.newVisualTag).toBeUndefined();
  });

  it('una caravana visual de verdad queda como visual', () => {
    const data = run('identify_animal', { animal_ref: '0000000077', new_visual_tag: 'AZ-45' },
      'a la 0000000077 le puse la visual AZ-45');
    expect(data.newVisualTag).toBe('AZ-45');
    expect(data.newRfid).toBeUndefined();
  });
});
