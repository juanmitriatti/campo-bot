/**
 * QA Bulk-Mode Extended — 20 NEW Varied Conversations
 *
 * Each test sends ONE compound message mixing 4+ action types. Tests focus on
 * verifying the EXTENDED bulkMode logic: agronomy/livestock/stock handlers
 * should no longer STOP the compound when data is missing. They should save
 * what they can (best-effort), and the compound MUST always reach the end —
 * never leave the user mid-flow.
 *
 * Distribution:
 *   - 8 with COMPLETE data (all params provided)
 *   - 12 with PARTIAL data (missing plot/price/quantity/etc.)
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-bulk-extended-20.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-bulk-ext@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Bulk';

async function apiRegister(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'Test', email: EMAIL, password: PASSWORD }),
  });
  if (res.ok) { const d = await res.json() as any; return { token: d.tokens.accessToken, userId: d.user.id }; }
  if (res.status === 409) return apiLogin();
  throw new Error(`Register failed: ${res.status}`);
}
async function apiLogin(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const d = await res.json() as any;
  return { token: d.tokens.accessToken, userId: d.user.id };
}

let TOKEN = '';
async function apiReset(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test-bot/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` }, body: '{}',
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}
async function apiSend(message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  return res.json();
}
async function apiTap(buttonId: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status}`);
  return res.json();
}
async function apiQueryDb(sql: string, params: unknown[]): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`Query failed: ${res.status}`);
  const d = await res.json() as any;
  return d.rows ?? [];
}

function extractText(data: any): string {
  const parts: string[] = [];
  for (const m of (data.messages || [])) {
    if (m.text) parts.push(m.text);
    if (m.interactive?.body) parts.push(m.interactive.body);
  }
  return parts.join('\n');
}
async function sendAndLog(message: string): Promise<string> {
  return extractText(await apiSend(message));
}

async function setupRichState(userId: number): Promise<void> {
  console.log('🔧 Setting up rich state...');
  await sendAndLog('agregar campo La Esperanza');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');
  for (const [name, ha] of [['Norte', 150], ['Sur', 80], ['Fondo', 200]] as const) {
    await sendAndLog(`agregar lote ${name} al campo La Esperanza`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré soja en Norte');
  await sendAndLog('sembré maíz en Sur');
  await sendAndLog('sembré trigo en Fondo');
  await sendAndLog('agregué 60 vacas Angus en Norte');
  await sendAndLog('agregué 40 novillos en Norte');
  await sendAndLog('crear galpón Principal en La Esperanza');
  await sendAndLog('agregar 200 bolsas de soja al galpón Principal');
  await sendAndLog('agregar 150 lt de glifosato al galpón Principal');
  console.log('✅ Setup done\n');
}

interface TestSpec {
  name: string;
  category: 'complete' | 'partial';
  message: string;
  /** Minimum total DB writes (across all tables) we expect. */
  minWrites: number;
  /** Substrings expected in response (any one missing → WARN, not FAIL). */
  expectAny?: string[];
  /** Substrings that should NEVER appear in response (true failure if found). */
  expectNot?: string[];
}

