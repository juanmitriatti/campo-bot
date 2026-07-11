import { describe, it, expect } from 'vitest';
import { isSafeFallbackCommand, fallbackBlockedCopy, SAFE_FALLBACK_INTENTS } from '../intent-safety.js';

describe('isSafeFallbackCommand', () => {
  it('allows conversation control commands', () => {
    for (const cmd of ['confirm', 'cancel', 'greeting', 'thanks', 'ack', 'help', 'menu']) {
      expect(isSafeFallbackCommand(cmd)).toBe(true);
    }
  });

  it('allows read-only listings and info', () => {
    for (const cmd of [
      'list_fields', 'list_plots',
      'field_info', 'plot_info',
      'show_alerts', 'show_expense_menu', 'show_income_menu',
      'query_plot_history',
    ]) {
      expect(isSafeFallbackCommand(cmd)).toBe(true);
    }
  });

  it('allows weather and dollar lookups (read-only external)', () => {
    for (const cmd of ['weather_all', 'weather_field', 'weather_forecast', 'weather_full', 'dollar']) {
      expect(isSafeFallbackCommand(cmd)).toBe(true);
    }
  });

  it('allows log_observation (text-only write)', () => {
    expect(isSafeFallbackCommand('log_observation')).toBe(true);
  });

  it('blocks all data-CRUD commands (regression guard)', () => {
    const dangerous = [
      // Field/plot CRUD — high-risk if mis-parsed
      'add_field', 'add_plot', 'add_plots_batch',
      'delete_field', 'delete_plot',
      'rename_field', 'rename_plot',
      'set_field_city', 'add_field_city', 'set_plot_area',
      'restore_field',
      // Settings writes
      'set_city', 'set_name', 'set_budget',
      'set_rain_threshold',
      'enable_rain_alerts', 'disable_rain_alerts',
      'enable_budget_alerts', 'disable_budget_alerts',
      'enable_weekly_summary', 'disable_weekly_summary',
      // Edits and deletes of past records
      'delete_last', 'delete_last_income', 'delete_specific',
      'edit_specific', 'edit_last', 'edit_last_activity',
      // Flow starters (data-write flows)
      'start_expense_flow', 'start_income_flow', 'start_document_upload',
      'prompt_rainfall', 'prompt_add_field', 'prompt_add_plot',
      // Heavy / AI-required
      'generate_agro_report',
      'export_csv',
      // Internal / unknown
      '_toggle_alert',
      // Financial / agronomic / livestock / stock — never via regex
      'log_expense', 'log_income', 'log_rainfall', 'log_rainfall_batch',
      'sow_crop', 'harvest_crop', 'log_spraying', 'log_fertilization',
      'add_livestock', 'remove_livestock', 'transfer_livestock',
      'log_health_event', 'log_repro_event', 'log_weighing',
      'add_stock', 'remove_stock', 'check_stock', 'create_warehouse',
      'log_crop_scouting', 'query_scoutings',
      'upload_document',
    ];
    for (const cmd of dangerous) {
      expect(isSafeFallbackCommand(cmd)).toBe(false);
    }
  });

  it('blocks empty / null / undefined / non-string', () => {
    expect(isSafeFallbackCommand(null)).toBe(false);
    expect(isSafeFallbackCommand(undefined)).toBe(false);
    expect(isSafeFallbackCommand('')).toBe(false);
    expect(isSafeFallbackCommand(123 as unknown as string)).toBe(false);
  });

  it('blocks a totally unknown command (default deny)', () => {
    expect(isSafeFallbackCommand('do_something_dangerous')).toBe(false);
    expect(isSafeFallbackCommand('SAFE_BUT_LOWERCASE_ONLY')).toBe(false); // case-sensitive
  });

  it('SAFE set is small (audit guard against accidental expansion)', () => {
    // Hard cap: if you legitimately need to add an intent, bump this number
    // explicitly in the test so reviewers notice. This guards against careless
    // additions that quietly let dangerous commands through.
    expect(SAFE_FALLBACK_INTENTS.size).toBeLessThanOrEqual(26);
  });
});

describe('fallbackBlockedCopy', () => {
  it('uses non-technical language (no quota/credits/tokens)', () => {
    for (const reason of ['ai_required', 'ai_error', 'ai_rate_limited', 'unparseable_complex'] as const) {
      const copy = fallbackBlockedCopy(reason);
      expect(copy.toLowerCase()).not.toContain('quota');
      expect(copy.toLowerCase()).not.toContain('credit');
      expect(copy.toLowerCase()).not.toContain('token');
      expect(copy.length).toBeGreaterThan(0);
    }
  });

  it('hints at simple things the user can still do (rate limit)', () => {
    const copy = fallbackBlockedCopy('ai_rate_limited');
    // Should mention an example simple command (menú, lluvia, lote)
    expect(copy.toLowerCase()).toMatch(/menú|lluvia|lote/);
    expect(copy).toContain('tope diario'); // única causa donde el tope es verdad
  });

  // Ronda 3 (Jul 2026): copy honesto por causa — el tope diario solo se
  // menciona cuando ES la causa; un error del agente admite el problema.
  it('ai_error admite el problema técnico y NO culpa al usuario ni al tope', () => {
    const copy = fallbackBlockedCopy('ai_error');
    expect(copy.toLowerCase()).toContain('problema');
    expect(copy).not.toContain('tope diario');
    expect(copy.toLowerCase()).not.toContain('no entend');
  });

  it('ai_required (low confidence) no menciona el tope diario', () => {
    const copy = fallbackBlockedCopy('ai_required');
    expect(copy).not.toContain('tope diario');
  });

  it('handles unparseable_complex variant', () => {
    const copy = fallbackBlockedCopy('unparseable_complex');
    expect(copy.toLowerCase()).toContain('pausada');
    expect(copy.length).toBeGreaterThan(0);
  });
});
