import { describe, it, expect } from 'vitest';
import { AgentPromptBuilder } from '../agent-prompt-builder.js';
import type { UserContext } from '../user-context.service.js';

describe('AgentPromptBuilder', () => {
  const builder = new AgentPromptBuilder();

  it('builds prompt without user context', () => {
    const prompt = builder.build(null);
    expect(prompt).toContain('MIA');
    expect(prompt).toContain('herramienta');
    expect(prompt).toContain('DESAMBIGUACIÓN');
    expect(prompt).not.toContain('Usuario:');
  });

  it('exposes user context via buildUserMessagePrefix (not in cached system prompt)', () => {
    const ctx: UserContext = {
      fieldNames: ['Norte', 'Sur'],
      plotNames: ['A1', 'B2'],
      lastFieldName: 'Norte',
      lastPlotName: 'A1',
    };
    const prompt = builder.build(ctx);
    // User-specific context format must NOT leak into the cached system prompt
    expect(prompt).not.toContain('Usuario:');
    expect(prompt).not.toContain('último campo:');
    expect(prompt).not.toContain('último lote:');

    const prefix = builder.buildUserMessagePrefix(ctx);
    expect(prefix).toContain('campos:[Norte,Sur]');
    expect(prefix).toContain('lotes:[A1,B2]');
    expect(prefix).toContain('último campo:Norte');
    expect(prefix).toContain('último lote:A1');
    expect(prefix).toMatch(/^Hoy: \d{4}-\d{2}-\d{2}/);
  });

  it('omits empty context sections', () => {
    const ctx: UserContext = {
      fieldNames: [],
      plotNames: [],
      lastFieldName: null,
      lastPlotName: null,
    };
    const prompt = builder.build(ctx);
    expect(prompt).not.toContain('Usuario:');
  });

  it('includes disambiguation rules', () => {
    const prompt = builder.build(null);
    expect(prompt).toContain('log_expense');
    expect(prompt).toContain('log_income');
    expect(prompt).toContain('log_spraying');
    expect(prompt).toContain('query_plot_history');
    expect(prompt).toContain('financial_report');
  });

  it('includes currency conventions', () => {
    const prompt = builder.build(null);
    expect(prompt).toContain('lucas=miles');
    expect(prompt).toContain('palos=millones');
    expect(prompt).toContain('ARS');
  });
});
