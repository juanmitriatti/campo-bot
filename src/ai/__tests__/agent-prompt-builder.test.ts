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
    expect(prompt).toContain('palo=millón');
    expect(prompt).toContain('ARS');
  });

  describe('reduced context mode (Phase 5)', () => {
    const ctx: UserContext = {
      fieldNames: ['Norte', 'Sur'],
      plotNames: ['A1', 'B2'],
      lastFieldName: 'Norte',
      lastPlotName: 'A1',
      recentContexts: [
        { fieldName: 'Norte', plotName: 'A1' },
        { fieldName: 'Sur', plotName: 'B2' },
      ],
      corralNames: [],
      feedlotNames: [],
    };

    it('includes último/recent context when reduced flag is OFF (default)', () => {
      const prefix = builder.buildUserMessagePrefix(ctx);
      expect(prefix).toContain('último campo:Norte');
      expect(prefix).toContain('último lote:A1');
      expect(prefix).toContain('contextos recientes:');
    });

    it('omits último/recent context when reduced flag is ON', () => {
      const prefix = builder.buildUserMessagePrefix(ctx, true);
      expect(prefix).not.toContain('último campo:');
      expect(prefix).not.toContain('último lote:');
      expect(prefix).not.toContain('contextos recientes:');
    });

    it('still includes campos/lotes lists in reduced mode', () => {
      // Names of all owned plots/fields are kept — the agent still needs them
      // to recognize when the user says a real plot name like "Norte".
      const prefix = builder.buildUserMessagePrefix(ctx, true);
      expect(prefix).toContain('campos:[Norte,Sur]');
      expect(prefix).toContain('lotes:[A1,B2]');
    });

    it('still includes today date in reduced mode', () => {
      const prefix = builder.buildUserMessagePrefix(ctx, true);
      expect(prefix).toMatch(/^Hoy: \d{4}-\d{2}-\d{2}/);
    });

    it('reduced mode with no context returns just the date', () => {
      const prefix = builder.buildUserMessagePrefix(null, true);
      expect(prefix).toMatch(/^Hoy: \d{4}-\d{2}-\d{2}/);
      expect(prefix).not.toContain('Usuario:');
    });
  });
});
