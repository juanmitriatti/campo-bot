import type { BotResponseItem, SeedStep } from './types.js';

const BASE = process.env.TEST_BOT_URL || 'http://localhost:3000';

export class Harness {
  token = '';
  userId = 0;

  async ensureUser(email: string, password: string): Promise<void> {
    let res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'QA', last_name: 'V2', email, password }),
    });
    if (res.status === 409) {
      res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    }
    if (!res.ok) throw new Error(`auth failed (${res.status}) for ${email}`);
    const data = (await res.json()) as { user: { id: number }; tokens: { accessToken: string } };
    this.token = data.tokens.accessToken;
    this.userId = data.user.id;
  }

  /** Force enterprise plan so every feature is available (parity across scenarios). */
  async setEnterprise(): Promise<void> {
    await this.query(`UPDATE users SET plan_id = 4 WHERE id = $1`, [this.userId]);
  }

  async reset(): Promise<void> {
    const res = await fetch(`${BASE}/api/test-bot/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, body: '{}',
    });
    if (!res.ok) throw new Error(`reset failed (${res.status})`);
  }

  async send(message: string): Promise<BotResponseItem[]> { return this.post({ message }); }
  async tap(id: string): Promise<BotResponseItem[]> { return this.post({ interactiveReplyId: id }); }

  private async post(body: Record<string, unknown>): Promise<BotResponseItem[]> {
    const res = await fetch(`${BASE}/api/test-bot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`test-bot failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { messages: BotResponseItem[] };
    return data.messages || [];
  }

  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const { pool } = await import('../../config/db.js');
    const r = await pool.query(sql, params);
    return r.rows;
  }

  /** Run seed steps; reuses send/tap. Throws on first failure so a bad seed is loud. */
  async runSeed(steps: SeedStep[] = []): Promise<void> {
    for (const s of steps) {
      if ('send' in s) await this.send(s.send);
      else await this.tap(s.tap);
    }
  }
}

/** Flatten response items to a single text blob (text + interactive bodies). */
export function responseText(items: BotResponseItem[]): string {
  return items.map((m) => [m.text, m.interactive?.body].filter(Boolean).join('\n')).join('\n');
}
