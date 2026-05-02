/**
 * QA P0 — MercadoPago subscriptions (provider mocked).
 *
 * Run: `npx tsx src/testing/qa-p0/qa-p0-billing.ts`
 *
 * Mocking strategy: this script starts a tiny HTTP server that mimics MP's
 * Preapproval API. To exercise the checkout/cancel flows end-to-end the app
 * container has to point its MP client at that mock — set
 * `MP_API_BASE_URL=http://host.docker.internal:9999` in docker-compose
 * BEFORE bringing the app up. Without that, this script still runs the tests
 * that don't depend on outbound MP calls (trial bootstrap, status, webhook
 * idempotency, payments-disabled gate).
 *
 * Tests:
 *   1. PAYMENTS_DISABLED → POST /subscription/checkout returns 503.
 *   2. PAYMENTS_ENABLED + register → trial subscription auto-created.
 *   3. GET /subscription returns the trial.
 *   4. POST /subscription/cancel during trial → immediate downgrade to free.
 *   5. Webhook idempotency: same (provider, provider_event_id) insert twice
 *      → second is a no-op via the unique constraint.
 *   6. (Optional, requires MP_API_BASE_URL pointed at our mock) checkout
 *      → returns init_point + creates a pending subscription row.
 */
import http from 'http';
import { URL } from 'url';
import {
  apiRegister,
  apiLogin,
  queryDb,
  setSystemSetting,
  getSystemSetting,
  BASE_URL,
  fail,
  pass,
  printSummary,
  runTest,
  type AuthCreds,
} from './_shared.js';

const EMAIL_BASE = `qa-p0-billing-${Date.now()}`;
const PASSWORD = 'qa-p0-test-1234';
const MOCK_PORT = Number(process.env.MOCK_MP_PORT ?? '9999');

interface MockState {
  receivedCheckouts: Array<Record<string, unknown>>;
  cancelCalls: string[];
  preapprovalDetails: Record<string, { status: string; next_payment_date?: string }>;
}

const mockState: MockState = {
  receivedCheckouts: [],
  cancelCalls: [],
  preapprovalDetails: {},
};

function startMockMp(): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${MOCK_PORT}`);
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      // POST /preapproval — create
      if (req.method === 'POST' && url.pathname === '/preapproval') {
        try {
          const parsed = JSON.parse(body);
          mockState.receivedCheckouts.push(parsed);
          const id = `mock_pre_${Date.now()}`;
          mockState.preapprovalDetails[id] = { status: 'pending', next_payment_date: new Date(Date.now() + 30 * 86400_000).toISOString() };
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id,
            init_point: `https://mp.example.test/checkout/${id}`,
            status: 'pending',
          }));
          return;
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
          return;
        }
      }
      // PUT /preapproval/:id — cancel/update
      const cancelMatch = url.pathname.match(/^\/preapproval\/(.+)$/);
      if (req.method === 'PUT' && cancelMatch) {
        const id = cancelMatch[1];
        mockState.cancelCalls.push(id);
        if (mockState.preapprovalDetails[id]) {
          mockState.preapprovalDetails[id].status = 'cancelled';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, status: 'cancelled' }));
        return;
      }
      // GET /preapproval/:id — fetch
      if (req.method === 'GET' && cancelMatch) {
        const id = cancelMatch[1];
        const detail = mockState.preapprovalDetails[id] ?? { status: 'authorized', next_payment_date: new Date(Date.now() + 30 * 86400_000).toISOString() };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, ...detail }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'mock route not implemented', path: url.pathname }));
    });
  });
  server.listen(MOCK_PORT, '0.0.0.0');
  return server;
}

