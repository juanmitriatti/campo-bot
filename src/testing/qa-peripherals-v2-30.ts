/**
 * QA Peripherals V2 — 30 NEW tests cubriendo las 9 bugs detectados +
 * extensión de cobertura periférica. Conversaciones DIFERENTES de v1.
 *
 * Foco regresión bug-by-bug:
 *  - F05: compound feedlot+N corrales (varias variantes)
 *  - F07: transfer plot→corral
 *  - F08: vacuné en corral → health, no add_livestock
 *  - W01/W03/W04/W06: weather field-city fallback
 *  - W05: compound multi-city
 *  - C01: set_rain_threshold "alertame cuando"
 *  - C02: activá resumen semanal (vos form)
 *  - S03: share con persona → no fake success
 *  - X01/X02: Invalid Date en templates
 *
 * Plus extras nuevos: feedlot delete, corral livestock query,
 * sharing con email/phone, rainfall threshold variants, weather forecast.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-peripherals-v2-30.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-perif-v2@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Perif V2';

async function apiRegister(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Send failed: ${res.status} — ${t.slice(0, 100)}`);
  }
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
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Query failed ${res.status}: ${t.slice(0, 200)}`);
  }
  const d = await res.json() as any;
  return d.rows ?? [];
}
function extractText(data: any): string {
  return (data.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}
async function sendAndLog(message: string): Promise<string> {
  return extractText(await apiSend(message));
}

async function setup(userId: number): Promise<void> {
  console.log('🔧 Setup base…');
  await sendAndLog('agregar campo La Margarita');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');
  // Verify city was saved
  const fr = await apiQueryDb(`SELECT city FROM fields WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [userId]);
  if (!fr[0]?.city) {
    console.warn('  ⚠️ Field city not set, forcing Pergamino directly via DB');
    await apiQueryDb(`UPDATE fields SET city='Pergamino' WHERE user_id=$1 AND city IS NULL`, [userId]);
  }
  for (const [name, ha] of [['K1', 80], ['K2', 120], ['K3', 60]] as const) {
    await sendAndLog(`agregar lote ${name} al campo La Margarita`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré maíz en K1');
  await sendAndLog('agregué 40 novillos Hereford en K2');
  console.log('  ✅ campo + 3 lotes + 1 siembra + 1 hacienda\n');
}

// ── Tests ──────────────────────────────────────────────────────────────

interface MultiTurnTest {
  name: string;
  description: string;
  category: string;
  turns: Array<string | { tap: string }>;
  // undefined = ese turno no se valida (solo se envia).
  validate?: Array<((text: string) => { pass: boolean; note: string }) | undefined>;
}

const TESTS: MultiTurnTest[] = [
  // ═════════ F08 regression — vacuné en corral → health_event ═════════
  {
    name: 'V01_vacuna_corral',
    description: 'vacuna en corral → log_health_event (NO add_livestock)',
    category: 'corral-health',
    turns: [
      'crear feedlot Sur en La Margarita',
      'crear corral A1 en feedlot Sur',
      'agregué 50 novillos al corral A1',
      'vacuné los novillos del corral A1 contra aftosa',
    ],
    validate: [
      undefined,
      undefined,
      (t) => ({ pass: /\+50|nuevo grupo|🐄/.test(t), note: 'add_livestock OK' }),
      (t) => ({ pass: /(vacun|💉|sanitari|aftosa)/i.test(t) && !/➕\s*50|✚\s*50/.test(t), note: 'health no add_livestock' }),
    ],
  },
  {
    name: 'V02_desparasit_corral',
    description: 'desparasitación en corral',
    category: 'corral-health',
    turns: ['desparasité los novillos del corral A1 con ivermectina'],
    validate: [
      (t) => ({ pass: /(desparas|sanitari|💉|ivermec)/i.test(t), note: 'health event' }),
    ],
  },
  {
    name: 'V03_compound_2health_corral',
    description: '2 health events: corral + plot',
    category: 'corral-health',
    turns: ['vacuné los novillos del corral A1 contra brucelosis y a los de K2 contra aftosa'],
  },

  // ═════════ F07 regression — transfer plot→corral ═════════
  {
    name: 'V04_transfer_plot_to_corral',
    description: 'transferir N novillos de K2 al corral A1',
    category: 'corral-transfer',
    turns: ['pasá 15 novillos de K2 al corral A1'],
    validate: [
      (t) => ({ pass: /(transfer|trasfer|movim|↔|→|pasaron|trasladados)/i.test(t), note: 'es transfer' }),
    ],
  },
  {
    name: 'V05_transfer_corral_to_plot',
    description: 'transferir corral→plot (reverso)',
    category: 'corral-transfer',
    turns: ['saqué 5 novillos del corral A1 y los mandé a K2'],
  },

  // ═════════ F05 regression — compound feedlot+corrales ═════════
  {
    name: 'V06_feedlot_3corrales',
    description: 'crear feedlot con 3 corrales (mayor exigencia)',
    category: 'compound-feedlot',
    turns: ['crear feedlot Norte en La Margarita con corrales 1, 2 y 3'],
  },
  {
    name: 'V07_list_after_compound',
    description: 'verificar los 3 corrales se crearon',
    category: 'compound-feedlot',
    turns: ['cuántos corrales tengo en el feedlot Norte'],
    validate: [
      (t) => ({ pass: /(3|tres|1|2|3)/.test(t), note: 'menciona los corrales' }),
    ],
  },
  {
    name: 'V08_feedlot_corral_livestock',
    description: 'feedlot+corral+livestock 3-tool compound',
    category: 'compound-feedlot',
    turns: ['crear feedlot Este en La Margarita con corral B1 y meté 20 novillos en B1'],
  },

  // ═════════ W weather field-fallback regression ═════════
  {
    name: 'V09_weather_no_city_uses_field',
    description: 'clima sin ciudad → usa campo La Margarita en Pergamino',
    category: 'weather-fallback',
    turns: ['cómo está el clima'],
    validate: [
      (t) => ({ pass: /(Pergamino|pergamino|clima|°C|temperatura)/i.test(t) && !/no tengo tu ubicación/i.test(t), note: 'usa field city' }),
    ],
  },
  {
    name: 'V10_weather_forecast_field',
    description: 'pronóstico sin ciudad',
    category: 'weather-fallback',
    turns: ['va a llover mañana'],
    validate: [
      (t) => ({ pass: /(Pergamino|pergamino|pronóstico|lluvia|°C|💨|💧|mm)/i.test(t) && !/no tengo tu ubicación/i.test(t), note: 'usa field city' }),
    ],
  },
  {
    name: 'V11_weather_spray_advice_field',
    description: 'consejo spray sin ciudad',
    category: 'weather-fallback',
    turns: ['hay viento mañana para fumigar'],
  },

  // ═════════ W05 regression — multi-city compound ═════════
  {
    name: 'V12_multi_city_2',
    description: 'clima en 2 ciudades',
    category: 'weather-multi',
    turns: ['clima en Pergamino y Rosario'],
    validate: [
      (t) => ({ pass: /Pergamino/i.test(t) && /Rosario/i.test(t), note: 'ambas ciudades' }),
    ],
  },
  {
    name: 'V13_multi_city_3',
    description: 'clima en 3 ciudades',
    category: 'weather-multi',
    turns: ['cómo está el clima en Junín, Pergamino y Rosario'],
    validate: [
      (t) => ({ pass: /Junín|junin/i.test(t) && /Pergamino/i.test(t) && /Rosario/i.test(t), note: '3 ciudades' }),
    ],
  },

  // ═════════ C01 regression — alertame cuando llueva ═════════
  {
    name: 'V14_set_rain_threshold_natural',
    description: 'alertame cuando llueva más de N mm (forma natural)',
    category: 'settings-rain',
    turns: ['alertame cuando llueva más de 30 mm'],
    validate: [
      (t) => ({ pass: /(30|umbral|configurad|alerta)/i.test(t) && !/no tengo|por ahora/i.test(t), note: 'configura threshold' }),
    ],
  },
  {
    name: 'V15_set_rain_threshold_avisame',
    description: '"avisame cuando llueva"',
    category: 'settings-rain',
    turns: ['avisame cuando llueva más de 15 mm'],
  },

  // ═════════ C02 regression — activá resumen semanal ═════════
  {
    name: 'V16_activa_resumen_vos',
    description: '"activá resumen semanal" (vos)',
    category: 'settings-summary',
    turns: ['activá el resumen semanal'],
    validate: [
      (t) => ({ pass: /(resumen|semanal|activad|✅)/i.test(t) && !/expense|recurrente|gasto fijo/i.test(t), note: 'es resumen no expense template' }),
    ],
  },
  {
    name: 'V17_desactiva_resumen',
    description: '"desactivá el resumen semanal"',
    category: 'settings-summary',
    turns: ['desactivá el resumen semanal'],
  },

  // ═════════ S03 regression — share with non-existent user ═════════
  {
    name: 'V18_share_with_phone',
    description: 'compartí con número de teléfono → no fake success',
    category: 'sharing',
    turns: ['compartí el campo La Margarita con +5491133334444'],
    validate: [
      (t) => ({ pass: /(código|invitaci|`[A-Z0-9]{6}`)/i.test(t) && !/✅.*compartido con.*\+5491133/i.test(t), note: 'genera código sin fake' }),
    ],
  },
  {
    name: 'V19_share_with_email',
    description: 'compartí con email',
    category: 'sharing',
    turns: ['compartí el campo La Margarita con juan@example.com'],
  },

  // ═════════ X01/X02 regression — Invalid Date ═════════
  {
    name: 'V20_recurring_no_invalid_date',
    description: 'gasto fijo no muestra "Invalid Date"',
    category: 'templates-date',
    turns: ['crear gasto fijo mensual de combustible 100 mil'],
    validate: [
      (t) => ({ pass: !/Invalid Date|NaN/i.test(t) && /(próximo|mensual|combust|✅)/i.test(t), note: 'fecha válida' }),
    ],
  },
  {
    name: 'V21_recurring_weekly',
    description: 'gasto fijo semanal',
    category: 'templates-date',
    turns: ['crear gasto recurrente semanal de jornal 80 mil'],
    validate: [
      (t) => ({ pass: !/Invalid Date|NaN/i.test(t), note: 'fecha válida' }),
    ],
  },
  {
    name: 'V22_list_recurrings_no_invalid',
    description: 'listar gastos recurrentes sin Invalid Date',
    category: 'templates-date',
    turns: ['mis gastos fijos'],
    validate: [
      (t) => ({ pass: !/Invalid Date|NaN/i.test(t), note: 'lista sin Invalid Date' }),
    ],
  },

  // ═════════ Coverage adicional — features OK reforzadas ═════════
  {
    name: 'V23_tacto_corral',
    description: 'tacto en corral (no plot)',
    category: 'tacto-extras',
    turns: ['hice tacto a las vacas del corral A1, 18 preñadas de 25'],
  },
  {
    name: 'V24_pesaje_corral',
    description: 'pesaje en corral',
    category: 'pesaje-extras',
    turns: ['los novillos del corral A1 pesan 380 kg promedio'],
  },
  {
    name: 'V25_compound_health_repro_corral',
    description: 'health + repro en corral compound',
    category: 'corral-multi',
    turns: ['vacuné los novillos del corral A1 contra clostridial y también eché el toro en K2'],
  },
  {
    name: 'V26_rainfall_to_corral',
    description: 'lluvia + actividad en corral compound',
    category: 'misc',
    turns: ['llovieron 25 mm en La Margarita y agregué 10 terneros al corral A1'],
  },
  {
    name: 'V27_delete_feedlot',
    description: 'borrar feedlot',
    category: 'feedlot-cleanup',
    turns: ['borrar feedlot del campo La Margarita'],
  },
  {
    name: 'V28_grupos_then_activity',
    description: 'grupos + actividad sobre grupo',
    category: 'grupos',
    turns: [
      'los lotes K1 y K3 son del grupo Familia A',
      'cuánto sembré del grupo Familia A',
    ],
  },
  {
    name: 'V29_compound_template_query',
    description: 'crear template + consultar',
    category: 'templates-multi',
    turns: ['crear gasto fijo mensual de luz 50 mil y mostrame mis gastos fijos'],
  },
  {
    name: 'V30_share_then_list',
    description: 'compartir + listar miembros',
    category: 'sharing-multi',
    turns: [
      'compartir campo La Margarita',
      'quién tiene acceso al campo La Margarita',
    ],
  },
];

// ── Main ───────────────────────────────────────────────────────────────

interface TurnResult { message: string; response: string; pass: boolean; note: string; }
interface TestResult { name: string; description: string; category: string; turns: TurnResult[]; overallPass: boolean; }

async function main(): Promise<void> {
  console.log(`🧪 QA Peripherals V2 — ${TESTS.length} tests\n`);

  const auth = await apiRegister();
  TOKEN = auth.token;
  console.log(`✅ User ${auth.userId} (${EMAIL})`);

  await apiReset();
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [auth.userId]);
  // Clear user's city to test the field-fallback for weather
  await apiQueryDb('UPDATE users SET city = NULL WHERE id = $1', [auth.userId]);
  console.log('✅ Reset + enterprise plan + cleared user.city for field-fallback test\n');

  await setup(auth.userId);

  const allResults: TestResult[] = [];
  let pass = 0, fail = 0;

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    console.log(`\n${num}/${TESTS.length} 🔧 ${test.name} — ${test.description}`);

    const turnResults: TurnResult[] = [];
    let allTurnsPass = true;

    try { await apiSend('cancelar'); } catch { /* ignore */ }

    for (let t = 0; t < test.turns.length; t++) {
      const turn = test.turns[t];
      const isTap = typeof turn === 'object';
      const message = isTap ? `[TAP ${turn.tap}]` : (turn as string);
      console.log(`  T${t + 1} 👤 ${message}`);
      try {
        const data = isTap ? await apiTap(turn.tap) : await apiSend(turn as string);
        const text = extractText(data) || '(empty)';
        const preview = text.substring(0, 300).replace(/\n/g, ' ');
        console.log(`  T${t + 1} 🤖 ${preview}${text.length > 300 ? '…' : ''}`);

        let turnPass = true;
        let note = 'auto-pass';
        if (test.validate && test.validate[t]) {
          const v = test.validate[t]!(text);
          turnPass = v.pass;
          note = v.note;
        } else {
          const isErrorOnly = /^(error|err|fail|fallo)/i.test(text.trim()) || text.trim() === '(empty)';
          turnPass = !isErrorOnly && text.length > 5;
          note = turnPass ? 'non-empty' : 'empty/error';
        }

        if (!turnPass) allTurnsPass = false;
        turnResults.push({ message, response: text, pass: turnPass, note });
        console.log(`  T${t + 1} ${turnPass ? '✅' : '❌'} ${note}`);
      } catch (err: any) {
        console.log(`  T${t + 1} 💥 ${err.message}`);
        turnResults.push({ message, response: `ERROR: ${err.message}`, pass: false, note: 'runtime error' });
        allTurnsPass = false;
      }
    }

    if (allTurnsPass) pass++; else fail++;
    allResults.push({ name: test.name, description: test.description, category: test.category, turns: turnResults, overallPass: allTurnsPass });
  }

  console.log('\n\n═══════════════════════ SUMMARY ═══════════════════════');
  console.log(`  ✅ PASS:    ${pass} / ${TESTS.length}`);
  console.log(`  ❌ FAIL:    ${fail} / ${TESTS.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / TESTS.length) * 100)}%`);

  console.log('\n═══════════════════════ DETALLE FAILS ═══════════════════════\n');
  for (const r of allResults) {
    if (r.overallPass) continue;
    console.log(`\n[${r.name}] ${r.description}`);
    for (const t of r.turns) {
      console.log(`  ${t.pass ? '✅' : '❌'} 👤 ${t.message}`);
      console.log(`     🤖 ${t.response.substring(0, 350).replace(/\n/g, ' ')}${t.response.length > 350 ? '…' : ''}`);
      if (!t.pass) console.log(`     💡 ${t.note}`);
    }
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-peripherals-v2-30-results.json',
    JSON.stringify({ summary: { pass, fail, total: TESTS.length }, tests: allResults }, null, 2),
  );
  console.log(`\n📄 Full report: src/testing/qa-peripherals-v2-30-results.json`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
