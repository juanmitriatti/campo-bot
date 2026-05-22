/**
 * QA Compound Mixed Testing — 25 Multi-Domain Conversations
 *
 * Each test sends ONE message that mixes 4+ different action types out of:
 *   gastos | ingresos | actividades | hacienda | cosecha | monitoreos | stock
 *
 * - 10 conversations with COMPLETE data (all prices/quantities/plots provided)
 * - 15 conversations with PARTIAL data (missing prices/plots/crops/etc.)
 *
 * Goal: exercise the compound executor, bulk-mode handling, partial-pending
 * wire, and verify the agent emits ONE tool call per item even when some
 * are incomplete (the bug we patched on 2026-05-22).
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-compound-mixed-25.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-mixed@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Pedro';

// --- API helpers ---------------------------------------------------------

async function apiRegister(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'Mixed', email: EMAIL, password: PASSWORD }),
  });
  if (res.ok) {
    const data = await res.json() as any;
    return { token: data.tokens.accessToken, userId: data.user.id };
  }
  if (res.status === 409) return apiLogin();
  throw new Error(`Register failed: ${res.status}`);
}

async function apiLogin(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json() as any;
  return { token: data.tokens.accessToken, userId: data.user.id };
}

let TOKEN = '';

async function apiReset(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test-bot/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: '{}',
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}

async function apiSend(message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  return res.json();
}

async function apiTap(buttonId: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status}`);
  return res.json();
}

async function apiQueryDb(sql: string, params: unknown[]): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`Query failed: ${res.status}`);
  const data = await res.json() as any;
  return data.rows ?? [];
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
  const data = await apiSend(message);
  return extractText(data);
}

// --- Setup: rich initial state ------------------------------------------

interface SetupCounts {
  fields: number;
  plots: number;
  livestockGroups: number;
  warehouses: number;
}

async function setupRichState(userId: number): Promise<SetupCounts> {
  console.log('🔧 Setting up rich base data...');

  // Field: La Esperanza in Pergamino
  await sendAndLog('agregar campo La Esperanza');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');

  // 3 plots with hectares
  for (const [name, ha] of [['Norte', 150], ['Sur', 80], ['Fondo', 200]] as const) {
    await sendAndLog(`agregar lote ${name} al campo La Esperanza`);
    await sendAndLog(String(ha));
  }

  // Sow crops so cosecha tests have something to harvest
  await sendAndLog('sembré soja en el lote Norte');
  await sendAndLog('sembré maíz en el lote Sur');
  await sendAndLog('sembré trigo en el lote Fondo');

  // Livestock
  await sendAndLog('agregué 60 vacas Angus en el lote Norte');
  await sendAndLog('agregué 40 novillos en el lote Norte');
  await sendAndLog('agregué 30 terneros en el lote Norte');

  // Warehouse + stock items
  await sendAndLog('crear galpón Principal en La Esperanza');
  await sendAndLog('agregar 200 bolsas de soja al galpón Principal');
  await sendAndLog('agregar 150 lt de glifosato al galpón Principal');
  await sendAndLog('agregar 80 bolsas de urea al galpón Principal');

  // Verify
  const counts = {
    fields: (await apiQueryDb('SELECT COUNT(*)::int as c FROM fields WHERE user_id=$1 AND deleted_at IS NULL', [userId]))[0]?.c ?? 0,
    plots: (await apiQueryDb('SELECT COUNT(*)::int as c FROM plots p JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND p.deleted_at IS NULL', [userId]))[0]?.c ?? 0,
    livestockGroups: (await apiQueryDb('SELECT COUNT(*)::int as c FROM livestock_groups WHERE user_id=$1', [userId]))[0]?.c ?? 0,
    warehouses: (await apiQueryDb('SELECT COUNT(*)::int as c FROM warehouses w JOIN fields f ON f.id=w.field_id WHERE f.user_id=$1', [userId]))[0]?.c ?? 0,
  };
  console.log(`✅ Setup ready: ${counts.fields} fields, ${counts.plots} plots, ${counts.livestockGroups} livestock groups, ${counts.warehouses} warehouses\n`);
  return counts;
}

// --- Test definitions ---------------------------------------------------

interface TestSpec {
  name: string;
  category: 'complete' | 'partial';
  domains: string[]; // gastos|ingresos|actividades|hacienda|cosecha|monitoreos|stock
  message: string;
  /** Substrings that should appear in the response. Pass if all present. */
  expect: string[];
  /** Substrings that should NOT appear (negative assertions). */
  notExpect?: string[];
  /** Optional DB check after the message. */
  dbCheck?: { sql: string; params: (uid: number) => unknown[]; expectedRows: (n: number) => boolean };
}

