/**
 * QA Multi-Query 40 — 40 NEW conversations against the v2 seeded user.
 *
 * Each conversation = 1..4 messages. Mix of:
 *  - compound queries (multiple things in one message)
 *  - multi-turn refinements (inherit / pivot)
 *  - cross-domain joins
 *  - conversational big-picture
 *
 * Reuses the qa-hist-v2@campo.test user (rich 6-month seed: livestock +
 * stock + scoutings + harvest_loads + sanidad + repro + pesajes +
 * gastos + ingresos + lluvias + actividades).
 *
 * Run after qa-historical-consistency-v2.ts has been run at least once.
 * Run: docker compose up -d && npx tsx src/testing/qa-multi-query-40.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-hist-v2@campo.test';
const PASSWORD = 'qatest123';

// ── API helpers ─────────────────────────────────────────────────────────

async function apiLogin(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} — run qa-historical-consistency-v2 first to create the user`);
  const d = await res.json() as any;
  return { token: d.tokens.accessToken, userId: d.user.id };
}

let TOKEN = '';

async function apiSend(message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  return res.json();
}

function extractText(data: any): string {
  return (data.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}

// ── Test spec ──────────────────────────────────────────────────────────

interface MultiTurnTest {
  name: string;
  description: string;
  turns: string[];
  /** Per-turn validator. Optional: if absent, turn passes when response is non-empty + non-error */
  validate?: Array<(text: string) => { pass: boolean; note: string }>;
}

