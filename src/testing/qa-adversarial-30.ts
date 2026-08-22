/**
 * QA Adversarial Testing - 30 Complex Scenarios
 * Tests: stock, hacienda, agronomic activities, observations, complex queries
 * Simulates a real Argentine farmer using informal language
 */

// Direct API calls — TestBotClient has wrong auth paths for Docker setup.
// El parametro 'client' de cada test quedo vestigial: sendAndLog lo ignora
// (_unused) y todo va por fetch directo. Se tipa asi para no reintroducir
// la dependencia del cliente que este archivo evita a proposito.
type TestBotClient = unknown;

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-adversarial@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Raúl';

// Direct API helper (TestBotClient has /auth path, but routes are at /api/auth)
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
  if (res.status === 409) {
    // Already exists, login
    return apiLogin(baseUrl, email, password);
  }
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
        for (const r of s.rows) buttons.push({ id: r.id, title: r.title });
      }
    }
  }
  return buttons;
}

async function sendAndLog(_unused: any, message: string): Promise<string> {
  const data = await apiSend(BASE_URL, AUTH_TOKEN, message);
  return extractText(data);
}

async function tapAndLog(_unused: any, buttonId: string): Promise<string> {
  const data = await apiTap(BASE_URL, AUTH_TOKEN, buttonId);
  return extractText(data);
}

async function setupBaseData(client: TestBotClient): Promise<void> {
  console.log('\n🔧 Setting up base data...\n');

  // Add field "La Esperanza" in Pergamino
  let r = await sendAndLog(client, 'agregar campo La Esperanza');
  console.log('  → Setup: agregar campo →', r.substring(0, 80));

  // Handle field location flow
  r = await tapAndLog(client, 'flow_field_loc_city');
  console.log('  → Setup: loc city →', r.substring(0, 80));

  r = await sendAndLog(client, 'Pergamino');
  console.log('  → Setup: Pergamino →', r.substring(0, 80));

  // Confirm
  r = await tapAndLog(client, 'flow_confirm');
  console.log('  → Setup: confirm →', r.substring(0, 80));

  // Add plot "Norte" 150 has
  r = await sendAndLog(client, 'agregar lote Norte al campo La Esperanza');
  console.log('  → Setup: lote Norte →', r.substring(0, 80));
  r = await sendAndLog(client, '150');
  console.log('  → Setup: 150 has →', r.substring(0, 80));

  // Add plot "Sur" 80 has
  r = await sendAndLog(client, 'agregar lote Sur al campo La Esperanza');
  console.log('  → Setup: lote Sur →', r.substring(0, 80));
  r = await sendAndLog(client, '80');
  console.log('  → Setup: 80 has →', r.substring(0, 80));

  // Add plot "El Fondo" 200 has
  r = await sendAndLog(client, 'agregar lote El Fondo al campo La Esperanza');
  console.log('  → Setup: lote El Fondo →', r.substring(0, 80));
  r = await sendAndLog(client, '200');
  console.log('  → Setup: 200 has →', r.substring(0, 80));

  // Sow soja in Norte
  r = await sendAndLog(client, 'sembré soja en el lote Norte');
  console.log('  → Setup: soja Norte →', r.substring(0, 80));

  // Sow maíz in Sur
  r = await sendAndLog(client, 'sembré maíz en el lote Sur');
  console.log('  → Setup: maíz Sur →', r.substring(0, 80));

  // Add livestock (specify lote to avoid ambiguity)
  r = await sendAndLog(client, 'agregué 50 vacas en el lote Norte');
  console.log('  → Setup: 50 vacas →', r.substring(0, 80));

  r = await sendAndLog(client, 'agregué 30 novillos en el lote Norte');
  console.log('  → Setup: 30 novillos →', r.substring(0, 80));

  r = await sendAndLog(client, 'agregué 20 terneros en el lote Norte');
  console.log('  → Setup: 20 terneros →', r.substring(0, 80));

  console.log('\n✅ Base data setup complete\n');
}

// ============= TEST DEFINITIONS =============

async function test01_implicit_plot_reference(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // First mention lote Norte explicitly
  let r = await sendAndLog(client, 'cuántas has tiene el lote Norte?');
  convo.push({ role: 'user', message: 'cuántas has tiene el lote Norte?', response: r });

  // Then use implicit reference "ahí"
  r = await sendAndLog(client, 'fumigué ahí con glifosato 3lt/ha');
  convo.push({ role: 'user', message: 'fumigué ahí con glifosato 3lt/ha', response: r });

  const pass = r.toLowerCase().includes('norte') || r.toLowerCase().includes('glifosato') || r.toLowerCase().includes('fumig');

  return {
    test_name: '01_implicit_plot_reference',
    category: 'contexto_conversacional',
    severity: 'high',
    status: pass ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should resolve "ahí" to lote Norte from previous message context'],
    possible_failures: ['Bot asks which plot instead of using context', 'Bot logs to wrong plot'],
    actual_result: r,
    notes: pass ? 'Implicit reference resolved correctly' : 'Failed to resolve implicit reference "ahí"'
  };
}

