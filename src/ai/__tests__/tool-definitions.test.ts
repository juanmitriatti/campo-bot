import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../tool-definitions.js';

describe('TOOL_DEFINITIONS', () => {
  it('has 48 tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(48);
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

  it('financial tools have amount in properties', () => {
    const expense = TOOL_DEFINITIONS.find(t => t.name === 'log_expense')!;
    expect(expense.input_schema.properties).toHaveProperty('amount');
    expect(expense.input_schema.required).toContain('amount');

    const income = TOOL_DEFINITIONS.find(t => t.name === 'log_income')!;
    expect(income.input_schema.properties).toHaveProperty('amount');
    expect(income.input_schema.required).toContain('amount');
  });

  it('activity tools have field and plot properties', () => {
    const activityTools = ['log_spraying', 'log_fertilization', 'log_tillage', 'log_irrigation', 'sow_crop', 'harvest_crop'];
    for (const name of activityTools) {
      const tool = TOOL_DEFINITIONS.find(t => t.name === name)!;
      expect(tool.input_schema.properties).toHaveProperty('field');
      expect(tool.input_schema.properties).toHaveProperty('plot');
    }
  });

  it('log_expense has enum for category with all expense categories', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'log_expense')!;
    const catProp = tool.input_schema.properties!.category as { enum: string[] };
    expect(catProp.enum).toContain('Combustible');
    expect(catProp.enum).toContain('Otros');
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

    // add_livestock requires category, count, plot
    const add = TOOL_DEFINITIONS.find(t => t.name === 'add_livestock')!;
    expect(add.input_schema.required).toContain('category');
    expect(add.input_schema.required).toContain('count');
    expect(add.input_schema.required).toContain('plot');

    // transfer_livestock requires source_plot and dest_plot
    const transfer = TOOL_DEFINITIONS.find(t => t.name === 'transfer_livestock')!;
    expect(transfer.input_schema.required).toContain('source_plot');
    expect(transfer.input_schema.required).toContain('dest_plot');

    // category enum has 9 values
    const catProp = add.input_schema.properties!.category as { enum: string[] };
    expect(catProp.enum).toEqual([
      'vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey',
    ]);
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
