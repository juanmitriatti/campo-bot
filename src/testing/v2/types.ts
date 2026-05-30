export type Axis = 'comprension' | 'contexto' | 'repreguntas';

/** One user action in a scenario: send free text, or tap an interactive button by id. */
export type Turn = { send: string } | { tap: string };

/** A bot response item as returned by /api/test-bot. */
export interface BotResponseItem {
  type?: 'text' | 'interactive';
  text?: string;
  interactive?: {
    type: 'buttons' | 'list';
    body: string;
    buttons?: Array<{ id: string; title: string }>;
    sections?: Array<{ title: string; rows: Array<{ id: string; title: string }> }>;
  };
}

/** Context handed to an assertion at evaluation time. */
export interface AssertContext {
  userId: number;
  /** All response items produced by the LAST turn. */
  lastResponse: BotResponseItem[];
  /** Concatenated text of the last turn's response (text + interactive bodies). */
  lastText: string;
  /** Run a user-scoped SQL query. */
  query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}

export interface AssertionResult { ok: boolean; detail: string; }

/** An assertion is a named predicate over the post-conversation state. */
export interface Assertion {
  label: string;
  run: (ctx: AssertContext) => Promise<AssertionResult>;
}

/** Declarative seed step: a setup message or button tap run before the scenario turns. */
export type SeedStep = { send: string } | { tap: string };

export interface Scenario {
  id: string;
  source: 'prod' | 'written';
  domains: string[];
  axes: Axis[];
  /** Setup run after a full reset, before `turns`. Empty = start from zero state. */
  seed?: SeedStep[];
  turns: Turn[];
  assert: Assertion[];
}

export interface ScenarioResult {
  id: string;
  source: 'prod' | 'written';
  domains: string[];
  axes: Axis[];
  status: 'PASS' | 'FAIL' | 'ERROR';
  failed: string[]; // labels of failed assertions
  detail: string;
}