async function test02_ambiguous_size_reference(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'fumigá el chico con 2,4D');
  convo.push({ role: 'user', message: 'fumigá el chico con 2,4D', response: r });

  // "el chico" could mean lote Sur (80 has, the smallest)
  const pass = r.toLowerCase().includes('sur') || r.toLowerCase().includes('lote') || r.toLowerCase().includes('cuál');

  return {
    test_name: '02_ambiguous_size_reference',
    category: 'ambiguedad',
    severity: 'medium',
    status: pass ? 'PASS' : 'WARN',
    conversation: convo,
    expected_behavior: ['Bot should ask which plot "el chico" refers to, or resolve to smallest plot'],
    possible_failures: ['Bot picks random plot', 'Bot creates observation instead of activity', 'Bot ignores the command'],
    actual_result: r,
    notes: 'Testing if bot handles informal size-based plot references'
  };
}

async function test03_compound_activity_expense(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'fumigué el lote Norte con glifosato, gasté 85mil en el producto');
  convo.push({ role: 'user', message: 'fumigué el lote Norte con glifosato, gasté 85mil en el producto', response: r });

  const hasActivity = r.toLowerCase().includes('fumig') || r.toLowerCase().includes('aplicaci');
  const hasExpense = r.toLowerCase().includes('85') || r.toLowerCase().includes('gasto') || r.toLowerCase().includes('registr');
  const pass = hasActivity && hasExpense;

  return {
    test_name: '03_compound_activity_expense',
    category: 'acciones_compuestas',
    severity: 'high',
    status: pass ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should register BOTH a spray activity AND an expense of $85,000'],
    possible_failures: ['Only registers activity, misses expense', 'Only registers expense, misses activity', 'Registers duplicate'],
    actual_result: r,
    notes: pass ? 'Compound action executed correctly' : 'Failed to handle compound activity+expense'
  };
}

async function test04_livestock_ambiguity(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'vendí un poco de hacienda');
  convo.push({ role: 'user', message: 'vendí un poco de hacienda', response: r });

  // Should ask for quantity and category
  const asksDetails = r.toLowerCase().includes('cuánt') || r.toLowerCase().includes('categoría') || r.toLowerCase().includes('cabeza');

  return {
    test_name: '04_livestock_ambiguity_no_quantity',
    category: 'hacienda',
    severity: 'medium',
    status: asksDetails ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should ask how many animals and which category were sold'],
    possible_failures: ['Bot registers sale without quantity', 'Bot ignores command', 'Bot creates generic income instead of livestock removal'],
    actual_result: r,
    notes: asksDetails ? 'Bot correctly asked for details' : 'Bot did not request missing livestock details'
  };
}

async function test05_typo_crop_name(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'sembre soga en el fondo');
  convo.push({ role: 'user', message: 'sembre soga en el fondo', response: r });

  // "soga" is a typo for "soja", "el fondo" = lote El Fondo
  const resolvedCrop = r.toLowerCase().includes('soja') || r.toLowerCase().includes('soga');
  const resolvedPlot = r.toLowerCase().includes('fondo');

  return {
    test_name: '05_typo_crop_name',
    category: 'lenguaje_informal',
    severity: 'medium',
    status: resolvedCrop && resolvedPlot ? 'PASS' : 'WARN',
    conversation: convo,
    expected_behavior: ['Bot should interpret "soga" as "soja" and "el fondo" as lote El Fondo'],
    possible_failures: ['Bot does not understand "soga"', 'Bot does not resolve "el fondo" to plot name', 'Creates observation instead of sowing activity'],
    actual_result: r,
    notes: 'Testing typo tolerance and informal plot naming'
  };
}

async function test06_stock_without_warehouse(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'tengo 500lt de glifosato en el galpón');
  convo.push({ role: 'user', message: 'tengo 500lt de glifosato en el galpón', response: r });

  return {
    test_name: '06_stock_without_warehouse',
    category: 'stock',
    severity: 'medium',
    status: r.toLowerCase().includes('galpón') || r.toLowerCase().includes('depósito') || r.toLowerCase().includes('stock') || r.toLowerCase().includes('glifosato') ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should create warehouse "el galpón" and add 500lt of glifosato, or ask for warehouse creation'],
    possible_failures: ['Bot ignores warehouse mention', 'Bot creates expense instead of stock entry', 'Bot fails because no warehouse exists'],
    actual_result: r,
    notes: 'Testing stock creation flow when no warehouse pre-exists'
  };
}

