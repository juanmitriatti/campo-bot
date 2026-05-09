/**
 * QA Friction Tester — sends short / ambiguous prompts and classifies how
 * the bot responds. Goal: find places where the bot is generic, confusing,
 * or silent when it could provide a smart redirect (buttons + examples).
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-friction.ts
 *      ONLY=01,03,12 npx tsx src/testing/qa-friction.ts   (filter by id)
 */

import { writeFileSync } from 'node:fs';

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'testin@gmail.com';
const PASSWORD = 'tester123';
const NAME = 'Friction';

// ============= API HELPERS =============

async function apiRegister(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'QA', email: EMAIL, password: PASSWORD }),
  });
  if (res.ok) { const d = await res.json() as any; return { token: d.tokens.accessToken, userId: d.user.id }; }
  if (res.status === 409) return apiLogin();
  throw new Error(`Register failed: ${res.status} ${await res.text()}`);
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
async function apiReset(token: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test-bot/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: '{}',
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}
async function apiSend(token: string, message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function apiTap(token: string, buttonId: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status} ${await res.text()}`);
  return res.json();
}

let TOKEN = '';
let USER_ID = 0;

function extractButtons(data: any): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  for (const m of (data.messages || [])) {
    if (m.interactive?.buttons) for (const b of m.interactive.buttons) out.push(b);
    if (m.interactive?.sections) for (const s of m.interactive.sections) for (const r of (s.rows || [])) out.push({ id: r.id, title: r.title });
  }
  return out;
}
function extractText(data: any): { text: string; buttons: Array<{ id: string; title: string }>; hasInteractive: boolean } {
  const messages = data.messages || [];
  const parts: string[] = [];
  let hasInteractive = false;
  for (const m of messages) {
    if (m.text) parts.push(m.text);
    if (m.interactive?.body) { parts.push(m.interactive.body); hasInteractive = true; }
    if (m.interactive?.buttons || m.interactive?.sections) hasInteractive = true;
  }
  return { text: parts.join('\n'), buttons: extractButtons(data), hasInteractive };
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ============= TEST PROMPTS =============

type Category = 'one_word' | 'fragment' | 'polite' | 'numbers' | 'partial' | 'context_lost';

interface FrictionPrompt {
  id: string;
  prompt: string;
  category: Category;
  what_user_likely_meant: string;
  ideal_response: string;
}

const PROMPTS: FrictionPrompt[] = [
  // --- A. ONE-WORD TRIGGERS ---
  { id: '01', prompt: 'lluvia', category: 'one_word',
    what_user_likely_meant: 'register or query rainfall',
    ideal_response: 'buttons: registrar lluvia / lluvia mes / clima' },
  { id: '02', prompt: 'soja', category: 'one_word',
    what_user_likely_meant: 'query soja crops',
    ideal_response: 'buttons: dónde tengo soja / cosecha de soja / siembra' },
  { id: '03', prompt: 'vacas', category: 'one_word',
    what_user_likely_meant: 'livestock action or query',
    ideal_response: 'buttons: agregar / vender / cuántas tengo' },
  { id: '04', prompt: 'cosecha', category: 'one_word',
    what_user_likely_meant: 'register or view harvest',
    ideal_response: 'examples + buttons: cargas del lote X / coseché soja en X' },
  { id: '05', prompt: 'gasto', category: 'one_word',
    what_user_likely_meant: 'register or view expenses',
    ideal_response: 'buttons: cargar gasto / resumen mes / categoría' },
  { id: '06', prompt: 'siembra', category: 'one_word',
    what_user_likely_meant: 'register sowing',
    ideal_response: 'examples: "sembré soja en lote 3"' },
  { id: '07', prompt: 'fumigué', category: 'one_word',
    what_user_likely_meant: 'incomplete spraying record',
    ideal_response: 'ask: "¿qué fumigaste y dónde? ej: fumigué glifosato 2 lt/ha en lote 3"' },
  { id: '08', prompt: 'campos', category: 'one_word',
    what_user_likely_meant: 'list_fields',
    ideal_response: 'list of fields (existing trivial command)' },
  { id: '09', prompt: 'stock', category: 'one_word',
    what_user_likely_meant: 'view or add stock',
    ideal_response: 'buttons or examples for stock' },

  // --- B. FRAGMENTS ---
  { id: '10', prompt: 'vi algo', category: 'fragment',
    what_user_likely_meant: 'incomplete observation',
    ideal_response: 'ask: "¿qué viste? ej: vi rama negra en lote 3"' },
  { id: '11', prompt: 'compré', category: 'fragment',
    what_user_likely_meant: 'incomplete purchase',
    ideal_response: 'ask: "¿qué compraste? ej: compré 200 lt de glifosato"' },
  { id: '12', prompt: 'vendí', category: 'fragment',
    what_user_likely_meant: 'incomplete sale',
    ideal_response: 'ask: "¿qué vendiste? ej: vendí 30 tn de soja a 300 USD"' },
  { id: '13', prompt: '200 mil', category: 'fragment',
    what_user_likely_meant: 'incomplete amount',
    ideal_response: 'ask: "¿200 mil de qué? ej: gasté 200 mil en gasoil"' },
  { id: '14', prompt: 'cargar', category: 'fragment',
    what_user_likely_meant: 'incomplete action',
    ideal_response: 'ask: "¿cargar qué? gasto/lluvia/lote/etc"' },
  { id: '15', prompt: 'registrar', category: 'fragment',
    what_user_likely_meant: 'incomplete action',
    ideal_response: 'ask: "¿registrar qué? gasto/actividad/lluvia"' },

  // --- C. POLITE / UNCERTAIN ---
  { id: '16', prompt: 'che', category: 'polite',
    what_user_likely_meant: 'attention call',
    ideal_response: 'friendly + ayuda hint' },
  { id: '17', prompt: 'una pregunta', category: 'polite',
    what_user_likely_meant: 'about to ask something',
    ideal_response: 'friendly: "¡dale! ¿qué necesitás?"' },
  { id: '18', prompt: 'no se', category: 'polite',
    what_user_likely_meant: 'lost',
    ideal_response: 'point at ayuda + give 2 quick examples' },
  { id: '19', prompt: 'no entiendo', category: 'polite',
    what_user_likely_meant: 'confused',
    ideal_response: 'point at ayuda + give 2 quick examples' },
  { id: '20', prompt: 'podrías ayudarme', category: 'polite',
    what_user_likely_meant: 'asking for help',
    ideal_response: 'help menu (paginated)' },

  // --- D. AMBIGUOUS NUMBERS/UNITS ---
  { id: '21', prompt: '30 tn', category: 'numbers',
    what_user_likely_meant: 'incomplete (cosecha? venta? capacidad?)',
    ideal_response: 'ask which: "¿30 tn de qué? cosecha/venta/stock"' },
  { id: '22', prompt: '100 ha', category: 'numbers',
    what_user_likely_meant: 'incomplete (lote area? sembré?)',
    ideal_response: 'ask: "¿qué es de 100 ha? lote nuevo / siembra / arrendamiento"' },
  { id: '23', prompt: '20 mm', category: 'numbers',
    what_user_likely_meant: 'rainfall without verb',
    ideal_response: 'should register rainfall (or ask field if needed)' },

  // --- E. PARTIALS / COMMON TYPOS ---
  { id: '24', prompt: 'lluv', category: 'partial',
    what_user_likely_meant: 'lluvia',
    ideal_response: 'should be smart: assume lluvia + offer options' },
  { id: '25', prompt: 'fum', category: 'partial',
    what_user_likely_meant: 'fumigación',
    ideal_response: 'examples: "fumigué glifosato en lote X"' },
  { id: '26', prompt: 'siembr', category: 'partial',
    what_user_likely_meant: 'siembra',
    ideal_response: 'examples: "sembré soja en lote X"' },

  // --- F. LOST CONTEXT ---
  { id: '27', prompt: 'lote 3', category: 'context_lost',
    what_user_likely_meant: 'query about lote 3',
    ideal_response: 'ask: "¿qué del lote 3? info / historial / cosecha / gastos"' },
  { id: '28', prompt: 'reportes', category: 'context_lost',
    what_user_likely_meant: 'show reports menu',
    ideal_response: 'list of report types (already works as show_reports_menu)' },
  { id: '29', prompt: 'que hay', category: 'context_lost',
    what_user_likely_meant: 'overview / status',
    ideal_response: 'menu or quick status' },
  { id: '30', prompt: 'hola que tal', category: 'context_lost',
    what_user_likely_meant: 'greeting',
    ideal_response: 'greeting + menu hint (already works)' },
];

// ============= CLASSIFICATION =============

type Verdict = 'GOOD' | 'OK_FALLBACK' | 'GENERIC' | 'EMPTY' | 'CONFUSED';

interface PromptResult {
  id: string;
  prompt: string;
  category: Category;
  verdict: Verdict;
  response_text: string;
  has_buttons: boolean;
  button_count: number;
  button_ids: string[];
  intent_command: string | null;
  notes: string;
}

function classify(parsed: ReturnType<typeof extractText>, dbIntent: string | null, prompt: string): { verdict: Verdict; notes: string } {
  const t = parsed.text.trim();
  const tl = t.toLowerCase();

  if (!t && parsed.buttons.length === 0) {
    return { verdict: 'EMPTY', notes: 'Bot no respondió nada' };
  }

  // GOOD via interactive buttons / list
  if (parsed.hasInteractive && parsed.buttons.length > 0) {
    if (dbIntent && ['list_fields', 'show_reports_menu', 'help', 'menu', 'show_rain_menu', 'show_agro_menu', 'active_crop', 'list_livestock'].includes(dbIntent)) {
      return { verdict: 'GOOD', notes: `Routed to ${dbIntent} (+${parsed.buttons.length} buttons)` };
    }
    return { verdict: 'GOOD', notes: `${parsed.buttons.length} buttons offered` };
  }

  // GOOD via text-based plot prompt: "¿En qué lote?" with bullet list
  if (/¿en qu[eé] lote\?/i.test(t) && /•/.test(t)) {
    return { verdict: 'GOOD', notes: 'Asked for plot with list (text mode)' };
  }

  // GOOD via category list: response has multiple emoji-prefixed bullets/labels
  // (e.g., "📦 Stock... 💰 Gasto... 🐄 Hacienda...")
  const emojiBullets = (t.match(/[📦💰🐄🌧️🌱📊🏡⚙️🌾☀️📋💸🧾↩️➕]/gu) || []).length;
  if (emojiBullets >= 3 && /\*[a-záéíóúñ]+:?\*/i.test(t)) {
    return { verdict: 'GOOD', notes: `Category list (${emojiBullets} emoji bullets)` };
  }

  // CONFUSED — known broken paths
  if (/no entendí si querías registrar/.test(t)) {
    return { verdict: 'CONFUSED', notes: 'Hit observation guard fallback' };
  }
  if (/no pude detectar/.test(tl) || (/error/.test(tl) && /reintenta/.test(tl))) {
    return { verdict: 'CONFUSED', notes: 'Bot reported error' };
  }

  // OK_FALLBACK — text response that points the user somewhere
  if (/escribí.*ayuda/i.test(t) || /escribí.*menú/i.test(t) || /\*ayuda\*/.test(t) || /\*menú\*/.test(t)) {
    return { verdict: 'OK_FALLBACK', notes: 'Mentions ayuda/menú' };
  }
  if (/ej:|por ejemplo|ejemplo:/i.test(t)) {
    return { verdict: 'OK_FALLBACK', notes: 'Has examples but no buttons' };
  }

  // Otherwise — ambiguous text response with no guidance
  return { verdict: 'GENERIC', notes: 'No buttons, no clear next step' };
}

// ============= MAIN =============

async function setupFixture(): Promise<void> {
  console.log('  Setup: resetting + seeding minimal fixture...');
  await apiReset(TOKEN);
  // 1 field + 3 plots so "lote 3" has something to resolve to.
  await apiSend(TOKEN, 'agregar campo Friccion en Pergamino');
  await sleep(150);
  for (const name of ['1', '2', '3']) {
    await apiSend(TOKEN, `agregar lote ${name} al campo Friccion`);
    await sleep(80);
    await apiSend(TOKEN, '50');
    await sleep(80);
  }
  console.log('    1 field + 3 plots ready');
}

async function getLastIntent(token: string): Promise<string | null> {
  // The test-bot doesn't expose conversation_logs directly; we can query via /query-db
  try {
    const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sql: `SELECT intent_command FROM conversation_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, params: [USER_ID] }),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.rows?.[0]?.intent_command || null;
  } catch {
    return null;
  }
}