const TESTS: TestSpec[] = [
  // === 10 COMPLETE DATA SCENARIOS ===

  {
    name: '01_complete_quad_basic',
    category: 'complete',
    domains: ['gastos', 'ingresos', 'actividades', 'hacienda'],
    message: 'Hoy gasté 50 mil en gasoil, vendí 20 tn de maíz a 200 USD por tonelada, fumigué Norte con glifosato 3 lt/ha, agregué 10 vaquillonas Angus en Sur',
    expect: ['gasoil', 'Maíz', 'glifosato', 'vaquillona'],
  },
  {
    name: '02_complete_sow_harvest_health_stock',
    category: 'complete',
    domains: ['actividades', 'cosecha', 'hacienda', 'stock'],
    message: 'Sembré trigo en Sur, coseché soja en Norte con 4500 kg/ha, vacuné 50 vacas contra aftosa, agregué 30 bolsas de soja al galpón Principal',
    expect: ['trigo', 'soja', 'aftosa', 'soja'],
  },
  {
    name: '03_complete_4xagro',
    category: 'complete',
    domains: ['actividades', 'monitoreos', 'gastos', 'cosecha'],
    message: 'Coseché maíz en Sur con 8500 kg/ha, monitoreé Norte soja V3 con 15% de rama negra, fumigué Fondo con 2,4D 1,5 lt/ha, gasté 200 mil en agroquímicos',
    expect: ['Maíz', 'V3', 'rama negra', '2,4D'],
  },
  {
    name: '04_complete_full_livestock_chain',
    category: 'complete',
    domains: ['hacienda', 'hacienda', 'ingresos', 'gastos'],
    message: 'Pesé 40 terneros 250 kg promedio, inseminé 20 vacas con IATF, vendí 15 novillos a 1500 dólares cada uno, compré 5 bolsas de antiparasitario por 80 mil',
    expect: ['250', 'inseminación', 'novillos', 'antiparasitario'],
  },
  {
    name: '05_complete_stock_spraying_fertil_expense',
    category: 'complete',
    domains: ['stock', 'actividades', 'actividades', 'gastos'],
    message: 'Saqué 40 lt de glifosato del galpón Principal, fumigué Norte con eso, fertilicé Sur con urea 120 kg/ha, gasté 30 mil en gasoil',
    expect: ['glifosato', 'urea', 'gasoil'],
  },
  {
    name: '06_complete_harvest_income_scouting_expense',
    category: 'complete',
    domains: ['cosecha', 'ingresos', 'monitoreos', 'gastos'],
    message: 'Coseché soja en Norte con 4200 kg/ha, vendí 80 tn a 450 USD por tonelada, monitoreé Sur maíz V8 sin plagas, gasté 30 mil en combustible',
    expect: ['Soja', 'V8'],
  },
  {
    name: '07_complete_rainfall_sow_livestock_expense',
    category: 'complete',
    domains: ['actividades', 'actividades', 'hacienda', 'gastos'],
    message: 'Llovieron 25 mm anoche en La Esperanza, sembré girasol en Fondo, agregué 25 vacas Brangus en Norte, compré 100 bolsas de urea a 9 mil cada una',
    expect: ['25 mm', 'girasol', 'Brangus', 'urea'],
  },
  {
    name: '08_complete_pesaje_repro_income_stock',
    category: 'complete',
    domains: ['hacienda', 'hacienda', 'ingresos', 'stock'],
    message: 'Pesé 30 vacas con 420 kg promedio, eché el toro Don Pancho en Norte, vendí 10 toros a 2000 USD cada uno, saqué 100 bolsas de semilla del galpón',
    expect: ['420', 'Don Pancho', 'toro', 'semilla'],
  },
  {
    name: '09_complete_spray_fertil_expense_observation',
    category: 'complete',
    domains: ['actividades', 'actividades', 'gastos', 'monitoreos'],
    message: 'Fumigué Norte con 2,4D 1,5 lt/ha, fertilicé Sur con urea 100 kg/ha, gasté 80 mil en herbicidas, vi liebres en Fondo',
    expect: ['2,4D', 'urea', 'herbicida', 'liebre'],
  },
  {
    name: '10_complete_tillage_sow_expense_livestock',
    category: 'complete',
    domains: ['actividades', 'actividades', 'gastos', 'hacienda'],
    message: 'Aré Norte con rastra, sembré soja en Norte, gasté 150 mil en gasoil de la sembradora, traté 50 vacas con ivermectina contra parásitos',
    expect: ['soja', 'gasoil', 'ivermectina'],
  },

  // === 15 PARTIAL DATA SCENARIOS ===

  {
    name: '11_partial_missing_prices_quad',
    category: 'partial',
    domains: ['ingresos', 'ingresos', 'gastos', 'gastos'],
    message: 'Vendí 30 tn de maíz y 20 tn de soja a 950 USD, gasté en gasoil, compré urea',
    expect: ['falta'], // partial price message
  },
  {
    name: '12_partial_missing_plots',
    category: 'partial',
    domains: ['actividades', 'actividades', 'ingresos', 'gastos'],
    message: 'Fumigué con glifosato 3 lt/ha, sembré soja, vendí maíz a 200 USD por tonelada, gasté 50 mil en agroquímicos',
    expect: [], // any pass — we just want it to not error
  },
  {
    name: '13_partial_missing_crops_in_activities',
    category: 'partial',
    domains: ['actividades', 'cosecha', 'ingresos', 'monitoreos'],
    message: 'Sembré en Sur, coseché en Norte con 4500 kg/ha, vendí 20 tn a 300 USD por tonelada, observé chinches en Fondo',
    expect: ['chinche'],
  },
  {
    name: '14_partial_no_quantities',
    category: 'partial',
    domains: ['ingresos', 'gastos', 'stock', 'actividades'],
    message: 'Vendí soja a buen precio, gasté en semillas, compré bolsas de urea, fumigué Norte',
    expect: [],
  },
  {
    name: '15_partial_hacienda_incomplete',
    category: 'partial',
    domains: ['hacienda', 'ingresos', 'hacienda', 'hacienda'],
    message: 'Agregué vacas Angus en Norte, vendí novillos, vacuné, pesé los terneros',
    expect: [],
  },
  {
    name: '16_partial_stock_incomplete',
    category: 'partial',
    domains: ['stock', 'stock', 'gastos', 'actividades'],
    message: 'Saqué semilla del galpón, agregué bolsas, compré agroquímico, fumigué Sur',
    expect: [],
  },
  {
    name: '17_partial_cosecha_incomplete',
    category: 'partial',
    domains: ['cosecha', 'ingresos', 'monitoreos', 'actividades'],
    message: 'Coseché en Norte, vendí parte a 380 USD por tonelada, monitoreé Sur, llovió un poco',
    expect: ['falta'],
  },
  {
    name: '18_partial_4x_no_specifics',
    category: 'partial',
    domains: ['actividades', 'hacienda', 'hacienda', 'hacienda'],
    message: 'Fumigué Norte, inseminé vacas, vacuné, pesé los terneros',
    expect: [],
  },
  {
    name: '19_partial_ambiguous_compound',
    category: 'partial',
    domains: ['gastos', 'actividades', 'hacienda', 'ingresos'],
    message: 'Compré bolsas, sembré, agregué vacas, vendí maíz',
    expect: [],
  },
  {
    name: '20_partial_stock_sow_repro_pesaje',
    category: 'partial',
    domains: ['stock', 'actividades', 'hacienda', 'hacienda'],
    message: 'Saqué del galpón para sembrar Norte, regué Sur, eché el toro, pesé los terneros',
    expect: [],
  },
  {
    name: '21_partial_informal_compound',
    category: 'partial',
    domains: ['ingresos', 'gastos', 'actividades', 'hacienda'],
    message: 'Vendí algo de soja, compré urea, ayer fumigué Norte con un herbicida, agregué unos terneros en Sur',
    expect: [],
  },
  {
    name: '22_partial_stock_monitor_income_expense',
    category: 'partial',
    domains: ['stock', 'monitoreos', 'ingresos', 'gastos'],
    message: 'Saqué un poco de glifosato, monitoreé Norte con plagas, vendí parte de la cosecha, gasté en combustible',
    expect: [],
  },
  {
    name: '23_partial_cosecha_with_3_partials',
    category: 'partial',
    domains: ['cosecha', 'ingresos', 'gastos', 'monitoreos'],
    message: 'Coseché soja en Norte con 4500 kg/ha, vendí parte, gasté en cosechadora, monitoreé que venía bien',
    expect: ['Soja'],
  },
  {
    name: '24_partial_4x_partial_data',
    category: 'partial',
    domains: ['actividades', 'hacienda', 'monitoreos', 'ingresos'],
    message: 'Aré Norte ayer, vacuné el ganado, monitoreé soja, vendí 5 tn',
    expect: [],
  },
  {
    name: '25_partial_long_informal_4plus',
    category: 'partial',
    domains: ['ingresos', 'actividades', 'hacienda', 'stock'],
    message: 'Che, ayer pasaron muchas cosas: vendí 15 tn de trigo a 180 USD por tonelada, fumigué Norte con un herbicida nuevo, agregué 12 terneros en Sur, perdí 30 lt de gasoil del galpón Principal',
    expect: ['trigo', 'tern', 'gasoil'],
  },
];

