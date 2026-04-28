/**
 * QA Adversarial ADVANCED Testing - 40 Scenarios
 * Focus: Silent data corruption, memory drift, temporal contradictions,
 *        entity collisions, cross-domain confusion, edge cases.
 *
 * These tests target SILENT bugs — where the bot acts incorrectly
 * without showing errors.
 *
 * Run: npx tsx src/testing/qa-adversarial-advanced-40.ts
 * Requires: docker compose up -d (app on :3000, DB on :5433)
 */

type TestBotClient = any;

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-advanced@campo.test';
const PASSWORD = 'qaadv123';
const NAME = 'Don Patricio';

// ============= API HELPERS =============

async function apiRegister(baseUrl: string, email: string, password: string, name: string): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, last_name: 'Test', email, password }),
  });
  if (res.ok) {
    const data = await res.json() as any;
    return { token: data.tokens.accessToken, userId: data.user.id };
  }
  if (res.status === 409) return apiLogin(baseUrl, email, password);
  throw new Error(`Register failed: ${res.status}`);
}

async function apiLogin(baseUrl: string, email: string, password: string): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json() as any;
  return { token: data.tokens.accessToken, userId: data.user.id };
}

async function apiReset(baseUrl: string, token: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/test-bot/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: '{}',
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}

async function apiSend(baseUrl: string, token: string, message: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  return res.json();
}