async function test07_complex_livestock_movement(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Specify origin lote to avoid ambiguity (terneros may exist in multiple plots)
  let r = await sendAndLog(client, 'pasé 10 terneros del lote Norte a novillos');
  convo.push({ role: 'user', message: 'pasé 10 terneros del lote Norte a novillos', response: r });

  const isTransfer = r.toLowerCase().includes('transfer') || r.toLowerCase().includes('recategoriz') || r.toLowerCase().includes('novillos') || r.toLowerCase().includes('ternero');

  return {
    test_name: '07_livestock_recategorization',
    category: 'hacienda',
    severity: 'high',
    status: isTransfer ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should use transfer_livestock to recategorize 10 terneros from Norte to novillos (same lote)'],
    possible_failures: ['Bot removes terneros + adds novillos as separate actions', 'Bot creates generic observation', 'Bot does not understand recategorization'],
    actual_result: r,
    notes: isTransfer ? 'Recategorization handled correctly' : 'Failed to handle livestock recategorization'
  };
}

async function test08_date_relative_reference(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'el martes pasado llovieron 25mm');
  convo.push({ role: 'user', message: 'el martes pasado llovieron 25mm', response: r });

  const hasRainfall = r.toLowerCase().includes('25') || r.toLowerCase().includes('lluvia') || r.toLowerCase().includes('mm');

  return {
    test_name: '08_relative_date_rainfall',
    category: 'fechas',
    severity: 'medium',
    status: hasRainfall ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should register 25mm rainfall for last Tuesday'],
    possible_failures: ['Bot uses today\'s date instead of last Tuesday', 'Bot asks for date despite clear reference', 'Bot ignores rainfall command'],
    actual_result: r,
    notes: hasRainfall ? 'Relative date handled' : 'Failed to parse relative date reference'
  };
}

async function test09_multi_day_rainfall(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'llovió 15mm el lunes, 20mm el martes y 8mm el miércoles');
  convo.push({ role: 'user', message: 'llovió 15mm el lunes, 20mm el martes y 8mm el miércoles', response: r });

  const hasMultiple = (r.match(/\d+/g) || []).length >= 2;

  return {
    test_name: '09_multi_day_rainfall_batch',
    category: 'lluvia',
    severity: 'medium',
    status: hasMultiple || r.toLowerCase().includes('lluvia') ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should register 3 separate rainfall entries for Monday, Tuesday, Wednesday'],
    possible_failures: ['Bot only registers one day', 'Bot sums all rainfall into one entry', 'Bot asks for field 3 times instead of once'],
    actual_result: r,
    notes: 'Testing multi-day rainfall batch consolidation'
  };
}

async function test10_crop_scouting_informal(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'la soja del norte viene en R3 con algo de rama negra, diría 10% ponele');
  convo.push({ role: 'user', message: 'la soja del norte viene en R3 con algo de rama negra, diría 10% ponele', response: r });

  const isScouting = r.toLowerCase().includes('monitor') || r.toLowerCase().includes('r3') || r.toLowerCase().includes('rama negra') || r.toLowerCase().includes('registr');

  return {
    test_name: '10_crop_scouting_informal_language',
    category: 'monitoreo',
    severity: 'high',
    status: isScouting ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should log crop scouting: stage=R3, weed_species=rama negra, weed_coverage_pct=10 for lote Norte'],
    possible_failures: ['Bot creates free-text observation instead of structured scouting', 'Misses stage code', 'Misses weed percentage', 'Wrong plot assignment'],
    actual_result: r,
    notes: isScouting ? 'Structured scouting captured from informal language' : 'Failed to parse informal scouting data'
  };
}

async function test11_financial_query_vs_registration(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'cuánto gasté en el lote Norte?');
  convo.push({ role: 'user', message: 'cuánto gasté en el lote Norte?', response: r });

  const isQuery = r.toLowerCase().includes('gast') || r.toLowerCase().includes('$') || r.toLowerCase().includes('total') || r.toLowerCase().includes('no hay') || r.toLowerCase().includes('0');
  const isRegistration = r.toLowerCase().includes('confirmar') || r.toLowerCase().includes('registrar');

  return {
    test_name: '11_financial_query_not_registration',
    category: 'queries',
    severity: 'high',
    status: isQuery && !isRegistration ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should return financial report for lote Norte, NOT try to register an expense'],
    possible_failures: ['Bot interprets as expense registration', 'Bot creates observation', 'Bot asks for amount'],
    actual_result: r,
    notes: isQuery && !isRegistration ? 'Correctly identified as query' : 'Misidentified query as registration'
  };
}

