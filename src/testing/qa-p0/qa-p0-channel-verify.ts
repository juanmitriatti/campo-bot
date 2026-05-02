/**
 * QA P0 — WhatsApp OTP + Telegram deep-link channel verification.
 *
 * Run: `npx tsx src/testing/qa-p0/qa-p0-channel-verify.ts`
 *
 * Trick used for WhatsApp: the service inserts the OTP into
 * `channel_verifications` BEFORE calling the WA Cloud API. In a test env
 * without a real WHATSAPP_TOKEN that send fails (502 from the endpoint), but
 * the row is already there — we read the OTP via test-bot/query-db and confirm.
 *
 * Tests:
 *   1. GET /verify/status on fresh user → both null.
 *   2. POST /verify/whatsapp/start → row in channel_verifications (200 or 502).
 *   3. POST /verify/whatsapp/confirm wrong code → 401, attempts incremented.
 *   4. POST /verify/whatsapp/confirm right code → 200 + user.whatsapp_verified_at set.
 *   5. Phone collision: another user trying to verify the same phone → 409.
 *   6. POST /verify/telegram/start → 200 with deep_link + DB row.
 *   7. DELETE /verify/whatsapp → unverify.
 */
import {
  apiRegister,
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

const EMAIL_A = `qa-p0-verify-a-${Date.now()}@campo.test`;
const EMAIL_B = `qa-p0-verify-b-${Date.now()}@campo.test`;
const PASSWORD = 'qa-p0-test-1234';
const PHONE = `+5491155${Math.floor(100000 + Math.random() * 899999)}`;

async function callVerify(
  creds: AuthCreds,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${BASE_URL}/api/auth${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds.token}`,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* may have empty body */
  }
  return { status: res.status, data };
}

async function readLatestOtp(creds: AuthCreds): Promise<{ code: string; attempts: number; expires_at: string } | null> {
  const rows = await queryDb(
    creds,
    `SELECT code, attempts, expires_at FROM channel_verifications
     WHERE user_id = $1 AND channel = 'whatsapp' AND verified_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [creds.userId],
  );
  return rows.length > 0
    ? {
        code: rows[0].code as string,
        attempts: Number(rows[0].attempts ?? 0),
        expires_at: String(rows[0].expires_at),
      }
    : null;
}

