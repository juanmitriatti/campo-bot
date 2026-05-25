/**
 * QA Fresh Scenarios — 30 NEW multi-turn scenarios across 5 groups.
 *
 * Distinct from qa-broad-coverage-30, qa-serial-conversations-20, qa-onboarding-25,
 * qa-bulk-extended-20, qa-compound-mixed-25, qa-repeated-combos-20.
 *
 * Verifies today's hotfixes (commit e4eebc3):
 *   - T06: livestock breed-disambig auto-picks LARGEST group in bulkMode
 *   - T11: warehouse name tolerance (galpón/Galpón/no-prefix all resolve)
 *   - T21: trigo income category falls back to "Trigo" (not "Otros")
 *
 * Groups:
 *   F — Conversational / informal (5)
 *   G — Hacienda edge cases (5)
 *   H — Stock + financial integration (5)
 *   I — Cosecha + financial chains (5)
 *   J — Edge cases / regression (10)
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-fresh-scenarios-30.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-fresh@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Fresco';

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

// ── Setup (ONCE) ────────────────────────────────────────────────────────

async function setupState(): Promise<void> {
  console.log('🔧 Setting up shared state...');
  await sendAndLog('agregar campo El Rincón');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Salto');
  await apiTap('flow_confirm');

  for (const [name, ha] of [['Loma', 180], ['Bajo', 110], ['Frente', 70], ['Atrás', 95]] as const) {
    await sendAndLog(`agregar lote ${name} al campo El Rincón`);
    await sendAndLog(String(ha));
  }

  await sendAndLog('sembré sorgo en Loma');
  await sendAndLog('sembré cebada en Bajo');
  await sendAndLog('sembré soja en Frente');
  await sendAndLog('sembré maíz en Atrás');

  // Mixed breeds at Loma — critical for breed-disambig test G06
  await sendAndLog('agregué 90 vacas Hereford en Loma');
  await sendAndLog('agregué 70 vacas Brangus en Loma');
  await sendAndLog('agregué 40 novillos en Bajo');
  await sendAndLog('agregué 50 terneros en Frente');

  await sendAndLog('crear galpón Norte en El Rincón');
  await sendAndLog('agregar 250 bolsas semilla maíz al galpón Norte');
  await sendAndLog('agregar 180 lt 2,4D al galpón Norte');
  await sendAndLog('agregar 150 bolsas DAP al galpón Norte');

  console.log('✅ Setup done\n');
}

// ── Counters ────────────────────────────────────────────────────────────

interface CountRow {
  e: number; i: number; d: number; o: number; s: number;
  lm: number; sm: number; r: number; f: number; p: number;
  he: number;
}

const COUNT_SQL = `SELECT
  (SELECT COUNT(*)::int FROM expenses WHERE user_id=$1 AND deleted_at IS NULL) as e,
  (SELECT COUNT(*)::int FROM incomes WHERE user_id=$1 AND deleted_at IS NULL) as i,
  (SELECT COUNT(*)::int FROM domain_events WHERE user_id=$1 AND deleted_at IS NULL) as d,
  (SELECT COUNT(*)::int FROM agro_observations WHERE user_id=$1) as o,
  (SELECT COUNT(*)::int FROM crop_scoutings WHERE user_id=$1 AND deleted_at IS NULL) as s,
  (SELECT COUNT(*)::int FROM livestock_movements WHERE user_id=$1) as lm,
  (SELECT COUNT(*)::int FROM stock_movements WHERE user_id=$1) as sm,
  (SELECT COUNT(*)::int FROM rainfall WHERE user_id=$1) as r,
  (SELECT COUNT(*)::int FROM fields WHERE user_id=$1 AND deleted_at IS NULL) as f,
  (SELECT COUNT(*)::int FROM plots p JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND p.deleted_at IS NULL) as p,
  (SELECT COUNT(*)::int FROM domain_events WHERE user_id=$1 AND deleted_at IS NULL AND event_type IN ('health_event','repro_event','weighing')) as he`;

async function countAll(userId: number): Promise<CountRow> {
  const rows = await apiQueryDb(COUNT_SQL, [userId]);
  return rows[0] as CountRow;
}
function diffCounts(before: CountRow, after: CountRow): Record<keyof CountRow, number> {
  const out: any = {};
  for (const k of Object.keys(after) as Array<keyof CountRow>) {
    out[k] = Number(after[k]) - Number(before[k]);
  }
  return out;
}

// ── Test spec ───────────────────────────────────────────────────────────

type Group = 'F_conv' | 'G_hacienda' | 'H_stock_fin' | 'I_cosecha' | 'J_edge';

interface ExpectCtx { userId: number; diff: Record<keyof CountRow, number>; turns: string[] }
type ExpectFn = (ctx: ExpectCtx) => Promise<{ pass: boolean; reason: string; warn?: boolean }>;

interface TestSpec {
  name: string;
  desc: string;
  group: Group;
  compound: string;
  answers?: string[];
  expect: ExpectFn;
}

function botIsAsking(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasQ = text.includes('?') || text.includes('¿');
  const hasAskWord = /(cu[aá]nto|cu[aá]l|qu[eé] |c[oó]mo|en qu[eé]|d[oó]nde|falta|me falta|necesit|elig|aclar)/i.test(lower);
  const hasQueueMark = /👇|pendiente/i.test(text);
  return (hasQ && hasAskWord) || hasQueueMark;
}

// ── Tests ────────────────────────────────────────────────────────────────

const TESTS: TestSpec[] = [
  // ───────── F — CONVERSATIONAL / INFORMAL (5) ─────────
  {
    name: 'F01_voice_input_style',
    desc: 'che, gasté como 80 lucas en gasoil y vendí soja a 480 USD, 12 tn',
    group: 'F_conv',
    compound: 'che, hoy gasté como 80 lucas en gasoil y vendí soja a buen precio, como 480 dolar la tonelada, fueron 12 toneladas',
    expect: async ({ diff }) => ({
      pass: diff.e >= 1 && diff.i >= 1,
      reason: `e=${diff.e} i=${diff.i} (want e>=1, i>=1)`,
    }),
  },
  {
    name: 'F02_abbreviations',
    desc: 'fum/fert/siembra con abreviaturas',
    group: 'F_conv',
    compound: 'fum Loma glifo 3lt/ha, fert Bajo urea 100kg/ha, sembré sorgo en Frente',
    expect: async ({ diff }) => ({
      pass: diff.d >= 2,
      reason: `d=${diff.d} (want>=2; ideal=3)`,
      warn: diff.d < 3,
    }),
  },
  {
    name: 'F03_time_relative_chain',
    desc: 'anteayer/ayer/hoy with 3 actions',
    group: 'F_conv',
    compound: 'anteayer vendí 18 tn trigo a 180 USD, ayer compré 50 bolsas urea a 9mil, hoy sembré avena en Atrás',
    expect: async ({ diff }) => {
      const sum = diff.i + diff.e + diff.d;
      return {
        pass: diff.i >= 1 && diff.e >= 1 && diff.d >= 1 && sum >= 3,
        reason: `i=${diff.i} e=${diff.e} d=${diff.d} (sum=${sum}, want all>=1)`,
      };
    },
  },
  {
    name: 'F04_currency_mix',
    desc: 'venta USD + compra ARS, no conflation',
    group: 'F_conv',
    compound: 'vendí 25 tn soja a 480 USD y compré 80 bolsas urea a 8500 pesos',
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price, currency FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const soja = incomes.find((r: any) => /soja/i.test(String(r.category)) && Number(r.quantity) === 25);
      const expenses = await apiQueryDb(
        `SELECT product, unit_price, quantity, currency FROM expenses
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const urea = expenses.find((r: any) => /urea/i.test(String(r.product ?? '')) && Number(r.quantity) === 80);
      const sojaCcy = String(soja?.currency ?? '').toUpperCase();
      const ureaCcy = String(urea?.currency ?? '').toUpperCase();
      const sojaPrice = Number(soja?.unit_price ?? 0);
      const ureaPrice = Number(urea?.unit_price ?? 0);
      return {
        pass: diff.i >= 1 && diff.e >= 1
          && !!soja && sojaCcy === 'USD' && sojaPrice === 480
          && !!urea && ureaCcy === 'ARS' && ureaPrice === 8500,
        reason: `i=${diff.i} e=${diff.e}; soja={ccy:${sojaCcy},price:${sojaPrice}} urea={ccy:${ureaCcy},price:${ureaPrice}}`,
      };
    },
  },
  {
    name: 'F05_numbers_as_words',
    desc: 'veinte toneladas a quinientos dólares',
    group: 'F_conv',
    compound: 'vendí veinte toneladas de soja a quinientos dólares la tonelada y compré cien litros de glifosato a mil pesos',
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const soja = incomes.find((r: any) => /soja/i.test(String(r.category)));
      return {
        pass: diff.i >= 1 && diff.e >= 1,
        reason: `i=${diff.i} e=${diff.e}; soja=${JSON.stringify(soja)}`,
        warn: !soja || Number(soja.quantity) !== 20 || Number(soja.unit_price) !== 500,
      };
    },
  },

  // ───────── G — HACIENDA EDGE CASES (5) ─────────
  {
    name: 'G06_breed_autopick_largest',
    desc: 'REGRESSION (e4eebc3): vendí 5 vacas en Loma → auto-pick Hereford (largest)',
    group: 'G_hacienda',
    compound: 'vendí 5 vacas a 1500 USD cada una en Loma',
    expect: async ({ userId, diff }) => {
      // Look at the most recent remove movement and its source group's breed
      const movs = await apiQueryDb(
        `SELECT lm.count, lm.movement_type, lg.breed
         FROM livestock_movements lm
         LEFT JOIN livestock_groups lg ON lg.id = lm.source_group_id
         WHERE lm.user_id=$1 AND lm.created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY lm.created_at DESC LIMIT 3`, [userId]);
      const rem = movs.find((r: any) =>
        Number(r.count) === 5 && /remove|salida/i.test(String(r.movement_type)));
      const breed = String(rem?.breed ?? '');
      // FIX VERIFICATION: source breed should be Hereford (largest = 90 head) NOT Brangus (70)
      return {
        pass: diff.lm >= 1 && !!rem && /hereford/i.test(breed),
        reason: `lm=${diff.lm}; remove5 found=${!!rem} breed='${breed}' (want Hereford = largest group)`,
      };
    },
  },
  {
    name: 'G07_mixed_health_chain',
    desc: 'vacuna aftosa + vacuna brucelosis + desparasitación doramectina',
    group: 'G_hacienda',
    compound: 'vacuné 60 vacas Hereford contra aftosa en Loma, vacuné 50 novillos contra brucelosis en Bajo, desparasité 40 terneros con doramectina en Frente',
    expect: async ({ userId, diff }) => {
      const events = await apiQueryDb(
        `SELECT product, notes FROM domain_events
         WHERE user_id=$1 AND event_type='health_event' AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 5`, [userId]);
      const aftosa = events.find((r: any) => /aftosa/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      const bruce = events.find((r: any) => /brucelosis/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      const dora = events.find((r: any) => /doramectina/i.test(String(r.product ?? '') + ' ' + String(r.notes ?? '')));
      const missing: string[] = [];
      if (!aftosa) missing.push('aftosa');
      if (!bruce) missing.push('brucelosis');
      if (!dora) missing.push('doramectina');
      return {
        pass: diff.he >= 3 && missing.length === 0,
        reason: `he=${diff.he}; ${missing.length ? 'MISSING:' + missing.join(',') : '3/3 found'}`,
      };
    },
  },
  {
    name: 'G08_birth_sale_transfer',
    desc: 'nacieron + venta + transfer',
    group: 'G_hacienda',
    compound: 'nacieron 12 terneros de las vacas Hereford en Loma, vendí 8 novillos a 1700 USD c/u en Bajo, transferí 20 terneros de Frente a Bajo',
    expect: async ({ userId, diff }) => {
      const movs = await apiQueryDb(
        `SELECT count, movement_type FROM livestock_movements
         WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 10`, [userId]);
      const nac = movs.find((r: any) => Number(r.count) === 12);
      const rem = movs.find((r: any) => Number(r.count) === 8 && /remove|salida/i.test(String(r.movement_type)));
      const tr  = movs.find((r: any) => Number(r.count) === 20 && /transfer/i.test(String(r.movement_type)));
      const missing: string[] = [];
      if (!nac) missing.push('nacimiento-12');
      if (!rem) missing.push('venta-8');
      if (!tr)  missing.push('transfer-20');
      return {
        pass: diff.lm >= 3 && missing.length === 0,
        reason: `lm=${diff.lm}; ${missing.length ? 'MISSING:' + missing.join(',') : '3/3 movs'}`,
        warn: !!tr === false, // transfer is the trickiest
      };
    },
  },
  {
    name: 'G09_all_livestock_partials',
    desc: 'add vaquillonas+vacuné las vacas+vendí novillos+pesé terneros (no plot for some)',
    group: 'G_hacienda',
    compound: 'agregué 30 vaquillonas, vacuné las vacas, vendí 10 novillos, pesé 50 terneros 230 kg',
    answers: ['en Bajo', 'aftosa', 'en Bajo a 1700 USD', 'en Frente'],
    expect: async ({ diff }) => {
      const sum = diff.lm + diff.he;
      return {
        pass: sum >= 3,
        reason: `lm=${diff.lm} he=${diff.he} (sum=${sum}, want>=3 from queue resolution)`,
        warn: sum < 4,
      };
    },
  },
  {
    name: 'G10_repro_chain_sire',
    desc: 'toro Toro Negro Angus + IATF + detección celo',
    group: 'G_hacienda',
    compound: 'eché el toro Toro Negro Angus en Loma, inseminé 25 vacas con IATF en Loma, detecté 18 vacas en celo en Loma',
    expect: async ({ userId, diff }) => {
      const events = await apiQueryDb(
        `SELECT event_type, product, notes FROM domain_events
         WHERE user_id=$1 AND event_type='repro_event' AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 5`, [userId]);
      return {
        pass: diff.he >= 3,
        reason: `he=${diff.he} repro_events=${events.length} (want>=3)`,
        warn: diff.he < 3 && events.length >= 2,
      };
    },
  },

  // ───────── H — STOCK + FINANCIAL INTEGRATION (5) ─────────
  {
    name: 'H11_warehouse_name_variants',
    desc: 'REGRESSION (e4eebc3): galpón norte / Norte / Galpón Norte all resolve',
    group: 'H_stock_fin',
    compound: 'agregué 100 bolsas urea al galpón norte, saqué 30 lt 2,4D del Norte, agregué 50 lt cipermetrina al Galpón Norte',
    expect: async ({ userId, diff }) => {
      // FIX VERIFICATION: all 3 movements should target the SAME warehouse "Norte"
      const movs = await apiQueryDb(
        `SELECT sm.qty, sm.movement_type, w.name as wh_name, si.name as item_name
         FROM stock_movements sm
         JOIN stock_items si ON si.id = sm.stock_item_id
         JOIN warehouses w ON w.id = si.warehouse_id
         WHERE sm.user_id=$1 AND sm.created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY sm.created_at DESC LIMIT 10`, [userId]);
      const distinctWh = new Set(movs.map((r: any) => String(r.wh_name).toLowerCase()));
      const urea100 = movs.find((r: any) => /urea/i.test(String(r.item_name)) && Number(r.qty) === 100);
      const tdsalida = movs.find((r: any) => /2,?4.?d/i.test(String(r.item_name)) && /salida|out/i.test(String(r.movement_type)));
      const cip50 = movs.find((r: any) => /cipermetr/i.test(String(r.item_name)) && Number(r.qty) === 50);
      const missing: string[] = [];
      if (!urea100) missing.push('urea+100');
      if (!tdsalida) missing.push('2,4D salida');
      if (!cip50) missing.push('cipermetrina+50');
      return {
        pass: diff.sm >= 3 && distinctWh.size === 1 && missing.length === 0,
        reason: `sm=${diff.sm} distinctWh=${[...distinctWh].join('|')} (want size=1); ${missing.length ? 'MISSING:' + missing.join(',') : 'all 3 mov ok'}`,
      };
    },
  },
  {
    name: 'H12_grain_sale_with_stock',
    desc: 'venta de soja 80 tn (no stock soja loaded yet; expect income only)',
    group: 'H_stock_fin',
    compound: 'vendí 80 tn de soja a 480 USD por tonelada',
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const soja = incomes.find((r: any) => /soja/i.test(String(r.category)) && Number(r.quantity) === 80);
      return {
        pass: diff.i >= 1 && !!soja && Number(soja.unit_price) === 480,
        reason: `i=${diff.i} soja=${JSON.stringify(soja)}`,
      };
    },
  },
  {
    name: 'H13_multi_product_stock_add_with_price',
    desc: '3 stock adds, each with unit_price → 3 stock + 3 linked expenses',
    group: 'H_stock_fin',
    compound: 'agregué 200 lt fipronil al galpón Norte a 1500 c/u, agregué 100 bolsas atrazina a 4500 c/u, agregué 50 bolsas roundup max a 18mil c/u',
    expect: async ({ diff }) => {
      const sum = diff.sm + diff.e;
      return {
        pass: diff.sm >= 2 && diff.e >= 2,
        reason: `sm=${diff.sm} e=${diff.e} (want sm>=3 + e>=3 ideal; min 2 each)`,
        warn: sum < 6,
      };
    },
  },
  {
    name: 'H14_stock_out_activities_chain',
    desc: 'saqué 40 lt 2,4D + fumi Loma 2 lt/ha + saqué 60 DAP + fert Bajo 150 kg/ha',
    group: 'H_stock_fin',
    compound: 'saqué 40 lt 2,4D del galpón Norte, fumigué Loma con eso 2 lt/ha, saqué 60 bolsas DAP del galpón Norte, fertilicé Bajo con DAP 150 kg/ha',
    expect: async ({ diff }) => ({
      pass: diff.sm >= 2 && diff.d >= 2,
      reason: `sm=${diff.sm} (want>=2) d=${diff.d} (want>=2)`,
    }),
  },
  {
    name: 'H15_stock_query_plus_add',
    desc: 'query stock + add stock (mixed action)',
    group: 'H_stock_fin',
    compound: 'qué hay en el galpón Norte y agregar 80 bolsas urea a 8500 c/u',
    expect: async ({ diff }) => ({
      pass: diff.sm >= 1,
      reason: `sm=${diff.sm} (want>=1; ideal 1 add + N reads)`,
      warn: diff.sm < 1,
    }),
  },

  // ───────── I — COSECHA + FINANCIAL CHAINS (5) ─────────
  {
    name: 'I16_cosecha_inmediata',
    desc: 'coseché sorgo en Loma 5800 kg/ha + vendí 100 tn a 150 USD/tn',
    group: 'I_cosecha',
    compound: 'coseché sorgo en Loma 5800 kg/ha, vendí 100 tn a 150 USD por tonelada',
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const venta = incomes.find((r: any) => Number(r.quantity) === 100 && Number(r.unit_price) === 150);
      return {
        pass: diff.d >= 1 && diff.i >= 1 && !!venta,
        reason: `d=${diff.d} i=${diff.i} venta100x150=${!!venta}; incomes=${JSON.stringify(incomes.slice(0,2))}`,
      };
    },
  },
  {
    name: 'I17_cosecha_3_loads',
    desc: 'cosecha soja Frente + 3 destinos (Juan/Pedro/Roberto)',
    group: 'I_cosecha',
    compound: 'coseché soja en Frente, Juan llevó 25 tn al acopio, Pedro 30 tn al silo, Roberto 18 tn a la cooperativa',
    expect: async ({ userId, diff }) => {
      const loads = await apiQueryDb(
        `SELECT driver_name, weight_kg FROM harvest_loads
         WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY created_at DESC LIMIT 10`, [userId]);
      const juan = loads.find((r: any) => /juan/i.test(String(r.driver_name)));
      const pedro = loads.find((r: any) => /pedro/i.test(String(r.driver_name)));
      const rob = loads.find((r: any) => /roberto/i.test(String(r.driver_name)));
      const missing: string[] = [];
      if (!juan) missing.push('juan');
      if (!pedro) missing.push('pedro');
      if (!rob) missing.push('roberto');
      return {
        pass: diff.d >= 1 && loads.length >= 3 && missing.length === 0,
        reason: `d=${diff.d} loads=${loads.length}; ${missing.length ? 'MISSING:' + missing.join(',') : '3/3 drivers'}`,
      };
    },
  },
  {
    name: 'I18_cosecha_partial_venta_partial',
    desc: 'cosecha sin yield + venta sin price → 2 partials serial',
    group: 'I_cosecha',
    compound: 'coseché cebada en Bajo y vendí 40 tn de cebada',
    answers: ['3500 kg/ha', '165 USD por tonelada'],
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const cebada = incomes.find((r: any) => /cebada/i.test(String(r.category)) && Number(r.quantity) === 40);
      const sum = diff.d + diff.i;
      return {
        pass: sum >= 2 && !!cebada,
        reason: `d=${diff.d} i=${diff.i}; cebada=${JSON.stringify(cebada)}`,
        warn: cebada && Number(cebada.unit_price) !== 165,
      };
    },
  },
  {
    name: 'I19_cosecha_venta_stock_gasto',
    desc: 'cosecha maíz + venta + add stock + gasto (4 records)',
    group: 'I_cosecha',
    compound: 'coseché maíz en Atrás 8200 kg/ha, vendí 50 tn a 200 USD por tonelada, agregué 200 bolsas maíz al galpón Norte, gasté 90 mil en cosechadora',
    expect: async ({ diff }) => {
      const sum = diff.d + diff.i + diff.sm + diff.e;
      return {
        pass: diff.d >= 1 && diff.i >= 1 && diff.sm >= 1 && diff.e >= 1 && sum >= 4,
        reason: `d=${diff.d} i=${diff.i} sm=${diff.sm} e=${diff.e} (sum=${sum}, want all>=1)`,
      };
    },
  },
  {
    name: 'I20_cosecha_crop_mismatch',
    desc: 'coseché trigo en Loma (Loma=sorgo) → expect warning, no crash',
    group: 'I_cosecha',
    compound: 'coseché trigo en Loma 3200 kg/ha',
    expect: async ({ turns }) => {
      const text = (turns || []).join('\n').toLowerCase();
      // Accept either: bot recorded it (sorgo) or warned about mismatch
      const warned = /trigo/i.test(text) && (/no.*sembr|sembr.*sorgo|no coincide|cultivo.*activo|mismatch|no es el cultivo|sorgo/i.test(text));
      const responded = text.length > 0;
      return {
        pass: responded,
        reason: `bot responded; warned-about-mismatch=${warned}`,
        warn: !warned,
      };
    },
  },

  // ───────── J — EDGE CASES / REGRESSION (10) ─────────
  {
    name: 'J21_trigo_income_category',
    desc: 'REGRESSION (e4eebc3): vendí 30 tn trigo → category="Trigo" NOT "Otros"',
    group: 'J_edge',
    compound: 'vendí 30 tn de trigo a 180 USD por tonelada',
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price, currency, description FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const trigo = incomes.find((r: any) => Number(r.quantity) === 30 && Number(r.unit_price) === 180);
      const cat = String(trigo?.category ?? '');
      // FIX VERIFICATION: category should literally be "Trigo", not "Otros"
      return {
        pass: diff.i >= 1 && !!trigo && /^trigo$/i.test(cat),
        reason: `i=${diff.i} trigo found=${!!trigo} category='${cat}' (want 'Trigo', NOT 'Otros')`,
      };
    },
  },
  {
    name: 'J22_ambiguous_no_save',
    desc: '"hice algunas cosas en el campo" → no save expected',
    group: 'J_edge',
    compound: 'hice algunas cosas en el campo hoy',
    expect: async ({ diff, turns }) => {
      const sum = diff.e + diff.i + diff.d + diff.lm + diff.s + diff.o + diff.sm + diff.r;
      const text = (turns || []).join(' ').toLowerCase();
      const asked = /qu[eé]|cu[aá]l|cont[aá]me|especif|decime|m[aá]s detalle/i.test(text);
      return {
        pass: sum === 0,
        reason: `sum=${sum} (want 0); bot asked for detail=${asked}`,
        warn: !asked,
      };
    },
  },
  {
    name: 'J23_long_natural_lang',
    desc: 'narrative paragraph: 4 actions',
    group: 'J_edge',
    compound: 'estuvimos a full hoy, fumigamos el lote Loma temprano con un herbicida que se llama glifosato, le tiramos 3 lt por hectárea, después fertilizamos Bajo con DAP a razón de 120 kg por hectárea, gastamos como 150 mil pesos en gasoil y agregamos 25 terneros Angus al lote Atrás',
    expect: async ({ diff }) => {
      const sum = diff.d + diff.e + diff.lm;
      return {
        pass: diff.d >= 2 && diff.e >= 1 && diff.lm >= 1 && sum >= 4,
        reason: `d=${diff.d} e=${diff.e} lm=${diff.lm} (sum=${sum}, want d>=2,e>=1,lm>=1)`,
      };
    },
  },
  {
    name: 'J24_quoted_strings',
    desc: 'comillas alrededor de descriptores no rompen parsing',
    group: 'J_edge',
    compound: 'vendí "soja de la nueva cosecha" 30 tn a 480 USD y compré "urea granulada" 80 bolsas a 9mil',
    expect: async ({ userId, diff }) => {
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const soja = incomes.find((r: any) => /soja/i.test(String(r.category)) && Number(r.quantity) === 30);
      return {
        pass: diff.i >= 1 && diff.e >= 1 && !!soja,
        reason: `i=${diff.i} e=${diff.e}; soja30x480=${!!soja}`,
      };
    },
  },
  {
    name: 'J25_dedup_identical',
    desc: 'compré 30 bolsas urea x 8mil REPETIDO 2 veces → dedup check',
    group: 'J_edge',
    compound: 'compré 30 bolsas urea a 8mil, compré 30 bolsas urea a 8mil',
    expect: async ({ userId, diff }) => {
      const expenses = await apiQueryDb(
        `SELECT id, product, quantity, unit_price FROM expenses
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
           AND quantity = 30 AND unit_price = 8000
         ORDER BY id DESC LIMIT 5`, [userId]);
      // Acceptable: 1 expense (dedup) OR 2 expenses (no dedup, but no extra duplicates)
      const ok = expenses.length >= 1 && expenses.length <= 2;
      return {
        pass: ok,
        reason: `expenses_with_30x8000=${expenses.length} diff.e=${diff.e} (acceptable: 1 or 2)`,
        warn: expenses.length === 2, // ideal is dedup → 1
      };
    },
  },
  {
    name: 'J26_4_partials_cross_domain',
    desc: '4 partials cross-domain, serial answers',
    group: 'J_edge',
    compound: 'fumigué con glifosato, vendí cebada, vacuné, gasté en gasoil',
    answers: [
      'Bajo 2 lt/ha',
      '15 tn a 160 USD',
      '40 vacas Hereford contra aftosa en Loma',
      '70 mil',
    ],
    expect: async ({ diff }) => {
      const sum = diff.d + diff.i + diff.he + diff.e;
      return {
        pass: sum >= 3,
        reason: `d=${diff.d} i=${diff.i} he=${diff.he} e=${diff.e} (sum=${sum}, want>=3)`,
        warn: sum < 4,
      };
    },
  },
  {
    name: 'J27_cosecha_multi_truck_sale',
    desc: 'cosecha + 1 truck + venta',
    group: 'J_edge',
    compound: 'coseché soja en Frente 4200 kg/ha, Mario trajo 35 tn al silo, vendí 25 tn a 480 USD por tonelada',
    expect: async ({ userId, diff }) => {
      const loads = await apiQueryDb(
        `SELECT driver_name, weight_kg FROM harvest_loads
         WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds'
           AND driver_name ILIKE '%mario%'
         ORDER BY created_at DESC LIMIT 3`, [userId]);
      const incomes = await apiQueryDb(
        `SELECT category, quantity, unit_price FROM incomes
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 3`, [userId]);
      const venta = incomes.find((r: any) => Number(r.quantity) === 25 && Number(r.unit_price) === 480);
      return {
        pass: diff.d >= 1 && loads.length >= 1 && !!venta,
        reason: `d=${diff.d} loads_mario=${loads.length} venta25x480=${!!venta}`,
      };
    },
  },
  {
    name: 'J28_hacienda_multi_step_purchase',
    desc: 'compré 20 vacas Aberdeen Angus + vacuné + pesé',
    group: 'J_edge',
    compound: 'compré 20 vacas Aberdeen Angus a 1600 USD cada una para Loma, las vacuné contra aftosa y las pesé al ingreso 380 kg promedio',
    expect: async ({ userId, diff }) => {
      const movs = await apiQueryDb(
        `SELECT count, movement_type FROM livestock_movements
         WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY id DESC LIMIT 5`, [userId]);
      const add = movs.find((r: any) => Number(r.count) === 20 && /entrada|add/i.test(String(r.movement_type)));
      const sum = diff.lm + diff.he;
      return {
        pass: diff.lm >= 1 && !!add && diff.he >= 1,
        reason: `lm=${diff.lm} add20=${!!add} he=${diff.he} (sum=${sum}, want all>=1 ideally he>=2 for vacuna+pesaje)`,
        warn: diff.he < 2,
      };
    },
  },
  {
    name: 'J29_8_action_mega_mix',
    desc: '8-action across ALL domains',
    group: 'J_edge',
    compound: 'vendí 20 tn maíz a 200 USD, compré 50 bolsas urea a 8mil, fumigué Loma con 2,4D 1.5 lt/ha, agregué 15 vaquillonas en Bajo, monitoreé Frente con V6 sin plagas, llovieron 18 mm en El Rincón, observé hongos en Atrás, gasté 70 mil en gasoil',
    expect: async ({ diff }) => {
      const sum = diff.e + diff.i + diff.d + diff.lm + diff.s + diff.r + diff.o;
      return {
        pass: diff.e >= 2 && diff.i >= 1 && diff.d >= 1 && diff.lm >= 1
          && diff.s >= 1 && diff.r >= 1 && sum >= 7,
        reason: `e=${diff.e} i=${diff.i} d=${diff.d} lm=${diff.lm} s=${diff.s} r=${diff.r} o=${diff.o} (sum=${sum}, want>=7 across domains)`,
        warn: sum < 8,
      };
    },
  },
  {
    name: 'J30_report_plus_register',
    desc: 'pedido de resumen + registro de gasto en 1 mensaje',
    group: 'J_edge',
    compound: 'dame el resumen del mes y registrá un gasto de 50mil en repuestos',
    expect: async ({ userId, diff }) => {
      const expenses = await apiQueryDb(
        `SELECT category, amount FROM expenses
         WHERE user_id=$1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '90 seconds'
           AND amount = 50000
         ORDER BY id DESC LIMIT 3`, [userId]);
      return {
        pass: diff.e >= 1 && expenses.length >= 1,
        reason: `e=${diff.e} expenses_50k=${expenses.length}`,
        warn: expenses.length === 0,
      };
    },
  },
];

// ── Runner ──────────────────────────────────────────────────────────────

interface Result {
  test: TestSpec;
  status: 'PASS' | 'FAIL' | 'WARN';
  reason: string;
  turns: string[];
  responses: string[];
}

async function runTest(t: TestSpec, userId: number): Promise<Result> {
  const before = await countAll(userId);
  const turns: string[] = [];
  const responses: string[] = [];

  turns.push(`USER: ${t.compound}`);
  let respObj = await apiSend(t.compound);
  let resp = extractText(respObj);
  turns.push(`BOT: ${resp.substring(0, 320)}${resp.length > 320 ? '...' : ''}`);
  responses.push(resp);

  const remaining = [...(t.answers ?? [])];
  let safety = 10;
  while (remaining.length > 0 && botIsAsking(resp) && safety > 0) {
    const ans = remaining.shift()!;
    turns.push(`USER: ${ans}`);
    respObj = await apiSend(ans);
    resp = extractText(respObj);
    turns.push(`BOT: ${resp.substring(0, 320)}${resp.length > 320 ? '...' : ''}`);
    responses.push(resp);
    safety--;
  }

  if (botIsAsking(resp) && remaining.length === 0) {
    try { await sendAndLog('cancelar'); } catch { /* ignore */ }
  }

  const after = await countAll(userId);
  const diff = diffCounts(before, after);

  let status: 'PASS' | 'FAIL' | 'WARN';
  let reason: string;
  try {
    const v = await t.expect({ userId, diff, turns: responses });
    if (v.pass && v.warn) status = 'WARN';
    else status = v.pass ? 'PASS' : 'FAIL';
    reason = v.reason;
  } catch (err: any) {
    status = 'FAIL';
    reason = `expect-fn threw: ${err.message}`;
  }

  try { await sendAndLog('cancelar'); } catch { /* ignore */ }

  return { test: t, status, reason, turns, responses };
}

