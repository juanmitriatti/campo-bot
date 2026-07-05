import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../tool-definitions.js';

describe('TOOL_DEFINITIONS', () => {
  it('has 102 tools', () => {
    // 85 → 91 on May 28 (morning): added 6 financial edit/delete tools
    //   (delete_last_expense, delete_specific_expense, delete_specific_income,
    //   edit_specific_expense, edit_last_income, edit_specific_income)
    // 91 → 97 on May 28 (afternoon): added 6 non-financial edit/delete tools
    // 97 → 98 on Jun 12: +set_livestock_price (precio tardío de hacienda)
    //   (delete_last_income, edit_last_observation, delete_last_observation,
    //   edit_last_rainfall, delete_last_rainfall, delete_last_scouting)
    // 98 → 99 on Jul 5: +grain_prices (pizarra Matba-Rofex)
    // 99 → 102 on Jul 5: +create_reminder/list_reminders/complete_reminder
    expect(TOOL_DEFINITIONS).toHaveLength(102);
  });

  it('all tools have unique names', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('TOOL_NAMES matches definitions', () => {
    expect(TOOL_NAMES.size).toBe(TOOL_DEFINITIONS.length);
    for (const tool of TOOL_DEFINITIONS) {
      expect(TOOL_NAMES.has(tool.name)).toBe(true);
    }
  });

  it('all tools have description and input_schema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeTruthy();
      expect(tool.input_schema.type).toBe('object');
    }
  });

  it('financial tools expose amount but do not require it (agent never invents missing values)', () => {
    const expense = TOOL_DEFINITIONS.find(t => t.name === 'log_expense')!;
    expect(expense.input_schema.properties).toHaveProperty('amount');
    expect(expense.input_schema.required).not.toContain('amount');

    const income = TOOL_DEFINITIONS.find(t => t.name === 'log_income')!;
    expect(income.input_schema.properties).toHaveProperty('amount');
    expect(income.input_schema.required).not.toContain('amount');
  });

  it('activity tools have field and plot properties', () => {
    const activityTools = ['log_spraying', 'log_fertilization', 'log_tillage', 'log_irrigation', 'sow_crop', 'harvest_crop'];
    for (const name of activityTools) {
      const tool = TOOL_DEFINITIONS.find(t => t.name === name)!;
      expect(tool.input_schema.properties).toHaveProperty('field');
      expect(tool.input_schema.properties).toHaveProperty('plot');
    }
  });

  it('log_expense category is free-form string and has category_match enum', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'log_expense')!;
    const catProp = tool.input_schema.properties!.category as { type: string; enum?: string[] };
    expect(catProp.type).toBe('string');
    expect(catProp.enum).toBeUndefined();

    const matchProp = tool.input_schema.properties!.category_match as { type: string; enum: string[] };
    expect(matchProp.enum).toContain('exact');
    expect(matchProp.enum).toContain('new');
  });

  it('log_rainfall requires quantity', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'log_rainfall')!;
    expect(tool.input_schema.required).toContain('quantity');
  });

  it('field management tools exist', () => {
    expect(TOOL_NAMES.has('add_field')).toBe(true);
    expect(TOOL_NAMES.has('add_plot')).toBe(true);
    expect(TOOL_NAMES.has('add_plots_batch')).toBe(true);
    expect(TOOL_NAMES.has('set_plot_area')).toBe(true);
    expect(TOOL_NAMES.has('set_field_city')).toBe(true);
    expect(TOOL_NAMES.has('delete_field')).toBe(true);
    expect(TOOL_NAMES.has('delete_plot')).toBe(true);
    expect(TOOL_NAMES.has('rename_field')).toBe(true);
    expect(TOOL_NAMES.has('rename_plot')).toBe(true);
    expect(TOOL_NAMES.has('restore_field')).toBe(true);
    expect(TOOL_NAMES.has('restore_plot')).toBe(true);
  });

  it('report tools exist', () => {
    const reportTools = ['weather_full', 'rainfall_report', 'financial_report',
      'generate_agro_report', 'query_plot_history'];
    for (const name of reportTools) {
      expect(TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it('livestock tools exist with required fields', () => {
    const livestockTools = ['add_livestock', 'remove_livestock', 'transfer_livestock',
      'record_livestock_death', 'record_livestock_birth', 'list_livestock', 'livestock_history'];
    for (const name of livestockTools) {
      expect(TOOL_NAMES.has(name)).toBe(true);
    }

    // add_livestock requires category, count (plot is now optional — plot OR corral)
    const add = TOOL_DEFINITIONS.find(t => t.name === 'add_livestock')!;
    expect(add.input_schema.required).toContain('category');
    expect(add.input_schema.required).toContain('count');
    expect(add.input_schema.properties).toHaveProperty('plot');
    expect(add.input_schema.properties).toHaveProperty('corral');

    // transfer_livestock has source_plot/dest_plot/source_corral/dest_corral (all optional)
    const transfer = TOOL_DEFINITIONS.find(t => t.name === 'transfer_livestock')!;
    expect(transfer.input_schema.properties).toHaveProperty('source_plot');
    expect(transfer.input_schema.properties).toHaveProperty('dest_plot');
    expect(transfer.input_schema.properties).toHaveProperty('source_corral');
    expect(transfer.input_schema.properties).toHaveProperty('dest_corral');

    // category enum has 9 values
    const catProp = add.input_schema.properties!.category as { enum: string[] };
    expect(catProp.enum).toEqual([
      'vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey',
    ]);
  });

  it('feedlot tools exist', () => {
    const feedlotTools = ['create_feedlot', 'list_feedlots', 'delete_feedlot',
      'create_corral', 'list_corrals', 'delete_corral', 'rename_corral'];
    for (const name of feedlotTools) {
      expect(TOOL_NAMES.has(name)).toBe(true);
    }

    const createFeedlot = TOOL_DEFINITIONS.find(t => t.name === 'create_feedlot')!;
    expect(createFeedlot.input_schema.required).toContain('name');
    expect(createFeedlot.input_schema.required).toContain('field');

    const createCorral = TOOL_DEFINITIONS.find(t => t.name === 'create_corral')!;
    expect(createCorral.input_schema.required).toContain('name');
  });

  it('financial_report has all expected properties', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'financial_report')!;
    expect(tool).toBeTruthy();
    const props = tool.input_schema.properties!;
    expect(props).toHaveProperty('field');
    expect(props).toHaveProperty('plot');
    expect(props).toHaveProperty('period');
    expect(props).toHaveProperty('desde');
    expect(props).toHaveProperty('hasta');
    expect(props).toHaveProperty('days');
    expect(props).toHaveProperty('category');
    expect(props).toHaveProperty('type');
    expect(props).toHaveProperty('include_activities');
    expect(props).toHaveProperty('activity_filter');
    expect(tool.input_schema.required).toEqual([]);
  });
});