// --- Runner -------------------------------------------------------------

interface Result {
  test: TestSpec;
  status: 'PASS' | 'FAIL' | 'WARN';
  reason: string;
  response: string;
  toolCallsHint?: number;
}

async function main(): Promise<void> {
  console.log('🧪 QA Compound Mixed Testing — 25 Multi-Domain Conversations');
  console.log('=============================================================\n');

  let userId: number;
  try {
    const auth = await apiRegister();
    TOKEN = auth.token;
    userId = auth.userId;
    console.log(`✅ Authenticated as user ${userId}`);
  } catch (e) {
    console.error('Auth failed:', e);
    process.exit(1);
  }

  await apiReset();
  console.log('✅ User data reset');

  // Bump user to enterprise plan so the daily AI limit doesn't kill the suite (25 tests + setup ≈ 40+ calls).
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [userId]);
  console.log('✅ User upgraded to enterprise plan (1000/day AI limit)\n');

  await setupRichState(userId);

  const results: Result[] = [];
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`${num}/${TESTS.length} [${t.category}|${t.domains.join('+')}] ${t.name}... `);
    try {
      // Inject userId via overriding apiQueryDb at call time — use a local helper.
      const r = await runTestWithUser(t, userId);
      results.push(r);
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`${icon} ${r.reason}`);
    } catch (err: any) {
      console.log(`💥 ERROR: ${err.message}`);
      results.push({ test: t, status: 'FAIL', reason: `runtime error: ${err.message}`, response: '' });
    }
  }

  // Summary
  console.log('\n════════════════════════════════════════════');
  console.log('                 SUMMARY');
  console.log('════════════════════════════════════════════\n');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  console.log(`  ✅ PASS: ${pass}`);
  console.log(`  ⚠️  WARN: ${warn}`);
  console.log(`  ❌ FAIL: ${fail}`);
  console.log(`  📊 Total: ${results.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / results.length) * 100)}%\n`);

  // Complete vs partial breakdown
  const completePass = results.filter(r => r.status === 'PASS' && r.test.category === 'complete').length;
  const partialPass = results.filter(r => r.status === 'PASS' && r.test.category === 'partial').length;
  const totalComplete = results.filter(r => r.test.category === 'complete').length;
  const totalPartial = results.filter(r => r.test.category === 'partial').length;
  console.log(`  Complete: ${completePass}/${totalComplete} pass`);
  console.log(`  Partial:  ${partialPass}/${totalPartial} pass\n`);

  if (fail > 0) {
    console.log('─── FAILURES ───\n');
    for (const r of results.filter(x => x.status === 'FAIL')) {
      console.log(`  ❌ ${r.test.name}`);
      console.log(`     Reason: ${r.reason}`);
      console.log(`     Response preview: ${r.response.substring(0, 200).replace(/\n/g, ' ')}\n`);
    }
  }
  if (warn > 0) {
    console.log('─── WARNINGS ───\n');
    for (const r of results.filter(x => x.status === 'WARN')) {
      console.log(`  ⚠️  ${r.test.name}: ${r.reason}`);
    }
  }

  // Write full report
  const fs = await import('fs');
  const outputPath = '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-compound-mixed-results.json';
  fs.writeFileSync(outputPath, JSON.stringify(
    results.map(r => ({
      name: r.test.name,
      category: r.test.category,
      domains: r.test.domains,
      message: r.test.message,
      status: r.status,
      reason: r.reason,
      response: r.response,
    })),
    null, 2,
  ));
  console.log(`📄 Full report: ${outputPath}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

// Helper that runs a test with the correct userId in DB queries.
async function runTestWithUser(t: TestSpec, userId: number): Promise<Result> {
  const cols = 'e,i,d,o,s,lm,sm,r';
  const countSql = `SELECT
    (SELECT COUNT(*)::int FROM expenses WHERE user_id=$1 AND deleted_at IS NULL) as e,
    (SELECT COUNT(*)::int FROM incomes WHERE user_id=$1 AND deleted_at IS NULL) as i,
    (SELECT COUNT(*)::int FROM domain_events WHERE user_id=$1) as d,
    (SELECT COUNT(*)::int FROM agro_observations WHERE user_id=$1) as o,
    (SELECT COUNT(*)::int FROM crop_scoutings WHERE user_id=$1) as s,
    (SELECT COUNT(*)::int FROM livestock_movements WHERE user_id=$1) as lm,
    (SELECT COUNT(*)::int FROM stock_movements WHERE user_id=$1) as sm,
    (SELECT COUNT(*)::int FROM rainfall WHERE user_id=$1) as r`;

  const before = await apiQueryDb(countSql, [userId]);
  const res = await sendAndLog(t.message);
  const resLower = res.toLowerCase();
  const after = await apiQueryDb(countSql, [userId]);

  const sumRow = (row: any): number => cols.split(',').reduce((a, k) => a + (Number(row?.[k]) || 0), 0);
  const wrote = sumRow(after[0]) - sumRow(before[0]);

  const missing = t.expect.filter(s => !resLower.includes(s.toLowerCase()));
  const unwanted = (t.notExpect ?? []).filter(s => resLower.includes(s.toLowerCase()));

  let status: 'PASS' | 'FAIL' | 'WARN';
  let reason: string;

  if (t.category === 'complete') {
    if (wrote >= 4 && missing.length === 0 && unwanted.length === 0) {
      status = 'PASS';
      reason = `4+ writes (${wrote})`;
    } else if (wrote >= 3 && missing.length === 0) {
      status = 'WARN';
      reason = `wrote=${wrote} (expected ≥4)`;
    } else {
      status = 'FAIL';
      reason = `wrote=${wrote}, missing=[${missing.join(',')}]`;
    }
  } else {
    const hasPendingOrAsk = /falta|cu[aá]l|cu[aá]nto|qu[eé] precio|en qu[eé] lote|qu[eé] cultivo|\?/i.test(res);
    if (wrote >= 1 || hasPendingOrAsk) {
      if (missing.length === 0 && unwanted.length === 0) {
        status = 'PASS';
        reason = `wrote=${wrote}, ask=${hasPendingOrAsk}`;
      } else {
        status = 'WARN';
        reason = `wrote=${wrote}, ask=${hasPendingOrAsk}, missing=[${missing.join(',')}]`;
      }
    } else {
      status = 'FAIL';
      reason = `no writes + no clarification`;
    }
  }

  try { await sendAndLog('cancelar'); } catch { /* ignore */ }
  return { test: t, status, reason, response: res };
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
