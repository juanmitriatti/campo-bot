/**
 * Deterministic assertion helpers for conversation test scenarios.
 * Each returns { pass, message } for composable reporting.
 */

import { TestBotClient, type SendResult } from './test-bot-client.js';

export interface AssertionResult {
  pass: boolean;
  name: string;
  message: string;
}

// --- Response text assertions ---

/** All substrings must appear in at least one response message (case-insensitive). */
export function responseContains(result: SendResult, substrings: string[]): AssertionResult {
  const allText = TestBotClient.allText(result).toLowerCase();
  const missing = substrings.filter(s => !allText.includes(s.toLowerCase()));
  return {
    pass: missing.length === 0,
    name: 'responseContains',
    message: missing.length === 0
      ? `Found all: [${substrings.join(', ')}]`
      : `Missing: [${missing.join(', ')}] in response text`,
  };
}

/** None of the substrings should appear in any response message (case-insensitive). */
export function responseNotContains(result: SendResult, substrings: string[]): AssertionResult {
  const allText = TestBotClient.allText(result).toLowerCase();
  const found = substrings.filter(s => allText.includes(s.toLowerCase()));
  return {
    pass: found.length === 0,
    name: 'responseNotContains',
    message: found.length === 0
      ? `None found (good): [${substrings.join(', ')}]`
      : `Unexpectedly found: [${found.join(', ')}]`,
  };
}

// --- Interactive assertions ---

/** Response includes at least one interactive element (buttons or list). */
export function hasInteractive(result: SendResult, type?: 'buttons' | 'list'): AssertionResult {
  const interactives = result.messages.filter(m => m.interactive);
  if (type) {
    const matched = interactives.filter(m => m.interactive?.type === type);
    return {
      pass: matched.length > 0,
      name: 'hasInteractive',
      message: matched.length > 0 ? `Found ${type} interactive` : `No ${type} interactive in response`,
    };
  }
  return {
    pass: interactives.length > 0,
    name: 'hasInteractive',
    message: interactives.length > 0 ? 'Found interactive element' : 'No interactive elements in response',
  };
}

/** A specific button (by ID) exists in the response. */
export function hasButton(result: SendResult, buttonId: string): AssertionResult {
  const buttons = TestBotClient.allButtons(result);
  const found = buttons.some(b => b.id === buttonId);
  return {
    pass: found,
    name: 'hasButton',
    message: found
      ? `Found button "${buttonId}"`
      : `Button "${buttonId}" not found. Available: [${buttons.map(b => b.id).join(', ')}]`,
  };
}

// --- DB state assertions ---
// All DB assertions filter by user_id to prevent cross-user contamination.

export interface DbExpenseFilter {
  amount?: number;
  category?: string;
  description?: string;
}

