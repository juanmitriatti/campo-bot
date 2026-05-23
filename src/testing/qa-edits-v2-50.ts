/**
 * QA Edits V2 — 50 NEW edit/correction tests.
 *
 * Énfasis en los patrones que más fallaron en suite v1:
 *   • Mid-flow corrections (amount, category, plot — durante el flow)
 *   • Hacienda edits (revert + repeat)
 *   • Rename de campo/lote
 *   • Confirm sin lote (ahora plotName=optional)
 *   • delete_last_activity (nuevo handler)
 *   • Pending action processor con respuestas inválidas (no crash)
 *
 * Conversaciones DIFERENTES de qa-edits-documents-40.
 * Fresh user qa-edits-v2@campo.test.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-edits-v2-50.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-edits-v2@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Edits V2';

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
  console.log('🔧 Setup base…');
  await sendAndLog('agregar campo Don V');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');
  for (const [name, ha] of [['P1', 100], ['P2', 90], ['P3', 70], ['P4', 50]] as const) {
    await sendAndLog(`agregar lote ${name} al campo Don V`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré soja en P1');
  await sendAndLog('sembré maíz en P2');
  await sendAndLog('sembré trigo en P3');
  await sendAndLog('agregué 30 vacas Angus en P1');
  await sendAndLog('agregué 15 novillos Hereford en P2');
  await sendAndLog('crear galpón Sur en Don V');
  console.log('  ✅ campo + 4 lotes + 3 siembras + 2 hacienda + 1 galpón\n');
}

// ── Tests ──────────────────────────────────────────────────────────────

interface MultiTurnTest {
  name: string;
  description: string;
  turns: Array<string | { tap: string }>;
  validate?: Array<(text: string) => { pass: boolean; note: string }>;
}

const TESTS: MultiTurnTest[] = [
  // ═════════ Bug-1 regression: pending no crash ═════════
  {
    name: 'B01_pending_no_crash_date',
    description: 'Pending quantity + user da fecha → debe re-preguntar, no 500',
    turns: [
      'fumigué P1 con glifosato',
      'no, fue el 15 de mayo',
    ],
    validate: [
      (t) => ({ pass: /falt|cantidad|¿/i.test(t), note: 'asks for missing data' }),
      (t) => ({ pass: !/ERROR|500/i.test(t), note: 'no crash' }),
    ],
  },
  {
    name: 'B02_pending_no_crash_letras',
    description: 'Pending quantity + user da texto → re-preguntar',
    turns: [
      'sembré P1',
      'el tractor estaba roto',
    ],
  },
  {
    name: 'B03_pending_no_crash_emoji',
    description: 'Pending + user manda emoji',
    turns: [
      'fertilicé P2 con urea',
      '🤔🌽',
    ],
  },

  // ═════════ Bug-2 regression: delete_last_activity ═════════
  {
    name: 'B04_delete_last_siembra',
    description: 'Borrar última siembra',
    turns: [
      'sembré P4 con cebada',
      'borrá la última siembra',
    ],
    validate: [
      (t) => ({ pass: /sembr|cebada/i.test(t), note: 'siembra registrada' }),
      (t) => ({ pass: /(elimin|borr|🗑)/i.test(t), note: 'siembra borrada' }),
    ],
  },
  {
    name: 'B05_delete_last_fumigacion',
    description: 'Borrar última fumigación',
    turns: [
      'fumigué P1 con 2,4D 1 lt/ha',
      'borrá la última fumigación',
    ],
    validate: [
      (t) => ({ pass: /fumig|2,4d/i.test(t), note: 'fumigación OK' }),
      (t) => ({ pass: /(elimin|borr|🗑)/i.test(t), note: 'fumigación borrada' }),
    ],
  },
  {
    name: 'B06_delete_last_cosecha',
    description: 'Borrar última cosecha',
    turns: [
      'coseché P3 trigo 4000 kg/ha',
      'borrá la última cosecha',
    ],
  },
  {
    name: 'B07_delete_last_actividad_generic',
    description: 'Borrar "la última actividad" (genérico, sin tipo)',
    turns: [
      'fertilicé P2 con urea 90 kg/ha',
      'borrá la última actividad',
    ],
    validate: [
      (t) => ({ pass: /fertiliz|urea/i.test(t), note: 'fertilización OK' }),
      (t) => ({ pass: /(elimin|borr|🗑)/i.test(t), note: 'borrada' }),
    ],
  },
  {
    name: 'B08_eliminar_last_riego',
    description: '"eliminá" en lugar de "borrá"',
    turns: [
      'regué P1 con 30 mm',
      'eliminá la última actividad',
    ],
  },

  // ═════════ Bug-3 regression: rename label correcto ═════════
  {
    name: 'B09_rename_field_says_campo',
    description: 'Rename field debe decir "Campo" no "Lote"',
    turns: ['cambiá nombre del campo Don V a Don V Nuevo'],
    validate: [
      (t) => ({ pass: /(Campo|✏️.*campo)/i.test(t) && !/^✏️ Lote/i.test(t.trim()), note: 'dice Campo no Lote' }),
    ],
  },
  {
    name: 'B10_rename_back',
    description: 'Volver al nombre original',
    turns: ['renombrá el campo Don V Nuevo a Don V'],
  },

  // ═════════ Bug-6 regression: confirm sin lote ═════════
  {
    name: 'B11_confirm_expense_no_lote',
    description: 'Gasto sin lote → confirm directo → debe guardar a nivel campo',
    turns: [
      'gasté 75 mil en gasoil',
      { tap: 'flow_confirm' },
    ],
    validate: [
      (t) => ({ pass: /\$75|combust|gasoil/i.test(t), note: 'gasto procesado' }),
      (t) => ({ pass: /(registr|guard|confirm|✅)/i.test(t) && !/falta|empezá de nuevo/i.test(t), note: 'guardado sin error' }),
    ],
  },
  {
    name: 'B12_confirm_income_no_lote',
    description: 'Ingreso sin lote → confirm directo',
    turns: [
      'cobré 5000 USD de arrendamiento',
      { tap: 'flow_confirm' },
    ],
  },
  {
    name: 'B13_compound_gastos_no_lote_then_confirm',
    description: '2 gastos sin lote en compound',
    turns: [
      'gasté 20 mil en combustible y 30 mil en sueldos',
      { tap: 'flow_confirm' },
    ],
  },

  // ═════════ Mid-flow corrections (Bug 4 + variants) ═════════
  {
    name: 'B14_midflow_category_from_blank',
    description: 'Gasto sin categoría → en step plot user da categoría',
    turns: [
      'gasté 33 mil',
      'agroquímicos',
      'P1',
      { tap: 'flow_confirm' },
    ],
    validate: [
      (t) => ({ pass: /(33|monto|cuánto|gastaste|concepto)/i.test(t), note: 'flow inició' }),
      (t) => ({ pass: /(agroqu|categor)/i.test(t), note: 'categoría capturada' }),
    ],
  },
  {
    name: 'B15_midflow_amount_correction',
    description: 'Mid-flow amount correction antes de confirm',
    turns: [
      'gasté en combustible',
      '40 mil',
      'no, fueron 50 mil',
      { tap: 'flow_confirm' },
    ],
  },
  {
    name: 'B16_midflow_no_es_X_correction',
    description: '"no, es X" durante flow plot',
    turns: [
      'gasté 60 mil en herbicida',
      'no, es categoria sueldos',
      { tap: 'flow_confirm' },
    ],
  },
  {
    name: 'B17_midflow_cancel',
    description: 'Cancel a mitad de flow no leak state',
    turns: [
      'gasté 99 mil',
      'cancelar',
      'qué gastos tengo',
    ],
    validate: [
      (t) => ({ pass: /\$99|monto|cuanto/i.test(t), note: 'flow inició' }),
      (t) => ({ pass: /(cancel|limpio|listo)/i.test(t), note: 'flow cancelado' }),
      (t) => ({ pass: !/99/i.test(t) || /no hay/i.test(t), note: 'state limpio (no quedó el 99 mil)' }),
    ],
  },

  // ═════════ edit_last_activity variantes ═════════
  {
    name: 'B18_edit_activity_lote_diff_field',
    description: 'Edit lote cuando hay varios lotes con nombre similar',
    turns: [
      'fumigué P2 con cipermetrina',
      'no, era en P4',
    ],
  },
  {
    name: 'B19_edit_activity_clear_lot',
    description: 'Sacar lote a actividad (nivel campo)',
    turns: [
      'fumigué P1 con glifosato 1,5',
      'no fue en ningún lote, fue general del campo',
    ],
  },
  {
    name: 'B20_edit_activity_crop_correction',
    description: 'Corregir cultivo de cosecha',
    turns: [
      'coseché P2 soja 3500 kg/ha',
      'perdón, fue maíz no soja',
    ],
  },
  {
    name: 'B21_edit_activity_no_targeting',
    description: '"corregí actividad" sin specificar qué',
    turns: [
      'sembré P3 con avena',
      'corregí la última actividad',
    ],
    validate: [
      (t) => ({ pass: /sembr|avena/i.test(t), note: 'siembra OK' }),
      (t) => ({ pass: /(corregimos|nuevo lote|cultivo|fecha|edit)/i.test(t), note: 'pide info' }),
    ],
  },

  // ═════════ edit_last_expense variantes ═════════
  {
    name: 'B22_edit_expense_two_recent_pick_by_category',
    description: '2 gastos recientes, edit by category_filter',
    turns: [
      'gasté 10 mil en gasoil',
      { tap: 'flow_confirm' },
      'gasté 20 mil en agroquímicos',
      { tap: 'flow_confirm' },
      'el gasto de gasoil sacale el lote',
    ],
  },
  {
    name: 'B23_edit_expense_change_to_diff_field',
    description: 'Cambiar lote del último gasto a otro campo',
    turns: [
      'gasté 80 mil en sueldos',
      { tap: 'flow_confirm' },
      'no, era del lote P3',
    ],
  },

  // ═════════ delete_last + delete_specific ═════════
  {
    name: 'B24_delete_last_then_query',
    description: 'Eliminar último gasto + verificar con query',
    turns: [
      'gasté 25 mil en combustible',
      { tap: 'flow_confirm' },
      'borrá el último gasto',
      'cuánto gasté hoy en combustible',
    ],
  },
  {
    name: 'B25_delete_specific_by_keyword',
    description: 'Borrar gasto específico por keyword',
    turns: [
      'gasté 17000 en plaguicidas',
      { tap: 'flow_confirm' },
      'borrá el gasto de plaguicidas',
    ],
  },

  // ═════════ Hacienda edits ═════════
  {
    name: 'B26_adjust_livestock',
    description: 'Ajustar conteo absoluto post-load',
    turns: [
      'en P1 hay 28 vacas Angus',
    ],
  },
  {
    name: 'B27_add_then_remove',
    description: 'Add hacienda + remove parcial',
    turns: [
      'agregué 5 terneros en P1',
      'vendí 2 terneros del P1 a 800 USD',
    ],
  },
  {
    name: 'B28_transfer_workaround_revert',
    description: 'Transfer en vez de revert (workaround Bug 5)',
    turns: [
      'agregué 8 vaquillonas en P3',
      'pasá 8 vaquillonas de P3 a P4',
    ],
  },
  {
    name: 'B29_recategorize_inplace',
    description: 'Recategorización (terneros → novillos en mismo lote)',
    turns: [
      'pasé 5 terneros a novillos en P1',
    ],
  },

  // ═════════ Rename + delete + restore field/plot ═════════
  {
    name: 'B30_rename_plot_with_field_hint',
    description: 'Renombrar lote con field hint',
    turns: ['renombrá lote P4 a P4-Bis en campo Don V'],
  },
  {
    name: 'B31_delete_plot_with_dependencies',
    description: 'Borrar lote con dependencias',
    turns: ['borrá el lote P4-Bis'],
  },
  {
    name: 'B32_delete_restore_field_query_after',
    description: 'Borrar campo, restaurar, listar',
    turns: [
      'agregar campo Volátil',
      { tap: 'flow_field_loc_city' },
      'Pergamino',
      { tap: 'flow_confirm' },
      'borrá el campo Volátil',
      'restaurá el campo Volátil',
      'qué campos tengo',
    ],
  },

  // ═════════ Edit harvest loads ═════════
  {
    name: 'B33_edit_harvest_loads_delete',
    description: 'Borrar cargas de cosecha sin destino',
    turns: [
      'coseché P3 trigo, Pedro 25 tn',
      'borrá las cargas sin destino del lote P3',
    ],
  },

  // ═════════ Observaciones edit + delete ═════════
  {
    name: 'B34_delete_observation',
    description: 'Borrar observación',
    turns: [
      'observé hongos en hojas de P2',
      'borrá la última observación',
    ],
  },
  {
    name: 'B35_observation_then_correct_plot',
    description: 'Observación con lote correcto post-fact',
    turns: [
      'observé chinches en P1',
      'no, era en P2',
    ],
  },

  // ═════════ Multi-turn complex (4-5 steps) ═════════
  {
    name: 'B36_complex_5step',
    description: '5 turnos: gasto + correction + edit lote + delete + query',
    turns: [
      'gasté 50 mil en herbicida',
      { tap: 'flow_confirm' },
      'no, eran 60 mil',
      { tap: 'flow_confirm' },
      'borrá ese último gasto',
      'cuánto gasté en herbicida',
    ],
  },
  {
    name: 'B37_complex_activity_chain',
    description: 'Siembra + cosecha + edit cultivo',
    turns: [
      'sembré P4-Bis con girasol',
      'cosechá P4-Bis 2800 kg/ha',
      'perdón, lo que sembré fue avena',
    ],
  },

  // ═════════ Edge cases ═════════
  {
    name: 'B38_edit_without_recent_action',
    description: 'Edit sin acción reciente',
    turns: [
      'la última siembra era en P2',
    ],
  },
  {
    name: 'B39_borrar_when_nothing_to_delete',
    description: 'Borrar gasto cuando no hay gastos',
    turns: [
      'cancelar',
      'borrá el último gasto',
    ],
  },
  {
    name: 'B40_double_edit',
    description: '2 ediciones consecutivas',
    turns: [
      'fumigué P1 con glifosato 2 lt/ha',
      'no, era en P2',
      'perdón, era 3 lt/ha',
    ],
  },

  // ═════════ Adversarial / ambiguous ═════════
  {
    name: 'B41_ambiguous_pronoun_edit',
    description: '"ese gasto" sin contexto claro',
    turns: [
      'gasté 12 mil en gasoil',
      { tap: 'flow_confirm' },
      'gasté 34 mil en agroquímicos',
      { tap: 'flow_confirm' },
      'sacale el lote a ese gasto',
    ],
  },
  {
    name: 'B42_misspelled_borra',
    description: '"borame" en lugar de "borrame"',
    turns: [
      'fertilicé P3 con DAP 80 kg/ha',
      'bora la ultima actividad',
    ],
  },
  {
    name: 'B43_partial_corr_amount_only',
    description: 'Correction de solo amount mid-flow',
    turns: [
      'gasté 100 mil en sueldos',
      'no, son 120 mil',
      { tap: 'flow_confirm' },
    ],
  },

  // ═════════ Document upload prompts (sin Vision real) ═════════
  {
    name: 'D01_voy_a_subir_factura_compleja',
    description: '"voy a subir factura de YPF"',
    turns: ['voy a subir una factura de YPF por 50 mil'],
  },
  {
    name: 'D02_query_factura_proveedor',
    description: 'Buscar factura por proveedor',
    turns: ['mostrame las facturas de YPF'],
  },
  {
    name: 'D03_doc_classification_request',
    description: '"qué tipos de documentos puedo subir"',
    turns: ['qué tipos de documentos puedo cargar al sistema'],
  },
  {
    name: 'D04_pdf_o_imagen',
    description: '"puedo subir PDF o solo fotos?"',
    turns: ['puedo subir PDF o solo fotos?'],
  },
  {
    name: 'D05_compound_factura_then_record',
    description: 'Factura mention + registro manual',
    turns: [
      'voy a cargar facturas',
      'mejor anotá ya: gasté 25 mil en combustible',
      { tap: 'flow_confirm' },
    ],
  },
  {
    name: 'D06_pregunta_documentos_pendientes',
    description: 'Status de procesamiento',
    turns: ['cuántas facturas me faltan procesar'],
  },
  {
    name: 'D07_help_doc',
    description: 'Help específico de documentos',
    turns: ['cómo funcionan los documentos'],
  },
];

// ── Main ───────────────────────────────────────────────────────────────

interface TurnResult { message: string; response: string; pass: boolean; note: string; }
interface TestResult { name: string; description: string; turns: TurnResult[]; overallPass: boolean; }

async function main(): Promise<void> {
  console.log(`🧪 QA Edits V2 — ${TESTS.length} tests\n`);

  const auth = await apiRegister();
  TOKEN = auth.token;
  console.log(`✅ User ${auth.userId} (${EMAIL})`);

  await apiReset();
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [auth.userId]);
  console.log('✅ Reset + enterprise plan\n');

  await setup(auth.userId);

  const allResults: TestResult[] = [];
  let pass = 0, fail = 0;

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    const group = test.name.startsWith('B') ? '✏️' : '📄';
    console.log(`\n${num}/${TESTS.length} ${group} ${test.name} — ${test.description}`);

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
    allResults.push({ name: test.name, description: test.description, turns: turnResults, overallPass: allTurnsPass });
  }

  console.log('\n\n═══════════════════════ SUMMARY ═══════════════════════');
  console.log(`  ✅ PASS:    ${pass} / ${TESTS.length}`);
  console.log(`  ❌ FAIL:    ${fail} / ${TESTS.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / TESTS.length) * 100)}%`);
  const bugRegression = allResults.filter(r => r.name.startsWith('B0') || (r.name.length === 3 && r.name >= 'B11' && r.name <= 'B17'));
  console.log(`  🐛 Bug-regression tests: ${bugRegression.filter(r => r.overallPass).length} / ${bugRegression.length}\n`);

  console.log('═══════════════════════ DETALLE FAILS ═══════════════════════\n');
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
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-edits-v2-50-results.json',
    JSON.stringify({ summary: { pass, fail, total: TESTS.length }, tests: allResults }, null, 2),
  );
  console.log(`\n📄 Full report: src/testing/qa-edits-v2-50-results.json`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