async function main(): Promise<void> {
  console.log('🧪 QA Fresh Scenarios — 30 NEW scenarios across 5 groups (regression: commit e4eebc3)');
  console.log('==========================================================================================\n');

  const auth = await apiRegister();
  TOKEN = auth.token;
  const userId = auth.userId;
  console.log(`✅ Authenticated as user ${userId}`);

  await apiReset();
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [userId]);
  console.log('✅ Reset + enterprise plan\n');

  await setupState();

  const results: Result[] = [];
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`${num}/${TESTS.length} [${t.group}] ${t.name} — ${t.desc}\n`);
    process.stdout.write('   ');
    try {
      const r = await runTest(t, userId);
      results.push(r);
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`${icon} ${r.status} — ${r.reason}`);
    } catch (err: any) {
      console.log(`💥 ERROR: ${err.message}`);
      results.push({ test: t, status: 'FAIL', reason: `runtime: ${err.message}`, turns: [], responses: [] });
    }
  }

  // ── Summary ──
  console.log('\n════════════════════════════════════════════');
  console.log('                 SUMMARY');
  console.log('════════════════════════════════════════════\n');
  const byGroup = (g: Group) => results.filter(r => r.test.group === g);
  const passOf = (rs: Result[]) => rs.filter(r => r.status === 'PASS').length;
  const failOf = (rs: Result[]) => rs.filter(r => r.status === 'FAIL').length;
  const warnOf = (rs: Result[]) => rs.filter(r => r.status === 'WARN').length;

  for (const g of ['F_conv', 'G_hacienda', 'H_stock_fin', 'I_cosecha', 'J_edge'] as Group[]) {
    const rs = byGroup(g);
    console.log(`  ${g.padEnd(14)}: ${passOf(rs)}/${rs.length} pass, ${warnOf(rs)} warn, ${failOf(rs)} fail`);
  }

  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n  ✅ PASS: ${pass}`);
  console.log(`  ⚠️  WARN: ${warn}`);
  console.log(`  ❌ FAIL: ${fail}`);
  console.log(`  📊 Total: ${results.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / results.length) * 100)}%\n`);

  // Explicit regression status
  const r06 = results.find(r => r.test.name.startsWith('G06'));
  const r11 = results.find(r => r.test.name.startsWith('H11'));
  const r21 = results.find(r => r.test.name.startsWith('J21'));
  console.log('─── REGRESSION CHECKS (commit e4eebc3) ───');
  console.log(`  G06 breed-autopick: ${r06?.status ?? 'N/A'} — ${r06?.reason ?? ''}`);
  console.log(`  H11 warehouse-name: ${r11?.status ?? 'N/A'} — ${r11?.reason ?? ''}`);
  console.log(`  J21 trigo-category: ${r21?.status ?? 'N/A'} — ${r21?.reason ?? ''}`);
  console.log('');

  if (fail > 0) {
    console.log('─── FAILURES ───\n');
    for (const r of results.filter(x => x.status === 'FAIL')) {
      console.log(`  ❌ ${r.test.name} (${r.test.group})`);
      console.log(`     ${r.reason}`);
      console.log(`     Compound: ${r.test.compound}`);
      console.log(`     Planned answers: ${JSON.stringify(r.test.answers ?? [])}`);
      for (const t of r.turns.slice(0, 14)) {
        console.log(`       ${t}`);
      }
      console.log('');
    }
  }

  if (warn > 0) {
    console.log('─── WARNINGS ───\n');
    for (const r of results.filter(x => x.status === 'WARN')) {
      console.log(`  ⚠️  ${r.test.name} (${r.test.group}): ${r.reason}`);
    }
    console.log('');
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-fresh-scenarios-results.json',
    JSON.stringify(results.map(r => ({
      name: r.test.name, desc: r.test.desc, group: r.test.group,
      compound: r.test.compound, answers: r.test.answers ?? [],
      status: r.status, reason: r.reason, turns: r.turns,
    })), null, 2),
  );
  console.log(`📄 Full report: src/testing/qa-fresh-scenarios-results.json\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