async function apiTap(baseUrl: string, token: string, buttonId: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status}`);
  return res.json();
}

async function apiDbQuery(baseUrl: string, token: string, sql: string, params: any[] = []): Promise<any[]> {
  const res = await fetch(`${baseUrl}/api/test-bot/query-db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status}`);
  const data = await res.json() as any;
  return data.rows || [];
}

// ============= STATE & HELPERS =============

interface TestResult {
  test_name: string;
  category: string;
  severity: 'low' | 'medium' | 'high';
  status: 'PASS' | 'FAIL' | 'WARN';
  conversation: Array<{ role: string; message: string; response?: string }>;
  expected_behavior: string[];
  possible_failures: string[];
  actual_result: string;
  notes: string;
}

const results: TestResult[] = [];
let AUTH_TOKEN = '';
let USER_ID = 0;

function extractText(data: any): string {
  const messages = data.messages || [];
  const parts: string[] = [];
  for (const m of messages) {
    if (m.text) parts.push(m.text);
    if (m.interactive?.body) parts.push(m.interactive.body);
  }
  const buttons = extractButtons(data);
  let full = parts.join('\n');
  if (buttons.length > 0) {
    full += '\n[BUTTONS: ' + buttons.map((b: any) => `${b.id}="${b.title}"`).join(', ') + ']';
  }
  return full;
}

function extractButtons(data: any): Array<{ id: string; title: string }> {
  const buttons: Array<{ id: string; title: string }> = [];
  for (const m of (data.messages || [])) {
    if (m.interactive?.buttons) {
      for (const b of m.interactive.buttons) buttons.push(b);
    }
    if (m.interactive?.sections) {
      for (const s of m.interactive.sections) {
        for (const r of (s.rows || [])) buttons.push({ id: r.id, title: r.title });
      }
    }
  }
  return buttons;
}

async function send(message: string): Promise<string> {
  const data = await apiSend(BASE_URL, AUTH_TOKEN, message);
  return extractText(data);
}

async function tap(buttonId: string): Promise<string> {
  const data = await apiTap(BASE_URL, AUTH_TOKEN, buttonId);
  return extractText(data);
}

async function dbQuery(sql: string, params: any[] = []): Promise<any[]> {
  return apiDbQuery(BASE_URL, AUTH_TOKEN, sql, params);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============= SETUP =============

async function setupBaseData(): Promise<void> {
  console.log('\n  Setting up base data...\n');

  // Field 1: "La Esperanza" in Pergamino
  let r = await send('agregar campo La Esperanza');
  console.log('    -> agregar campo La Esperanza:', r.substring(0, 60));
  r = await tap('flow_field_loc_city');
  console.log('    -> loc city:', r.substring(0, 60));
  r = await send('Pergamino');
  console.log('    -> Pergamino:', r.substring(0, 60));
  r = await tap('flow_confirm');
  console.log('    -> confirm:', r.substring(0, 60));
  await send('cancelar');

  // Plot Norte - 150 has
  r = await send('agregar lote Norte al campo La Esperanza');
  console.log('    -> lote Norte:', r.substring(0, 60));
  r = await send('150');
  console.log('    -> 150 has:', r.substring(0, 60));
  await send('cancelar');

  // Plot Sur - 80 has
  r = await send('agregar lote Sur al campo La Esperanza');
  console.log('    -> lote Sur:', r.substring(0, 60));
  r = await send('80');
  console.log('    -> 80 has:', r.substring(0, 60));
  await send('cancelar');

  // Plot 1A - 100 has
  r = await send('agregar lote 1A al campo La Esperanza');
  console.log('    -> lote 1A:', r.substring(0, 60));
  r = await send('100');
  console.log('    -> 100 has:', r.substring(0, 60));
  await send('cancelar');

  // Plot Noreste - 60 has (for disambiguation test 27)
  r = await send('agregar lote Noreste al campo La Esperanza');
  console.log('    -> lote Noreste:', r.substring(0, 60));
  r = await send('60');
  console.log('    -> 60 has:', r.substring(0, 60));
  await send('cancelar');

  // Field 2: "San Martin" in Venado Tuerto (non-ambiguous city)
  r = await send('agregar campo San Martin');
  console.log('    -> agregar campo San Martin:', r.substring(0, 60));
  r = await tap('flow_field_loc_city');
  console.log('    -> loc city:', r.substring(0, 60));
  r = await send('Venado Tuerto');
  console.log('    -> Venado Tuerto:', r.substring(0, 60));
  // May show confirm button or need to handle disambiguation
  if (r.includes('Confirmar') || r.includes('confirmar')) {
    r = await tap('flow_confirm');
    console.log('    -> confirm:', r.substring(0, 60));
  }
  await send('cancelar');

  // Plot Principal - 200 has
  r = await send('agregar lote Principal al campo San Martin');
  console.log('    -> lote Principal:', r.substring(0, 60));
  r = await send('200');
  console.log('    -> 200 has:', r.substring(0, 60));
  await send('cancelar');

  // Plot Reserva - 50 has (NO crop)
  r = await send('agregar lote Reserva al campo San Martin');
  console.log('    -> lote Reserva:', r.substring(0, 60));
  r = await send('50');
  console.log('    -> 50 has:', r.substring(0, 60));
  await send('cancelar');

  // Sow crops
  r = await send('sembre soja en el lote Norte');
  console.log('    -> soja Norte:', r.substring(0, 60));
  await send('cancelar');

  r = await send('sembre maiz en el lote Sur');
  console.log('    -> maiz Sur:', r.substring(0, 60));
  await send('cancelar');

  r = await send('sembre trigo en el lote 1A');
  console.log('    -> trigo 1A:', r.substring(0, 60));
  await send('cancelar');

  r = await send('sembre soja en el lote Principal del campo San Martin');
  console.log('    -> soja Principal:', r.substring(0, 60));
  await send('cancelar');

  // Livestock
  r = await send('agregue 100 vacas en el lote Norte');
  console.log('    -> 100 vacas Norte:', r.substring(0, 60));
  await send('cancelar');

  r = await send('agregue 50 novillos en el lote Sur');
  console.log('    -> 50 novillos Sur:', r.substring(0, 60));
  await send('cancelar');

  r = await send('agregue 30 terneros en el lote Principal del campo San Martin');
  console.log('    -> 30 terneros Principal:', r.substring(0, 60));
  await send('cancelar');

  // Stock: warehouse + some items
  r = await send('crear deposito Galpon Central');
  console.log('    -> crear deposito:', r.substring(0, 60));
  await send('cancelar');

  r = await send('agregar 500 litros de glifosato al Galpon Central');
  console.log('    -> stock glifosato:', r.substring(0, 60));
  await send('cancelar');

  r = await send('agregar 2000 kg de urea al Galpon Central');
  console.log('    -> stock urea:', r.substring(0, 60));
  await send('cancelar');

  console.log('\n  Base data setup complete.\n');
}

// ============= CATEGORY 1: Silent Data Corruption (01-08) =============

async function test01(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Send the exact same expense twice rapidly (with plot to avoid pending flow)
  const msg = 'gaste 5000 en gasoil en el lote Norte';
  const [data1, data2] = await Promise.all([
    apiSend(BASE_URL, AUTH_TOKEN, msg),
    apiSend(BASE_URL, AUTH_TOKEN, msg),
  ]);
  const r1 = extractText(data1);
  const r2 = extractText(data2);
  convo.push({ role: 'user', message: msg + ' (sent twice simultaneously)', response: r1 + ' | ' + r2 });

  // Confirm any pending confirmations (both may need confirmation)
  if (r1.includes('Confirmar') || r2.includes('Confirmar')) {
    await tap('confirm_pending');
    await sleep(500);
    // Second confirm attempt (if the first one created a new pending)
    try { await tap('confirm_pending'); } catch { /* no more pending */ }
  }

  // Wait for DB to settle
  await sleep(1500);

  // Check DB for duplicates
  const rows = await dbQuery(
    `SELECT COUNT(*) as cnt FROM expenses WHERE user_id = $1 AND description ILIKE '%gasoil%' AND deleted_at IS NULL`,
    [USER_ID]
  );
  const count = parseInt(rows[0]?.cnt || '0');

  let status: TestResult['status'] = 'PASS';
  let notes = '';
  if (count > 1) {
    status = 'FAIL';
    notes = `Created ${count} duplicate expenses for the same message sent simultaneously`;
  } else if (count === 0) {
    status = 'WARN';
    notes = 'No expense created at all (both requests may have been dropped)';
  } else {
    notes = 'Only 1 expense created despite simultaneous sends - no duplication';
  }

  return {
    test_name: '01_duplicate_expense_rapid',
    category: 'silent_corruption',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['Should NOT create duplicate expenses when same message sent twice rapidly'],
    possible_failures: ['Creates 2 identical expenses', 'Race condition causes data corruption'],
    actual_result: `DB count: ${count}, responses: ${r1.substring(0, 60)} | ${r2.substring(0, 60)}`,
    notes,
  };
}

async function test02(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Register an expense (with plot to avoid pending flow)
  let r = await send('gaste 15000 en fertilizante en el lote Norte');
  convo.push({ role: 'user', message: 'gaste 15000 en fertilizante en el lote Norte', response: r });

  // Query it
  r = await send('cuanto gaste en fertilizante?');
  convo.push({ role: 'user', message: 'cuanto gaste en fertilizante?', response: r });

  // Try to "correct" it
  r = await send('no, eran 20000');
  convo.push({ role: 'user', message: 'no, eran 20000', response: r });

  // Check DB - should have either 1 expense at 20000 or still 1 at 15000
  await sleep(500);
  const rows = await dbQuery(
    `SELECT amount FROM expenses WHERE user_id = $1 AND description ILIKE '%fertilizante%' AND deleted_at IS NULL ORDER BY created_at DESC`,
    [USER_ID]
  );

  const amounts = rows.map(r => parseFloat(r.amount));
  const hasDuplicate = amounts.length > 1;
  const wasModified = amounts.length === 1 && amounts[0] === 20000;
  const unchanged = amounts.length === 1 && amounts[0] === 15000;

  let status: TestResult['status'];
  let notes: string;
  if (hasDuplicate) {
    status = 'FAIL';
    notes = `Created duplicate entries: ${amounts.join(', ')} - correction created new expense instead of modifying`;
  } else if (wasModified) {
    status = 'PASS';
    notes = 'Expense was correctly updated to 20000';
  } else if (unchanged) {
    status = 'WARN';
    notes = 'Correction was ignored - expense remains at 15000 (bot may not support conversational edits)';
  } else {
    status = 'WARN';
    notes = `Unexpected state: ${JSON.stringify(amounts)}`;
  }

  return {
    test_name: '02_amount_mutation_context',
    category: 'silent_corruption',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['Correction "no, eran 20000" should either update the expense or explicitly ask for confirmation'],
    possible_failures: ['Creates second expense instead of updating', 'Silently ignores correction', 'Creates observation'],
    actual_result: `DB amounts: ${JSON.stringify(amounts)}, last response: ${r.substring(0, 80)}`,
    notes,
  };
}

async function test03(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Spray lote 1A (trigo)
  let r = await send('fumigue el lote 1A con glifosato 2lt/ha');
  convo.push({ role: 'user', message: 'fumigue el lote 1A con glifosato 2lt/ha', response: r });

  // Then use "ahi" reference
  r = await send('fumigue tambien ahi con 2,4D 1lt/ha');
  convo.push({ role: 'user', message: 'fumigue tambien ahi con 2,4D 1lt/ha', response: r });

  // Check if "ahi" resolved to 1A
  const mentions1A = r.toLowerCase().includes('1a');
  const asksWhich = r.toLowerCase().includes('cuál') || r.toLowerCase().includes('qué lote');
  const mentionsOther = r.toLowerCase().includes('norte') || r.toLowerCase().includes('sur');

  let status: TestResult['status'];
  let notes: string;
  if (mentions1A && !mentionsOther) {
    status = 'PASS';
    notes = '"ahi" correctly resolved to lote 1A from previous context';
  } else if (asksWhich) {
    status = 'WARN';
    notes = 'Bot asked which plot instead of using context (acceptable but suboptimal)';
  } else if (mentionsOther) {
    status = 'FAIL';
    notes = 'Bot resolved "ahi" to a DIFFERENT plot than 1A - context leak';
  } else {
    status = 'WARN';
    notes = `Response unclear: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '03_wrong_plot_assignment_similar_names',
    category: 'silent_corruption',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['"ahi" should resolve to lote 1A from previous spray context'],
    possible_failures: ['Resolves to wrong plot', 'Assigns to Norte/Sur instead of 1A', 'Creates duplicate on wrong plot'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test04(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Sell soja with ambiguous currency — specify plot and confirm
  let r = await send('vendi soja a 300 el kg en el lote Norte');
  convo.push({ role: 'user', message: 'vendi soja a 300 el kg en el lote Norte', response: r });
  // Confirm if pending
  if (r.includes('Confirmar') || r.includes('confirm')) {
    r = await tap('confirm_pending');
  }

  // Now sell maiz explicitly in USD — specify plot
  r = await send('vendi maiz a 200 dolares la tonelada en el lote Sur');
  convo.push({ role: 'user', message: 'vendi maiz a 200 dolares la tonelada en el lote Sur', response: r });
  // Confirm if pending
  if (r.includes('Confirmar') || r.includes('confirm')) {
    r = await tap('confirm_pending');
  }

  // Check DB currencies
  await sleep(500);
  const rows = await dbQuery(
    `SELECT description, currency, amount FROM incomes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 2`,
    [USER_ID]
  );

  const usdEntry = rows.find(r => r.description?.toLowerCase().includes('maiz') || r.description?.toLowerCase().includes('maíz'));
  const arsEntry = rows.find(r => r.description?.toLowerCase().includes('soja'));

  let status: TestResult['status'];
  let notes: string;
  if (usdEntry?.currency === 'USD' && (arsEntry?.currency === 'ARS' || !arsEntry)) {
    status = 'PASS';
    notes = `Currencies correct: maiz=${usdEntry.currency}, soja=${arsEntry?.currency || 'N/A'}`;
  } else if (usdEntry?.currency !== 'USD') {
    status = 'FAIL';
    notes = `"dolares" not recognized: maiz stored as ${usdEntry?.currency || 'not found'}`;
  } else {
    status = 'WARN';
    notes = `Partial: ${JSON.stringify(rows.map(r => ({ desc: r.description?.substring(0, 20), curr: r.currency })))}`;
  }

  return {
    test_name: '04_currency_confusion',
    category: 'silent_corruption',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['"300 el kg" should be ARS (default), "200 dolares" should be USD'],
    possible_failures: ['Both stored as ARS', 'Both stored as USD', 'Currency field empty'],
    actual_result: JSON.stringify(rows.map(r => ({ desc: r.description?.substring(0, 30), curr: r.currency, amt: r.amount }))),
    notes,
  };
}

async function test05(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await send('cosechamos -500 kg en norte');
  convo.push({ role: 'user', message: 'cosechamos -500 kg en norte', response: r });

  // Check if negative was stored
  await sleep(500);
  const rows = await dbQuery(
    `SELECT quantity FROM domain_events WHERE user_id = $1 AND event_type = 'harvest' AND quantity < 0`,
    [USER_ID]
  );

  const negativeStored = rows.length > 0;
  const botWarned = r.toLowerCase().includes('negativ') || r.toLowerCase().includes('no se puede') || r.toLowerCase().includes('inválid') || r.toLowerCase().includes('error');

  let status: TestResult['status'];
  let notes: string;
  if (negativeStored) {
    status = 'FAIL';
    notes = 'Negative yield stored in DB without validation';
  } else if (botWarned) {
    status = 'PASS';
    notes = 'Bot rejected negative quantity with appropriate warning';
  } else {
    status = 'PASS';
    notes = `No negative stored and response: ${r.substring(0, 80)}`;
  }

  return {
    test_name: '05_negative_quantity_injection',
    category: 'silent_corruption',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['Should reject or warn about negative harvest yield, NEVER store negative'],
    possible_failures: ['Stores -500 kg yield', 'Interprets as expense removal', 'Crashes'],
    actual_result: `DB negative rows: ${rows.length}, response: ${r.substring(0, 80)}`,
    notes,
  };
}

async function test06(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await send('sembre soja en 0 hectareas del lote Sur');
  convo.push({ role: 'user', message: 'sembre soja en 0 hectareas del lote Sur', response: r });

  // Check if a crop was created with 0 hectares
  await sleep(500);
  const rows = await dbQuery(
    `SELECT pc.sowed_hectares, p.name FROM plot_crops pc
     JOIN plots p ON p.id = pc.plot_id
     JOIN fields f ON f.id = p.field_id
     WHERE f.user_id = $1 AND pc.sowed_hectares = 0`,
    [USER_ID]
  );

  const zeroHaStored = rows.length > 0;
  const botRejected = r.toLowerCase().includes('no se puede') || r.toLowerCase().includes('inválid') || r.toLowerCase().includes('0') || r.toLowerCase().includes('hectárea');

  let status: TestResult['status'];
  let notes: string;
  if (zeroHaStored) {
    status = 'FAIL';
    notes = 'Created crop with 0 hectares - invalid business state';
  } else {
    status = 'PASS';
    notes = botRejected ? 'Rejected zero hectares appropriately' : 'Zero hectares not stored (good)';
  }

  return {
    test_name: '06_zero_hectares_sow',
    category: 'silent_corruption',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['Should reject sowing with 0 hectares'],
    possible_failures: ['Creates crop record with 0 area', 'Ignores hectares param and uses full plot area', 'Crashes'],
    actual_result: `Zero-ha crops in DB: ${rows.length}, response: ${r.substring(0, 80)}`,
    notes,
  };
}

async function test07(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await send('gaste 50000 en semillas el 15 de diciembre de 2027');
  convo.push({ role: 'user', message: 'gaste 50000 en semillas el 15 de diciembre de 2027', response: r });

  // Check DB for far-future date
  await sleep(500);
  const rows = await dbQuery(
    `SELECT expense_date FROM expenses WHERE user_id = $1 AND description ILIKE '%semilla%' AND expense_date > '2027-01-01' AND deleted_at IS NULL`,
    [USER_ID]
  );

  const futureStored = rows.length > 0;
  const botWarned = r.toLowerCase().includes('futuro') || r.toLowerCase().includes('2027') || r.toLowerCase().includes('seguro');

  let status: TestResult['status'];
  let notes: string;
  if (futureStored && !botWarned) {
    status = 'FAIL';
    notes = 'Stored expense with date in Dec 2027 without any warning';
  } else if (futureStored && botWarned) {
    status = 'PASS';
    notes = 'Stored but warned about far-future date';
  } else if (!futureStored) {
    status = 'PASS';
    notes = 'Did not store far-future expense (rejected or used different date)';
  } else {
    status = 'WARN';
    notes = `Unclear: ${r.substring(0, 80)}`;
  }

  return {
    test_name: '07_future_date_expense',
    category: 'silent_corruption',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['Should warn about far-future date (Dec 2027) or reject it'],
    possible_failures: ['Silently stores expense with 2027 date', 'Does not validate date range'],
    actual_result: `Future rows: ${rows.length}, response: ${r.substring(0, 80)}`,
    notes,
  };
}

async function test08(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Norte already has soja from setup. Try to sow maiz on top.
  let r = await send('sembre maiz en el lote Norte');
  convo.push({ role: 'user', message: 'sembre maiz en el lote Norte', response: r });

  const warns = r.toLowerCase().includes('soja') || r.toLowerCase().includes('activ') || r.toLowerCase().includes('ya tiene') || r.toLowerCase().includes('cosechar');
  const silentOverwrite = r.toLowerCase().includes('maíz') && r.toLowerCase().includes('registr') && !warns;

  let status: TestResult['status'];
  let notes: string;
  if (warns) {
    status = 'PASS';
    notes = 'Bot warned about existing active crop (soja) before allowing sow';
  } else if (silentOverwrite) {
    status = 'FAIL';
    notes = 'Bot silently sowed maiz over existing soja without warning';
  } else {
    status = 'WARN';
    notes = `Response unclear about conflict handling: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '08_overwrite_active_crop',
    category: 'silent_corruption',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['Should warn that Norte already has active soja crop before allowing new sow'],
    possible_failures: ['Silently overwrites active crop', 'Creates second active crop on same plot', 'No validation'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

// ============= CATEGORY 2: Memory Drift / Context Pollution (09-16) =============

async function test09(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Mention lote Norte explicitly
  let r = await send('cuantas has tiene el lote Norte?');
  convo.push({ role: 'user', message: 'cuantas has tiene el lote Norte?', response: r });

  // Send 10 unrelated messages to decay context
  const fillers = [
    'hola', 'que hora es?', 'buen dia', 'todo bien',
    'como esta el clima?', 'gracias', 'ok', 'dale',
    'perfecto', 'buenisimo'
  ];
  for (const filler of fillers) {
    await send(filler);
    await sleep(200);
  }
  convo.push({ role: 'user', message: '(10 filler messages sent)', response: '...' });

  // Now use implicit reference
  r = await send('fumigue ahi con glifosato');
  convo.push({ role: 'user', message: 'fumigue ahi con glifosato', response: r });

  const remembersNorte = r.toLowerCase().includes('norte');
  const asks = r.toLowerCase().includes('cuál') || r.toLowerCase().includes('qué lote') || r.toLowerCase().includes('dónde');

  let status: TestResult['status'];
  let notes: string;
  if (remembersNorte) {
    status = 'PASS';
    notes = 'Context survived 10 intervening messages - "ahi" resolved to Norte';
  } else if (asks) {
    status = 'WARN';
    notes = 'Context decayed after 10 messages - bot asked which plot (acceptable given 4000 char budget)';
  } else {
    status = 'FAIL';
    notes = `Neither remembered nor asked - may have assigned to wrong plot: ${r.substring(0, 80)}`;
  }

  return {
    test_name: '09_context_decay_10_messages',
    category: 'memory_drift',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"ahi" should resolve to Norte or bot should ask (context may have decayed)'],
    possible_failures: ['Assigns to wrong plot without asking', 'Creates observation instead of activity'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test10(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Ask about Principal (San Martin field)
  let r = await send('que cultivo tiene el lote Principal?');
  convo.push({ role: 'user', message: 'que cultivo tiene el lote Principal?', response: r });

  // Then ask about Norte (La Esperanza field)
  r = await send('y el lote Norte?');
  convo.push({ role: 'user', message: 'y el lote Norte?', response: r });

  // Now ask about "ese campo" - should be La Esperanza (last field context = Norte's field)
  r = await send('gastos de ese campo');
  convo.push({ role: 'user', message: 'gastos de ese campo', response: r });

  const mentionsEsperanza = r.toLowerCase().includes('esperanza');
  const mentionsSanMartin = r.toLowerCase().includes('san mart') || r.toLowerCase().includes('martin');
  const asks = r.toLowerCase().includes('cuál') || r.toLowerCase().includes('qué campo');

  let status: TestResult['status'];
  let notes: string;
  if (mentionsEsperanza && !mentionsSanMartin) {
    status = 'PASS';
    notes = '"ese campo" correctly resolved to La Esperanza (Norte is context)';
  } else if (mentionsSanMartin && !mentionsEsperanza) {
    status = 'WARN';
    notes = 'Context resolved to San Martin instead of La Esperanza — context tracking may not reflect latest query';
  } else if (asks) {
    status = 'WARN';
    notes = 'Bot asked which field (acceptable disambiguation)';
  } else {
    status = 'WARN';
    notes = `Could not determine field resolution from response: ${r.substring(0, 80)}`;
  }

  return {
    test_name: '10_cross_field_context_leak',
    category: 'memory_drift',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['"ese campo" after mentioning Norte should resolve to La Esperanza, not San Martin'],
    possible_failures: ['Resolves to San Martin (first field mentioned)', 'Context from Principal leaks into resolution'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test11(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Register expense in lote Norte explicitly
  let r = await send('gaste 10000 en gasoil para el lote Norte');
  convo.push({ role: 'user', message: 'gaste 10000 en gasoil para el lote Norte', response: r });

  // Now register another expense without specifying plot
  r = await send('gaste 5000 en repuestos');
  convo.push({ role: 'user', message: 'gaste 5000 en repuestos', response: r });

  // Check if it inherited Norte or left plot null
  await sleep(500);
  const rows = await dbQuery(
    `SELECT e.description, e.plot_id, p.name as plot_name
     FROM expenses e LEFT JOIN plots p ON p.id = e.plot_id
     WHERE e.user_id = $1 AND e.description ILIKE '%repuesto%' AND e.deleted_at IS NULL
     ORDER BY e.created_at DESC LIMIT 1`,
    [USER_ID]
  );

  const inheritedPlot = rows.length > 0 && rows[0].plot_id != null;
  const askedPlot = r.toLowerCase().includes('lote') || r.toLowerCase().includes('cuál') || r.toLowerCase().includes('campo');

  let status: TestResult['status'];
  let notes: string;
  if (inheritedPlot) {
    status = 'FAIL';
    notes = `Silently inherited plot "${rows[0].plot_name}" from previous message - should not auto-assign`;
  } else if (askedPlot) {
    status = 'WARN';
    notes = 'Bot asked which plot (expenses do not always need a plot)';
  } else {
    status = 'PASS';
    notes = 'Expense created without inheriting plot from previous context (correct)';
  }

  return {
    test_name: '11_stale_pronoun_after_action',
    category: 'memory_drift',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['New expense without plot mention should NOT inherit plot from previous message'],
    possible_failures: ['Silently assigns Norte to unrelated expense', 'Context bleeds between actions'],
    actual_result: `plot_id=${rows[0]?.plot_id || 'null'}, plot_name=${rows[0]?.plot_name || 'null'}`,
    notes,
  };
}

async function test12(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Spray Norte with glifosato
  let r = await send('fumigue el norte con glifosato 3lt/ha');
  convo.push({ role: 'user', message: 'fumigue el norte con glifosato 3lt/ha', response: r });

  // Spray Sur with 2,4D
  r = await send('fumigue el sur con 2,4D 1.5lt/ha');
  convo.push({ role: 'user', message: 'fumigue el sur con 2,4D 1.5lt/ha', response: r });

  // Query: what was applied to Norte?
  r = await send('que se le puso al norte?');
  convo.push({ role: 'user', message: 'que se le puso al norte?', response: r });

  const mentionsGlifosato = r.toLowerCase().includes('glifosato');
  const mentions24D = r.toLowerCase().includes('2,4') || r.toLowerCase().includes('2,4d');
  const mentionsBoth = mentionsGlifosato && mentions24D;

  let status: TestResult['status'];
  let notes: string;
  if (mentionsGlifosato && !mentions24D) {
    status = 'PASS';
    notes = 'Correctly attributed glifosato to Norte (not 2,4D from Sur)';
  } else if (mentions24D && !mentionsGlifosato) {
    status = 'FAIL';
    notes = 'WRONG attribution: showed 2,4D (Sur product) for Norte query';
  } else if (mentionsBoth) {
    status = 'WARN';
    notes = 'Showed both products - may have confused plots or shown all recent sprays';
  } else {
    status = 'WARN';
    notes = `Response did not clearly show product: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '12_entity_confusion_same_verb',
    category: 'memory_drift',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['Query about Norte should show glifosato, NOT 2,4D which was for Sur'],
    possible_failures: ['Shows 2,4D for Norte (entity confusion)', 'Mixes up plot-product attributions'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test13(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Compound action
  let r = await send('sembre soja en el lote Principal y maiz en el lote Sur');
  convo.push({ role: 'user', message: 'sembre soja en el lote Principal y maiz en el lote Sur', response: r });

  // "ahi" after compound is ambiguous
  r = await send('cuanto rindio ahi?');
  convo.push({ role: 'user', message: 'cuanto rindio ahi?', response: r });

  const asks = r.toLowerCase().includes('cuál') || r.toLowerCase().includes('qué lote') || r.toLowerCase().includes('principal') && r.toLowerCase().includes('sur');
  const answersOne = (r.toLowerCase().includes('principal') || r.toLowerCase().includes('sur')) && !asks;

  let status: TestResult['status'];
  let notes: string;
  if (asks) {
    status = 'PASS';
    notes = 'Bot correctly identified ambiguity after compound and asked which plot';
  } else if (answersOne) {
    status = 'WARN';
    notes = `Bot picked one plot without disambiguation (picked last? ${r.substring(0, 60)})`;
  } else {
    status = 'WARN';
    notes = `Response: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '13_compound_context_bleed',
    category: 'memory_drift',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"ahi" after compound action is ambiguous - bot should ask which plot'],
    possible_failures: ['Picks last plot silently', 'Picks first plot silently', 'Crashes'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test14(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Start a field flow
  let r = await send('agregar campo Nuevo');
  convo.push({ role: 'user', message: 'agregar campo Nuevo', response: r });

  // Cancel it
  r = await send('cancelar');
  convo.push({ role: 'user', message: 'cancelar', response: r });

  // Try to resume the cancelled flow
  r = await send('si, registra eso');
  convo.push({ role: 'user', message: 'si, registra eso', response: r });

  const resumed = r.toLowerCase().includes('nuevo') && (r.toLowerCase().includes('campo') || r.toLowerCase().includes('creado'));
  const notResumed = r.toLowerCase().includes('no hay') || r.toLowerCase().includes('no entend') || r.toLowerCase().includes('qué') || !resumed;

  let status: TestResult['status'];
  let notes: string;
  if (resumed) {
    status = 'FAIL';
    notes = 'Cancelled flow was RESUMED by "si, registra eso" - state not properly cleared';
  } else {
    status = 'PASS';
    notes = 'Cancelled flow not resumed - state was properly cleared';
  }

  return {
    test_name: '14_cancel_then_reference',
    category: 'memory_drift',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['After cancel, "si registra eso" should NOT resume the cancelled flow'],
    possible_failures: ['Resumes field creation flow', 'Creates "Nuevo" field', 'State leak after cancel'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test15(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Register livestock
  let r = await send('tengo 50 vacas en el lote Norte');
  convo.push({ role: 'user', message: 'tengo 50 vacas en el lote Norte', response: r });

  // Register expense with number
  r = await send('gaste 50000 en alimento');
  convo.push({ role: 'user', message: 'gaste 50000 en alimento', response: r });

  // Ask about cattle count - should be 50 (not confused with 50000)
  r = await send('cuantas vacas tengo?');
  convo.push({ role: 'user', message: 'cuantas vacas tengo?', response: r });

  const shows50 = r.includes('50') && !r.includes('50000') && !r.includes('50.000');
  const showsLivestock = r.toLowerCase().includes('vaca') || r.toLowerCase().includes('cabeza') || r.toLowerCase().includes('hacienda');
  const showsExpense = r.toLowerCase().includes('gasto') || r.toLowerCase().includes('$');

  let status: TestResult['status'];
  let notes: string;
  if (showsLivestock && !showsExpense) {
    status = 'PASS';
    notes = 'Correctly reported cattle count without confusing with expense amount';
  } else if (showsExpense) {
    status = 'FAIL';
    notes = 'Confused cattle query with expense data';
  } else {
    status = 'WARN';
    notes = `Response: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '15_number_context_confusion',
    category: 'memory_drift',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"cuantas vacas" should show cattle count (50), not confuse with expense amount (50000)'],
    possible_failures: ['Shows 50000 from expense context', 'Confuses livestock with financial data'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test16(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Reference "esperanza" - could be field "La Esperanza" or could it match a plot?
  let r = await send('cuantas hectareas tiene esperanza?');
  convo.push({ role: 'user', message: 'cuantas hectareas tiene esperanza?', response: r });

  // Check what it resolved to
  const showsField = r.toLowerCase().includes('la esperanza') || r.toLowerCase().includes('campo');
  const showsAllPlots = r.includes('150') || r.includes('80') || r.includes('100');
  const showsSinglePlot = !showsAllPlots && (r.includes('150') || r.includes('80') || r.includes('100'));

  let status: TestResult['status'];
  let notes: string;
  if (showsField || showsAllPlots) {
    status = 'PASS';
    notes = 'Resolved "esperanza" to field "La Esperanza" and showed total/per-plot hectares';
  } else {
    status = 'WARN';
    notes = `Unclear resolution: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '16_field_vs_plot_name_collision',
    category: 'memory_drift',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"esperanza" should resolve to field "La Esperanza" (partial match)'],
    possible_failures: ['Does not match any entity', 'Matches wrong entity', 'Creates confusion with partial match'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

// ============= CATEGORY 3: Temporal Contradictions (17-22) =============

async function test17(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Soja was sowed recently (in setup). Try to spray BEFORE sow date.
  let r = await send('fumigue el lote Norte el 1 de enero de 2025');
  convo.push({ role: 'user', message: 'fumigue el lote Norte el 1 de enero de 2025', response: r });

  // Check if it warned about date being before sow
  const warns = r.toLowerCase().includes('antes') || r.toLowerCase().includes('siembra') || r.toLowerCase().includes('2025') || r.toLowerCase().includes('fecha');
  const registered = r.toLowerCase().includes('registr') || r.toLowerCase().includes('fumig');

  // Also check DB
  await sleep(500);
  const rows = await dbQuery(
    `SELECT event_date FROM domain_events
     WHERE user_id = $1 AND event_type = 'spray' AND event_date < '2025-02-01'`,
    [USER_ID]
  );

  let status: TestResult['status'];
  let notes: string;
  if (rows.length > 0 && !warns) {
    status = 'WARN';
    notes = 'Registered spray with 2025 date without warning about temporal inconsistency';
  } else if (warns) {
    status = 'PASS';
    notes = 'Bot warned about date being before crop sow date';
  } else {
    status = 'PASS';
    notes = `No pre-sow activity stored. Response: ${r.substring(0, 60)}`;
  }

  return {
    test_name: '17_past_date_before_sow',
    category: 'temporal_contradiction',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['Spraying before sow date should trigger warning or rejection'],
    possible_failures: ['Stores activity with date before sow', 'No temporal validation'],
    actual_result: `DB rows: ${rows.length}, response: ${r.substring(0, 80)}`,
    notes,
  };
}

async function test18(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Reserva has NO crop. Try to harvest it.
  let r = await send('coseche el lote Reserva');
  convo.push({ role: 'user', message: 'coseche el lote Reserva', response: r });

  const rejects = r.toLowerCase().includes('no tiene') || r.toLowerCase().includes('no hay') || r.toLowerCase().includes('sin cultivo') || r.toLowerCase().includes('activo');
  const harvested = r.toLowerCase().includes('cosech') && r.toLowerCase().includes('registr');

  let status: TestResult['status'];
  let notes: string;
  if (rejects) {
    status = 'PASS';
    notes = 'Bot correctly rejected harvest on plot without active crop';
  } else if (harvested) {
    status = 'FAIL';
    notes = 'Bot allowed harvest on plot with no active crop';
  } else {
    status = 'WARN';
    notes = `Response unclear: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '18_harvest_before_sow',
    category: 'temporal_contradiction',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['Harvesting a plot with no crop should fail cleanly'],
    possible_failures: ['Creates harvest event on empty plot', 'Crashes', 'Creates observation'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test19(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Two sprays on same plot, same day, different products
  let r = await send('fumigue el lote Norte con glifosato 2lt/ha hoy a la manana');
  convo.push({ role: 'user', message: 'fumigue el lote Norte con glifosato 2lt/ha hoy a la manana', response: r });

  r = await send('fumigue el lote Norte con 2,4D 1lt/ha hoy a la tarde');
  convo.push({ role: 'user', message: 'fumigue el lote Norte con 2,4D 1lt/ha hoy a la tarde', response: r });

  // Both should exist as separate events
  await sleep(500);
  const rows = await dbQuery(
    `SELECT product FROM domain_events
     WHERE user_id = $1 AND event_type = 'spray'
     AND event_date >= CURRENT_DATE
     ORDER BY created_at DESC LIMIT 5`,
    [USER_ID]
  );

  const products = rows.map(r => r.product?.toLowerCase() || '');
  const hasGlifosato = products.some(p => p.includes('glifosato'));
  const has24D = products.some(p => p.includes('2,4'));

  let status: TestResult['status'];
  let notes: string;
  if (hasGlifosato && has24D) {
    status = 'PASS';
    notes = 'Both spray events created as separate records (correct)';
  } else if (hasGlifosato || has24D) {
    status = 'FAIL';
    notes = `Only one spray stored: ${products.join(', ')} - second may have overwritten first`;
  } else {
    status = 'WARN';
    notes = `Could not verify in DB. Products found: ${JSON.stringify(products)}`;
  }

  return {
    test_name: '19_overlapping_activities_same_day',
    category: 'temporal_contradiction',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['Two different sprays on same day/plot should create 2 separate events'],
    possible_failures: ['Second spray overwrites first', 'Deduplication incorrectly merges them'],
    actual_result: `Products in DB: ${JSON.stringify(products)}`,
    notes,
  };
}

async function test20(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Report yield
  let r = await send('el lote 1A rindio 3000 kg/ha');
  convo.push({ role: 'user', message: 'el lote 1A rindio 3000 kg/ha', response: r });

  // Immediately contradict
  r = await send('no mentira, rindio 2500 kg/ha');
  convo.push({ role: 'user', message: 'no mentira, rindio 2500 kg/ha', response: r });

  // Check DB for duplicates
  await sleep(500);
  const rows = await dbQuery(
    `SELECT de.quantity, pc.yield_kg FROM domain_events de
     LEFT JOIN plot_crops pc ON pc.id = de.plot_crop_id
     WHERE de.user_id = $1 AND de.event_type = 'harvest'
     ORDER BY de.created_at DESC LIMIT 3`,
    [USER_ID]
  );

  const yieldValues = rows.map(r => r.yield_kg || r.quantity).filter(Boolean);
  const hasDuplicateHarvest = rows.length > 1;

  let status: TestResult['status'];
  let notes: string;
  if (hasDuplicateHarvest) {
    status = 'WARN';
    notes = `Multiple harvest events: ${JSON.stringify(yieldValues)} - may need manual cleanup`;
  } else if (yieldValues.length === 1) {
    const val = parseInt(yieldValues[0]);
    if (val === 2500 || val === 250000) {
      status = 'PASS';
      notes = 'Yield was updated to corrected value (2500)';
    } else {
      status = 'WARN';
      notes = `Single yield stored: ${val}`;
    }
  } else {
    status = 'WARN';
    notes = `DB state: ${JSON.stringify(rows)}`;
  }

  return {
    test_name: '20_contradictory_yield',
    category: 'temporal_contradiction',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['Correction should update yield, not create duplicate harvest'],
    possible_failures: ['Creates two harvest events', 'Ignores correction', 'Original yield remains'],
    actual_result: `Yields in DB: ${JSON.stringify(yieldValues)}, response: ${r.substring(0, 80)}`,
    notes,
  };
}

async function test21(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // 800mm in one day is physically absurd (world record single day is ~1800mm)
  let r = await send('llovieron 800mm en el campo La Esperanza');
  convo.push({ role: 'user', message: 'llovieron 800mm en el campo La Esperanza', response: r });

  // Check if bot warns or stores blindly
  await sleep(500);
  const rows = await dbQuery(
    `SELECT millimeters FROM rainfall WHERE user_id = $1 AND millimeters = 800`,
    [USER_ID]
  );

  const stored = rows.length > 0;
  const warns = r.toLowerCase().includes('seguro') || r.toLowerCase().includes('mucho') || r.toLowerCase().includes('800');

  let status: TestResult['status'];
  let notes: string;
  if (stored && !warns) {
    status = 'WARN';
    notes = 'Stored 800mm without any sanity warning (unusual but not technically invalid)';
  } else if (warns) {
    status = 'PASS';
    notes = 'Bot questioned the extreme rainfall value';
  } else if (!stored) {
    status = 'PASS';
    notes = 'Did not store extreme value (rejected or asked for confirmation)';
  } else {
    status = 'WARN';
    notes = `Stored with some response: ${r.substring(0, 80)}`;
  }

  return {
    test_name: '21_rainfall_exceeds_physics',
    category: 'temporal_contradiction',
    severity: 'low',
    status,
    conversation: convo,
    expected_behavior: ['800mm in one day should trigger sanity warning (rare but possible in extreme events)'],
    possible_failures: ['Stores without question', 'No range validation on rainfall'],
    actual_result: `Stored: ${stored}, response: ${r.substring(0, 80)}`,
    notes,
  };
}

async function test22(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Current month is April. "15 de agosto" - is it past (2025) or future (2026)?
  let r = await send('coseche el lote 1A el 15 de agosto');
  convo.push({ role: 'user', message: 'coseche el lote 1A el 15 de agosto', response: r });

  // Check what date was stored
  await sleep(500);
  const rows = await dbQuery(
    `SELECT event_date FROM domain_events
     WHERE user_id = $1 AND event_type = 'harvest'
     AND event_date::text LIKE '%08-15%'
     ORDER BY created_at DESC LIMIT 1`,
    [USER_ID]
  );

  const storedDate = String(rows[0]?.event_date || '');
  const isFuture = storedDate.includes('2026-08') || storedDate.includes('2027-08');
  const isPast = storedDate.includes('2025-08') || storedDate.includes('2024-08');

  let status: TestResult['status'];
  let notes: string;
  if (isPast) {
    status = 'PASS';
    notes = `Interpreted "15 de agosto" as past (${storedDate}) - reasonable since it hasn't happened yet this year`;
  } else if (isFuture) {
    status = 'WARN';
    notes = `Interpreted as future date (${storedDate}) - August hasn't happened in 2026 yet`;
  } else if (!storedDate) {
    status = 'WARN';
    notes = `No harvest stored with August date. Response: ${r.substring(0, 80)}`;
  } else {
    status = 'WARN';
    notes = `Date stored: ${storedDate}`;
  }

  return {
    test_name: '22_future_harvest_date',
    category: 'temporal_contradiction',
    severity: 'low',
    status,
    conversation: convo,
    expected_behavior: ['"15 de agosto" in April should be interpreted as past August or bot should ask'],
    possible_failures: ['Stores future date without asking', 'Cannot determine year'],
    actual_result: `Stored date: ${storedDate || 'none'}, response: ${r.substring(0, 80)}`,
    notes,
  };
}

// ============= CATEGORY 4: Entity Collisions & Disambiguation (23-30) =============

async function test23(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // "rye" is English for centeno - should be normalized
  let r = await send('sembre rye en el lote Reserva');
  convo.push({ role: 'user', message: 'sembre rye en el lote Reserva', response: r });

  const normalizedToCenteno = r.toLowerCase().includes('centeno');
  const keptRye = r.toLowerCase().includes('rye');
  const registered = r.toLowerCase().includes('registr') || r.toLowerCase().includes('sembr');

  let status: TestResult['status'];
  let notes: string;
  if (normalizedToCenteno) {
    status = 'PASS';
    notes = '"rye" correctly normalized to "centeno"';
  } else if (keptRye && registered) {
    status = 'FAIL';
    notes = 'Stored "rye" without normalizing to "centeno" (synonym translation failed)';
  } else {
    status = 'WARN';
    notes = `Response: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '23_lote_vs_product_homonym',
    category: 'entity_collision',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"rye" should be normalized to "centeno" via anglicism synonyms'],
    possible_failures: ['Stores "rye" literally', 'Interprets as brand name', 'Normalization fails'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test24(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Add a plot named "100" first
  let r = await send('agregar lote 100 al campo San Martin');
  convo.push({ role: 'user', message: 'agregar lote 100 al campo San Martin', response: r });
  // Provide hectares for the flow
  r = await send('45');
  convo.push({ role: 'user', message: '45 (hectares)', response: r });
  await send('cancelar');

  // Now try to sow on plot "100"
  r = await send('sembre soja en 100');
  convo.push({ role: 'user', message: 'sembre soja en 100', response: r });

  const resolvedAsPlot = r.toLowerCase().includes('lote') || r.toLowerCase().includes('100');
  const resolvedAsHectares = r.toLowerCase().includes('hectárea') || r.toLowerCase().includes('parcial');

  let status: TestResult['status'];
  let notes: string;
  if (resolvedAsPlot && !resolvedAsHectares) {
    status = 'PASS';
    notes = '"100" resolved as plot name, not hectares quantity';
  } else if (resolvedAsHectares) {
    status = 'FAIL';
    notes = '"100" interpreted as hectares instead of plot name';
  } else {
    status = 'WARN';
    notes = `Ambiguous resolution: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '24_number_as_plot_name',
    category: 'entity_collision',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"sembre soja en 100" should interpret 100 as plot name (since it exists)'],
    possible_failures: ['Interprets as 100 hectares partial sow', 'Asks for plot when "100" IS the plot'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test25(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // "agregue vaca 1 en norte" vs "agregue 1 vaca en norte"
  let r = await send('agregue 1 vaca en el lote Norte');
  convo.push({ role: 'user', message: 'agregue 1 vaca en el lote Norte', response: r });

  const isQuantity = r.toLowerCase().includes('1') && (r.toLowerCase().includes('vaca') || r.toLowerCase().includes('registr') || r.toLowerCase().includes('cabeza'));

  // Second variant
  await send('cancelar');
  r = await send('agregue vaca 1 en el lote Norte');
  convo.push({ role: 'user', message: 'agregue vaca 1 en el lote Norte', response: r });

  // Both should add 1 cow (the "1" in "vaca 1" is likely an ear tag reference but there's no ear tag system)
  const secondIsQuantity = r.toLowerCase().includes('vaca') || r.toLowerCase().includes('registr');

  let status: TestResult['status'];
  let notes: string;
  if (isQuantity && secondIsQuantity) {
    status = 'PASS';
    notes = 'Both variants handled (quantity interpretation in both cases)';
  } else if (!isQuantity) {
    status = 'WARN';
    notes = `First variant unclear: ${convo[0].response?.substring(0, 60)}`;
  } else {
    status = 'WARN';
    notes = 'Inconsistent handling between "1 vaca" and "vaca 1"';
  }

  return {
    test_name: '25_animal_category_as_quantity',
    category: 'entity_collision',
    severity: 'low',
    status,
    conversation: convo,
    expected_behavior: ['Both "1 vaca" and "vaca 1" should add 1 cow (no ear tag system exists)'],
    possible_failures: ['"vaca 1" misinterpreted as category name', 'Quantity parsing fails on word order change'],
    actual_result: `First: ${convo[0].response?.substring(0, 40)}, Second: ${r.substring(0, 40)}`,
    notes,
  };
}

async function test26(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Field "La Esperanza" is in Pergamino. Ask weather for "Pergamino"
  let r = await send('clima en Pergamino');
  convo.push({ role: 'user', message: 'clima en Pergamino', response: r });

  const isWeather = r.toLowerCase().includes('temperatura') || r.toLowerCase().includes('lluv') || r.toLowerCase().includes('viento') || r.toLowerCase().includes('clima') || r.toLowerCase().includes('pronóstico') || r.toLowerCase().includes('°');
  const isField = r.toLowerCase().includes('lote') || r.toLowerCase().includes('hectárea') || r.toLowerCase().includes('campo');

  let status: TestResult['status'];
  let notes: string;
  if (isWeather && !isField) {
    status = 'PASS';
    notes = '"Pergamino" correctly interpreted as city for weather, not field/plot reference';
  } else if (isField) {
    status = 'FAIL';
    notes = 'Confused city name with field data - showed plot info instead of weather';
  } else {
    status = 'WARN';
    notes = `Response unclear: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '26_city_as_field_name',
    category: 'entity_collision',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"clima en Pergamino" should query weather for city, not show field info'],
    possible_failures: ['Resolves to field "La Esperanza" (which is IN Pergamino)', 'Shows plot data'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test27(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Both "Norte" and "Noreste" exist. Say "nor..."
  let r = await send('fumigue el nor con glifosato');
  convo.push({ role: 'user', message: 'fumigue el nor con glifosato', response: r });

  const asksWhich = r.toLowerCase().includes('cuál') || r.toLowerCase().includes('norte') && r.toLowerCase().includes('noreste');
  const pickedOne = (r.toLowerCase().includes('norte') && !r.toLowerCase().includes('noreste')) || (r.toLowerCase().includes('noreste') && !r.toLowerCase().includes('norte'));

  let status: TestResult['status'];
  let notes: string;
  if (asksWhich) {
    status = 'PASS';
    notes = 'Bot correctly detected ambiguity between Norte and Noreste, asked for clarification';
  } else if (pickedOne) {
    status = 'WARN';
    notes = `Bot picked one without asking (might be acceptable if "nor" clearly matches "Norte"): ${r.substring(0, 60)}`;
  } else {
    status = 'WARN';
    notes = `Response: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '27_partial_name_match',
    category: 'entity_collision',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"el nor" is ambiguous between Norte and Noreste - should ask or match Norte (exact start)'],
    possible_failures: ['Silently picks wrong plot', 'Crashes on ambiguous match', 'Creates new plot "nor"'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test28(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Impossible: 2 crops on same plot
  let r = await send('sembre soja y maiz en el lote Norte');
  convo.push({ role: 'user', message: 'sembre soja y maiz en el lote Norte', response: r });

  const rejects = r.toLowerCase().includes('no se puede') || r.toLowerCase().includes('un solo') || r.toLowerCase().includes('ya tiene');
  const asksWhich = r.toLowerCase().includes('cuál') || r.toLowerCase().includes('qué cultivo');
  const registered = r.toLowerCase().includes('registr') && r.toLowerCase().includes('soja') && r.toLowerCase().includes('maíz');

  let status: TestResult['status'];
  let notes: string;
  if (rejects || asksWhich) {
    status = 'PASS';
    notes = 'Bot correctly rejected or asked about impossible dual-crop sow';
  } else if (registered) {
    status = 'FAIL';
    notes = 'Bot registered 2 crops on same plot without rejection';
  } else {
    status = 'WARN';
    notes = `Response: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '28_compound_different_crops_same_plot',
    category: 'entity_collision',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['Cannot sow 2 different crops on same plot simultaneously - should reject or ask'],
    possible_failures: ['Creates both crops', 'Only sows first, silently drops second', 'Crashes'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test29(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Vacas exist in Norte (La Esperanza) from setup. Say "vendi 10 vacas" without location.
  let r = await send('vendi 10 vacas');
  convo.push({ role: 'user', message: 'vendi 10 vacas', response: r });

  const asksLocation = r.toLowerCase().includes('cuál') || r.toLowerCase().includes('dónde') || r.toLowerCase().includes('qué lote') || r.toLowerCase().includes('norte');
  const registered = r.toLowerCase().includes('registr') || r.toLowerCase().includes('remov') || r.toLowerCase().includes('venta');

  let status: TestResult['status'];
  let notes: string;
  if (asksLocation) {
    status = 'PASS';
    notes = 'Bot asked which location for livestock sale (correct disambiguation)';
  } else if (registered) {
    // If there's only one group of vacas, auto-resolve is acceptable
    status = 'PASS';
    notes = 'Bot auto-resolved (likely only 1 location has vacas) and registered sale';
  } else {
    status = 'WARN';
    notes = `Response: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '29_livestock_same_category_multi_location',
    category: 'entity_collision',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['With vacas in multiple locations, "vendi vacas" should ask which location OR auto-resolve if only 1 group'],
    possible_failures: ['Sells from wrong location', 'Creates income without removing from inventory', 'Crashes'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test30(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // "fumigue con 3 litros de glifosato a 5000" - price ambiguity
  let r = await send('fumigue el norte con 3 litros de glifosato a 5000');
  convo.push({ role: 'user', message: 'fumigue el norte con 3 litros de glifosato a 5000', response: r });

  const hasActivity = r.toLowerCase().includes('fumig') || r.toLowerCase().includes('aplic') || r.toLowerCase().includes('registr');
  const hasExpense = r.toLowerCase().includes('5000') || r.toLowerCase().includes('gasto') || r.toLowerCase().includes('$');
  const asksPrice = r.toLowerCase().includes('precio') || r.toLowerCase().includes('total') || r.toLowerCase().includes('litro');

  let status: TestResult['status'];
  let notes: string;
  if (hasActivity && hasExpense) {
    status = 'PASS';
    notes = 'Registered both activity and expense (compound action with amount)';
  } else if (hasActivity && !hasExpense) {
    status = 'WARN';
    notes = 'Registered activity but missed expense component (a 5000 = price)';
  } else {
    status = 'WARN';
    notes = `Response: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '30_activity_with_expense_unit_ambiguity',
    category: 'entity_collision',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"fumigue con X a 5000" should register activity + expense ($5000 total or per unit)'],
    possible_failures: ['Only registers activity, misses price', 'Price interpreted as quantity', 'Creates observation'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

// ============= CATEGORY 5: Cross-Domain Confusion (31-36) =============

async function test31(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await send('cuantas has hay en el norte?');
  convo.push({ role: 'user', message: 'cuantas has hay en el norte?', response: r });

  const isHectares = r.includes('150') || r.toLowerCase().includes('hectárea') || r.toLowerCase().includes('superficie');
  const isLivestock = r.toLowerCase().includes('vaca') || r.toLowerCase().includes('cabeza') || r.toLowerCase().includes('hacienda') || r.toLowerCase().includes('novillo');

  let status: TestResult['status'];
  let notes: string;
  if (isHectares && !isLivestock) {
    status = 'PASS';
    notes = '"has" correctly interpreted as hectareas (150 for Norte)';
  } else if (isLivestock) {
    status = 'FAIL';
    notes = '"has" confused with hacienda - showed livestock instead of area';
  } else {
    status = 'WARN';
    notes = `Response: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '31_hacienda_vs_hectareas_typo',
    category: 'cross_domain',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['"cuantas has" = hectareas query, NOT hacienda. Should show 150 has for Norte'],
    possible_failures: ['Shows cattle count instead of area', 'Interprets "has" as abbreviation for hacienda'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test32(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await send('el trigo del 1A esta con roya');
  convo.push({ role: 'user', message: 'el trigo del 1A esta con roya', response: r });

  const isObservation = r.toLowerCase().includes('observación') || r.toLowerCase().includes('nota registrad');
  const isScouting = r.toLowerCase().includes('monitoreo') || r.toLowerCase().includes('scouting');
  // Only count as activity if the MAIN action was spray/application, not just a suggestion
  const isActivity = (r.toLowerCase().includes('fumigación registrada') || r.toLowerCase().includes('aplicación registrada')) && !isObservation;

  let status: TestResult['status'];
  let notes: string;
  if ((isObservation || isScouting) && !isActivity) {
    status = 'PASS';
    notes = 'Correctly classified as observation/scouting (disease report), not activity';
  } else if (isActivity) {
    status = 'FAIL';
    notes = 'Incorrectly classified disease report as agronomic activity';
  } else {
    status = 'WARN';
    notes = `Classification unclear: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '32_observation_vs_activity',
    category: 'cross_domain',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"esta con roya" is a disease observation, NOT a spray/activity registration'],
    possible_failures: ['Creates spray activity', 'Creates expense', 'Ignores entirely'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test33(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // "movi 30 novillos al feedlot" - is it transfer?
  let r = await send('movi 30 novillos al feedlot');
  convo.push({ role: 'user', message: 'movi 30 novillos al feedlot', response: r });

  const isTransfer = r.toLowerCase().includes('transfer') || r.toLowerCase().includes('movi') || r.toLowerCase().includes('registr');
  const isIncome = r.toLowerCase().includes('ingreso') || r.toLowerCase().includes('venta');

  // Now try "vendi 30 novillos al feedlot"
  await send('cancelar');
  r = await send('vendi 30 novillos al feedlot');
  convo.push({ role: 'user', message: 'vendi 30 novillos al feedlot', response: r });

  const isSale = r.toLowerCase().includes('venta') || r.toLowerCase().includes('ingreso') || r.toLowerCase().includes('remov') || r.toLowerCase().includes('registr');

  let status: TestResult['status'];
  let notes: string;
  if (isTransfer && !isIncome && isSale) {
    status = 'PASS';
    notes = '"movi" = transfer (physical move), "vendi" = sale with income (correct distinction)';
  } else if (!isTransfer && !isSale) {
    status = 'WARN';
    notes = `Neither clearly handled: move=${convo[0].response?.substring(0, 40)}, sell=${r.substring(0, 40)}`;
  } else {
    status = 'WARN';
    notes = `Partial: transfer=${isTransfer}, income1=${isIncome}, sale=${isSale}`;
  }

  return {
    test_name: '33_income_vs_transfer',
    category: 'cross_domain',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['"movi" = transfer_livestock (physical), "vendi" = remove_livestock + income'],
    possible_failures: ['Both treated as sales', 'Both treated as transfers', 'No distinction between verbs'],
    actual_result: `Move: ${convo[0].response?.substring(0, 50)}, Sell: ${r.substring(0, 50)}`,
    notes,
  };
}

async function test34(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // "compre 200 litros de glifosato" - should be expense. Should it also add to stock?
  let r = await send('compre 200 litros de glifosato a 3000 el litro en el lote Norte');
  convo.push({ role: 'user', message: 'compre 200 litros de glifosato a 3000 el litro en el lote Norte', response: r });

  const isExpense = r.toLowerCase().includes('gasto') || r.toLowerCase().includes('registr') || r.toLowerCase().includes('$') || r.toLowerCase().includes('600');
  const isStock = r.toLowerCase().includes('stock') || r.toLowerCase().includes('depósito') || r.toLowerCase().includes('inventario');

  // Check DB (wait for async persistence)
  await sleep(1000);
  const expenseRows = await dbQuery(
    `SELECT COUNT(*) as cnt FROM expenses WHERE user_id = $1 AND description ILIKE '%glifosato%' AND deleted_at IS NULL`,
    [USER_ID]
  );
  const stockRows = await dbQuery(
    `SELECT current_quantity FROM stock_items WHERE user_id = $1 AND name ILIKE '%glifosato%'`,
    [USER_ID]
  );

  const hasExpenseInDb = parseInt(expenseRows[0]?.cnt || '0') > 0;
  const hasStockInDb = stockRows.length > 0;

  let status: TestResult['status'];
  let notes: string;
  if (hasExpenseInDb) {
    status = 'PASS';
    notes = `Expense created. Stock also updated: ${hasStockInDb}. Response: ${r.substring(0, 60)}`;
  } else {
    status = 'FAIL';
    notes = '"compre" should at minimum create an expense';
  }

  return {
    test_name: '34_stock_vs_expense',
    category: 'cross_domain',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"compre glifosato" should create expense (and optionally update stock)'],
    possible_failures: ['Only adds to stock, no expense', 'Neither expense nor stock', 'Only expense, stock diverges'],
    actual_result: `Expense in DB: ${hasExpenseInDb}, Stock in DB: ${hasStockInDb}`,
    notes,
  };
}

async function test35(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // "llovio 20mm" should be log_rainfall, not just chat
  let r = await send('llovio 20mm');
  convo.push({ role: 'user', message: 'llovio 20mm', response: r });

  // Check DB
  await sleep(500);
  const rows = await dbQuery(
    `SELECT millimeters FROM rainfall WHERE user_id = $1 AND millimeters = 20 ORDER BY created_at DESC LIMIT 1`,
    [USER_ID]
  );

  const stored = rows.length > 0;
  const isRainfall = r.toLowerCase().includes('lluvia') || r.toLowerCase().includes('registr') || r.toLowerCase().includes('20') || r.toLowerCase().includes('mm');
  const isChat = r.toLowerCase().includes('qué lluvia') || r.toLowerCase().includes('interesante');

  let status: TestResult['status'];
  let notes: string;
  if (stored || isRainfall) {
    status = 'PASS';
    notes = '"llovio 20mm" correctly interpreted as rainfall registration';
  } else if (isChat) {
    status = 'FAIL';
    notes = 'Treated rainfall as casual conversation instead of data registration';
  } else {
    status = 'WARN';
    notes = `DB stored: ${stored}, response: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '35_weather_vs_rainfall',
    category: 'cross_domain',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['"llovio 20mm" should register rainfall data, not be treated as chat'],
    possible_failures: ['Treated as conversational message', 'Creates observation instead of rainfall record'],
    actual_result: `Stored in DB: ${stored}, response: ${r.substring(0, 80)}`,
    notes,
  };
}

async function test36(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // "soja a 300 dolares" - is it a price query or an income registration?
  let r = await send('soja a 300 dolares');
  convo.push({ role: 'user', message: 'soja a 300 dolares', response: r });

  const isQuery = r.toLowerCase().includes('precio') || r.toLowerCase().includes('mercado') || r.toLowerCase().includes('cotización');
  const isIncome = r.toLowerCase().includes('ingreso') || r.toLowerCase().includes('venta') || r.toLowerCase().includes('registr');
  const asks = r.toLowerCase().includes('vendiste') || r.toLowerCase().includes('cuánto') || r.toLowerCase().includes('quieres');

  let status: TestResult['status'];
  let notes: string;
  if (asks) {
    status = 'PASS';
    notes = 'Bot asked for clarification (ambiguous between price info and sale)';
  } else if (isIncome) {
    status = 'WARN';
    notes = 'Interpreted as income without quantity - may be premature registration';
  } else if (isQuery) {
    status = 'WARN';
    notes = 'Interpreted as price query (reasonable)';
  } else {
    status = 'WARN';
    notes = `Response unclear: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '36_query_vs_registration',
    category: 'cross_domain',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['"soja a 300 dolares" is ambiguous - bot should ask if selling or just noting price'],
    possible_failures: ['Creates income without quantity', 'Creates expense', 'Ignores entirely'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

// ============= CATEGORY 6: Edge Cases & Negative Tests (37-40) =============

async function test37(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // SQL injection attempt
  const malicious = "agregue campo '; DROP TABLE users; --";
  let r = await send(malicious);
  convo.push({ role: 'user', message: malicious, response: r });

  // Check that users table still exists
  await sleep(500);
  let dbOk = false;
  try {
    const rows = await dbQuery('SELECT COUNT(*) as cnt FROM users');
    dbOk = parseInt(rows[0]?.cnt || '0') > 0;
  } catch (e: any) {
    dbOk = false;
  }

  let status: TestResult['status'];
  let notes: string;
  if (dbOk) {
    status = 'PASS';
    notes = 'SQL injection attempt safely handled - DB intact';
  } else {
    status = 'FAIL';
    notes = 'SQL injection may have succeeded - cannot query users table!';
  }

  return {
    test_name: '37_sql_injection_attempt',
    category: 'edge_case',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['SQL injection should be safely handled via parameterized queries'],
    possible_failures: ['DB tables dropped', 'Application crash', 'Data corruption'],
    actual_result: `DB intact: ${dbOk}, response: ${r.substring(0, 80)}`,
    notes,
  };
}

async function test38(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Generate a 2000-char message with embedded operations
  const longMsg = 'Hoy fue un dia largo. ' +
    'Primero fumigue el lote Norte con glifosato 3lt/ha. ' +
    'Despues fui al Sur y fertilice con urea 150kg/ha. ' +
    'A la tarde me cargaron 3 camiones de trigo del 1A: Garcia 28000kg, Lopez 31000kg y Martinez 29500kg. ' +
    'Tambien compre 500lt de gasoil a 900 pesos el litro, 2000kg de urea a 800 el kg. ' +
    'El clima estuvo pesado, llovieron unos 15mm a la nochecita. ' +
    'La soja del Norte viene bien, esta en R3, vi algo de chinche pero poquito, calculo 5% de presion. ' +
    'Los novillos del Sur estan en 390kg promedio ya, los pese hoy. ' +
    'Ah y vacune las 100 vacas contra aftosa, ya estaba pendiente. ' +
    'Para la semana que viene tengo que desparasitar los terneros del Principal. ' +
    'Me debo quedar con el detalle de lo que cada camion trajo de humedad: Garcia 13.8%, Lopez 14.1%, Martinez 13.5%. ';

  // Pad to 2000+ chars
  const padding = 'Tambien note que la maleza del 1A esta creciendo mucho, hay que meterle un quimico pronto. ';
  let fullMsg = longMsg;
  while (fullMsg.length < 2000) {
    fullMsg += padding;
  }

  let r = await send(fullMsg);
  convo.push({ role: 'user', message: `(${fullMsg.length} chars - multiple embedded operations)`, response: r });

  // The bot should handle this somehow - either process or indicate truncation
  const hasContent = r.length > 20;
  const truncationWarning = r.toLowerCase().includes('cortó') || r.toLowerCase().includes('trunca') || r.toLowerCase().includes('largo');
  const hasRegistrations = r.toLowerCase().includes('registr') || r.toLowerCase().includes('fumig') || r.toLowerCase().includes('cosech');

  let status: TestResult['status'];
  let notes: string;
  if (hasRegistrations) {
    status = 'PASS';
    notes = `Bot processed long message and registered actions (response ${r.length} chars)`;
  } else if (truncationWarning) {
    status = 'PASS';
    notes = 'Bot warned about message being too long (truncation handling working)';
  } else if (hasContent) {
    status = 'WARN';
    notes = `Bot responded but unclear if it processed operations: ${r.substring(0, 100)}`;
  } else {
    status = 'FAIL';
    notes = 'Bot produced empty or minimal response to long message';
  }

  return {
    test_name: '38_extremely_long_message',
    category: 'edge_case',
    severity: 'medium',
    status,
    conversation: convo,
    expected_behavior: ['Should process embedded operations or warn about truncation for very long messages'],
    possible_failures: ['Crashes', 'Silent data loss', 'Only processes first operation', 'Timeout'],
    actual_result: `Response length: ${r.length}, contains registrations: ${hasRegistrations}, truncation warning: ${truncationWarning}`,
    notes,
  };
}

async function test39(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await send('sembre \u{1F33D} en el lote \u{1F33E} norte \u{1F69C}');
  convo.push({ role: 'user', message: 'sembre corn-emoji en el lote wheat-emoji norte tractor-emoji', response: r });

  const extractedCrop = r.toLowerCase().includes('maíz') || r.toLowerCase().includes('maiz') || r.toLowerCase().includes('soja');
  const extractedPlot = r.toLowerCase().includes('norte');
  const registered = r.toLowerCase().includes('registr') || r.toLowerCase().includes('sembr');

  let status: TestResult['status'];
  let notes: string;
  if (extractedPlot && registered) {
    status = 'PASS';
    notes = `Bot extracted plot "Norte" from emoji-laden text. Crop: ${extractedCrop ? 'detected' : 'unclear'}`;
  } else if (r.toLowerCase().includes('no entend') || r.toLowerCase().includes('no pude')) {
    status = 'WARN';
    notes = 'Bot could not parse emoji-heavy message (acceptable graceful degradation)';
  } else {
    status = 'WARN';
    notes = `Response: ${r.substring(0, 100)}`;
  }

  return {
    test_name: '39_emoji_heavy_message',
    category: 'edge_case',
    severity: 'low',
    status,
    conversation: convo,
    expected_behavior: ['Should extract "norte" as plot despite emojis, optionally interpret corn emoji as maiz'],
    possible_failures: ['Crashes on emoji characters', 'Ignores entire message', 'Creates garbled data'],
    actual_result: r.substring(0, 120),
    notes,
  };
}

async function test40(): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // 5 toneladas a 200 pesos el kilo = 5000kg * 200 = 1,000,000
  let r = await send('compre 5 toneladas de urea a 200 pesos el kilo en el lote Norte');
  convo.push({ role: 'user', message: 'compre 5 toneladas de urea a 200 pesos el kilo en el lote Norte', response: r });
  // Confirm if pending
  if (r.includes('Confirmar') || r.includes('confirm')) {
    r = await tap('confirm_pending');
  }

  // Check DB for the expense amount (wait for async persistence)
  await sleep(1000);
  const rows = await dbQuery(
    `SELECT amount, description FROM expenses
     WHERE user_id = $1 AND description ILIKE '%urea%' AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [USER_ID]
  );

  const amount = parseFloat(rows[0]?.amount || '0');
  // Expected: 5000kg * 200 = 1,000,000
  const expectedAmount = 1000000;
  const tolerance = 0.1; // 10% tolerance for rounding

  let status: TestResult['status'];
  let notes: string;
  if (Math.abs(amount - expectedAmount) / expectedAmount < tolerance) {
    status = 'PASS';
    notes = `Correctly calculated: 5tn * 200/kg = $${amount.toLocaleString()} (expected ~$1,000,000)`;
  } else if (amount === 200) {
    status = 'FAIL';
    notes = 'Only stored unit price (200), did not multiply by quantity';
  } else if (amount === 1000) {
    status = 'FAIL';
    notes = 'Stored 1000 - may have multiplied 5*200 without converting tn to kg';
  } else if (amount === 5000) {
    status = 'FAIL';
    notes = 'Stored 5000 - may have used 5tn as-is without price calculation';
  } else if (amount > 0) {
    status = 'WARN';
    notes = `Stored amount: $${amount.toLocaleString()} (expected $1,000,000). May have different calculation.`;
  } else {
    status = 'WARN';
    notes = `No expense found or zero amount. Response: ${r.substring(0, 80)}`;
  }

  return {
    test_name: '40_contradictory_units',
    category: 'edge_case',
    severity: 'high',
    status,
    conversation: convo,
    expected_behavior: ['5 toneladas at 200/kg = 5000kg * 200 = $1,000,000'],
    possible_failures: ['Does not convert tn to kg for price calc', 'Stores unit price only', 'Wrong multiplication'],
    actual_result: `DB amount: ${amount ? '$' + amount.toLocaleString() : 'not found'}, response: ${r.substring(0, 80)}`,
    notes,
  };
}

// ============= MAIN RUNNER =============

async function main() {
  console.log('');
  console.log('=======================================================');
  console.log('  QA ADVERSARIAL ADVANCED -- 40 Scenarios');
  console.log('  Focus: Silent corruption, drift, contradictions');
  console.log('=======================================================');
  console.log('');

  // Register/login
  const { token, userId } = await apiRegister(BASE_URL, EMAIL, PASSWORD, NAME);
  AUTH_TOKEN = token;
  USER_ID = userId;
  console.log(`  Auth OK (userId=${userId})`);

  // Upgrade to enterprise plan for full feature access
  await dbQuery(`UPDATE users SET plan_id = 4 WHERE id = $1`, [userId]);
  console.log('  Upgraded to enterprise plan');

  // Reset user data
  await apiReset(BASE_URL, AUTH_TOKEN);
  console.log('  Reset complete');

  // Setup base data
  await setupBaseData();

  // All test functions
  const tests = [
    test01, test02, test03, test04, test05, test06, test07, test08,
    test09, test10, test11, test12, test13, test14, test15, test16,
    test17, test18, test19, test20, test21, test22, test23, test24,
    test25, test26, test27, test28, test29, test30, test31, test32,
    test33, test34, test35, test36, test37, test38, test39, test40,
  ];

  console.log(`\n  Running ${tests.length} tests...\n`);

  for (let i = 0; i < tests.length; i++) {
    const testFn = tests[i];

    // Clear flow state before each test
    try { await send('cancelar'); } catch { /* ignore */ }
    await sleep(300);

    console.log(`  --- Test ${String(i + 1).padStart(2, '0')}/${tests.length} ---`);

    try {
      const result = await testFn();
      results.push(result);
      const icon = result.status === 'PASS' ? 'PASS' : result.status === 'WARN' ? 'WARN' : 'FAIL';
      console.log(`  [${icon}] ${result.test_name} (${result.category}, ${result.severity})`);
      if (result.status !== 'PASS') {
        console.log(`       -> ${result.notes.substring(0, 120)}`);
      }
    } catch (e: any) {
      console.log(`  [ERROR] ${testFn.name}: ${e.message}`);
      results.push({
        test_name: testFn.name,
        category: 'error',
        severity: 'high',
        status: 'FAIL',
        conversation: [],
        expected_behavior: ['Should not crash'],
        possible_failures: ['Runtime error'],
        actual_result: e.message,
        notes: `Crashed: ${e.message}`,
      });
    }
  }

  // Summary
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const warn = results.filter(r => r.status === 'WARN').length;

  console.log('');
  console.log('=======================================================');
  console.log(`  RESULTS: ${pass} PASS | ${fail} FAIL | ${warn} WARN`);
  console.log(`  Pass rate: ${Math.round(pass / results.length * 100)}%`);
  console.log('=======================================================');
  console.log('');

  if (fail > 0) {
    console.log('  FAILURES:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`    - [${r.severity}] ${r.test_name}: ${r.notes.substring(0, 100)}`);
    }
    console.log('');
  }

  if (warn > 0) {
    console.log('  WARNINGS:');
    for (const r of results.filter(r => r.status === 'WARN')) {
      console.log(`    - [${r.severity}] ${r.test_name}: ${r.notes.substring(0, 100)}`);
    }
    console.log('');
  }

  // Category breakdown
  const categories = [...new Set(results.map(r => r.category))];
  console.log('  CATEGORY BREAKDOWN:');
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catPass = catResults.filter(r => r.status === 'PASS').length;
    console.log(`    ${cat}: ${catPass}/${catResults.length} pass`);
  }

  // Severity breakdown
  console.log('');
  console.log('  SEVERITY BREAKDOWN:');
  const highFails = results.filter(r => r.status === 'FAIL' && r.severity === 'high').length;
  const medFails = results.filter(r => r.status === 'FAIL' && r.severity === 'medium').length;
  const lowFails = results.filter(r => r.status === 'FAIL' && r.severity === 'low').length;
  console.log(`    High-severity failures: ${highFails}`);
  console.log(`    Medium-severity failures: ${medFails}`);
  console.log(`    Low-severity failures: ${lowFails}`);

  // Write results to JSON
  const fs = await import('fs');
  const outputPath = '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-adversarial-advanced-40-results.json';
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n  Results written to: ${outputPath}`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(2);
});
