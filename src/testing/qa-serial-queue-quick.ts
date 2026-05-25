/**
 * Quick end-to-end test for the SERIAL PENDING QUEUE.
 *
 * Replays the user's reported case: "vendi 2 vacas y compre glifosato"
 * → bot should ask vacas' lote FIRST, save vacas, THEN ask glifosato's
 * price, save gasto. Each answer applied to ONLY ONE item — no
 * conflation.
 */

const BASE_URL = 'http://localhost:3000';
const EMAIL = 'qa-serial@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Serial';

async function api(path: string, opts: RequestInit = {}, token?: string): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers });
  if (!res.ok && res.status !== 409) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function extract(data: any): string {
  return (data.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}

async function main(): Promise<void> {
  console.log('🧪 Serial Pending Queue — quick end-to-end\n');

  let auth;
  try {
    auth = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: NAME, last_name: 'Test', email: EMAIL, password: PASSWORD }) });
  } catch {
    auth = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  }
  const token = auth.tokens.accessToken;
  const userId = auth.user.id;

  await api('/api/test-bot/reset', { method: 'POST', body: '{}' }, token);
  await api('/api/test-bot/query-db', { method: 'POST', body: JSON.stringify({ sql: 'UPDATE users SET plan_id = 4 WHERE id = $1', params: [userId] }) }, token);

  // Setup: 1 field, 3 plots (A1/A2/A3), 1 livestock group (vacas)
  console.log('🔧 Setup...');
  await api('/api/test-bot', { method: 'POST', body: JSON.stringify({ message: 'agregar campo La Esperanza' }) }, token);
  await api('/api/test-bot', { method: 'POST', body: JSON.stringify({ interactiveReplyId: 'flow_field_loc_city' }) }, token);
  await api('/api/test-bot', { method: 'POST', body: JSON.stringify({ message: 'Pergamino' }) }, token);
  await api('/api/test-bot', { method: 'POST', body: JSON.stringify({ interactiveReplyId: 'flow_confirm' }) }, token);
  for (const [name, ha] of [['A1', 100], ['A2', 80], ['A3', 120]] as const) {
    await api('/api/test-bot', { method: 'POST', body: JSON.stringify({ message: `agregar lote ${name} al campo La Esperanza` }) }, token);
    await api('/api/test-bot', { method: 'POST', body: JSON.stringify({ message: String(ha) }) }, token);
  }
  await api('/api/test-bot', { method: 'POST', body: JSON.stringify({ message: 'agregué 20 vacas Angus en A1' }) }, token);
  console.log('✅ Setup done\n');

  // ── The actual test ──
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('USER: vendi 2 vacas y compre glifosato');
  const r1 = await api('/api/test-bot', { method: 'POST', body: JSON.stringify({ message: 'vendi 2 vacas y compre glifosato' }) }, token);
  console.log('BOT:');
  console.log(extract(r1));
  console.log();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('USER: A2  (responding to first asked item)');
  const r2 = await api('/api/test-bot', { method: 'POST', body: JSON.stringify({ message: 'A2' }) }, token);
  console.log('BOT:');
  console.log(extract(r2));
  console.log();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('USER: 100mil  (responding to second asked item)');
  const r3 = await api('/api/test-bot', { method: 'POST', body: JSON.stringify({ message: '100mil' }) }, token);
  console.log('BOT:');
  console.log(extract(r3));
  console.log();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Verifying DB state...');
  const livestockMov = await api('/api/test-bot/query-db', {
    method: 'POST',
    body: JSON.stringify({
      sql: `SELECT category, count, movement_type, plot_id, unit_price_ars FROM livestock_movements WHERE user_id=$1 ORDER BY id DESC LIMIT 5`,
      params: [userId],
    }),
  }, token);
  const expenses = await api('/api/test-bot/query-db', {
    method: 'POST',
    body: JSON.stringify({
      sql: `SELECT category, amount, product, plot_id FROM expenses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
      params: [userId],
    }),
  }, token);
  console.log('\nlivestock_movements:', JSON.stringify(livestockMov.rows, null, 2));
  console.log('\nexpenses:', JSON.stringify(expenses.rows, null, 2));

  // Expected:
  //  - One livestock movement: 2 vacas removed at plot A2, NO unit_price_ars
  //  - One expense: glifosato 100k at... A2? or null plot?
  // If user said "A2" only for vacas, glifosato should NOT have plot A2 unless agent re-resolved it from context.
  // If user said "100mil" only for gasto, vacas should NOT have unit_price=100000.

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