const TESTS: MultiTurnTest[] = [
  // ── COMPOUND (multiple things in same message) ──
  {
    name: 'T01_compound_vacas+pesaje',
    description: '2 queries en 1 mensaje: count + último peso',
    turns: ['cuántas vacas tengo y cuánto pesan'],
    validate: [(t) => ({ pass: /vaca/i.test(t) && /460|kg|peso/i.test(t), note: 'esperaba vacas+kg' })],
  },
  {
    name: 'T02_compound_2_categories',
    description: 'gasoil + sueldos en 1 mensaje',
    turns: ['cuánto gasté en gasoil y cuánto en sueldos'],
    validate: [(t) => ({ pass: /gasoil|combust/i.test(t) && /sueldo/i.test(t), note: 'esperaba ambas categorías' })],
  },
  {
    name: 'T03_multiturn_type_pivot',
    description: '"vendí soja" → "y de trigo?" (pivot crop, inherit type)',
    turns: ['cuánto vendí de soja', 'y de trigo?'],
    validate: [
      (t) => ({ pass: /soja/i.test(t), note: 'soja en T1' }),
      (t) => ({ pass: /trigo/i.test(t), note: 'trigo en T2' }),
    ],
  },
  {
    name: 'T04_compound_stock_2_items',
    description: 'urea y glifosato',
    turns: ['stock de urea y de glifosato'],
    validate: [(t) => ({ pass: /urea/i.test(t) && /glifo/i.test(t), note: 'esperaba ambos productos' })],
  },
  {
    name: 'T05_refine_progressive',
    description: '"monitoreos N1" → "con plagas" → "severos"',
    turns: ['monitoreos del lote N1', 'y con plagas?', 'y los severos?'],
  },
  {
    name: 'T06_cross_domain_cosecha_ingreso',
    description: 'cosecha + ingreso de soja en 1 mensaje',
    turns: ['cuántos kg de soja coseché y cuánto vendí'],
    validate: [(t) => ({ pass: /soja/i.test(t) && /(kg|tn|usd|\$)/i.test(t), note: 'esperaba cosecha+venta' })],
  },
  {
    name: 'T07_compound_3_categories',
    description: '3 categorías de gasto en 1 mensaje',
    turns: ['gastos de combustible, sueldos y agroquímicos'],
    validate: [(t) => ({ pass: /combust|gasoil/i.test(t) && /sueldo/i.test(t) && /agroqu|glifo/i.test(t), note: 'esperaba 3 cat' })],
  },
  {
    name: 'T08_multiturn_periods',
    description: '"este mes" → "mes pasado" → "total"',
    turns: ['cuánto llovió este mes', 'y el mes pasado?', 'y en total?'],
  },
  {
    name: 'T09_compound_what_where',
    description: 'qué cultivos + en qué lotes',
    turns: ['qué cultivos tengo y en qué lotes'],
    validate: [(t) => ({ pass: /(soja|maíz|trigo|N1|N2|N3)/i.test(t), note: 'esperaba cultivos+lotes' })],
  },
  {
    name: 'T10_multiturn_balance_periods',
    description: 'balance este mes → mes pasado → comparalos',
    turns: ['balance este mes', 'y el mes pasado?', 'comparalos'],
  },
  {
    name: 'T11_compound_lluvia_monitor',
    description: '2 dominios distintos en 1 msg',
    turns: ['lluvias y monitoreos del lote N1'],
    validate: [(t) => ({ pass: /lluv|mm/i.test(t) || /monitor|VE|V\d|R\d/i.test(t), note: 'esperaba al menos uno' })],
  },
  {
    name: 'T12_specific_date',
    description: 'qué pasó el 10 de marzo',
    turns: ['qué pasó el 10 de marzo'],
  },
  {
    name: 'T13_compound_hacienda_in_out',
    description: 'vendí + quedan en 1 msg',
    turns: ['cuántas vacas vendí y cuántas me quedan'],
    validate: [(t) => ({ pass: /vaca|hacienda/i.test(t), note: 'esperaba vacas' })],
  },
  {
    name: 'T14_refine_progressive_harvest',
    description: 'viajes → soja → Cargill → ordenalos',
    turns: ['viajes de cosecha', 'solo de soja', 'solo a Cargill', 'ordenalos por peso'],
  },
  {
    name: 'T15_compound_metrics',
    description: 'humedad + proteína promedio en 1 msg',
    turns: ['promedio de humedad y proteína de la cosecha'],
  },
  {
    name: 'T16_cross_rinde_precio',
    description: 'rinde + precio en 1 msg',
    turns: ['rinde de soja y precio promedio de venta'],
  },
  {
    name: 'T17_multiturn_stock_action_query',
    description: 'consulta → acción de carga → consulta',
    turns: ['hay stock bajo?', 'agregame 50 lt de glifosato al stock', 'y ahora cómo está el glifosato?'],
  },
  {
    name: 'T18_compound_extremes',
    description: 'más + menos en 1 msg',
    turns: ['en qué lote más llovió y dónde menos'],
  },
  {
    name: 'T19_multiturn_ingresos_gastos_balance',
    description: 'ingresos+gastos → balance',
    turns: ['ingresos y gastos del mes', 'cuál es el balance'],
  },
  {
    name: 'T20_refine_periods_types',
    description: 'actividades → fumigaciones → mes anterior',
    turns: ['actividades de mayo', 'solo fumigaciones', 'y de abril?'],
  },
  {
    name: 'T21_compound_3_activities',
    description: '3 tipos de actividad del año',
    turns: ['fumigaciones, fertilizaciones y cosechas del año'],
  },
  {
    name: 'T22_broad_lote_history',
    description: 'todo lo del lote',
    turns: ['todo lo que pasó en N1'],
  },
  {
    name: 'T23_date_range_activities',
    description: 'rango específico de fechas',
    turns: ['actividades del 1 de marzo al 30 de abril'],
  },
  {
    name: 'T24_compound_3_categories_livestock',
    description: '3 categorías hacienda en 1 msg',
    turns: ['cuántas vacas, novillos y terneros tengo'],
    validate: [(t) => ({ pass: /vaca/i.test(t) && /novillo/i.test(t) && /ternero/i.test(t), note: 'esperaba 3 categorías' })],
  },
  {
    name: 'T25_specific_period_drill',
    description: 'movimientos hacienda mes específico',
    turns: ['movimientos de hacienda en marzo'],
  },
  {
    name: 'T26_refine_scouting_extremes',
    description: 'monitoreos → más afectado → más sano',
    turns: ['monitoreos de soja', 'cuál fue el más afectado', 'y el más sano?'],
  },
  {
    name: 'T27_compound_per_plot_financial',
    description: 'gasto+ingreso del lote N1',
    turns: ['cuánto gasté en N1 y cuánto ingresé del N1'],
  },
  {
    name: 'T28_conversational_rodeo',
    description: '"cómo va el rodeo"',
    turns: ['cómo va el rodeo'],
  },
  {
    name: 'T29_conversational_campana',
    description: '"cómo viene la campaña"',
    turns: ['cómo viene la campaña'],
  },
  {
    name: 'T30_refine_rankings',
    description: 'ranking lluvia → ranking gastos',
    turns: ['ranking de lotes por lluvia', 'y ahora por gastos?'],
  },
  {
    name: 'T31_specific_product_activity',
    description: 'fumigaciones de soja con glifosato',
    turns: ['fumigaciones de soja con glifosato'],
  },
  {
    name: 'T32_compound_last_x',
    description: 'última lluvia + último monitoreo',
    turns: ['última lluvia y último monitoreo'],
  },
  {
    name: 'T33_refine_filters',
    description: 'lluvias filtradas con refinamiento',
    turns: ['lluvias arriba de 30 mm', 'solo de febrero'],
  },
  {
    name: 'T34_compound_health_what+who',
    description: 'qué vacuna + a cuántos',
    turns: ['qué vacuna apliqué y a cuántos animales'],
  },
  {
    name: 'T35_compound_3_agro',
    description: 'sembrado + fertilizado + cosechado',
    turns: ['cuánto sembré de soja, cuánto fertilicé y cuánto coseché'],
  },
  {
    name: 'T36_multiturn_year_to_crop',
    description: 'balance año → solo soja → solo trigo',
    turns: ['balance del año', 'y solo de soja?', 'y de trigo?'],
  },
  {
    name: 'T37_period_harvests',
    description: 'todas las cosechas de mayo',
    turns: ['todas las cosechas de mayo'],
  },
  {
    name: 'T38_compound_stock_with_alert',
    description: 'stock + alertas en 1 msg',
    turns: ['mostrame stock y alertas de stock bajo'],
  },
  {
    name: 'T39_refine_top_pivot',
    description: 'top 3 cosecha → top 3 malezas',
    turns: ['los 3 lotes con más cosecha', 'y los 3 con más malezas?'],
  },
  {
    name: 'T40_broad_summary',
    description: 'resumen general',
    turns: ['dame un resumen general del campo'],
  },
];

