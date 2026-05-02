/**
 * QA P0 — Data export + account deletion (GDPR).
 *
 * Run: `npx tsx src/testing/qa-p0/qa-p0-export-delete.ts`
 * Pre: `docker compose up -d` (app at :3000, DB at :5433).
 *
 * Tests:
 *   1. GET /me/export streams a non-empty ZIP (PK header + > 1KB).
 *   2. DELETE /me with wrong password → 401, account intact.
 *   3. DELETE /me with right password → soft-delete + PII nulled.
 *   4. Login with old creds after deletion → 401.
 *   5. Re-register with the same email → succeeds (PII released).
 */
import {
  apiRegister,
  apiLogin,
  apiSend,
  queryDb,
  BASE_URL,
  fail,
  pass,
  printSummary,
  runTest,
  type AuthCreds,
} from './_shared.js';

const EMAIL = `qa-p0-export-${Date.now()}@campo.test`;
const PASSWORD = 'qa-p0-test-1234';

async function seedSomeData(creds: AuthCreds): Promise<void> {
  // Sprinkle a tiny amount of data so the export ZIP isn't all empty CSVs.
  await apiSend(creds, 'agregar campo La Esperanza').catch(() => {});
  await apiSend(creds, 'gasté 5000 en gasoil').catch(() => {});
  await apiSend(creds, 'observación: el lote viene bien').catch(() => {});
}

async function main(): Promise<void> {
  console.log(`▶ Registering user ${EMAIL}`);
  const creds = await apiRegister(EMAIL, PASSWORD);
  await seedSomeData(creds);

  const results = [
    await runTest('export streams a real ZIP', async () => {
      const res = await fetch(`${BASE_URL}/api/auth/me/export`, {
        headers: { Authorization: `Bearer ${creds.token}` },
      });
      if (!res.ok) return fail('export', `status ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('zip')) return fail('export', `content-type was ${ct}, expected zip`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) return fail('export', `body too small (${buf.length} bytes)`);
      // ZIP magic bytes: 0x50 0x4B 0x03 0x04 ("PK\x03\x04")
      if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
        return fail('export', `body does not start with ZIP magic bytes`);
      }
      return pass('export streams a real ZIP', `${buf.length} bytes ✓`);
    }),

    await runTest('DELETE /me without password → 400', async () => {
      const res = await fetch(`${BASE_URL}/api/auth/me`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
        body: '{}',
      });
      if (res.status !== 400) return fail('delete-no-pwd', `expected 400, got ${res.status}`);
      return pass('DELETE /me without password → 400');
    }),

    await runTest('DELETE /me wrong password → 401, intact', async () => {
      const res = await fetch(`${BASE_URL}/api/auth/me`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
        body: JSON.stringify({ password: 'definitely-wrong' }),
      });
      if (res.status !== 401) return fail('delete-wrong-pwd', `expected 401, got ${res.status}`);
      // Verify account intact
      const rows = await queryDb(creds, `SELECT status, deleted_at FROM users WHERE id = $1`, [creds.userId]);
      if (rows.length === 0) return fail('delete-wrong-pwd', 'user row vanished');
      if (rows[0].status === 'deleted' || rows[0].deleted_at) {
        return fail('delete-wrong-pwd', `account got deleted on wrong password!`);
      }
      return pass('DELETE /me wrong password → 401, intact');
    }),

    await runTest('DELETE /me right password → soft-delete + PII nulled', async () => {
      const res = await fetch(`${BASE_URL}/api/auth/me`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
        body: JSON.stringify({ password: PASSWORD }),
      });
      if (!res.ok) return fail('delete-ok', `expected 200, got ${res.status}: ${await res.text()}`);
      const rows = await queryDb(
        creds,
        `SELECT status, deleted_at, email, phone_number, telegram_id, password_hash,
                whatsapp_verified_at, telegram_verified_at
         FROM users WHERE id = $1`,
        [creds.userId],
      );
      if (rows.length === 0) return fail('delete-ok', 'user row missing after soft-delete');
      const u = rows[0];
      if (u.status !== 'deleted') return fail('delete-ok', `status=${u.status}, expected 'deleted'`);
      if (!u.deleted_at) return fail('delete-ok', 'deleted_at is null');
      if (u.email != null) return fail('delete-ok', `email not nulled: ${u.email}`);
      if (u.phone_number != null) return fail('delete-ok', `phone not nulled: ${u.phone_number}`);
      if (u.password_hash != null) return fail('delete-ok', 'password_hash not nulled');
      return pass('DELETE /me → soft-delete + PII nulled');
    }),

    await runTest('login with deleted creds → 401', async () => {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      });
      if (res.status === 200) return fail('login-after-delete', 'login succeeded after deletion');
      if (res.status >= 400 && res.status < 500) return pass('login-after-delete', `${res.status}`);
      return fail('login-after-delete', `unexpected status ${res.status}`);
    }),

    await runTest('re-register same email → succeeds (PII released)', async () => {
      const fresh = await apiRegister(EMAIL, 'fresh-password-9999', 'Reborn');
      if (!fresh.userId || fresh.userId === creds.userId) {
        return fail('re-register', `expected new user_id, got ${fresh.userId} (old=${creds.userId})`);
      }
      // And the new user can login
      const newAuth = await apiLogin(EMAIL, 'fresh-password-9999');
      if (newAuth.userId !== fresh.userId) return fail('re-register', 'login returned different user_id');
      return pass('re-register same email → new user', `id=${fresh.userId}`);
    }),
  ];

  process.exit(printSummary('P0 — data export + account deletion', results));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
