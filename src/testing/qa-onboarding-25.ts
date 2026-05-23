/**
 * QA Onboarding — 25 First-Impression Cases
 *
 * Each test simulates a brand-new user who just registered and tries to dump
 * ALL their info in ONE message. The test resets to ZERO state before each
 * case (no fields, no plots, no livestock, no stock) and then sends a
 * single compound message that mixes:
 *   - Field creation
 *   - Plot creation (with/without hectares)
 *   - Sowing / harvesting
 *   - Spraying / fertilization
 *   - Livestock additions
 *   - Stock movements
 *   - Initial expenses/incomes
 *
 * The goal: verify the user gets a clean first impression — the bot should
 * never loop, never lose info silently, and should leave the user with
 * concrete next steps when data is missing.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-onboarding-25.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-onboarding@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Nuevo';

// ── API helpers ─────────────────────────────────────────────────────────

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

// ── Test spec ───────────────────────────────────────────────────────────

interface TestSpec {
  name: string;
  /** Optional brief description shown alongside the test name in output. */
  desc?: string;
  /** The single onboarding message the user types. */
  message: string;
  /** Minimum expected records (across tables). */
  minWrites: number;
  /** Minimum fields the test expects to have been created. */
  minFields?: number;
  /** Minimum plots created. */
  minPlots?: number;
  /** Substrings expected in response (any missing → WARN). */
  expectAny?: string[];
  /** Substrings forbidden in response (FAIL if present). */
  expectNot?: string[];
}