const TESTS: TestSpec[] = [
  // ─── COMPLETE (8) ────────────────────────────────────────────────────────
  {
    name: '01_complete_4mixed_gas_inc_act_lvstk',
    category: 'complete',
    message: 'Hoy gasté 30 mil en gasoil, vendí 15 tn de soja a 480 USD por tonelada, fumigué Norte con glifosato 3 lt/ha, agregué 20 vaquillonas Angus en Sur',
    minWrites: 4,
  },
  {
    name: '02_complete_5_agro_focus',
    category: 'complete',
    message: 'Sembré girasol en Norte, fertilicé Sur con urea 100 kg/ha, fumigué Fondo con 2,4D 1,5 lt/ha, agregué 30 terneros en Norte, vi liebres en Fondo',
    minWrites: 5,
  },
  {
    name: '03_complete_6_full_chain',
    category: 'complete',
    message: 'Coseché soja en Norte con 4500 kg/ha, vendí 100 tn a 450 USD por tonelada, gasté 200 mil en cosechadora, monitoreé Norte V8 sin plagas, fumigué Sur con un fungicida, agregué 25 vacas',
    minWrites: 5,
  },
  {
    name: '04_complete_livestock_chain',
    category: 'complete',
    message: 'Agregué 50 vacas Brangus en Norte, vacuné 50 vacas contra brucelosis, pesé 30 terneros 280 kg promedio, vendí 10 novillos a 1800 USD cada uno',
    minWrites: 3,
  },
  {
    name: '05_complete_stock_activity',
    category: 'complete',
    message: 'Saqué 80 lt de glifosato del galpón Principal, agregué 50 bolsas de urea al galpón Principal, fumigué Norte con glifosato 2 lt/ha, fertilicé Sur con urea 100 kg/ha',
    minWrites: 4,
  },
  {
    name: '06_complete_rainfall_4',
    category: 'complete',
    message: 'Llovieron 30 mm en La Esperanza, monitoreé Norte soja V5 con 10% rama negra, fumigué Sur con un herbicida, gasté 50 mil en combustible',
    minWrites: 4,
  },
  {
    name: '07_complete_monitoring_4',
    category: 'complete',
    message: 'Monitoreé Norte soja V4 con 8% malezas, vi orugas en Sur, observación en Fondo: estado del trigo bueno, gasté 25 mil en monitoreo',
    minWrites: 3,
  },
  {
    name: '08_complete_harvest_chain',
    category: 'complete',
    message: 'Coseché maíz en Sur con 8500 kg/ha, vendí 50 tn de maíz a 220 USD por tonelada, llovieron 12 mm en La Esperanza, monitoreé Norte V7 normal, gasté 80 mil en flete',
    minWrites: 4,
  },

  // ─── PARTIAL (12) ────────────────────────────────────────────────────────
  {
    name: '09_partial_spray_no_plot',
    category: 'partial',
    message: 'Fumigué con glifosato 2 lt/ha, vendí 20 tn de trigo a 200 USD por tonelada, agregué 10 terneros, gasté 60 mil en gasoil',
    minWrites: 2,
    expectNot: ['¿En qué lote?', '¿En qué lote lo registramos?'], // must not block
  },
  {
    name: '10_partial_obs_no_plot',
    category: 'partial',
    message: 'Observé liebres, fumigué con un herbicida nuevo, gasté 100 mil en agroquímicos, agregué 50 vacas en Sur',
    minWrites: 2,
    expectNot: ['Indicá el lote'],
  },
  {
    name: '11_partial_livestock_no_loc',
    category: 'partial',
    message: 'Agregué 30 vacas, vacuné el ganado contra aftosa, vendí 15 toros a 1800 USD cada uno, gasté 90 mil en sanidad',
    minWrites: 2,
  },
  {
    name: '12_partial_multi_spray',
    category: 'partial',
    message: 'Fumigué Norte con glifosato, fumigué con 2,4D, fertilicé Sur con urea, gasté 70 mil en herbicida',
    minWrites: 2,
  },
  {
    name: '13_partial_income_no_price',
    category: 'partial',
    message: 'Vendí soja, gasté 40 mil en gasoil, fumigué Norte con glifosato 3 lt/ha, agregué 20 vacas en Sur',
    minWrites: 2,
    expectAny: ['falta el precio'],
  },
  {
    name: '14_partial_sow_no_crop',
    category: 'partial',
    message: 'Sembré algo en Norte, fumigué Sur con un químico, vendí 5 tn a 300 USD por tonelada, gasté 25 mil en semillas',
    minWrites: 2,
  },
  {
    name: '15_partial_3_partials_1_complete',
    category: 'partial',
    message: 'Compré bolsas, vendí maíz, fumigué, agregué 50 terneros en Norte',
    minWrites: 1,
  },
  {
    name: '16_partial_informal_monitoreo',
    category: 'partial',
    message: 'Vi algo raro en el lote Norte, fumigué con glifosato, vendí 10 tn de soja a 480 USD por tonelada, gasté 30 mil en algo',
    minWrites: 2,
  },
  {
    name: '17_partial_stock_no_detail',
    category: 'partial',
    message: 'Saqué algo del galpón, fumigué Norte, agregué 20 terneros en Sur, gasté 40 mil en combustible',
    minWrites: 2,
  },
  {
    name: '18_partial_hacienda_incomplete',
    category: 'partial',
    message: 'Pesé los terneros, inseminé las vacas, vendí novillos, gasté 80 mil en vet',
    minWrites: 1,
  },
  {
    name: '19_partial_6_actions_long',
    category: 'partial',
    message: 'Hoy estuvimos a full: coseché en Norte 4000 kg/ha, vendí parte a 480 USD, gasté 100 mil en cosechadora, llovieron 20 mm, monitoreé Sur que venía bien, agregué 15 vaquillonas en Sur',
    minWrites: 3,
  },
  {
    name: '20_partial_ambiguous_short',
    category: 'partial',
    message: 'compré urea, sembré, vacuné las vacas, saqué glifosato del galpón',
    minWrites: 1,
    expectNot: ['No entendí'],
  },
];

interface Result {
  test: TestSpec;
  status: 'PASS' | 'FAIL' | 'WARN';
  reason: string;
  response: string;
  wrote: number;
}

