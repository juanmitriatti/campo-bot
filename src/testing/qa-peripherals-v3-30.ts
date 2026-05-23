/**
 * QA Peripherals V3 — 30 NEW tests cubriendo combinaciones no testeadas
 * en v1 ni v2. Conversaciones diferentes para encontrar gaps nuevos.
 *
 * Áreas nuevas / extensiones:
 *  - Tacto avanzado (4): tasa preñez por raza, histórico, evolución, multi-tacto
 *  - Feedlot edge cases (5): capacity, delete, multi-feedlot, list+livestock, validation
 *  - Sharing flows complete (4): accept_invite, member queries, share+list compound
 *  - Weather variations (4): provincia hint, "ahora", weather+observación, edge cases
 *  - Rainfall queries (3): por lote, comparison, in compound
 *  - Grupos extended (3): grupo+cultivo, financial by grupo, observation by grupo
 *  - Templates triggers (3): scope field/plot, list detail, edit
 *  - Misc (4): check_low_stock, adjust_livestock, multi-domain compound, "qué puedo"
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-peripherals-v3-30.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-perif-v3@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Perif V3';

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
  await sendAndLog('agregar campo San Roque');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');
  for (const [name, ha] of [['S1', 110], ['S2', 90], ['S3', 70]] as const) {
    await sendAndLog(`agregar lote ${name} al campo San Roque`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré soja en S1');
  await sendAndLog('sembré maíz en S2');
  await sendAndLog('agregué 40 vacas Angus en S1');
  await sendAndLog('agregué 25 vacas Hereford en S2');
  await sendAndLog('agregué 20 novillos Angus en S3');
  await sendAndLog('crear galpón Principal en San Roque');
  await sendAndLog('cargué 500 kg urea al galpón');
  await sendAndLog('cargué 200 lt glifosato al galpón');

  // Verify field city saved
  const fr = await apiQueryDb(`SELECT city FROM fields WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [userId]);
  if (!fr[0]?.city) {
    await apiQueryDb(`UPDATE fields SET city='Pergamino' WHERE user_id=$1 AND city IS NULL`, [userId]);
  }
  console.log(`  ✅ campo (Pergamino) + 3 lotes + 2 siembras + 3 hacienda (65 vacas + 20 novillos) + galpón + stock\n`);
}

// ── Tests ──────────────────────────────────────────────────────────────

interface MultiTurnTest {
  name: string;
  description: string;
  category: string;
  turns: Array<string | { tap: string }>;
  validate?: Array<(text: string) => { pass: boolean; note: string }>;
}

const TESTS: MultiTurnTest[] = [
  // ═════════ TACTO AVANZADO (4) ═════════
  {
    name: 'T01_tacto_por_raza',
    description: 'Tacto separado por raza (Angus y Hereford)',
    category: 'tacto',
    turns: [
      'palpé 35 vacas Angus en S1, 28 preñadas',
      'palpé 20 vacas Hereford en S2, 16 preñadas',
      'tasa de preñez por raza',
    ],
  },
  {
    name: 'T02_tacto_historico',
    description: 'Tacto histórico de varios meses',
    category: 'tacto',
    turns: [
      'tacto del año pasado',
    ],
  },
  {
    name: 'T03_tacto_compound_multi_lote',
    description: 'Tactos en distintos lotes simultáneos',
    category: 'tacto',
    turns: ['hice tacto en S1 a 30 vacas con 24 preñadas y en S2 a 22 vacas con 18 preñadas'],
  },
  {
    name: 'T04_repro_summary_compound',
    description: 'Tacto + servicio + destete en 1 msg',
    category: 'tacto',
    turns: ['tacto 25 vacas S1 todas preñadas, eché el toro en S2 el 1 de junio y desteté 12 terneros en S3'],
  },

  // ═════════ FEEDLOT EDGE CASES (5) ═════════
  {
    name: 'FD01_feedlot_capacity',
    description: 'Feedlot con capacity',
    category: 'feedlot',
    turns: ['crear feedlot Oeste en San Roque con capacidad 500'],
  },
  {
    name: 'FD02_create_2_feedlots_diff_fields',
    description: 'Querer 2 feedlots → bot debe rechazar (1 por campo)',
    category: 'feedlot',
    turns: [
      'crear feedlot Norte en San Roque',
      'crear otro feedlot Este en San Roque',
    ],
    validate: [
      undefined,
      (t) => ({ pass: /ya tiene un feedlot|límite|máximo|no se puede/i.test(t), note: 'rechaza el 2do' }),
    ],
  },
  {
    name: 'FD03_delete_feedlot_with_corrales',
    description: 'Borrar feedlot que tiene corrales',
    category: 'feedlot',
    turns: [
      'crear corral X1 en feedlot Norte',
      'crear corral X2 en feedlot Norte',
      'borrar el feedlot Norte',
    ],
  },
  {
    name: 'FD04_corral_then_query_capacity',
    description: 'Crear corral + verificar capacidad',
    category: 'feedlot',
    turns: [
      'crear feedlot Sur en San Roque',
      'crear corral Y1 con capacidad 80 en feedlot Sur',
      'qué corrales tengo en Sur',
    ],
  },
  {
    name: 'FD05_health_corral_explicit',
    description: 'Health event en corral con sintaxis explícita',
    category: 'feedlot',
    turns: [
      'agregué 50 novillos al corral Y1',
      'log_health_event vacunación clostridial 50 novillos corral Y1',
    ],
  },

  // ═════════ SHARING FLOWS COMPLETE (4) ═════════
  {
    name: 'SH01_compound_share_list',
    description: 'Compartir + listar miembros (multi-tool compound)',
    category: 'sharing',
    turns: ['compartí el campo San Roque y mostrame los miembros'],
  },
  {
    name: 'SH02_accept_invite_invalid',
    description: 'Aceptar código inválido',
    category: 'sharing',
    turns: ['unirme XXXX99'],
    validate: [
      (t) => ({ pass: /(no.*válid|invál|inexistente|expirado|no encontr|no existe)/i.test(t), note: 'detecta inválido' }),
    ],
  },
  {
    name: 'SH03_query_unshared_field',
    description: 'Miembros de campo sin compartir',
    category: 'sharing',
    turns: ['quién tiene acceso al campo San Roque'],
    validate: [
      (t) => ({ pass: /(dueño|👑|solo vos|miembros)/i.test(t), note: 'muestra owner' }),
    ],
  },
  {
    name: 'SH04_share_multi_field',
    description: 'Compartir 2 campos en 1 mensaje',
    category: 'sharing',
    turns: [
      'agregar campo San Pedro',
      { tap: 'flow_field_loc_city' },
      'Pergamino',
      { tap: 'flow_confirm' },
      'compartí San Roque y San Pedro',
    ],
  },

  // ═════════ WEATHER VARIATIONS (4) ═════════
  {
    name: 'W01_weather_with_provincia',
    description: 'Clima con provincia explícita',
    category: 'weather',
    turns: ['clima en Junín provincia de Buenos Aires'],
    validate: [
      (t) => ({ pass: /(Junín|junin|°C|temperatura)/i.test(t) && !/varias localidades/i.test(t), note: 'resuelve con provincia' }),
    ],
  },
  {
    name: 'W02_weather_ahora',
    description: '"el clima ahora"',
    category: 'weather',
    turns: ['cómo está el clima ahora'],
  },
  {
    name: 'W03_weather_then_observation',
    description: 'Weather + observation compound',
    category: 'weather',
    turns: ['cómo está el clima y observé hojas amarillas en S1'],
  },
  {
    name: 'W04_weather_specific_day',
    description: 'Clima específico día',
    category: 'weather',
    turns: ['va a llover el viernes'],
  },

  // ═════════ RAINFALL QUERIES (3) ═════════
  {
    name: 'R01_rainfall_por_lote',
    description: 'Rainfall report por lote',
    category: 'rainfall',
    turns: [
      'llovieron 30mm en S1 y 22mm en S2',
      'cuánto llovió en cada lote',
    ],
  },
  {
    name: 'R02_rainfall_compound_3day_query',
    description: 'Rain batch 3 días + query inmediato',
    category: 'rainfall',
    turns: [
      'llovió 18mm el lunes, 12mm el martes y 25mm el miércoles',
      'total de lluvia esta semana',
    ],
  },
  {
    name: 'R03_rainfall_vs_year',
    description: 'Comparación lluvia con otro período',
    category: 'rainfall',
    turns: ['cuánto llovió este año'],
  },

  // ═════════ GRUPOS EXTENDED (3) ═════════
  {
    name: 'G01_grupo_with_crop_query',
    description: 'Asignar grupo + query por cultivo',
    category: 'grupos',
    turns: [
      'los lotes S1 y S2 son del grupo Pérez',
      'qué cultivos tiene el grupo Pérez',
    ],
  },
  {
    name: 'G02_grupo_financial',
    description: 'Financial scoped por grupo',
    category: 'grupos',
    turns: [
      'gastos del grupo Pérez',
    ],
  },
  {
    name: 'G03_grupo_multi_with_observation',
    description: 'Grupo + observación + query',
    category: 'grupos',
    turns: [
      'el lote S3 es del grupo García',
      'observé sequía leve en grupo García',
      'qué observaciones tengo del grupo García',
    ],
  },

  // ═════════ TEMPLATES TRIGGERS (3) ═════════
  {
    name: 'TM01_template_with_field_scope',
    description: 'Recurring expense con field scope',
    category: 'templates',
    turns: ['crear gasto fijo mensual 200 mil de arrendamiento para campo San Roque'],
  },
  {
    name: 'TM02_template_list_detail',
    description: 'Listar gastos fijos con detalle',
    category: 'templates',
    turns: [
      'crear gasto fijo mensual de servicios 50 mil',
      'mis gastos recurrentes',
    ],
  },
  {
    name: 'TM03_compound_template_then_edit',
    description: 'Crear + intentar editar monto',
    category: 'templates',
    turns: [
      'crear gasto recurrente mensual de internet 25 mil',
      'cambiá el gasto fijo de internet a 30 mil',
    ],
  },

  // ═════════ MISC (4) ═════════
  {
    name: 'M01_check_low_stock',
    description: 'Verificar productos con stock bajo',
    category: 'misc',
    turns: [
      'fijá stock mínimo de urea en 1000 kg',
      'qué productos tengo con stock bajo',
    ],
  },
  {
    name: 'M02_adjust_livestock',
    description: 'Ajustar conteo absoluto (no add)',
    category: 'misc',
    turns: [
      'en S1 hay 38 vacas Angus',
      'cuántas vacas tengo en S1',
    ],
    validate: [
      (t) => ({ pass: /(ajustad|corregid|actualizad|38)/i.test(t), note: 'ajuste absoluto' }),
      (t) => ({ pass: /38/.test(t), note: 'count = 38' }),
    ],
  },
  {
    name: 'M03_multi_domain_compound',
    description: 'Compound 4 dominios distintos',
    category: 'misc',
    turns: ['gasté 80 mil en gasoil, fumigué S1 con glifosato 2 lt/ha, llovieron 15mm en S2 y agregué 5 terneros en S1'],
  },
  {
    name: 'M04_qué_puedo_hacer',
    description: 'Help genérico',
    category: 'misc',
    turns: ['qué puedo hacer'],
  },
];

// ── Main ───────────────────────────────────────────────────────────────

interface TurnResult { message: string; response: string; pass: boolean; note: string; }
interface TestResult { name: string; description: string; category: string; turns: TurnResult[]; overallPass: boolean; }

async function main(): Promise<void> {
  console.log(`🧪 QA Peripherals V3 — ${TESTS.length} tests\n`);

  const auth = await apiRegister();
  TOKEN = auth.token;
  console.log(`✅ User ${auth.userId} (${EMAIL})`);

  // Try reset, but tolerate failure (corrals leftover from prior test runs)
  try { await apiReset(); } catch { console.log('⚠️ reset failed (leftover state) — continuing'); }
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [auth.userId]);
  // Clear user.city so weather fallback test can exercise field-fallback
  await apiQueryDb('UPDATE users SET city = NULL WHERE id = $1', [auth.userId]);
  console.log('✅ Enterprise plan + cleared user.city\n');

  await setup(auth.userId);

  const allResults: TestResult[] = [];
  let pass = 0, fail = 0;
  const byCat: Record<string, { pass: number; fail: number }> = {};

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    console.log(`\n${num}/${TESTS.length} [${test.category}] ${test.name} — ${test.description}`);

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
    if (!byCat[test.category]) byCat[test.category] = { pass: 0, fail: 0 };
    if (allTurnsPass) byCat[test.category].pass++; else byCat[test.category].fail++;
    allResults.push({ name: test.name, description: test.description, category: test.category, turns: turnResults, overallPass: allTurnsPass });
  }

  console.log('\n\n═══════════════════════ SUMMARY ═══════════════════════');
  console.log(`  ✅ PASS:    ${pass} / ${TESTS.length}`);
  console.log(`  ❌ FAIL:    ${fail} / ${TESTS.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / TESTS.length) * 100)}%\n`);
  console.log('  Por categoría:');
  for (const [cat, score] of Object.entries(byCat).sort()) {
    const total = score.pass + score.fail;
    console.log(`    ${cat.padEnd(12)} ${score.pass}/${total}`);
  }

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
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-peripherals-v3-30-results.json',
    JSON.stringify({ summary: { pass, fail, total: TESTS.length, byCat }, tests: allResults }, null, 2),
  );
  console.log(`\n📄 Full report: src/testing/qa-peripherals-v3-30-results.json`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