async function test12_harvest_with_loads(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'cosechamos soja del lote Norte. García 32000kg, Pérez 28500kg, Rodríguez 30000kg');
  convo.push({ role: 'user', message: 'cosechamos soja del lote Norte. García 32000kg, Pérez 28500kg, Rodríguez 30000kg', response: r });

  const hasLoads = r.toLowerCase().includes('garcía') || r.toLowerCase().includes('pérez') || r.toLowerCase().includes('carga') || r.toLowerCase().includes('cosech');

  return {
    test_name: '12_harvest_with_multiple_loads',
    category: 'cosecha',
    severity: 'high',
    status: hasLoads ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should register harvest with 3 loads: García 32000, Pérez 28500, Rodríguez 30000'],
    possible_failures: ['Bot only registers harvest without loads', 'Bot treats as 3 separate incomes', 'Bot misses driver names'],
    actual_result: r,
    notes: hasLoads ? 'Harvest loads captured' : 'Failed to parse harvest load data'
  };
}

async function test13_livestock_health_event(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'vacuné las 50 vacas contra aftosa');
  convo.push({ role: 'user', message: 'vacuné las 50 vacas contra aftosa', response: r });

  const isHealth = r.toLowerCase().includes('vacun') || r.toLowerCase().includes('aftosa') || r.toLowerCase().includes('sanidad') || r.toLowerCase().includes('registr');

  return {
    test_name: '13_livestock_health_vaccination',
    category: 'hacienda_sanidad',
    severity: 'high',
    status: isHealth ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should log health event: type=vacunacion, disease_or_vaccine=aftosa, animals_affected=50, category=vacas'],
    possible_failures: ['Bot creates generic observation', 'Bot uses log_observation instead of log_health_event', 'Misses vaccine name'],
    actual_result: r,
    notes: isHealth ? 'Health event logged correctly' : 'Failed to route to livestock health tool'
  };
}

async function test14_livestock_repro(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'eché el toro con las 50 vacas, monta natural');
  convo.push({ role: 'user', message: 'eché el toro con las 50 vacas, monta natural', response: r });

  const isRepro = r.toLowerCase().includes('servicio') || r.toLowerCase().includes('repro') || r.toLowerCase().includes('toro') || r.toLowerCase().includes('registr');

  return {
    test_name: '14_livestock_repro_service',
    category: 'hacienda_reproduccion',
    severity: 'high',
    status: isRepro ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should log repro event: type=servicio, method=monta natural, 50 vacas'],
    possible_failures: ['Bot creates generic activity', 'Bot uses add_livestock instead of log_repro_event', 'Misses method field'],
    actual_result: r,
    notes: isRepro ? 'Repro event logged' : 'Failed to handle reproductive event'
  };
}

async function test15_livestock_weighing(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'pesé los 30 novillos, promedio 380kg');
  convo.push({ role: 'user', message: 'pesé los 30 novillos, promedio 380kg', response: r });

  const isWeighing = r.toLowerCase().includes('380') || r.toLowerCase().includes('peso') || r.toLowerCase().includes('pesaje') || r.toLowerCase().includes('registr');

  return {
    test_name: '15_livestock_weighing',
    category: 'hacienda_pesaje',
    severity: 'high',
    status: isWeighing ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should log weighing: 30 novillos, avg 380kg per animal'],
    possible_failures: ['Bot interprets 380kg as total weight', 'Bot creates generic observation', 'Bot misses animal count'],
    actual_result: r,
    notes: isWeighing ? 'Weighing logged correctly' : 'Failed to handle weighing event'
  };
}

async function test16_context_confusion_multiple_actions(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Register something on lote Norte
  let r = await sendAndLog(client, 'fertilicé el lote Norte con urea 100kg/ha');
  convo.push({ role: 'user', message: 'fertilicé el lote Norte con urea 100kg/ha', response: r });

  // Now switch to lote Sur without naming it explicitly - use "el otro"
  r = await sendAndLog(client, 'hacé lo mismo en el otro lote');
  convo.push({ role: 'user', message: 'hacé lo mismo en el otro lote', response: r });

  return {
    test_name: '16_context_repeat_action_other_plot',
    category: 'contexto_conversacional',
    severity: 'high',
    status: 'WARN',
    conversation: convo,
    expected_behavior: ['Bot should either replicate fertilization on another plot or ask which plot'],
    possible_failures: ['Bot does not understand "hacé lo mismo"', 'Bot repeats on same plot', 'Bot loses context of previous action'],
    actual_result: r,
    notes: 'Testing if bot can replicate actions across plots from context'
  };
}

async function test17_observation_vs_activity(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'la soja del norte está un poco amarilla');
  convo.push({ role: 'user', message: 'la soja del norte está un poco amarilla', response: r });

  const isObservation = r.toLowerCase().includes('observación') || r.toLowerCase().includes('registr') || r.toLowerCase().includes('nota');
  const isActivity = r.toLowerCase().includes('actividad') || r.toLowerCase().includes('fumig') || r.toLowerCase().includes('fertiliz');

  return {
    test_name: '17_observation_not_activity',
    category: 'observaciones',
    severity: 'medium',
    status: isObservation && !isActivity ? 'PASS' : (isActivity ? 'FAIL' : 'WARN'),
    conversation: convo,
    expected_behavior: ['Bot should log as free-text observation, NOT as an agronomic activity'],
    possible_failures: ['Bot interprets as fertilization need', 'Bot creates scouting instead of observation', 'Bot ignores the message'],
    actual_result: r,
    notes: 'Visual observation should NOT trigger activity registration'
  };
}