const TESTS: TestSpec[] = [
  // ───────── Field + plots + activities (most common onboarding) ─────────
  {
    name: '01_field_plots_sowing_basic',
    desc: 'Field + 3 plots + sowing in one message',
    message: 'Tengo el campo La Esperanza en Pergamino, con los lotes Norte de 150 ha, Sur de 80 ha y Fondo de 200 ha. Sembré soja en Norte.',
    minWrites: 1, minFields: 1, minPlots: 3,
  },
  {
    name: '02_field_plot_sowing_expense',
    desc: 'Field + 1 plot + sow + initial expense',
    message: 'Arranco con el campo San Martín en Junín, lote único A1 de 100 hectáreas. Sembré maíz y gasté 200 mil en la semilla.',
    minWrites: 2, minFields: 1, minPlots: 1,
  },
  {
    name: '03_field_plots_livestock',
    desc: 'Field + plots + livestock add',
    message: 'Agregá el campo Don Pedro en Bolívar, con lote Casco 50 ha y lote Bajo 120 ha. Tengo 80 vacas Angus en el lote Casco.',
    minWrites: 1, minFields: 1, minPlots: 2,
  },
  {
    name: '04_field_plots_spraying_activity',
    desc: 'Field + plots + spray after sow',
    message: 'Campo Las Marías en Pergamino, lote Norte 100 ha, lote Sur 60 ha. Sembré soja en Norte y fumigué con glifosato 3 lt/ha.',
    minWrites: 2, minFields: 1, minPlots: 2,
  },
  {
    name: '05_field_plots_harvest_sale',
    desc: 'Field + plots + harvest + income',
    message: 'Campo La Inés en Junín, lote A 200 ha. Coseché soja con 4500 kg/ha en A y vendí 50 tn a 480 USD por tonelada.',
    minWrites: 1, minFields: 1, minPlots: 1,
  },
  {
    name: '06_field_plots_sowing_monitoreo',
    desc: 'Field + plots + sow + scouting',
    message: 'Tengo el campo El Recreo en Pergamino, lote A1 80 ha, lote A2 120 ha. Sembré soja en A1 y monitoreé A1 V3 con 8% malezas.',
    minWrites: 2, minFields: 1, minPlots: 2,
  },
  {
    name: '07_field_plots_multi_sowing',
    desc: 'Field + plots + multiple sowings',
    message: 'Doy de alta campo La Querencia en Bolívar con lotes Norte 100 ha, Sur 80 ha, Centro 150 ha. Sembré soja en Norte, maíz en Sur y trigo en Centro.',
    minWrites: 3, minFields: 1, minPlots: 3,
  },
  {
    name: '08_field_plots_warehouse_stock',
    desc: 'Field + plots + warehouse + stock items',
    message: 'Tengo el campo Los Olmos en Pergamino, lote A 80 ha. Creá el galpón Principal y cargá 200 bolsas de soja y 100 lt de glifosato.',
    minWrites: 2, minFields: 1, minPlots: 1,
  },

  // ───────── Mega-compound (8+ actions in one go) ──────────────────────
  {
    name: '09_mega_compound_full_chain',
    desc: 'Field + 3 plots + sowing + spray + livestock + expense + monitoreo',
    message: 'Cargá el campo Don Tito en Junín con lotes A 100 ha, B 150 ha, C 80 ha. Sembré soja en A, fumigué B con glifosato 2 lt/ha, agregué 50 vacas Angus en C, gasté 80 mil en gasoil y monitoreé A V2 con 5% malezas.',
    minWrites: 4, minFields: 1, minPlots: 3,
  },
  {
    name: '10_long_natural_language',
    desc: 'Long natural farmer message',
    message: 'Hola, soy productor de Bolívar. Tengo el campo Las Margaritas con tres lotes: el Norte de 130 hectáreas con soja sembrada, el Sur de 90 hectáreas con maíz, y el Bajo de 200 hectáreas con trigo. Pasamos la sembradora la semana pasada en todos. Llovieron 35mm anteayer.',
    minWrites: 1, minFields: 1, minPlots: 3,
  },

  // ───────── Partial / missing data (user evades fields) ───────────────
  {
    name: '11_field_no_city',
    desc: 'Field without city — bot should ask',
    message: 'Agregá el campo La Joya con lote único A 100 ha. Sembré soja.',
    minWrites: 0, minFields: 1, minPlots: 1,
  },
  {
    name: '12_field_no_plot_hectares',
    desc: 'Field + plots without hectares',
    message: 'Tengo el campo La Costa en Pergamino con lotes Este y Oeste. Sembré soja en Este.',
    minWrites: 0, minFields: 1, minPlots: 2,
  },
  {
    name: '13_field_no_plot_no_activity',
    desc: 'Just field — minimal info',
    message: 'Quiero dar de alta el campo Mi Tierra en Pergamino.',
    minWrites: 0, minFields: 1,
  },
  {
    name: '14_activity_no_field',
    desc: 'Activity mentioned without field — should block or ask',
    message: 'Fumigué 200 hectáreas con glifosato y gasté 150 mil en el producto.',
    minWrites: 0,
    expectAny: ['agreg', 'lote', 'campo'], // some kind of redirect to field creation
  },
  {
    name: '15_livestock_no_field',
    desc: 'Livestock without field — should ask',
    message: 'Agregá 100 vacas Angus.',
    minWrites: 0,
    expectAny: ['campo', 'lote', 'agreg'],
  },

  // ───────── Variations and edge cases ─────────────────────────────────
  {
    name: '16_field_short_plot_names',
    desc: 'Short alphanumeric plot names',
    message: 'Doy de alta campo San Juan en Junín. Lotes A1 50 ha, A2 80 ha, B1 100 ha. Sembré maíz en A1.',
    minWrites: 1, minFields: 1, minPlots: 3,
  },
  {
    name: '17_field_creative_names',
    desc: 'Creative plot names',
    message: 'Cargá el campo La Estancia en Bolívar con lotes Cañadón 150 ha, El Alto 90 ha, El Bajo 200 ha. Sembré soja en Cañadón.',
    minWrites: 1, minFields: 1, minPlots: 3,
  },
  {
    name: '18_field_with_dates',
    desc: 'Field + plots + activity with explicit date',
    message: 'Tengo el campo El Quebrachal en Pergamino, lote A 80 ha. El 5 de octubre sembré maíz, hoy fumigué con glifosato 3 lt/ha.',
    minWrites: 2, minFields: 1, minPlots: 1,
  },
  {
    name: '19_field_multiple_fields',
    desc: 'TWO fields in one message',
    message: 'Tengo dos campos: La Esperanza en Pergamino con lote Norte 100 ha, y San Martín en Junín con lote A 150 ha. Sembré soja en ambos.',
    minWrites: 1, minFields: 2, minPlots: 2,
  },
  {
    name: '20_field_with_livestock_full',
    desc: 'Field + plot + livestock with breed + age',
    message: 'Cargá el campo La Pampa en Bolívar, lote único Principal 250 ha. Tengo 50 vacas Angus y 30 terneras Hereford en el lote Principal.',
    minWrites: 0, minFields: 1, minPlots: 1,
  },
  {
    name: '21_informal_compact',
    desc: 'Informal compact message',
    message: 'campo norte pergamino, lote a 100ha, sembre soja',
    minWrites: 1, minFields: 1, minPlots: 1,
  },
  {
    name: '22_full_initial_loadout',
    desc: 'Complete farmer initial loadout',
    message: 'Arranco con el campo Los Cardos en Pergamino. Tres lotes: A 100 ha con soja, B 80 ha con maíz, C 50 ha con trigo. Galpón Principal con 200 bolsas de soja y 80 lt de glifosato. Y agregué 80 vacas en A.',
    minWrites: 3, minFields: 1, minPlots: 3,
  },
  {
    name: '23_field_with_alerts',
    desc: 'Field + monitoring alerts',
    message: 'Campo La Ribera en Junín, lote A 120 ha con soja sembrada. Monitoreé A1 con V3 y vi presencia leve de chinches.',
    minWrites: 1, minFields: 1, minPlots: 1,
  },
  {
    name: '24_field_harvest_sale_initial',
    desc: 'Harvest + sale right after field/plot creation',
    message: 'Doy de alta campo San José en Pergamino, lote A 150 ha. Acabamos de cosechar maíz con 8500 kg/ha en A y vendí 80 tn a 220 USD por tonelada.',
    minWrites: 1, minFields: 1, minPlots: 1,
  },
  {
    name: '25_field_plots_super_long',
    desc: 'Long message with 5+ actions',
    message: 'Tengo el campo La Quinta en Bolívar, con cinco lotes: A 100 ha, B 150 ha, C 80 ha, D 200 ha, E 120 ha. Sembré soja en A y B, maíz en C, trigo en D. Llovieron 25mm anteayer. Vendí 30 tn de soja vieja a 450 USD por tonelada y gasté 200 mil en la semilla.',
    minWrites: 4, minFields: 1, minPlots: 5,
  },
];

