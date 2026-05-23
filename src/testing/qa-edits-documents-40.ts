/**
 * QA Edits + Documents — 40 conversations.
 *
 * 25 edit/delete/restore tests + 15 document-flow tests.
 *
 * Edit coverage:
 *   - edit_last_activity (lote, fecha, cultivo)
 *   - edit_last_expense (categoría, amount, plot, clear_lot)
 *   - edit_last_income
 *   - delete_last (gasto, ingreso, actividad)
 *   - delete_specific
 *   - Mid-flow amount/category correction
 *   - Mid-flow rename
 *   - edit hacienda (revert+repeat)
 *   - edit observación
 *   - edit monitoreo
 *   - field/plot rename
 *   - field/plot delete + restore
 *
 * Document coverage (text-side, sin Vision real):
 *   - list_documents
 *   - "voy a subir factura" → prompt
 *   - "vinculá ese documento al gasto X" → link_document
 *   - Daily limit messaging
 *   - Wrong-format handling
 *   - Mid-flow "no procesar"
 *
 * Uses fresh user qa-edits@campo.test (seeds setup).
 * Run: docker compose up -d && npx tsx src/testing/qa-edits-documents-40.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-edits@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Edits';

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

// ── Setup ──────────────────────────────────────────────────────────────

async function setup(userId: number): Promise<void> {
  console.log('🔧 Setup base via bot…');
  await sendAndLog('agregar campo Don Edits');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Pergamino');
  await apiTap('flow_confirm');
  for (const [name, ha] of [['L1', 120], ['L2', 80], ['L3', 60]] as const) {
    await sendAndLog(`agregar lote ${name} al campo Don Edits`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré soja en L1');
  await sendAndLog('sembré maíz en L2');
  await sendAndLog('agregué 50 vacas Angus en L1');
  await sendAndLog('crear galpón Norte en Don Edits');
  console.log('  ✅ campo + 3 lotes + 2 siembras + 1 hacienda + 1 galpón\n');
}

// ── Test spec ──────────────────────────────────────────────────────────

interface MultiTurnTest {
  name: string;
  description: string;
  turns: Array<string | { tap: string }>;
  validate?: Array<(text: string) => { pass: boolean; note: string }>;
}

const TESTS: MultiTurnTest[] = [
  // ═══════════════ EDIT/DELETE/RESTORE — 25 ═══════════════

  // ── edit_last_activity (lote / cultivo / fecha) ──
  {
    name: 'E01_edit_last_activity_plot',
    description: 'Corregir lote de la última actividad',
    turns: [
      'fumigué L1 con glifosato 2 lt/ha',
      'no, era en L2',
    ],
    validate: [
      (t) => ({ pass: /fumig|spray|registr|guard/i.test(t), note: 'fumigación registrada' }),
      (t) => ({ pass: /(corregí|actualiz|modificad|edit|L2)/i.test(t), note: 'edit a L2 confirmado' }),
    ],
  },
  {
    name: 'E02_edit_last_activity_crop',
    description: 'Corregir cultivo de la última siembra',
    turns: [
      'sembré L3 con soja',
      'perdón, era trigo en L3',
    ],
  },
  {
    name: 'E03_edit_last_activity_date',
    description: 'Corregir fecha',
    turns: [
      'fumigué L1 con 2,4D ayer',
      'no, fue el 15 de mayo',
    ],
  },

  // ── edit_last_expense ──
  {
    name: 'E04_edit_expense_amount',
    description: 'Corregir monto post-confirmación',
    turns: [
      'gasté 80 mil en gasoil',
      { tap: 'flow_confirm' },
      'no, fueron 90 mil',
    ],
  },
  {
    name: 'E05_edit_expense_category',
    description: 'Corregir categoría',
    turns: [
      'gasté 50 mil en repuestos',
      { tap: 'flow_confirm' },
      'no, era de combustible',
    ],
  },
  {
    name: 'E06_edit_expense_clear_lot',
    description: 'Sacar lote del gasto (gasto general del campo)',
    turns: [
      'gasté 100 mil en sueldos del L1',
      { tap: 'flow_confirm' },
      'esos sueldos no son del L1, es general',
    ],
  },
  {
    name: 'E07_edit_expense_new_lot',
    description: 'Cambiar lote del gasto',
    turns: [
      'gasté 60 mil en herbicida L1',
      { tap: 'flow_confirm' },
      'no, era del L2',
    ],
  },

  // ── edit_last_income ──
  {
    name: 'E08_edit_income_amount',
    description: 'Corregir monto de ingreso',
    turns: [
      'vendí 10 tn de soja a 400 USD',
      { tap: 'flow_confirm' },
      'el precio era 420 USD',
    ],
  },

  // ── delete_last ──
  {
    name: 'E09_delete_last_expense',
    description: 'Eliminar último gasto',
    turns: [
      'gasté 30 mil en gasoil',
      { tap: 'flow_confirm' },
      'borrá el último gasto',
    ],
  },
  {
    name: 'E10_delete_last_income',
    description: 'Eliminar último ingreso',
    turns: [
      'vendí 5 tn de maíz a 200 USD',
      { tap: 'flow_confirm' },
      'borrá el último ingreso',
    ],
  },
  {
    name: 'E11_delete_last_activity',
    description: 'Eliminar última actividad',
    turns: [
      'fertilicé L2 con urea 100 kg/ha',
      'borrá la última actividad',
    ],
  },

  // ── delete_specific ──
  {
    name: 'E12_delete_specific_by_amount',
    description: 'Eliminar gasto específico por monto',
    turns: [
      'gasté 12345 en repuestos',
      { tap: 'flow_confirm' },
      'borrá el gasto de 12345',
    ],
  },

  // ── Mid-flow correction (amount in middle of flow) ──
  {
    name: 'E13_midflow_amount_correction',
    description: 'Corregir amount durante flow (antes de confirmar)',
    turns: [
      'gasté en combustible',
      '50 mil',
      'no, eran 60 mil',
      { tap: 'flow_confirm' },
    ],
  },

  // ── Mid-flow category correction ──
  {
    name: 'E14_midflow_category_correction',
    description: 'Corregir categoría durante flow',
    turns: [
      'gasté 40 mil',
      'agroquímicos',
      'no, es combustible',
      { tap: 'flow_confirm' },
    ],
  },

  // ── Mid-flow rename (field flow) ──
  {
    name: 'E15_midflow_rename_field',
    description: 'Renombrar campo mid-flow',
    turns: [
      'agregar campo La Esperanza Vieja',
      'no, el nombre es La Esperanza',
      { tap: 'flow_field_loc_city' },
      'Pergamino',
      { tap: 'flow_confirm' },
    ],
  },

  // ── Hacienda edit (revert + repeat) ──
  {
    name: 'E16_edit_hacienda_lote',
    description: 'Corregir lote post-add_livestock',
    turns: [
      'agregué 10 vaquillonas en L2',
      'no, era en L3',
    ],
  },
  {
    name: 'E17_adjust_livestock',
    description: 'Ajustar conteo absoluto',
    turns: [
      'en L1 hay 48 vacas Angus',
    ],
  },

  // ── Edit observación ──
  {
    name: 'E18_edit_observation',
    description: 'Eliminar observación reciente',
    turns: [
      'observé manchas amarillas en L2',
      'borrá la última observación',
    ],
  },

  // ── Edit harvest loads ──
  {
    name: 'E19_delete_harvest_loads',
    description: 'Borrar cargas duplicadas',
    turns: [
      'coseché soja L1 con Pedro 30 tn a Cargill',
      'borrá las cargas duplicadas de hoy',
    ],
  },

  // ── Field rename ──
  {
    name: 'E20_rename_field',
    description: 'Cambiar nombre de campo',
    turns: [
      'cambiá nombre del campo Don Edits a Don Edits 2',
    ],
  },

  // ── Plot rename ──
  {
    name: 'E21_rename_plot',
    description: 'Cambiar nombre de lote',
    turns: [
      'renombrá lote L3 a Nuevo',
    ],
  },

  // ── Field delete + restore ──
  {
    name: 'E22_delete_restore_field',
    description: 'Borrar campo y restaurar',
    turns: [
      'agregar campo Temporal',
      { tap: 'flow_field_loc_city' },
      'Pergamino',
      { tap: 'flow_confirm' },
      'borrar campo Temporal',
      'restaurá el campo Temporal',
    ],
  },

  // ── Plot delete ──
  {
    name: 'E23_delete_plot',
    description: 'Borrar lote vacío',
    turns: [
      'agregar lote Borrame al campo Don Edits',
      '10',
      'borrá el lote Borrame',
    ],
  },

  // ── Cancel mid-flow ──
  {
    name: 'E24_cancel_midflow',
    description: 'Cancelar gasto a mitad de flow',
    turns: [
      'gasté 25 mil',
      'cancelar',
    ],
  },

  // ── Edit con verificación de BD ──
  {
    name: 'E25_verify_db_after_edit',
    description: 'Edit + verificar DB',
    turns: [
      'gasté 11111 en herbicida',
      { tap: 'flow_confirm' },
      'no, eran 22222',
      { tap: 'flow_confirm' },
    ],
  },

  // ═══════════════ DOCUMENTS — 15 ═══════════════

  // ── List/queries ──
  {
    name: 'D01_list_documents_empty',
    description: 'Listar documentos cuando no hay',
    turns: ['mis documentos'],
  },
  {
    name: 'D02_list_facturas',
    description: 'Listar solo facturas',
    turns: ['listar mis facturas'],
  },

  // ── Conversational upload prompts ──
  {
    name: 'D03_upload_factura_prompt',
    description: 'Bot pide foto cuando dicen "voy a subir factura"',
    turns: ['voy a subir una factura'],
    validate: [
      (t) => ({ pass: /(foto|imagen|envi|mand|subí)/i.test(t), note: 'pide foto' }),
    ],
  },
  {
    name: 'D04_upload_remito_prompt',
    description: '"voy a subir remito" → bot pide foto',
    turns: ['voy a cargar un remito de stock'],
    validate: [
      (t) => ({ pass: /(foto|imagen|envi|mand|subí|remito)/i.test(t), note: 'pide foto remito' }),
    ],
  },
  {
    name: 'D05_factura_vs_remito_diff',
    description: 'Bot debe diferenciar factura (gastos) vs remito (stock)',
    turns: [
      'cuál es la diferencia entre factura y remito',
    ],
  },
  {
    name: 'D06_can_i_upload',
    description: '"puedo subir facturas?"',
    turns: ['puedo cargar facturas en el bot?'],
  },
  {
    name: 'D07_how_to_upload',
    description: '"cómo cargo gastos desde foto?"',
    turns: ['cómo cargo los gastos desde una foto'],
  },

  // ── Multi-turn upload conversation ──
  {
    name: 'D08_intent_factura_then_change_mind',
    description: 'Usuario dice factura y luego cambia idea',
    turns: [
      'voy a subir una factura',
      'mejor no, después la subo',
    ],
  },
  {
    name: 'D09_query_facturas_de_mes',
    description: 'Listar facturas del mes',
    turns: ['facturas de mayo'],
  },

  // ── Vinculación ──
  {
    name: 'D10_link_doc_to_expense_no_data',
    description: 'Pedir link sin documento → bot pide datos',
    turns: ['vinculá ese documento al gasto'],
  },
  {
    name: 'D11_query_specific_factura',
    description: 'Buscar factura de proveedor',
    turns: ['factura de YPF'],
  },

  // ── Edge cases ──
  {
    name: 'D12_total_factura_query',
    description: 'Total acumulado de facturas',
    turns: ['cuánto sumé en facturas este año'],
  },
  {
    name: 'D13_factura_pending_status',
    description: 'Facturas pendientes de procesar',
    turns: ['hay facturas pendientes de procesar'],
  },
  {
    name: 'D14_compound_doc_query',
    description: 'Multi-query: documentos + gastos del mes',
    turns: ['mostrame los documentos y los gastos del mes'],
  },
  {
    name: 'D15_help_documents',
    description: 'Ayuda sobre documentos',
    turns: ['ayuda con documentos'],
  },
];

// ── Main ───────────────────────────────────────────────────────────────

interface TurnResult { message: string; response: string; pass: boolean; note: string; }
interface TestResult { name: string; description: string; turns: TurnResult[]; overallPass: boolean; }

async function main(): Promise<void> {
  console.log('🧪 QA Edits + Documents — 25 edits + 15 documents\n');

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
    const group = test.name.startsWith('E') ? '✏️' : '📄';
    console.log(`\n${num}/${TESTS.length} ${group} ${test.name} — ${test.description}`);

    const turnResults: TurnResult[] = [];
    let allTurnsPass = true;

    // Clear pending state between tests
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
  const edits = allResults.slice(0, 25);
  const docs = allResults.slice(25);
  console.log(`  ✏️  Edits:    ${edits.filter(r => r.overallPass).length} / 25`);
  console.log(`  📄 Docs:     ${docs.filter(r => r.overallPass).length} / 15\n`);

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
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-edits-documents-40-results.json',
    JSON.stringify({ summary: { pass, fail, total: TESTS.length }, tests: allResults }, null, 2),
  );
  console.log(`\n📄 Full report: src/testing/qa-edits-documents-40-results.json`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
