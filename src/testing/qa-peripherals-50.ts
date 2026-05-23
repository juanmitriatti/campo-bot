/**
 * QA Peripherals — 50 tests cubriendo features periféricas no testeadas:
 *   - Tacto / preñez (8)
 *   - Feedlot / corrales (8)
 *   - Sharing / invites (5)
 *   - Weather avanzado (6)
 *   - Multi-day rainfall batch (4)
 *   - Plot grouping / titularidad (5)
 *   - Expense templates (4)
 *   - Generación de reportes PDF (4)
 *   - Settings / preferences (4)
 *   - CSV export + stock auto-linked expense (2)
 *
 * Multi-action por mensaje donde aplica. Fresh user.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-peripherals-50.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-perif@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Perif';

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

async function setup(_userId: number): Promise<void> {
  console.log('🔧 Setup base via bot…');
  await sendAndLog('agregar campo Don Perif');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');
  for (const [name, ha] of [['M1', 150], ['M2', 100], ['M3', 80]] as const) {
    await sendAndLog(`agregar lote ${name} al campo Don Perif`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré soja en M1');
  await sendAndLog('agregué 60 vacas Angus en M1');
  await sendAndLog('agregué 20 novillos Hereford en M2');
  console.log('  ✅ campo + 3 lotes + 1 siembra + 2 hacienda\n');
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
  // ═════════ TACTO / PREÑEZ (8) ═════════
  {
    name: 'T01_tacto_basic',
    description: 'Registrar tacto básico',
    category: 'tacto',
    turns: ['hice tacto en M1, 50 vacas tactadas, 40 preñadas y 10 vacías'],
  },
  {
    name: 'T02_tacto_with_uncertain',
    description: 'Tacto con dudas',
    category: 'tacto',
    turns: ['palpé 30 vacas en M1, 22 preñadas, 6 vacías, 2 dudosas'],
  },
  {
    name: 'T03_tacto_summary',
    description: 'Consulta tasa de preñez',
    category: 'tacto',
    turns: ['cuál es la tasa de preñez'],
  },
  {
    name: 'T04_tacto_query_pct',
    description: '% preñez del campo',
    category: 'tacto',
    turns: ['porcentaje de preñez del campo'],
  },
  {
    name: 'T05_compound_tacto_obs',
    description: 'Tacto + observación juntos',
    category: 'tacto',
    turns: ['hice tacto 25 vacas M1 todas preñadas y observé que están en buen estado'],
  },
  {
    name: 'T06_tacto_then_query',
    description: 'Multi-turn: tacto + consulta',
    category: 'tacto',
    turns: [
      'tacto a 40 vacas M1: 30 preñadas, 10 vacías',
      'cuánto da el % de preñez',
    ],
  },
  {
    name: 'T07_query_resultados_tacto',
    description: '"resultados del tacto"',
    category: 'tacto',
    turns: ['resultados del tacto'],
  },
  {
    name: 'T08_compound_tacto_repro',
    description: 'Tacto + servicio (compound multi-tool)',
    category: 'tacto',
    turns: ['tacto 50 vacas M1, 45 preñadas y echá el toro el 1 de junio en M1'],
  },

  // ═════════ FEEDLOT / CORRALES (8) ═════════
  {
    name: 'F01_create_feedlot',
    description: 'Crear feedlot en campo',
    category: 'feedlot',
    turns: ['crear feedlot Engorde en campo Don Perif'],
  },
  {
    name: 'F02_list_feedlots',
    description: 'Listar feedlots',
    category: 'feedlot',
    turns: ['mis feedlots'],
  },
  {
    name: 'F03_create_corral',
    description: 'Crear corral',
    category: 'feedlot',
    turns: ['crear corral 1 en feedlot Engorde'],
  },
  {
    name: 'F04_list_corrals',
    description: 'Listar corrales',
    category: 'feedlot',
    turns: ['qué corrales tengo'],
  },
  {
    name: 'F05_compound_feedlot_corrales',
    description: 'Crear feedlot + 2 corrales en 1 msg',
    category: 'feedlot',
    turns: ['crear feedlot Sur en Don Perif con corrales A y B'],
  },
  {
    name: 'F06_livestock_corral',
    description: 'Agregar hacienda a corral',
    category: 'feedlot',
    turns: ['agregué 30 novillos al corral 1'],
  },
  {
    name: 'F07_transfer_to_corral',
    description: 'Transferir de lote a corral',
    category: 'feedlot',
    turns: ['pasá 10 novillos de M2 al corral 1'],
  },
  {
    name: 'F08_health_corral',
    description: 'Health event en corral',
    category: 'feedlot',
    turns: ['vacuné los novillos del corral 1 contra clostridial'],
  },

  // ═════════ SHARING (5) ═════════
  {
    name: 'S01_share_field',
    description: 'Generar código compartir',
    category: 'sharing',
    turns: ['compartir campo Don Perif'],
  },
  {
    name: 'S02_list_members',
    description: 'Listar miembros',
    category: 'sharing',
    turns: ['miembros del campo Don Perif'],
  },
  {
    name: 'S03_share_with_phone',
    description: 'Compartir mencionando contacto',
    category: 'sharing',
    turns: ['comparti el campo Don Perif con Juan'],
  },
  {
    name: 'S04_who_has_access',
    description: 'Quién tiene acceso',
    category: 'sharing',
    turns: ['quién tiene acceso al campo Don Perif'],
  },
  {
    name: 'S05_revoke_access',
    description: 'Quitar acceso',
    category: 'sharing',
    turns: ['quitar a Juan del campo Don Perif'],
  },

  // ═════════ WEATHER AVANZADO (6) ═════════
  {
    name: 'W01_weather_today',
    description: 'Clima de hoy de mi ciudad',
    category: 'weather',
    turns: ['cómo está el clima hoy'],
  },
  {
    name: 'W02_weather_other_city',
    description: 'Clima de otra ciudad',
    category: 'weather',
    turns: ['cómo está el clima en Rosario'],
  },
  {
    name: 'W03_weather_forecast_3day',
    description: 'Pronóstico 3 días',
    category: 'weather',
    turns: ['va a llover en los próximos 3 días'],
  },
  {
    name: 'W04_compound_weather_field',
    description: 'Clima de campo específico',
    category: 'weather',
    turns: ['cómo está el clima en mi campo Don Perif'],
  },
  {
    name: 'W05_multi_city',
    description: 'Clima de 2 ciudades',
    category: 'weather',
    turns: ['clima en Pergamino y en Junín'],
  },
  {
    name: 'W06_weather_spray_advice',
    description: 'Clima + recomendación spray',
    category: 'weather',
    turns: ['voy a fumigar mañana, hay viento o lluvia?'],
  },

  // ═════════ RAINFALL BATCH (4) ═════════
  {
    name: 'R01_rainfall_3days',
    description: 'Lluvia multi-día simple',
    category: 'rainfall',
    turns: ['llovió 15mm el lunes, 22mm el martes y 8mm el miércoles en M1'],
  },
  {
    name: 'R02_rainfall_5days',
    description: 'Lluvia 5 días distintos lotes',
    category: 'rainfall',
    turns: ['llovieron 12mm el lunes en M1, 18mm el martes en M2, 25mm el miércoles en M3, 5mm el jueves y 10mm el viernes'],
  },
  {
    name: 'R03_compound_rainfall_activity',
    description: 'Lluvia + actividad post-lluvia',
    category: 'rainfall',
    turns: ['llovieron 30mm ayer en M1 y hoy fumigué M2 con glifosato 2 lt/ha'],
  },
  {
    name: 'R04_rainfall_batch_no_field',
    description: 'Multi-día sin field (consolidación)',
    category: 'rainfall',
    turns: ['20mm el viernes, 15mm el sábado, 10mm el domingo'],
  },

  // ═════════ PLOT GROUPING / TITULARIDAD (5) ═════════
  {
    name: 'G01_set_grupo_single',
    description: 'Asignar grupo a 1 lote',
    category: 'grupos',
    turns: ['el lote M1 es del grupo Pérez'],
  },
  {
    name: 'G02_set_grupo_multi',
    description: 'Asignar grupo a varios lotes',
    category: 'grupos',
    turns: ['los lotes M2 y M3 son del grupo García'],
  },
  {
    name: 'G03_query_grupo',
    description: 'Consultar lotes del grupo',
    category: 'grupos',
    turns: ['cuáles son los lotes del grupo Pérez'],
  },
  {
    name: 'G04_activity_by_grupo',
    description: 'Actividades del grupo',
    category: 'grupos',
    turns: ['actividades del grupo Pérez'],
  },
  {
    name: 'G05_compound_grupo_query',
    description: 'Grupo + has + cultivo',
    category: 'grupos',
    turns: ['cuántas hectáreas y qué cultivos tiene el grupo García'],
  },

  // ═════════ EXPENSE TEMPLATES (4) ═════════
  {
    name: 'X01_create_template',
    description: 'Crear gasto fijo mensual',
    category: 'templates',
    turns: ['crear gasto fijo mensual de sueldos 300 mil'],
  },
  {
    name: 'X02_list_templates',
    description: 'Listar gastos fijos',
    category: 'templates',
    turns: ['mis gastos fijos'],
  },
  {
    name: 'X03_recurring_query',
    description: 'Consulta gastos recurrentes',
    category: 'templates',
    turns: ['qué gastos recurrentes tengo configurados'],
  },
  {
    name: 'X04_delete_template',
    description: 'Borrar gasto fijo',
    category: 'templates',
    turns: ['borrá el gasto fijo de sueldos'],
  },

  // ═════════ PDF REPORTS (4) ═════════
  {
    name: 'P01_agro_report_basic',
    description: 'Reporte agro básico',
    category: 'pdf',
    turns: ['reporte agronómico'],
  },
  {
    name: 'P02_agro_report_field',
    description: 'Reporte agro de campo',
    category: 'pdf',
    turns: ['reporte agro del campo Don Perif'],
  },
  {
    name: 'P03_agro_report_range',
    description: 'Reporte con rango de fechas',
    category: 'pdf',
    turns: ['reporte agro de marzo a mayo'],
  },
  {
    name: 'P04_compound_report_share',
    description: 'Generar + compartir reporte',
    category: 'pdf',
    turns: ['generá reporte agro y compartilo'],
  },

  // ═════════ SETTINGS (4) ═════════
  {
    name: 'C01_set_rain_threshold',
    description: 'Cambiar threshold alerta lluvia',
    category: 'settings',
    turns: ['alertame cuando lluvan más de 25 mm'],
  },
  {
    name: 'C02_enable_weekly_summary',
    description: 'Activar resumen semanal',
    category: 'settings',
    turns: ['activá el resumen semanal'],
  },
  {
    name: 'C03_set_budget',
    description: 'Configurar presupuesto',
    category: 'settings',
    turns: ['mi presupuesto mensual es 2 millones'],
  },
  {
    name: 'C04_compound_settings',
    description: '2 settings en 1 msg',
    category: 'settings',
    turns: ['activá alertas de lluvia y de presupuesto'],
  },

  // ═════════ MISC / STOCK LINKED (2) ═════════
  {
    name: 'M01_export_csv',
    description: 'Exportar CSV',
    category: 'misc',
    turns: ['exportar gastos en CSV'],
  },
  {
    name: 'M02_stock_with_autoexpense',
    description: 'Compra stock con precio → genera gasto vinculado',
    category: 'misc',
    turns: ['compré 200 lt de glifosato a 5000 c/u y los cargué al galpón'],
  },
];

// ── Main ───────────────────────────────────────────────────────────────

interface TurnResult { message: string; response: string; pass: boolean; note: string; }
interface TestResult { name: string; description: string; category: string; turns: TurnResult[]; overallPass: boolean; }

async function main(): Promise<void> {
  console.log(`🧪 QA Peripherals — ${TESTS.length} tests\n`);

  const auth = await apiRegister();
  TOKEN = auth.token;
  console.log(`✅ User ${auth.userId} (${EMAIL})`);

  await apiReset();
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [auth.userId]);
  console.log('✅ Reset + enterprise plan\n');

  await setup(auth.userId);

  const allResults: TestResult[] = [];
  let pass = 0, fail = 0;
  const byCat: Record<string, { pass: number; fail: number }> = {};

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    const emoji = test.category === 'tacto' ? '🐮' : test.category === 'feedlot' ? '🏚️' : test.category === 'sharing' ? '🤝' : test.category === 'weather' ? '🌤️' : test.category === 'rainfall' ? '🌧️' : test.category === 'grupos' ? '👥' : test.category === 'templates' ? '🔁' : test.category === 'pdf' ? '📑' : test.category === 'settings' ? '⚙️' : '📌';
    console.log(`\n${num}/${TESTS.length} ${emoji} ${test.name} — ${test.description}`);

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
          const tooGeneric = /No pude identificar.*lote.*Indicá|necesito categor[ií]a.*y lote\/corral|^❌\s+\w+:\s+(?:not implemented|disponible)/i.test(text);
          turnPass = !isErrorOnly && !tooGeneric && text.length > 5;
          note = turnPass ? 'non-empty informative' : tooGeneric ? 'generic ask (gap)' : 'empty/error';
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
    console.log(`    ${cat.padEnd(12)} ${score.pass}/${total} (${Math.round((score.pass / total) * 100)}%)`);
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
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-peripherals-50-results.json',
    JSON.stringify({ summary: { pass, fail, total: TESTS.length, byCat }, tests: allResults }, null, 2),
  );
  console.log(`\n📄 Full report: src/testing/qa-peripherals-50-results.json`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