async function runOne(p: FrictionPrompt): Promise<PromptResult> {
  // Always cancel any sticky flow before testing the next prompt
  try { await apiSend(TOKEN, 'cancelar'); } catch { /* ignore */ }
  await sleep(200);

  const data = await apiSend(TOKEN, p.prompt);
  const parsed = extractText(data);
  const dbIntent = await getLastIntent(TOKEN);
  const cls = classify(parsed, dbIntent, p.prompt);

  return {
    id: p.id, prompt: p.prompt, category: p.category,
    verdict: cls.verdict,
    response_text: parsed.text.slice(0, 240),
    has_buttons: parsed.hasInteractive,
    button_count: parsed.buttons.length,
    button_ids: parsed.buttons.map(b => b.id).slice(0, 6),
    intent_command: dbIntent,
    notes: cls.notes,
  };
}

async function main() {
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(s => s.trim())) : null;

  console.log('\n=== QA Friction Tester ===');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Login as ${EMAIL}`);
  const auth = await apiRegister();
  TOKEN = auth.token; USER_ID = auth.userId;
  console.log(`User id: ${USER_ID}`);

  await setupFixture();

  const subset = only ? PROMPTS.filter(p => only.has(p.id)) : PROMPTS;
  console.log(`\nRunning ${subset.length} friction prompts...\n`);

  const results: PromptResult[] = [];
  for (const p of subset) {
    process.stdout.write(`[${p.id}] "${p.prompt}"`.padEnd(40));
    try {
      const r = await runOne(p);
      results.push(r);
      const verdictColor = { GOOD: '✅', OK_FALLBACK: '🟨', GENERIC: '⚠️ ', EMPTY: '❌', CONFUSED: '🚫' }[r.verdict];
      console.log(`${verdictColor} ${r.verdict.padEnd(12)} ${r.notes}`);
    } catch (e: any) {
      console.log(`❌ EXCEPTION: ${e.message}`);
      results.push({ id: p.id, prompt: p.prompt, category: p.category, verdict: 'EMPTY', response_text: `EXCEPTION: ${e.message}`, has_buttons: false, button_count: 0, button_ids: [], intent_command: null, notes: e.message });
    }
    await sleep(150);
  }

  // ============= REPORT =============
  console.log('\n\n=== RESULTS BY CATEGORY ===\n');
  const byCat: Record<string, PromptResult[]> = {};
  for (const r of results) {
    byCat[r.category] = byCat[r.category] || [];
    byCat[r.category].push(r);
  }
  for (const [cat, rs] of Object.entries(byCat)) {
    const counts = { GOOD: 0, OK_FALLBACK: 0, GENERIC: 0, EMPTY: 0, CONFUSED: 0 };
    for (const r of rs) counts[r.verdict]++;
    console.log(`${cat.padEnd(15)} ${rs.length} prompts → ✅${counts.GOOD} 🟨${counts.OK_FALLBACK} ⚠️ ${counts.GENERIC} 🚫${counts.CONFUSED} ❌${counts.EMPTY}`);
  }

  console.log('\n=== TOP OFFENDERS (need attention) ===\n');
  const bad = results.filter(r => r.verdict === 'GENERIC' || r.verdict === 'CONFUSED' || r.verdict === 'EMPTY');
  for (const r of bad) {
    console.log(`[${r.id}] "${r.prompt}" → ${r.verdict}`);
    console.log(`  bot: ${r.response_text.slice(0, 180).replace(/\n/g, ' ')}`);
    console.log(`  intent: ${r.intent_command || '(none)'}, notes: ${r.notes}\n`);
  }

  // Save full JSON for review
  writeFileSync('src/testing/qa-friction-results.json', JSON.stringify(results, null, 2));
  console.log(`\nFull results → src/testing/qa-friction-results.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
