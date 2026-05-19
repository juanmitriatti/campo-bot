/**
 * TestBotClient — HTTP client for the test-bot API.
 * Wraps fetch with auth, provides send/tap/reset/queryDb helpers.
 */

export interface BotResponseItem {
  type: 'text' | 'interactive';
  text?: string;
  interactive?: {
    type: 'buttons' | 'list';
    body: string;
    buttons?: Array<{ id: string; title: string }>;
    buttonText?: string;
    sections?: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
  };
}

export interface SendResult {
  messages: BotResponseItem[];
  raw: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class TestBotClient {
  private baseUrl: string;
  private token: string | null = null;
  private _userId: number | null = null;
  private timeoutMs: number;

  constructor(baseUrl = 'http://localhost:3000', timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  /** The authenticated user's ID (available after login/register). */
  get userId(): number {
    if (this._userId === null) throw new Error('Not authenticated — call login() or ensureUser() first');
    return this._userId;
  }

  /** Register a new user (ignores 409 if already exists). */
  async register(email: string, password: string, name = 'Eval User'): Promise<void> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, last_name: 'Test', email, password }),
    });
    if (res.ok) {
      const data = await res.json() as { user: { id: number }; tokens: { accessToken: string } };
      this.token = data.tokens.accessToken;
      this._userId = data.user.id;
      return;
    }
    // Already exists — try login instead
    if (res.status === 409) return;
    const body = await res.text();
    throw new Error(`Register failed (${res.status}): ${body}`);
  }

  /** Login and store JWT token + userId. */
  async login(email: string, password: string): Promise<void> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Login failed (${res.status}): ${body}`);
    }
    const data = await res.json() as { user: { id: number }; tokens: { accessToken: string } };
    this.token = data.tokens.accessToken;
    this._userId = data.user.id;
  }

  /** Ensure user exists and is logged in. */
  async ensureUser(email: string, password: string, name?: string): Promise<void> {
    await this.register(email, password, name);
    if (!this.token) {
      await this.login(email, password);
    }
  }

  /** Send a text message to the test-bot pipeline. */
  async send(text: string): Promise<SendResult> {
    return this.postTestBot({ message: text });
  }

  /** Tap an interactive button by its callback ID. */
  async tap(buttonId: string): Promise<SendResult> {
    return this.postTestBot({ interactiveReplyId: buttonId });
  }

  /** Reset all user data (hard-delete). */
  async reset(): Promise<void> {
    const res = await this.fetchAuth(`${this.baseUrl}/api/test-bot/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Reset failed (${res.status}): ${body}`);
    }
  }

  /** Run a raw SQL query against the DB (direct pg pool). */
  async queryDb(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    try {
      const { pool } = await import('../config/db.js');
      const result = await pool.query(sql, params);
      return result.rows;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`queryDb failed: ${msg}\n  SQL: ${sql}\n  Params: ${JSON.stringify(params)}`);
    }
  }

  /** Get all text from response messages joined. */
  static allText(result: SendResult): string {
    return result.messages
      .map(m => {
        const parts: string[] = [];
        if (m.text) parts.push(m.text);
        if (m.interactive?.body) parts.push(m.interactive.body);
        return parts.join('\n');
      })
      .join('\n');
  }

  /** Find all buttons across response messages. */
  static allButtons(result: SendResult): Array<{ id: string; title: string }> {
    const buttons: Array<{ id: string; title: string }> = [];
    for (const m of result.messages) {
      if (m.interactive?.buttons) {
        buttons.push(...m.interactive.buttons);
      }
      if (m.interactive?.sections) {
        for (const section of m.interactive.sections) {
          buttons.push(...section.rows);
        }
      }
    }
    return buttons;
  }

  // --- Private ---

  private async postTestBot(body: Record<string, unknown>): Promise<SendResult> {
    const res = await this.fetchAuth(`${this.baseUrl}/api/test-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`test-bot request failed (${res.status}): ${text}`);
    }
    const data = await res.json() as { messages: BotResponseItem[] };
    return { messages: data.messages, raw: data as Record<string, unknown> };
  }

  private async fetchAuth(url: string, init: RequestInit): Promise<Response> {
    if (!this.token) throw new Error('Not authenticated — call login() or ensureUser() first');
    const headers = new Headers(init.headers as HeadersInit);
    headers.set('Authorization', `Bearer ${this.token}`);
    return this.fetchWithTimeout(url, { ...init, headers });
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeoutMs}ms: ${init.method ?? 'GET'} ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
