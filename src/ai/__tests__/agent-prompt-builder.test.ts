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

  it('includes user context when provided', () => {
    const ctx: UserContext = {
      fieldNames: ['Norte', 'Sur'],
      plotNames: ['A1', 'B2'],
      lastFieldName: 'Norte',
      lastPlotName: 'A1',
    };
    const prompt = builder.build(ctx);
    expect(prompt).toContain('campos:[Norte,Sur]');
    expect(prompt).toContain('lotes:[A1,B2]');
    expect(prompt).toContain('último campo:Norte');
    expect(prompt).toContain('último lote:A1');
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
    expect(prompt).toContain('plot_report');
  });

  it('includes currency conventions', () => {
    const prompt = builder.build(null);
    expect(prompt).toContain('lucas=miles');
    expect(prompt).toContain('palos=millones');
    expect(prompt).toContain('ARS');
  });
});