interface Result {
  test: TestSpec;
  status: 'PASS' | 'FAIL' | 'WARN';
  reason: string;
  response: string;
  wrote: number;
  fields: number;
  plots: number;
}

async function runTest(t: TestSpec, userId: number): Promise<Result> {
  // Hard reset to zero state — this is the onboarding scenario.
  await apiReset();

  const countSql = `SELECT
    (SELECT COUNT(*)::int FROM fields WHERE user_id=$1 AND deleted_at IS NULL) as f,
    (SELECT COUNT(*)::int FROM plots p JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND p.deleted_at IS NULL) as p,
    (SELECT COUNT(*)::int FROM expenses WHERE user_id=$1 AND deleted_at IS NULL) as e,
    (SELECT COUNT(*)::int FROM incomes WHERE user_id=$1 AND deleted_at IS NULL) as i,
    (SELECT COUNT(*)::int FROM domain_events WHERE user_id=$1) as d,
    (SELECT COUNT(*)::int FROM agro_observations WHERE user_id=$1) as o,
    (SELECT COUNT(*)::int FROM crop_scoutings WHERE user_id=$1) as sc,
    (SELECT COUNT(*)::int FROM livestock_movements WHERE user_id=$1) as lm,
    (SELECT COUNT(*)::int FROM stock_movements WHERE user_id=$1) as sm,
    (SELECT COUNT(*)::int FROM rainfall WHERE user_id=$1) as r`;
  const before = (await apiQueryDb(countSql, [userId]))[0] ?? {};

  const res = await sendAndLog(t.message);

  const after = (await apiQueryDb(countSql, [userId]))[0] ?? {};
  const sumRow = (row: Record<string, unknown>, exclude = ['f', 'p']): number =>
    Object.entries(row).filter(([k]) => !exclude.includes(k)).reduce<number>((a, [, v]) => a + (Number(v) || 0), 0);
  const wrote = sumRow(after as Record<string, unknown>) - sumRow(before as Record<string, unknown>);
  const fields = Number((after as any).f || 0);
  const plots = Number((after as any).p || 0);

  const resLower = res.toLowerCase();
  const missing = (t.expectAny ?? []).filter(s => !resLower.includes(s.toLowerCase()));
  const unwanted = (t.expectNot ?? []).filter(s => res.includes(s));
  const hasAsk = /\?/.test(res) && /cu[aá]l|cu[aá]nto|qu[eé] |c[oó]mo|en qu[eé]|d[oó]nde/i.test(res);

  let status: 'PASS' | 'FAIL' | 'WARN';
  let reason: string;

  const wantedFields = t.minFields ?? 0;
  const wantedPlots = t.minPlots ?? 0;
  const wantedWrites = t.minWrites;

  if (unwanted.length > 0) {
    status = 'FAIL';
    reason = `Forbidden substring(s): [${unwanted.join(', ')}]`;
  } else if (fields >= wantedFields && plots >= wantedPlots && wrote >= wantedWrites) {
    status = missing.length === 0 ? 'PASS' : 'WARN';
    reason = `fields=${fields}, plots=${plots}, wrote=${wrote}${missing.length > 0 ? `, missing=[${missing.join(',')}]` : ''}`;
  } else if (hasAsk && missing.length === 0) {
    // Bot asked for missing data — acceptable for onboarding with partial info
    status = 'PASS';
    reason = `fields=${fields}, plots=${plots}, wrote=${wrote}, bot asked for missing info (acceptable onboarding UX)`;
  } else {
    status = 'FAIL';
    reason = `fields=${fields}/${wantedFields}, plots=${plots}/${wantedPlots}, wrote=${wrote}/${wantedWrites}` +
      (missing.length > 0 ? `, missing=[${missing.join(',')}]` : '');
  }

  // Try to clear any pending state between tests (best-effort).
  try { await sendAndLog('cancelar'); } catch { /* ignore */ }

  return { test: t, status, reason, response: res, wrote, fields, plots };
}