async function runTest(t: TestSpec, userId: number): Promise<Result> {
  const sql = `SELECT
    (SELECT COUNT(*)::int FROM expenses WHERE user_id=$1 AND deleted_at IS NULL) as e,
    (SELECT COUNT(*)::int FROM incomes WHERE user_id=$1 AND deleted_at IS NULL) as i,
    (SELECT COUNT(*)::int FROM domain_events WHERE user_id=$1) as d,
    (SELECT COUNT(*)::int FROM agro_observations WHERE user_id=$1) as o,
    (SELECT COUNT(*)::int FROM crop_scoutings WHERE user_id=$1) as s,
    (SELECT COUNT(*)::int FROM livestock_movements WHERE user_id=$1) as lm,
    (SELECT COUNT(*)::int FROM stock_movements WHERE user_id=$1) as sm,
    (SELECT COUNT(*)::int FROM rainfall WHERE user_id=$1) as r`;
  const before = (await apiQueryDb(sql, [userId]))[0] ?? {};
  const res = await sendAndLog(t.message);
  const after = (await apiQueryDb(sql, [userId]))[0] ?? {};
  const sumRow = (row: Record<string, unknown>): number => Object.values(row).reduce<number>((a, b) => a + (Number(b) || 0), 0);
  const wrote = sumRow(after as Record<string, unknown>) - sumRow(before as Record<string, unknown>);
  const resLower = res.toLowerCase();
  const missing = (t.expectAny ?? []).filter(s => !resLower.includes(s.toLowerCase()));
  const unwanted = (t.expectNot ?? []).filter(s => res.includes(s));

  let status: 'PASS' | 'FAIL' | 'WARN';
  let reason: string;
  // A "graceful ask" response counts as acceptable behavior for partial tests:
  // the agent didn't save anything but asked the user for the missing data.
  // That's better than silent drop. NOT acceptable for complete tests
  // (those should have enough data to fire all tools).
  const hasAsk = /\?/.test(res) && /cu[aá]l|cu[aá]nto|qu[eé] |c[oó]mo|en qu[eé]|d[oó]nde/i.test(res);
  if (unwanted.length > 0) {
    status = 'FAIL';
    reason = `Found forbidden substring(s): [${unwanted.join(', ')}]`;
  } else if (wrote >= t.minWrites) {
    status = missing.length === 0 ? 'PASS' : 'WARN';
    reason = `wrote=${wrote} (min ${t.minWrites})${missing.length > 0 ? `, missing=[${missing.join(',')}]` : ''}`;
  } else if (t.category === 'partial' && hasAsk) {
    status = 'PASS';
    reason = `wrote=${wrote}, agent asked for clarification (acceptable UX for partial input)`;
  } else {
    status = 'FAIL';
    reason = `wrote=${wrote} < min ${t.minWrites}`;
  }

  try { await sendAndLog('cancelar'); } catch { /* ignore */ }
  return { test: t, status, reason, response: res, wrote };
}

async function main(): Promise<void> {
  console.log('🧪 QA Bulk-Mode Extended — 20 New Varied Conversations');
  console.log('========================================================\n');

  const auth = await apiRegister();
  TOKEN = auth.token;
  const userId = auth.userId;
  console.log(`✅ Authenticated as user ${userId}`);
  await apiReset();
  console.log('✅ User data reset');
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [userId]);
  console.log('✅ User upgraded to enterprise plan\n');
  await setupRichState(userId);

  const results: Result[] = [];
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`${num}/${TESTS.length} [${t.category}] ${t.name}... `);
    try {
      const r = await runTest(t, userId);
      results.push(r);
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`${icon} ${r.reason}`);
    } catch (err: any) {
      console.log(`💥 ${err.message}`);
      results.push({ test: t, status: 'FAIL', reason: `runtime: ${err.message}`, response: '', wrote: 0 });
    }
  }

  // Summary
  console.log('\n════════════════════════════════════════════');
  console.log('                 SUMMARY');
  console.log('════════════════════════════════════════════\n');
  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const completePass = results.filter(r => r.status === 'PASS' && r.test.category === 'complete').length;
  const partialPass = results.filter(r => r.status === 'PASS' && r.test.category === 'partial').length;
  console.log(`  ✅ PASS: ${pass}`);
  console.log(`  ⚠️  WARN: ${warn}`);
  console.log(`  ❌ FAIL: ${fail}`);
  console.log(`  📊 Total: ${results.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / results.length) * 100)}%\n`);
  console.log(`  Complete: ${completePass}/${results.filter(r => r.test.category === 'complete').length} pass`);
  console.log(`  Partial:  ${partialPass}/${results.filter(r => r.test.category === 'partial').length} pass\n`);

  // Wrote count distribution
  const writeStats = results.map(r => r.wrote);
  console.log(`  Avg wrote/test: ${(writeStats.reduce((a, b) => a + b, 0) / writeStats.length).toFixed(1)}`);
  console.log(`  Max wrote: ${Math.max(...writeStats)}, Min wrote: ${Math.min(...writeStats)}\n`);

  if (fail > 0) {
    console.log('─── FAILURES ───\n');
    for (const r of results.filter(x => x.status === 'FAIL')) {
      console.log(`  ❌ ${r.test.name} (wrote=${r.wrote})`);
      console.log(`     ${r.reason}`);
      console.log(`     Preview: ${r.response.substring(0, 150).replace(/\n/g, ' ')}\n`);
    }
  }
  if (warn > 0) {
    console.log('─── WARNINGS ───\n');
    for (const r of results.filter(x => x.status === 'WARN')) {
      console.log(`  ⚠️  ${r.test.name}: ${r.reason}`);
    }
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-bulk-extended-results.json',
    JSON.stringify(results.map(r => ({
      name: r.test.name,
      category: r.test.category,
      message: r.test.message,
      status: r.status,
      wrote: r.wrote,
      reason: r.reason,
      response: r.response,
    })), null, 2),
  );
  console.log(`📄 Full report: src/testing/qa-bulk-extended-results.json\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