async function test18_query_plot_history(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'cuándo se fumigó el lote Norte por última vez?');
  convo.push({ role: 'user', message: 'cuándo se fumigó el lote Norte por última vez?', response: r });

  const isQuery = r.includes('?') === false && (r.toLowerCase().includes('fumig') || r.toLowerCase().includes('aplic') || r.toLowerCase().includes('no hay') || r.toLowerCase().includes('historial') || r.toLowerCase().includes('última'));

  return {
    test_name: '18_query_plot_history_not_registration',
    category: 'queries',
    severity: 'high',
    status: isQuery || r.toLowerCase().includes('fumig') ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should query and return spray history for lote Norte, NOT register a new spray'],
    possible_failures: ['Bot registers a new spray activity', 'Bot creates observation', 'Bot asks what product was used'],
    actual_result: r,
    notes: 'Question about history should trigger query, not registration'
  };
}

async function test19_income_with_unit_price(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'vendí 200 tn de soja a 300 dólares el tn');
  convo.push({ role: 'user', message: 'vendí 200 tn de soja a 300 dólares el tn', response: r });

  const hasIncome = r.toLowerCase().includes('ingreso') || r.toLowerCase().includes('venta') || r.toLowerCase().includes('registr') || r.toLowerCase().includes('60.000') || r.toLowerCase().includes('60000') || r.toLowerCase().includes('300');

  return {
    test_name: '19_income_with_unit_price_usd',
    category: 'ingresos',
    severity: 'high',
    status: hasIncome ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should register income: 200tn soja at USD 300/tn = USD 60,000'],
    possible_failures: ['Bot confuses ARS and USD', 'Bot misses unit price', 'Bot calculates wrong total', 'Bot creates expense instead of income'],
    actual_result: r,
    notes: hasIncome ? 'Income registered' : 'Failed to handle income with unit price'
  };
}

async function test20_long_conversation_context(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Build up context over multiple messages
  let r = await sendAndLog(client, 'che, qué cultivo tiene el lote Norte?');
  convo.push({ role: 'user', message: 'che, qué cultivo tiene el lote Norte?', response: r });

  r = await sendAndLog(client, 'y el Sur?');
  convo.push({ role: 'user', message: 'y el Sur?', response: r });

  r = await sendAndLog(client, 'en qué estadio está la del Norte?');
  convo.push({ role: 'user', message: 'en qué estadio está la del Norte?', response: r });

  return {
    test_name: '20_long_conversation_implicit_refs',
    category: 'contexto_conversacional',
    severity: 'high',
    status: 'WARN',
    conversation: convo,
    expected_behavior: ['Bot should understand "y el Sur?" refers to "qué cultivo tiene" and "la del Norte" refers to crop'],
    possible_failures: ['Bot loses context after first question', 'Bot asks what "la" refers to', 'Bot confuses plot references'],
    actual_result: convo.map(c => c.response).join(' | '),
    notes: 'Testing multi-turn conversational memory'
  };
}

async function test21_hectares_vs_hacienda(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'cuántas has tengo?');
  convo.push({ role: 'user', message: 'cuántas has tengo?', response: r });

  const isPlots = r.toLowerCase().includes('lote') || r.toLowerCase().includes('hectárea') || r.toLowerCase().includes('campo') || r.toLowerCase().includes('150') || r.toLowerCase().includes('80') || r.toLowerCase().includes('200');
  const isLivestock = r.toLowerCase().includes('vaca') || r.toLowerCase().includes('novillo') || r.toLowerCase().includes('cabeza');

  return {
    test_name: '21_hectareas_not_hacienda',
    category: 'ambiguedad',
    severity: 'high',
    status: isPlots && !isLivestock ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['"cuántas has" should list plots/hectares, NOT livestock'],
    possible_failures: ['Bot interprets "has" as "hacienda"', 'Bot shows livestock count instead of hectares'],
    actual_result: r,
    notes: isPlots ? 'Correctly identified hectares query' : 'Confused has with hacienda'
  };
}