/** Check that at least one expense matches the filter for the current user. */
export async function dbHasExpense(client: TestBotClient, filter: DbExpenseFilter): Promise<AssertionResult> {
  const conditions: string[] = ['user_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [client.userId];
  let idx = 2;

  if (filter.amount !== undefined) {
    conditions.push(`amount = $${idx++}`);
    params.push(filter.amount);
  }
  if (filter.category) {
    conditions.push(`LOWER(category) = LOWER($${idx++})`);
    params.push(filter.category);
  }
  if (filter.description) {
    conditions.push(`LOWER(description) LIKE LOWER($${idx++})`);
    params.push(`%${filter.description}%`);
  }

  const sql = `SELECT id, amount, category, description FROM expenses WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 1`;
  const rows = await client.queryDb(sql, params);
  return {
    pass: rows.length > 0,
    name: 'dbHasExpense',
    message: rows.length > 0
      ? `Found expense: $${rows[0].amount} ${rows[0].category}`
      : `No expense matching ${JSON.stringify(filter)}`,
  };
}

export interface DbIncomeFilter {
  amount?: number;
  category?: string;
}

/** Check that at least one income matches the filter for the current user. */
export async function dbHasIncome(client: TestBotClient, filter: DbIncomeFilter): Promise<AssertionResult> {
  const conditions: string[] = ['user_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [client.userId];
  let idx = 2;

  if (filter.amount !== undefined) {
    conditions.push(`amount = $${idx++}`);
    params.push(filter.amount);
  }
  if (filter.category) {
    conditions.push(`LOWER(category) = LOWER($${idx++})`);
    params.push(filter.category);
  }

  const sql = `SELECT id, amount, category FROM incomes WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 1`;
  const rows = await client.queryDb(sql, params);
  return {
    pass: rows.length > 0,
    name: 'dbHasIncome',
    message: rows.length > 0
      ? `Found income: $${rows[0].amount} ${rows[0].category}`
      : `No income matching ${JSON.stringify(filter)}`,
  };
}

export interface DbActivityFilter {
  eventType?: string;
  crop?: string;
  plot?: string;
}

/** Check that at least one domain_event (activity) matches the filter for the current user. */
export async function dbHasActivity(client: TestBotClient, filter: DbActivityFilter): Promise<AssertionResult> {
  const conditions: string[] = ['de.user_id = $1'];
  const params: unknown[] = [client.userId];
  let idx = 2;

  if (filter.eventType) {
    conditions.push(`LOWER(de.event_type) = LOWER($${idx++})`);
    params.push(filter.eventType);
  }
  if (filter.crop) {
    conditions.push(`LOWER(de.crop) = LOWER($${idx++})`);
    params.push(filter.crop);
  }
  if (filter.plot) {
    conditions.push(`LOWER(p.name) = LOWER($${idx++})`);
    params.push(filter.plot);
  }

  const sql = `SELECT de.id, de.event_type, de.crop, p.name as plot_name
    FROM domain_events de
    LEFT JOIN plots p ON p.id = de.plot_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY de.created_at DESC LIMIT 1`;
  const rows = await client.queryDb(sql, params);
  return {
    pass: rows.length > 0,
    name: 'dbHasActivity',
    message: rows.length > 0
      ? `Found activity: ${rows[0].event_type} ${rows[0].crop || ''} @ ${rows[0].plot_name || ''}`
      : `No activity matching ${JSON.stringify(filter)}`,
  };
}

export interface DbObservationFilter {
  textContains?: string;
  category?: string;
}

/** Check that at least one agro_observation matches the filter for the current user. */
export async function dbHasObservation(client: TestBotClient, filter: DbObservationFilter): Promise<AssertionResult> {
  const conditions: string[] = ['user_id = $1'];
  const params: unknown[] = [client.userId];
  let idx = 2;

  if (filter.textContains) {
    conditions.push(`LOWER(observation_text) LIKE LOWER($${idx++})`);
    params.push(`%${filter.textContains}%`);
  }
  if (filter.category) {
    conditions.push(`LOWER(category) = LOWER($${idx++})`);
    params.push(filter.category);
  }

  const sql = `SELECT id, observation_text, category FROM agro_observations WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 1`;
  const rows = await client.queryDb(sql, params);
  return {
    pass: rows.length > 0,
    name: 'dbHasObservation',
    message: rows.length > 0
      ? `Found observation: "${(rows[0].observation_text as string).slice(0, 50)}"`
      : `No observation matching ${JSON.stringify(filter)}`,
  };
}

/** Verify exact row count in a table for the current user. */
export async function dbRowCount(client: TestBotClient, table: string, expectedCount: number): Promise<AssertionResult> {
  // Sanitize table name to prevent injection
  const safeTables = [
    'expenses', 'incomes', 'fields', 'plots', 'domain_events',
    'agro_observations', 'crop_scoutings', 'harvest_loads', 'rainfall',
    'budgets', 'livestock_groups', 'livestock_movements',
    'stock_items', 'stock_movements', 'warehouses', 'documents',
  ];
  if (!safeTables.includes(table)) {
    return { pass: false, name: 'dbRowCount', message: `Table "${table}" not in safe list` };
  }

  // Tables with user_id directly
  const hasUserId = [
    'expenses', 'incomes', 'fields', 'domain_events',
    'agro_observations', 'crop_scoutings', 'rainfall', 'budgets',
    'livestock_groups', 'livestock_movements',
    'stock_items', 'stock_movements', 'warehouses', 'documents',
  ];
  // Tables with user_id via fields join
  const needsFieldJoin = ['plots', 'harvest_loads'];

  const hasDeletedAt = ['expenses', 'incomes', 'fields'].includes(table);
  const deletedFilter = hasDeletedAt ? ' AND deleted_at IS NULL' : '';

  let sql: string;
  if (hasUserId.includes(table)) {
    sql = `SELECT COUNT(*)::int as cnt FROM ${table} WHERE user_id = $1${deletedFilter}`;
  } else if (needsFieldJoin.includes(table)) {
    if (table === 'plots') {
      sql = `SELECT COUNT(*)::int as cnt FROM plots p JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1 AND f.deleted_at IS NULL`;
    } else {
      // harvest_loads → join plots → fields
      sql = `SELECT COUNT(*)::int as cnt FROM harvest_loads hl JOIN plots p ON p.id = hl.plot_id JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1`;
    }
  } else {
    return { pass: false, name: 'dbRowCount', message: `No user_id strategy for table "${table}"` };
  }

  const rows = await client.queryDb(sql, [client.userId]);
  const actual = (rows[0] as { cnt: number }).cnt;
  return {
    pass: actual === expectedCount,
    name: 'dbRowCount',
    message: actual === expectedCount
      ? `${table}: ${actual} rows (expected ${expectedCount})`
      : `${table}: got ${actual} rows, expected ${expectedCount}`,
  };
}
