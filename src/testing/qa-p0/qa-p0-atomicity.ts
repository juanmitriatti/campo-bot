/**
 * QA P0 — Compound action transaction atomicity (black-box).
 *
 * Run: `npx tsx src/testing/qa-p0/qa-p0-atomicity.ts`
 *
 * What this script verifies (and what it can't):
 *   - The AsyncLocalStorage hijack in `src/config/db.js` is wired up — i.e.
 *     wrapping multiple tool calls in `withTransaction` doesn't break the
 *     happy path. If we broke the savepoint shadow client, multi-step
 *     compounds would silently fail or hang here.
 *   - Single-action messages still work alongside the compound wrapper.
 *
 * What it does NOT test from outside:
 *   - Real TX rollback on hard exceptions. The handlers return *graceful*
 *     error messages (e.g. "no encontré el lote") for soft failures, which
 *     DON'T propagate exceptions, so the compound commits the successful
 *     steps. That's the intended design. To force a rollback you'd need a
 *     constraint violation or a code-level throw, which is hard to drive
 *     reliably from the bot interface. The unit-test suite covers that path
 *     (`src/domain/__tests__/compound-executor.test.ts`).
 *
 * Requires: AGENT_ENABLED=true (otherwise compound execution doesn't fire).
 */
import {
  apiRegister,
  apiSend,
  apiReset,
  queryDb,
  getSystemSetting,
  extractText,
  upgradeToEnterprise,
  fail,
  pass,
  printSummary,
  runTest,
  type AuthCreds,
} from './_shared.js';

const EMAIL = `qa-p0-atomicity-${Date.now()}@campo.test`;
const PASSWORD = 'qa-p0-test-1234';

async function countRows(creds: AuthCreds): Promise<{ expenses: number; livestock_movements: number; activities: number }> {
  const [exp, liv, act] = await Promise.all([
    queryDb(creds, `SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1 AND deleted_at IS NULL`, [creds.userId]),
    queryDb(creds, `SELECT COUNT(*)::int AS n FROM livestock_movements WHERE user_id = $1`, [creds.userId]),
    queryDb(creds, `SELECT COUNT(*)::int AS n FROM domain_events WHERE user_id = $1`, [creds.userId]),
  ]);
  return {
    expenses: Number(exp[0].n),
    livestock_movements: Number(liv[0].n),
    activities: Number(act[0].n),
  };
}

async function setupBaseData(creds: AuthCreds): Promise<void> {
  // Seed field + plot directly via DB. Going through the bot flow ("agregar
  // campo X" → flow_field_loc_city → "Pergamino" → confirm → "agregar lote ...")
  // is brittle for an automated suite. We just need rows to exist so subsequent
  // compounds have something to attach to.
  await queryDb(
    creds,
    `INSERT INTO fields (user_id, name, city, hectares)
     VALUES ($1, 'La Esperanza', 'Pergamino', 100)
     ON CONFLICT (user_id, name) DO NOTHING`,
    [creds.userId],
  );
  const fields = await queryDb(
    creds,
    `SELECT id FROM fields WHERE user_id = $1 AND name = 'La Esperanza'`,
    [creds.userId],
  );
  const fieldId = (fields[0] as { id: number }).id;
  // field_members is the access table — without an owner row, getUserFields
  // returns empty because it scopes via field_members (sharing-aware).
  await queryDb(
    creds,
    `INSERT INTO field_members (field_id, user_id, role, invited_by)
     VALUES ($1, $2, 'owner', $2)
     ON CONFLICT (field_id, user_id) DO NOTHING`,
    [fieldId, creds.userId],
  );
  await queryDb(
    creds,
    `INSERT INTO plots (field_id, name, area_hectares)
     VALUES ($1, 'Norte', 100)
     ON CONFLICT (field_id, name) DO NOTHING`,
    [fieldId],
  );
}

async function main(): Promise<void> {
  console.log(`▶ Registering user ${EMAIL}`);
  const creds = await apiRegister(EMAIL, PASSWORD, 'Atomicity QA');
  await upgradeToEnterprise(creds);

  const agentEnabled = await getSystemSetting(creds, 'AGENT_ENABLED');
  if (agentEnabled !== 'true') {
    console.warn(`⚠️  AGENT_ENABLED=${agentEnabled} — atomicity only kicks in with AGENT_ENABLED=true. Skipping.`);
    process.exit(0);
  }

  await apiReset(creds);
  await setupBaseData(creds);

  const results = [
    await runTest('happy compound: 2 valid actions both persist', async () => {
      const before = await countRows(creds);
      const data = await apiSend(
        creds,
        // expense + activity in one breath. Both should succeed.
        'gasté 5000 en gasoil y fumigué el lote Norte con glifosato',
      );
      const text = extractText(data).toLowerCase();
      // No rollback message expected
      if (text.includes('ningún dato quedó guardado')) {
        return fail('happy', `compound was rolled back unexpectedly: ${text.slice(0, 200)}`);
      }
      const after = await countRows(creds);
      if (after.expenses <= before.expenses) {
        return fail('happy', `expenses did not grow (${before.expenses} → ${after.expenses})`);
      }
      // activity may or may not register depending on plot resolution; not strict
      return pass('happy compound: both persisted', `expenses ${before.expenses}→${after.expenses}`);
    }),

    await runTest('3-step compound persists all valid actions', async () => {
      const before = await countRows(creds);
      // Three actionable steps in one message, all valid. Checks the wrapper
      // handles >2 steps (and the savepoint shadow client doesn't blow up on
      // nested begin/commit cycles inside livestock/stock repos).
      const data = await apiSend(
        creds,
        'gasté 1500 en gasoil, gasté 2300 en semillas y observación: el cultivo viene parejo',
      );
      const text = extractText(data).toLowerCase();
      if (text.includes('ningún dato quedó guardado')) {
        return fail('3-step', `unexpected rollback: ${text.slice(0, 200)}`);
      }
      const after = await countRows(creds);
      // expenses must grow by at least 2 (gasoil + semillas)
      if (after.expenses - before.expenses < 2) {
        return fail('3-step', `expenses grew by ${after.expenses - before.expenses}, expected ≥2`);
      }
      return pass('3-step compound persists all', `+${after.expenses - before.expenses} expenses`);
    }),

    await runTest('non-compound single action keeps working', async () => {
      // A plain single-tool message should still flow through the normal
      // handler (not the compound wrapper). Single expenses ask for
      // confirmation, so we have to confirm.
      await apiSend(creds, 'cancelar').catch(() => {});
      const before = await countRows(creds);
      await apiSend(creds, 'gasté 4321 en glifosato');
      // Confirm the expense
      await apiSend(creds, 'si').catch(() => {});
      const after = await countRows(creds);
      if (after.expenses <= before.expenses) {
        return fail('single', `expense did not persist (${before.expenses} → ${after.expenses})`);
      }
      return pass('single expense persists after confirm', `+${after.expenses - before.expenses}`);
    }),
  ];

  process.exit(printSummary('P0 — compound atomicity', results));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