async function main(): Promise<void> {
  console.log('🧪 QA Onboarding — 25 First-Impression Cases');
  console.log('============================================\n');

  const auth = await apiRegister();
  TOKEN = auth.token;
  const userId = auth.userId;
  console.log(`✅ Authenticated as user ${userId}`);

  // Plan upgrade so the daily AI limit doesn't kill the suite (25 tests + setup ≈ 50+ AI calls).
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [userId]);
  console.log('✅ User upgraded to enterprise plan\n');

  const results: Result[] = [];
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`${num}/${TESTS.length} ${t.name}${t.desc ? ` — ${t.desc}` : ''}\n`);
    process.stdout.write('   ');
    try {
      const r = await runTest(t, userId);
      results.push(r);
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`${icon} ${r.status} — ${r.reason}`);
    } catch (err: any) {
      console.log(`💥 ERROR: ${err.message}`);
      results.push({ test: t, status: 'FAIL', reason: `runtime: ${err.message}`, response: '', wrote: 0, fields: 0, plots: 0 });
    }
  }

  // Summary
  console.log('\n════════════════════════════════════════════');
  console.log('                 SUMMARY');
  console.log('════════════════════════════════════════════\n');
  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`  ✅ PASS: ${pass}`);
  console.log(`  ⚠️  WARN: ${warn}`);
  console.log(`  ❌ FAIL: ${fail}`);
  console.log(`  📊 Total: ${results.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / results.length) * 100)}%\n`);

  const avgFields = (results.reduce((a, r) => a + r.fields, 0) / results.length).toFixed(1);
  const avgPlots = (results.reduce((a, r) => a + r.plots, 0) / results.length).toFixed(1);
  const avgWrites = (results.reduce((a, r) => a + r.wrote, 0) / results.length).toFixed(1);
  console.log(`  Avg fields created: ${avgFields}`);
  console.log(`  Avg plots created: ${avgPlots}`);
  console.log(`  Avg writes per test: ${avgWrites}\n`);

  if (fail > 0) {
    console.log('─── FAILURES ───\n');
    for (const r of results.filter(x => x.status === 'FAIL')) {
      console.log(`  ❌ ${r.test.name}`);
      console.log(`     ${r.reason}`);
      console.log(`     Msg: ${r.test.message.substring(0, 100)}...`);
      console.log(`     Resp: ${r.response.substring(0, 200).replace(/\n/g, ' ')}\n`);
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
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-onboarding-results.json',
    JSON.stringify(results.map(r => ({
      name: r.test.name, desc: r.test.desc, message: r.test.message,
      status: r.status, fields: r.fields, plots: r.plots, wrote: r.wrote, reason: r.reason,
      response: r.response,
    })), null, 2),
  );
  console.log(`📄 Full report: src/testing/qa-onboarding-results.json\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