async function isMpMockReachableFromContainer(creds: AuthCreds): Promise<boolean> {
  // Indirectly: try to start a checkout. If it hits api.mercadopago.com, MP
  // returns 401 (we don't have a real token). If it hits our mock, it returns
  // 201. We treat "did the route succeed" as the signal.
  await setSystemSetting(creds, 'PAYMENTS_ENABLED', 'true');
  await setSystemSetting(creds, 'MP_ACCESS_TOKEN', 'TEST-mock-token-1234567890');
  // A pre-existing 'pro' plan with price > 0 is needed; assume it exists.
  const res = await fetch(`${BASE_URL}/api/auth/subscription/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
    body: JSON.stringify({ plan: 'pro', period: 'monthly' }),
  });
  if (res.ok) return true;
  return false;
}

async function main(): Promise<void> {
  // Save previous settings so we can restore at the end.
  const adminCredsForSettings = await apiRegister(`${EMAIL_BASE}-admin@campo.test`, PASSWORD, 'Settings Admin');
  const prevPaymentsEnabled = await getSystemSetting(adminCredsForSettings, 'PAYMENTS_ENABLED');
  const prevMpToken = await getSystemSetting(adminCredsForSettings, 'MP_ACCESS_TOKEN');
  const prevWebhookSecret = await getSystemSetting(adminCredsForSettings, 'MP_WEBHOOK_SECRET');

  // Disable payments + clear webhook secret to start in a known state.
  await setSystemSetting(adminCredsForSettings, 'PAYMENTS_ENABLED', 'false');
  await setSystemSetting(adminCredsForSettings, 'MP_WEBHOOK_SECRET', '');

  // Spin up the mock MP server (only effective if MP_API_BASE_URL is wired).
  const mockServer = startMockMp();
  console.log(`▶ Mock MP server listening on :${MOCK_PORT}`);

  const results = [
    await runTest('PAYMENTS_DISABLED → checkout returns 503', async () => {
      const userCreds = await apiRegister(`${EMAIL_BASE}-disabled@campo.test`, PASSWORD, 'Pay Disabled');
      const res = await fetch(`${BASE_URL}/api/auth/subscription/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userCreds.token}` },
        body: JSON.stringify({ plan: 'pro', period: 'monthly' }),
      });
      if (res.status !== 503) return fail('disabled', `expected 503, got ${res.status}: ${await res.text()}`);
      return pass('PAYMENTS_DISABLED → 503');
    }),

    await runTest('PAYMENTS_ENABLED + register → trial sub auto-created', async () => {
      await setSystemSetting(adminCredsForSettings, 'PAYMENTS_ENABLED', 'true');
      const userCreds = await apiRegister(`${EMAIL_BASE}-trial@campo.test`, PASSWORD, 'Trial');
      const subs = await queryDb(
        userCreds,
        `SELECT status, provider, trial_ends_at, plan_id FROM subscriptions WHERE user_id = $1`,
        [userCreds.userId],
      );
      if (subs.length === 0) return fail('trial', 'no subscription row created on register');
      if (subs[0].status !== 'trial') return fail('trial', `expected status=trial, got ${subs[0].status}`);
      if (subs[0].provider !== 'trial') return fail('trial', `expected provider=trial, got ${subs[0].provider}`);
      if (!subs[0].trial_ends_at) return fail('trial', 'trial_ends_at not set');
      return pass('trial sub auto-created on register', `trial_ends_at=${subs[0].trial_ends_at}`);
    }),

    await runTest('GET /subscription returns trial info', async () => {
      const userCreds = await apiLogin(`${EMAIL_BASE}-trial@campo.test`, PASSWORD);
      const res = await fetch(`${BASE_URL}/api/auth/subscription`, {
        headers: { Authorization: `Bearer ${userCreds.token}` },
      });
      if (!res.ok) return fail('status', `${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { subscription: { status: string } | null; payments_enabled: boolean };
      if (data.subscription?.status !== 'trial') return fail('status', `status=${data.subscription?.status}`);
      if (data.payments_enabled !== true) return fail('status', 'payments_enabled should be true');
      return pass('GET /subscription returns trial');
    }),

    await runTest('cancel during trial → immediate downgrade to free', async () => {
      const userCreds = await apiLogin(`${EMAIL_BASE}-trial@campo.test`, PASSWORD);
      const res = await fetch(`${BASE_URL}/api/auth/subscription/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userCreds.token}` },
        body: '{}',
      });
      if (!res.ok) return fail('cancel', `${res.status}: ${await res.text()}`);
      const subs = await queryDb(
        userCreds,
        `SELECT status FROM subscriptions WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
        [userCreds.userId],
      );
      if (subs[0].status !== 'cancelled') return fail('cancel', `expected cancelled, got ${subs[0].status}`);
      const userPlan = await queryDb(
        userCreds,
        `SELECT p.name AS plan_name FROM users u JOIN plans p ON p.id = u.plan_id WHERE u.id = $1`,
        [userCreds.userId],
      );
      if (userPlan[0].plan_name !== 'free') {
        return fail('cancel', `user plan should be 'free', got ${userPlan[0].plan_name}`);
      }
      return pass('trial cancel → cancelled + plan=free');
    }),

    await runTest('payment_events idempotency via unique constraint', async () => {
      // Insert a fake payment_event twice with the same (provider, provider_event_id).
      // The unique partial index (idx_payment_events_dedupe) should reject the
      // second one. We can't INSERT via /query-db (only SELECT/UPDATE), so we
      // verify the constraint exists at the schema level instead.
      const idx = await queryDb(
        adminCredsForSettings,
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'payment_events'
           AND indexdef ILIKE '%UNIQUE%'`,
      );
      const hasUnique = idx.some(r => /provider.*provider_event_id/i.test(String(r.indexdef)));
      if (!hasUnique) {
        return fail('idempotency', 'no UNIQUE index on (provider, provider_event_id)');
      }
      return pass('payment_events unique index present', `${idx.length} unique idx`);
    }),

    await runTest('mock MP reachable: full checkout flow (optional)', async () => {
      const userCreds = await apiRegister(`${EMAIL_BASE}-checkout@campo.test`, PASSWORD, 'Checkout');
      const reachable = await isMpMockReachableFromContainer(userCreds);
      if (!reachable) {
        return {
          name: 'mock checkout',
          status: 'WARN' as const,
          message: 'app container is not pointed at our mock MP — set MP_API_BASE_URL=http://host.docker.internal:9999 in docker-compose and restart to enable this test.',
        };
      }
      // Verify a pending sub got created locally
      const subs = await queryDb(
        userCreds,
        `SELECT status, provider_subscription_id FROM subscriptions
         WHERE user_id = $1 AND status = 'pending'
         ORDER BY id DESC LIMIT 1`,
        [userCreds.userId],
      );
      if (subs.length === 0) return fail('checkout', 'no pending sub created after checkout');
      if (mockState.receivedCheckouts.length === 0) return fail('checkout', 'mock did not receive any /preapproval POST');
      return pass('checkout went through mock MP', `received ${mockState.receivedCheckouts.length} POSTs`);
    }),
  ];

  // Restore settings
  await setSystemSetting(adminCredsForSettings, 'PAYMENTS_ENABLED', prevPaymentsEnabled ?? 'false');
  if (prevMpToken != null) await setSystemSetting(adminCredsForSettings, 'MP_ACCESS_TOKEN', prevMpToken);
  if (prevWebhookSecret != null) await setSystemSetting(adminCredsForSettings, 'MP_WEBHOOK_SECRET', prevWebhookSecret);

  mockServer.close();
  process.exit(printSummary('P0 — billing (MercadoPago)', results));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
