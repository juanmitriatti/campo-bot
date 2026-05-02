/**
 * Shared helpers for the four P0 hardening QA scripts.
 *
 *   - qa-p0-atomicity.ts        — compound action transaction rollback
 *   - qa-p0-channel-verify.ts   — WhatsApp OTP + Telegram deep-link
 *   - qa-p0-export-delete.ts    — GDPR export ZIP + soft-delete account
 *   - qa-p0-billing.ts          — MercadoPago subscriptions (mocked)
 *
 * Pattern matches src/testing/qa-adversarial-30.ts but trimmed: each script is
 * intended to be runnable standalone with `npx tsx`.
 */

export const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';

export interface AuthCreds {
  token: string;
  refreshToken?: string;
  userId: number;
}

export interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  message: string;
}

export async function apiRegister(
  email: string,
  password: string,
  name: string = 'QA P0',
): Promise<AuthCreds> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, last_name: 'Test', email, password }),
  });
  if (res.ok) {
    const data = (await res.json()) as { user: { id: number }; tokens: { accessToken: string; refreshToken: string } };
    return {
      token: data.tokens.accessToken,
      refreshToken: data.tokens.refreshToken,
      userId: data.user.id,
    };
  }
  if (res.status === 409) return apiLogin(email, password);
  throw new Error(`register failed: ${res.status} ${await res.text()}`);
}

export async function apiLogin(email: string, password: string): Promise<AuthCreds> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { user: { id: number }; tokens: { accessToken: string; refreshToken: string } };
  return { token: data.tokens.accessToken, refreshToken: data.tokens.refreshToken, userId: data.user.id };
}

export async function apiSend(creds: AuthCreds, message: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function apiTap(creds: AuthCreds, buttonId: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`tap failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function apiReset(creds: AuthCreds): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test-bot/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
    body: '{}',
  });
  if (!res.ok) throw new Error(`reset failed: ${res.status} ${await res.text()}`);
}

export async function queryDb(
  creds: AuthCreds,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`query-db failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { rows: Record<string, unknown>[] };
  return data.rows;
}

/**
 * Toggle a system setting via UPDATE on system_settings. Used by qa scripts to
 * enable PAYMENTS_ENABLED, set TELEGRAM_BOT_USERNAME, etc., for the duration of
 * the test. Caller is responsible for restoring the previous value if needed.
 */
export async function setSystemSetting(
  creds: AuthCreds,
  key: string,
  value: string,
): Promise<void> {
  // system_settings columns are (key, value). Bools are stored as 'true'/'false'.
  // Upsert because not every setting is seeded by migrations.
  await queryDb(
    creds,
    `INSERT INTO system_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}

/** Upgrade test user to enterprise so all features are unlocked. */
export async function upgradeToEnterprise(creds: AuthCreds): Promise<void> {
  await queryDb(
    creds,
    `UPDATE users SET plan_id = (SELECT id FROM plans WHERE name = 'enterprise') WHERE id = $1`,
    [creds.userId],
  );
}

export async function getSystemSetting(
  creds: AuthCreds,
  key: string,
): Promise<string | null> {
  const rows = await queryDb(
    creds,
    `SELECT value FROM system_settings WHERE key = $1`,
    [key],
  );
  return rows.length > 0 ? (rows[0].value as string | null) ?? null : null;
}

export function extractText(data: unknown): string {
  const messages = (data as { messages?: Array<{ text?: string; interactive?: { body?: string } }> }).messages || [];
  const parts: string[] = [];
  for (const m of messages) {
    if (m.text) parts.push(m.text);
    if (m.interactive?.body) parts.push(m.interactive.body);
  }
  return parts.join('\n');
}

export function pass(name: string, message = 'OK'): TestResult {
  return { name, status: 'PASS', message };
}

export function fail(name: string, message: string): TestResult {
  return { name, status: 'FAIL', message };
}

export function warn(name: string, message: string): TestResult {
  return { name, status: 'WARN', message };
}

export function printSummary(suite: string, results: TestResult[]): number {
  console.log(`\n══════════════════ ${suite} ══════════════════`);
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
    console.log(`${icon}  ${r.name}`);
    if (r.status !== 'PASS') console.log(`     → ${r.message}`);
  }
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const warned = results.filter(r => r.status === 'WARN').length;
  console.log(`\n  PASS=${passed}  FAIL=${failed}  WARN=${warned}  total=${results.length}`);
  return failed === 0 ? 0 : 1;
}

/** Run a test, capture its result, never let it throw past us. */
export async function runTest(
  name: string,
  fn: () => Promise<TestResult | void>,
): Promise<TestResult> {
  try {
    const r = await fn();
    return r ?? pass(name);
  } catch (err) {
    return fail(name, (err as Error).message);
  }
}