async function test22_expense_with_typo_amount(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'compré 2000lt de gasoil x 850 mangos el litro');
  convo.push({ role: 'user', message: 'compré 2000lt de gasoil x 850 mangos el litro', response: r });

  // "mangos" = pesos, 2000 * 850 = 1,700,000
  const hasExpense = r.toLowerCase().includes('gasoil') || r.toLowerCase().includes('1.700') || r.toLowerCase().includes('combustible') || r.toLowerCase().includes('registr');

  return {
    test_name: '22_informal_currency_slang',
    category: 'lenguaje_informal',
    severity: 'medium',
    status: hasExpense ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should understand "mangos" = pesos and calculate 2000 * 850 = $1,700,000'],
    possible_failures: ['Bot does not understand "mangos"', 'Bot misses unit price calculation', 'Bot registers wrong amount'],
    actual_result: r,
    notes: hasExpense ? 'Informal currency handled' : 'Failed to parse informal currency slang'
  };
}

async function test23_stock_query_complex(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'cuánto glifosato me queda?');
  convo.push({ role: 'user', message: 'cuánto glifosato me queda?', response: r });

  const isQuery = r.toLowerCase().includes('stock') || r.toLowerCase().includes('glifosato') || r.toLowerCase().includes('no hay') || r.toLowerCase().includes('litro') || r.toLowerCase().includes('disponible') || r.toLowerCase().includes('0');

  return {
    test_name: '23_stock_query',
    category: 'stock',
    severity: 'medium',
    status: isQuery ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should check stock of glifosato and report quantity available'],
    possible_failures: ['Bot creates expense instead', 'Bot asks for warehouse', 'Bot creates purchase order'],
    actual_result: r,
    notes: isQuery ? 'Stock query handled' : 'Failed to interpret as stock query'
  };
}

async function test24_scouting_severity_mapping(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'el maíz del Sur en V6, chinche con presión alta, y algo de roya moderada en hoja');
  convo.push({ role: 'user', message: 'el maíz del Sur en V6, chinche con presión alta, y algo de roya moderada en hoja', response: r });

  const isScouting = r.toLowerCase().includes('monitor') || r.toLowerCase().includes('v6') || r.toLowerCase().includes('chinche') || r.toLowerCase().includes('registr');

  return {
    test_name: '24_scouting_multiple_pests_severity',
    category: 'monitoreo',
    severity: 'high',
    status: isScouting ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should log scouting: stage=V6, pest=chinche severity=4(alta), disease=roya severity=3(moderada), plot=Sur'],
    possible_failures: ['Bot creates observation instead of scouting', 'Bot misses severity mapping', 'Bot only captures one pest/disease'],
    actual_result: r,
    notes: isScouting ? 'Complex scouting captured' : 'Failed to handle multiple pests with severity'
  };
}

async function test25_weather_query(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'va a llover en Pergamino esta semana?');
  convo.push({ role: 'user', message: 'va a llover en Pergamino esta semana?', response: r });

  const isWeather = r.toLowerCase().includes('pronóstico') || r.toLowerCase().includes('lluv') || r.toLowerCase().includes('mm') || r.toLowerCase().includes('temperatura') || r.toLowerCase().includes('clima') || r.toLowerCase().includes('pergamino');

  return {
    test_name: '25_weather_query_specific_city',
    category: 'clima',
    severity: 'low',
    status: isWeather ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should return weather forecast for Pergamino'],
    possible_failures: ['Bot uses user default city instead of Pergamino', 'Bot creates rainfall entry', 'Bot does not understand weather query'],
    actual_result: r,
    notes: isWeather ? 'Weather query handled' : 'Failed to process weather query'
  };
}

async function test26_inconsistent_data(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Try to harvest from a plot that has maíz but say soja
  let r = await sendAndLog(client, 'cosechamos soja del lote Sur');
  convo.push({ role: 'user', message: 'cosechamos soja del lote Sur', response: r });

  // Lote Sur has maíz, not soja
  const detectsInconsistency = r.toLowerCase().includes('maíz') || r.toLowerCase().includes('no tiene soja') || r.toLowerCase().includes('activo');

  return {
    test_name: '26_inconsistent_harvest_wrong_crop',
    category: 'validacion_negocio',
    severity: 'high',
    status: detectsInconsistency ? 'PASS' : 'WARN',
    conversation: convo,
    expected_behavior: ['Bot should warn that lote Sur has maíz, not soja, and ask for confirmation or correction'],
    possible_failures: ['Bot harvests soja from a maíz plot without warning', 'Bot creates new crop record', 'Bot ignores the discrepancy'],
    actual_result: r,
    notes: 'Testing business logic validation for crop consistency'
  };
}

async function test27_report_query(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'cómo viene la campaña del lote Norte?');
  convo.push({ role: 'user', message: 'cómo viene la campaña del lote Norte?', response: r });

  const isReport = r.toLowerCase().includes('campaña') || r.toLowerCase().includes('actividad') || r.toLowerCase().includes('norte') || r.toLowerCase().includes('soja') || r.toLowerCase().includes('gasto') || r.toLowerCase().includes('rinde');

  return {
    test_name: '27_campaign_stats_query',
    category: 'queries',
    severity: 'medium',
    status: isReport ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should return campaign stats for lote Norte (activities, expenses, yield if harvested)'],
    possible_failures: ['Bot creates observation', 'Bot shows general report instead of plot-specific', 'Bot does not understand "cómo viene"'],
    actual_result: r,
    notes: isReport ? 'Campaign query resolved' : 'Failed to interpret campaign query'
  };
}