// ── Main ───────────────────────────────────────────────────────────────

interface TurnResult {
  message: string;
  response: string;
  pass: boolean;
  note: string;
}

interface TestResult {
  name: string;
  description: string;
  turns: TurnResult[];
  overallPass: boolean;
}

async function main(): Promise<void> {
  console.log('🧪 QA Multi-Query 40 — conversaciones 1..4 turnos contra qa-hist-v2 seeded data\n');

  const auth = await apiLogin();
  TOKEN = auth.token;
  console.log(`✅ Login user ${auth.userId} (${EMAIL})\n`);

  const allResults: TestResult[] = [];
  let pass = 0;
  let partialPass = 0;
  let fail = 0;

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    console.log(`\n${num}/${TESTS.length} ${test.name} — ${test.description}`);

    const turnResults: TurnResult[] = [];
    let allTurnsPass = true;
    let anyTurnPass = false;

    // Best-effort cancel between tests to clear pending state
    try { await apiSend('cancelar'); } catch { /* ignore */ }

    for (let t = 0; t < test.turns.length; t++) {
      const message = test.turns[t];
      console.log(`  T${t + 1} 👤 ${message}`);
      try {
        const data = await apiSend(message);
        const text = extractText(data) || '(empty)';
        const preview = text.substring(0, 250).replace(/\n/g, ' ');
        console.log(`  T${t + 1} 🤖 ${preview}${text.length > 250 ? '…' : ''}`);

        // Validate
        let turnPass = true;
        let note = 'auto-pass (no validator)';
        if (test.validate && test.validate[t]) {
          const v = test.validate[t]!(text);
          turnPass = v.pass;
          note = v.note;
        } else {
          // Auto: pass if not empty + not pure error
          const isErrorOnly = /^(error|err|fail|fallo)/i.test(text.trim()) || text.trim() === '(empty)';
          turnPass = !isErrorOnly && text.length > 5;
          note = turnPass ? 'non-empty response' : 'empty/error';
        }

        if (turnPass) { anyTurnPass = true; } else { allTurnsPass = false; }
        turnResults.push({ message, response: text, pass: turnPass, note });
        console.log(`  T${t + 1} ${turnPass ? '✅' : '❌'} ${note}`);
      } catch (err: any) {
        console.log(`  T${t + 1} 💥 ${err.message}`);
        turnResults.push({ message, response: `ERROR: ${err.message}`, pass: false, note: 'runtime error' });
        allTurnsPass = false;
      }
    }

    if (allTurnsPass) { pass++; }
    else if (anyTurnPass) { partialPass++; }
    else { fail++; }

    allResults.push({ name: test.name, description: test.description, turns: turnResults, overallPass: allTurnsPass });
  }

  console.log('\n\n═══════════════════════ SUMMARY ═══════════════════════');
  console.log(`  ✅ FULL PASS:    ${pass} / ${TESTS.length}`);
  console.log(`  ⚠️  PARTIAL:      ${partialPass} / ${TESTS.length}`);
  console.log(`  ❌ FULL FAIL:    ${fail} / ${TESTS.length}`);
  console.log(`  📈 Pass rate:    ${Math.round(((pass + partialPass * 0.5) / TESTS.length) * 100)}% (weighted)\n`);

  // List partials + fails
  console.log('═══════════════════════ DETALLE FAILS / PARCIALES ═══════════════════════\n');
  for (const r of allResults) {
    if (r.overallPass) continue;
    console.log(`\n[${r.name}] ${r.description}`);
    for (const t of r.turns) {
      console.log(`  ${t.pass ? '✅' : '❌'} 👤 ${t.message}`);
      console.log(`     🤖 ${t.response.substring(0, 300).replace(/\n/g, ' ')}${t.response.length > 300 ? '…' : ''}`);
      if (!t.pass) console.log(`     💡 ${t.note}`);
    }
  }

  // Save full report
  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-multi-query-results.json',
    JSON.stringify({ summary: { pass, partialPass, fail, total: TESTS.length }, tests: allResults }, null, 2),
  );
  console.log(`\n📄 Full report: src/testing/qa-multi-query-results.json`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