async function main(): Promise<void> {
  const credsA = await apiRegister(EMAIL_A, PASSWORD, 'Verify A');
  const credsB = await apiRegister(EMAIL_B, PASSWORD, 'Verify B');

  // Ensure TELEGRAM_BOT_USERNAME is set so /verify/telegram/start doesn't 503.
  const tgPrev = await getSystemSetting(credsA, 'TELEGRAM_BOT_USERNAME');
  if (!tgPrev) {
    await setSystemSetting(credsA, 'TELEGRAM_BOT_USERNAME', 'campo_bot_qa');
  }

  const results = [
    await runTest('GET /verify/status on fresh user → both unverified', async () => {
      const r = await callVerify(credsA, 'GET', '/verify/status');
      if (r.status !== 200) return fail('status', `got ${r.status}`);
      const data = r.data as { whatsapp_verified: boolean; telegram_verified: boolean };
      if (data.whatsapp_verified !== false || data.telegram_verified !== false) {
        return fail('status', `expected both false, got ${JSON.stringify(data)}`);
      }
      return pass('GET /verify/status fresh');
    }),

    await runTest('POST /verify/whatsapp/start writes OTP row', async () => {
      const r = await callVerify(credsA, 'POST', '/verify/whatsapp/start', { phone: PHONE });
      // Without a real WHATSAPP_TOKEN the send throws → 502. But the OTP row is
      // already inserted before the send call, so query-db will find it.
      if (r.status !== 200 && r.status !== 502) {
        return fail('wa-start', `unexpected status ${r.status}: ${JSON.stringify(r.data)}`);
      }
      const otp = await readLatestOtp(credsA);
      if (!otp) return fail('wa-start', 'no row in channel_verifications');
      if (!/^\d{6}$/.test(otp.code)) return fail('wa-start', `OTP not 6 digits: ${otp.code}`);
      return pass('POST /verify/whatsapp/start → OTP persisted', `code=${otp.code}`);
    }),

    await runTest('POST /verify/whatsapp/confirm wrong code → 401 + attempts++', async () => {
      const before = await readLatestOtp(credsA);
      if (!before) return fail('wa-wrong', 'no pending OTP to test against');
      const r = await callVerify(credsA, 'POST', '/verify/whatsapp/confirm', { code: '000000' });
      // If by astronomical chance 000000 IS the real code, retry. We accept
      // either outcome but the more useful assertion is on attempts++.
      const after = await readLatestOtp(credsA);
      if (!after) {
        // OTP got verified — means 000000 happened to be right. Skip.
        return pass('wa-wrong', 'lucky — fixture matched 000000, skipped');
      }
      if (r.status !== 401) return fail('wa-wrong', `expected 401, got ${r.status}`);
      if (after.attempts !== before.attempts + 1) {
        return fail('wa-wrong', `attempts ${before.attempts} → ${after.attempts}, expected +1`);
      }
      return pass('POST /confirm wrong code → 401 + attempts++');
    }),

    await runTest('POST /verify/whatsapp/confirm right code → user verified', async () => {
      const otp = await readLatestOtp(credsA);
      if (!otp) return fail('wa-right', 'no pending OTP');
      const r = await callVerify(credsA, 'POST', '/verify/whatsapp/confirm', { code: otp.code });
      if (r.status !== 200) {
        return fail('wa-right', `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
      }
      const rows = await queryDb(
        credsA,
        `SELECT phone_number, whatsapp_verified_at FROM users WHERE id = $1`,
        [credsA.userId],
      );
      if (!rows[0].whatsapp_verified_at) return fail('wa-right', 'whatsapp_verified_at not set');
      if (rows[0].phone_number !== PHONE) {
        return fail('wa-right', `phone ${rows[0].phone_number}, expected ${PHONE}`);
      }
      return pass('POST /confirm right code → verified');
    }),

    await runTest('phone collision: user B can\'t take A\'s verified phone → 409', async () => {
      const r = await callVerify(credsB, 'POST', '/verify/whatsapp/start', { phone: PHONE });
      if (r.status !== 409) {
        return fail('phone-collision', `expected 409, got ${r.status}: ${JSON.stringify(r.data)}`);
      }
      return pass('phone collision → 409');
    }),

    await runTest('POST /verify/telegram/start → 200 with deep_link + token', async () => {
      const r = await callVerify(credsB, 'POST', '/verify/telegram/start');
      if (r.status !== 200) {
        return fail('tg-start', `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
      }
      const data = r.data as { deep_link: string; token: string };
      if (!data.deep_link?.includes('t.me/')) return fail('tg-start', `deep_link missing t.me: ${data.deep_link}`);
      if (!data.deep_link.includes(`verify_${data.token}`)) {
        return fail('tg-start', `deep_link does not contain verify_${data.token}`);
      }
      const rows = await queryDb(
        credsB,
        `SELECT code, expires_at FROM channel_verifications
         WHERE user_id = $1 AND channel = 'telegram' AND verified_at IS NULL
         ORDER BY id DESC LIMIT 1`,
        [credsB.userId],
      );
      if (rows.length === 0) return fail('tg-start', 'no telegram row in channel_verifications');
      if (rows[0].code !== data.token) {
        return fail('tg-start', `DB token=${rows[0].code} does not match returned ${data.token}`);
      }
      return pass('POST /verify/telegram/start');
    }),

    await runTest('DELETE /verify/whatsapp → status reverts', async () => {
      const r = await callVerify(credsA, 'DELETE', '/verify/whatsapp');
      if (r.status !== 200) return fail('wa-unlink', `expected 200, got ${r.status}`);
      const rows = await queryDb(
        credsA,
        `SELECT phone_number, whatsapp_verified_at FROM users WHERE id = $1`,
        [credsA.userId],
      );
      if (rows[0].phone_number != null) return fail('wa-unlink', `phone not nulled: ${rows[0].phone_number}`);
      if (rows[0].whatsapp_verified_at != null) return fail('wa-unlink', 'whatsapp_verified_at not nulled');
      return pass('DELETE /verify/whatsapp');
    }),
  ];

  // Restore TELEGRAM_BOT_USERNAME if we'd set it
  if (!tgPrev) {
    await setSystemSetting(credsA, 'TELEGRAM_BOT_USERNAME', '');
  }

  process.exit(printSummary('P0 — channel verification', results));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