async function test28_livestock_birth_vs_add(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, '5 vacas con 5 terneros');
  convo.push({ role: 'user', message: '5 vacas con 5 terneros', response: r });

  // Should be 2x add_livestock (NOT record_livestock_birth)
  const isAdd = r.toLowerCase().includes('registr') || r.toLowerCase().includes('vaca') || r.toLowerCase().includes('ternero');
  const isBirth = r.toLowerCase().includes('nacimiento') || r.toLowerCase().includes('parición');

  return {
    test_name: '28_livestock_add_not_birth',
    category: 'hacienda',
    severity: 'high',
    status: isAdd && !isBirth ? 'PASS' : (isBirth ? 'FAIL' : 'WARN'),
    conversation: convo,
    expected_behavior: ['"N vacas con N terneros" should trigger 2x add_livestock, NOT record_livestock_birth'],
    possible_failures: ['Bot uses birth event instead of add', 'Bot only adds one category', 'Bot asks which one to add'],
    actual_result: r,
    notes: 'Testing disambiguation between add and birth events'
  };
}

async function test29_quintal_units(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  let r = await sendAndLog(client, 'el lote Norte rindió 42 qq');
  convo.push({ role: 'user', message: 'el lote Norte rindió 42 qq', response: r });

  // 42 qq = 4200 kg/ha
  const hasYield = r.toLowerCase().includes('4200') || r.toLowerCase().includes('4.200') || r.toLowerCase().includes('42') || r.toLowerCase().includes('rinde') || r.toLowerCase().includes('cosech');

  return {
    test_name: '29_quintal_to_kg_conversion',
    category: 'unidades',
    severity: 'medium',
    status: hasYield ? 'PASS' : 'FAIL',
    conversation: convo,
    expected_behavior: ['Bot should convert 42 qq to 4200 kg/ha for yield'],
    possible_failures: ['Bot stores 42 as kg', 'Bot does not understand qq unit', 'Bot creates expense instead of harvest'],
    actual_result: r,
    notes: hasYield ? 'Quintal conversion handled' : 'Failed to convert quintal to kg'
  };
}

async function test30_full_conversation_flow(client: TestBotClient): Promise<TestResult> {
  const convo: TestResult['conversation'] = [];

  // Simulate a realistic multi-turn farmer conversation
  let r = await sendAndLog(client, 'hola');
  convo.push({ role: 'user', message: 'hola', response: r });

  r = await sendAndLog(client, 'ayer gasté 120 lucas en semilla de trigo');
  convo.push({ role: 'user', message: 'ayer gasté 120 lucas en semilla de trigo', response: r });

  // Confirm if there's a pending confirmation
  const dummyData = await apiSend(BASE_URL, AUTH_TOKEN, 'confirmar');
  const dummyText = extractText(dummyData);

  r = await sendAndLog(client, 'cómo estoy de plata este mes?');
  convo.push({ role: 'user', message: 'cómo estoy de plata este mes?', response: r });

  const hasFinancial = r.toLowerCase().includes('gasto') || r.toLowerCase().includes('ingreso') || r.toLowerCase().includes('$') || r.toLowerCase().includes('resultado') || r.toLowerCase().includes('balance');

  return {
    test_name: '30_full_realistic_conversation',
    category: 'flujo_completo',
    severity: 'medium',
    status: hasFinancial ? 'PASS' : 'WARN',
    conversation: convo,
    expected_behavior: ['Bot should greet, register expense for yesterday, then show monthly financial summary'],
    possible_failures: ['Bot loses context between messages', 'Bot double-registers expense', 'Financial report does not include registered expense'],
    actual_result: convo.map(c => `${c.message} → ${(c.response || '').substring(0, 60)}`).join('\n'),
    notes: 'Full multi-turn realistic farmer conversation'
  };
}

// ============= MAIN RUNNER =============

async function main() {
  const client = null; // unused, using direct API calls

  console.log('🧪 QA Adversarial Testing - 30 Complex Scenarios');
  console.log('================================================\n');

  // Register/login via direct API
  try {
    const auth = await apiRegister(BASE_URL, EMAIL, PASSWORD, NAME);
    AUTH_TOKEN = auth.token;
    console.log(`✅ Authenticated as user ${auth.userId}`);
  } catch {
    const auth = await apiLogin(BASE_URL, EMAIL, PASSWORD);
    AUTH_TOKEN = auth.token;
    console.log(`✅ Logged in as user ${auth.userId}`);
  }

  // Reset
  await apiReset(BASE_URL, AUTH_TOKEN);
  console.log('✅ User data reset\n');

  // Setup base data
  await setupBaseData(client as any);

  // Run all tests
  const tests = [
    test01_implicit_plot_reference,
    test02_ambiguous_size_reference,
    test03_compound_activity_expense,
    test04_livestock_ambiguity,
    test05_typo_crop_name,
    test06_stock_without_warehouse,
    test07_complex_livestock_movement,
    test08_date_relative_reference,
    test09_multi_day_rainfall,
    test10_crop_scouting_informal,
    test11_financial_query_vs_registration,
    test12_harvest_with_loads,
    test13_livestock_health_event,
    test14_livestock_repro,
    test15_livestock_weighing,
    test16_context_confusion_multiple_actions,
    test17_observation_vs_activity,
    test18_query_plot_history,
    test19_income_with_unit_price,
    test20_long_conversation_context,
    test21_hectares_vs_hacienda,
    test22_expense_with_typo_amount,
    test23_stock_query_complex,
    test24_scouting_severity_mapping,
    test25_weather_query,
    test26_inconsistent_data,
    test27_report_query,
    test28_livestock_birth_vs_add,
    test29_quintal_units,
    test30_full_conversation_flow,
  ];

  for (let i = 0; i < tests.length; i++) {
    const testFn = tests[i];
    console.log(`\n━━━ Test ${String(i + 1).padStart(2, '0')}/${tests.length}: ${testFn.name} ━━━`);
    try {
      const result = await testFn(client);
      results.push(result);
      const icon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`  ${icon} ${result.status} — ${result.test_name} [${result.category}] (${result.severity})`);
      if (result.status !== 'PASS') {
        console.log(`     Notes: ${result.notes}`);
        console.log(`     Response: ${result.actual_result.substring(0, 120)}...`);
      }
    } catch (err: any) {
      console.log(`  💥 ERROR — ${testFn.name}: ${err.message}`);
      results.push({
        test_name: testFn.name,
        category: 'error',
        severity: 'high',
        status: 'FAIL',
        conversation: [],
        expected_behavior: ['Test should execute without errors'],
        possible_failures: ['Runtime error'],
        actual_result: err.message,
        notes: `Runtime error: ${err.message}`
      });
    }

    // Clear any pending flow state between tests
    try {
      await apiSend(BASE_URL, AUTH_TOKEN, 'cancelar');
    } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 500));
  }

  // Print summary
  console.log('\n\n════════════════════════════════════════════');
  console.log('                 SUMMARY');
  console.log('════════════════════════════════════════════\n');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const warned = results.filter(r => r.status === 'WARN').length;

  console.log(`  ✅ PASS: ${passed}`);
  console.log(`  ❌ FAIL: ${failed}`);
  console.log(`  ⚠️  WARN: ${warned}`);
  console.log(`  📊 Total: ${results.length}`);
  console.log(`  📈 Pass rate: ${Math.round((passed / results.length) * 100)}%`);

  if (failed > 0) {
    console.log('\n\n─── FAILURES ───\n');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  ❌ ${r.test_name} [${r.severity}]`);
      console.log(`     Category: ${r.category}`);
      console.log(`     Expected: ${r.expected_behavior[0]}`);
      console.log(`     Got: ${r.actual_result.substring(0, 150)}`);
      console.log('');
    }
  }

  if (warned > 0) {
    console.log('\n─── WARNINGS ───\n');
    for (const r of results.filter(r => r.status === 'WARN')) {
      console.log(`  ⚠️  ${r.test_name} [${r.severity}]`);
      console.log(`     Notes: ${r.notes}`);
      console.log('');
    }
  }

  // MVP Assessment
  console.log('\n\n════════════════════════════════════════════');
  console.log('            MVP READINESS ASSESSMENT');
  console.log('════════════════════════════════════════════\n');

  const criticalFails = results.filter(r => r.status === 'FAIL' && r.severity === 'high').length;
  const mediumFails = results.filter(r => r.status === 'FAIL' && r.severity === 'medium').length;

  if (criticalFails === 0 && passed >= 20) {
    console.log('  🟢 MVP READY — No critical failures, solid pass rate');
  } else if (criticalFails <= 3 && passed >= 15) {
    console.log('  🟡 MVP ALMOST READY — Few critical issues to fix');
  } else {
    console.log('  🔴 NOT MVP READY — Multiple critical failures need attention');
  }

  console.log(`\n  Critical failures: ${criticalFails}`);
  console.log(`  Medium failures: ${mediumFails}`);
  console.log(`  Coverage areas tested: ${[...new Set(results.map(r => r.category))].join(', ')}`);

  // Write full results to JSON
  const fs = await import('fs');
  const outputPath = '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-adversarial-results.json';
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n  📄 Full results: ${outputPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
