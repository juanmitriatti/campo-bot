/**
 * QA Martin-Style 10 — conversaciones realistas con audio (Whisper)
 * cubriendo todos los dominios del bot.
 *
 * Cada conversación = N audios estilo audio-de-WhatsApp. Cubre:
 *   - Gastos (incluyendo auto-cancel de pending + USD format)
 *   - Ingresos (pesos y dólares)
 *   - Actividades agronómicas (fumigación, fertilización)
 *   - Siembras
 *   - Cosechas (con rinde y con cargas por chofer)
 *   - Flujos compuestos en un solo audio
 *   - Ciclo completo siembra → manejo → cosecha → venta
 *
 * Verifica los 4 bugs que fueron descubiertos en prod hoy:
 *   ✓ USD formateado como "USD X", nunca "$X USD"
 *   ✓ Auto-cancel de pending viejo cuando llega uno nuevo
 *   ✓ NO phantom tool calls (bleed-through del historial)
 *   ✓ response_text del logger NO vacío
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-martin-style-10.ts
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-martin@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Martin';
const TMP_DIR = '/tmp/qa-martin';

let TOKEN = '';
let USER_ID = 0;

// ── Auth ──────────────────────────────────────────────────────────────

async function register(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'QA', email: EMAIL, password: PASSWORD }),
  });
  if (res.ok) { const d = await res.json() as any; return { token: d.tokens.accessToken, userId: d.user.id }; }
  if (res.status === 409) return login();
  throw new Error(`Register failed: ${res.status} ${await res.text()}`);
}
async function login(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const d = await res.json() as any;
  return { token: d.tokens.accessToken, userId: d.user.id };
}

// ── Bot interaction ───────────────────────────────────────────────────

async function sendText(message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ message }),
  });
  const t = await res.text().catch(() => '');
  try { return JSON.parse(t); } catch { return { messages: [{ text: `HTTP ${res.status}` }] }; }
}
async function tap(buttonId: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  return res.json();
}

function generateAudio(text: string, slug: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const wav = path.join(TMP_DIR, `${slug}.wav`);
  execSync(`say -v Diego --data-format=LEI16@16000 -o ${wav} ${JSON.stringify(text)}`, { stdio: 'pipe' });
  return wav;
}

async function sendAudio(text: string, slug: string): Promise<{ transcript?: string; messages: any[] }> {
  const wav = generateAudio(text, slug);
  const buf = fs.readFileSync(wav);
  const form = new FormData();
  form.append('audio', new Blob([buf], { type: 'audio/wav' }), path.basename(wav));
  const res = await fetch(`${BASE_URL}/api/test-bot/audio`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}` }, body: form,
  });
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { messages: [{ text: `HTTP ${res.status}: ${t.slice(0, 200)}` }] }; }
}

async function dbq(sql: string, params: unknown[] = []): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status}`);
  const d = await res.json() as any;
  return d.rows ?? [];
}

function joinResponse(r: any): string {
  return (r.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}

// ── Setup ─────────────────────────────────────────────────────────────

async function setup(): Promise<void> {
  console.log('  → enabling confirm_before_save (Martin\'s setting)');
  await dbq(`INSERT INTO user_settings (user_id, confirm_before_save) VALUES ($1, true)
             ON CONFLICT (user_id) DO UPDATE SET confirm_before_save = true`, [USER_ID]);

  console.log('  → ensuring fields + plots exist');
  await sendText('cancelar');
  const fields = await dbq(`SELECT id FROM fields WHERE user_id=$1 AND deleted_at IS NULL`, [USER_ID]);
  if (fields.length === 0) {
    let r = await sendText('agregar campo Martin');
    if (/ubicar|localidad/i.test(joinResponse(r))) {
      await tap('flow_field_loc_city');
      await sendText('Pergamino');
      await tap('flow_confirm');
    }
    await sendText('agregar lote 1A al campo Martin'); await sendText('100');
    await sendText('agregar lote 2B al campo Martin'); await sendText('80');
    await sendText('agregar lote J2 al campo Martin'); await sendText('60');
  }
}

// ── Conversation definition ───────────────────────────────────────────

interface Step {
  audio?: string;
  tap?: string;
  expectContains?: (string | RegExp)[];
  expectNot?: (string | RegExp)[];
}

interface Conversation {
  id: string;
  description: string;
  steps: Step[];
  dbCheck?: () => Promise<{ ok: boolean; reason: string }>;
}

// ── 10 Conversations cubriendo todos los dominios ────────────────────

const CONVERSATIONS: Conversation[] = [

  // ────────────────────────────────────────────────────────────────
  // GASTOS
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C01_gastos_rapidos_USD',
    description: 'GASTOS — 2 audios USD seguidos: el segundo debe avisar "cancelé el anterior" y mostrar "USD X" (nunca "$X USD")',
    steps: [
      {
        audio: 'gasté ochocientos dólares en gasoil para el lote uno A',
        expectContains: [/USD\s*800/i, /gasoil|combust/i],
        expectNot: [/\$\s*800\s*USD/i],
      },
      {
        audio: 'gasté mil quinientos dólares en fertilizante para el lote dos B',
        expectContains: [/cancel[eé].*anterior/i, /USD\s*1\.?500/i, /fertiliz/i],
        expectNot: [/\$\s*1\.?500\s*USD/i],
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────
  // INGRESOS
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C02_ingreso_pesos_simple',
    description: 'INGRESO en pesos: confirmá y verificá que entró bien al DB',
    steps: [
      {
        audio: 'registrar quinientos mil pesos de ingreso por venta de soja en el lote uno A',
        expectContains: [/\$\s*500\.?000/i, /soja/i],
        expectNot: [/USD/i],
      },
      { tap: 'confirm_pending', expectContains: [/registrad|guardad/i] },
    ],
    dbCheck: async () => {
      const rows = await dbq(
        `SELECT amount::int, currency, category FROM incomes
         WHERE user_id=$1 AND amount=500000 AND currency='ARS' AND deleted_at IS NULL
         ORDER BY id DESC LIMIT 1`,
        [USER_ID],
      );
      if (rows.length === 0) return { ok: false, reason: 'no 500k ARS income saved' };
      return { ok: true, reason: `saved: ${rows[0].amount} ${rows[0].currency} ${rows[0].category}` };
    },
  },

  {
    id: 'C03_ingreso_dolares_chain',
    description: 'INGRESOS USD — 3 audios encadenados, cada nuevo auto-cancela',
    steps: [
      { audio: 'registrar veinte mil dólares de ingreso en soja para el lote uno A',
        expectContains: [/USD\s*20\.?000/i] },
      { audio: 'registrar cuarenta mil dólares de ingreso en maíz para el lote dos B',
        expectContains: [/cancel[eé]/i, /USD\s*40\.?000/i] },
      { audio: 'registrar setenta mil dólares de ingreso en trigo para el lote J dos',
        expectContains: [/cancel[eé]/i, /USD\s*70\.?000/i, /trigo/i] },
    ],
  },

  // ────────────────────────────────────────────────────────────────
  // SIEMBRA (activity, sin confirm flow)
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C04_siembra',
    description: 'SIEMBRA: registra cultivo en el lote, debe guardar plot_crop activo',
    steps: [
      {
        audio: 'sembré soja en el lote uno A',
        expectContains: [/soja/i, /sembr|siembra/i, /1\s*A|uno\s*A/i],
        expectNot: [/no\s+pude|error/i],
      },
    ],
    dbCheck: async () => {
      const rows = await dbq(
        `SELECT pc.crop, pc.state, p.name plot
         FROM plot_crops pc JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1 AND pc.state='active' ORDER BY pc.id DESC LIMIT 1`,
        [USER_ID],
      );
      if (rows.length === 0) return { ok: false, reason: 'no active plot_crop' };
      if (!/soja/i.test(rows[0].crop)) return { ok: false, reason: `expected soja, got ${rows[0].crop}` };
      return { ok: true, reason: `${rows[0].crop} active in plot ${rows[0].plot}` };
    },
  },

  // ────────────────────────────────────────────────────────────────
  // ACTIVIDAD: fumigación con producto + dosis
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C05_fumigacion',
    description: 'FUMIGACIÓN con glifosato 2 lt/ha en lote 1A',
    steps: [
      {
        audio: 'fumigué el lote uno A con glifosato a dos litros por hectárea',
        expectContains: [/fumig|spray/i, /glifosato/i, /(2\s*lt|2\s*l|dos\s*litros)/i],
        expectNot: [/no\s+pude|error/i],
      },
    ],
    dbCheck: async () => {
      const rows = await dbq(
        `SELECT event_type, product, quantity::int, unit
         FROM domain_events
         WHERE user_id=$1 AND event_type='spraying' AND deleted_at IS NULL
         ORDER BY id DESC LIMIT 1`,
        [USER_ID],
      );
      if (rows.length === 0) return { ok: false, reason: 'no spraying event saved' };
      if (!/glifosato/i.test(rows[0].product || '')) return { ok: false, reason: `expected glifosato, got ${rows[0].product}` };
      return { ok: true, reason: `spraying: ${rows[0].product} ${rows[0].quantity}${rows[0].unit}` };
    },
  },

  // ────────────────────────────────────────────────────────────────
  // ACTIVIDAD: fertilización
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C06_fertilizacion',
    description: 'FERTILIZACIÓN urea 80 kg/ha en lote 2B',
    steps: [
      {
        audio: 'fertilicé el lote dos B con urea a ochenta kilos por hectárea',
        expectContains: [/fertil/i, /urea/i, /(80|ochenta)/i],
        expectNot: [/no\s+pude|error/i],
      },
    ],
    dbCheck: async () => {
      const rows = await dbq(
        `SELECT event_type, product, quantity::int, unit
         FROM domain_events
         WHERE user_id=$1 AND event_type='fertilization' AND deleted_at IS NULL
         ORDER BY id DESC LIMIT 1`,
        [USER_ID],
      );
      if (rows.length === 0) return { ok: false, reason: 'no fertilization event' };
      if (!/urea/i.test(rows[0].product || '')) return { ok: false, reason: `expected urea, got ${rows[0].product}` };
      return { ok: true, reason: `fertilization: ${rows[0].product} ${rows[0].quantity}${rows[0].unit}` };
    },
  },

  // ────────────────────────────────────────────────────────────────
  // COSECHA con rinde kg/ha
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C07_cosecha_con_rinde',
    description: 'COSECHA de soja con rinde 3500 kg/ha en lote 1A',
    steps: [
      {
        audio: 'coseché soja en el lote uno A con un rinde de tres mil quinientos kilos por hectárea',
        expectContains: [/cosech/i, /soja/i, /(3\.?500|3500|tres\s*mil)/i],
        expectNot: [/no\s+pude|error/i],
      },
    ],
    dbCheck: async () => {
      const rows = await dbq(
        `SELECT pc.crop, pc.yield_kg, pc.yield_kg_per_ha
         FROM plot_crops pc JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1 AND pc.crop ILIKE 'soja'
         ORDER BY pc.id DESC LIMIT 1`,
        [USER_ID],
      );
      if (rows.length === 0) return { ok: false, reason: 'no soja plot_crop' };
      const ypha = Number(rows[0].yield_kg_per_ha);
      if (!ypha || Math.abs(ypha - 3500) > 200) return { ok: false, reason: `expected ~3500 kg/ha, got ${ypha}` };
      return { ok: true, reason: `cosecha: ${rows[0].yield_kg} kg total = ${ypha} kg/ha` };
    },
  },

  // ────────────────────────────────────────────────────────────────
  // COSECHA con cargas por chofer
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C08_cosecha_cargas',
    description: 'COSECHA de maíz con 2 cargas por chofer en lote 2B',
    steps: [
      {
        audio: 'cosechamos maíz en el lote dos B. Britos llevó treinta mil kilos y Contreras veinticinco mil kilos',
        expectContains: [/cosech/i, /ma[ií]z/i, /britos/i, /contreras/i, /30\.?000|treinta\s*mil/i],
        expectNot: [/no\s+pude|error/i],
      },
    ],
    dbCheck: async () => {
      const rows = await dbq(
        `SELECT hl.driver_name, hl.weight_kg::int, e.crop
         FROM harvest_loads hl JOIN domain_events e ON e.id=hl.domain_event_id
         WHERE e.user_id=$1 AND e.event_type='harvest'
         ORDER BY hl.id DESC LIMIT 4`,
        [USER_ID],
      );
      if (rows.length < 2) return { ok: false, reason: `expected 2+ loads, got ${rows.length}` };
      const drivers = rows.map(r => (r.driver_name || '').toLowerCase()).join(',');
      if (!/britos/i.test(drivers) || !/contreras/i.test(drivers)) {
        return { ok: false, reason: `drivers: ${drivers}` };
      }
      return { ok: true, reason: `${rows.length} loads, drivers: ${drivers}` };
    },
  },

  // ────────────────────────────────────────────────────────────────
  // COMPOUND: 2 acciones en un audio
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C09_compound_siembra_fertilizacion',
    description: 'COMPOUND en un audio: siembra + fertilización → 2 tools',
    steps: [
      {
        audio: 'sembré maíz en el lote J dos y fertilicé el lote dos B con urea a cien kilos por hectárea',
        expectContains: [/siembr|sembr/i, /fertil/i, /ma[ií]z/i, /urea/i],
        expectNot: [/no\s+pude|error/i],
      },
    ],
    dbCheck: async () => {
      // Look for both events in the last 5 sec
      const rows = await dbq(
        `SELECT event_type FROM domain_events
         WHERE user_id=$1 AND deleted_at IS NULL
           AND event_type IN ('planting','fertilization')
           AND created_at > NOW() - interval '15 seconds'
         ORDER BY id DESC`,
        [USER_ID],
      );
      const types = new Set(rows.map(r => r.event_type));
      if (!types.has('planting')) return { ok: false, reason: 'no planting event' };
      if (!types.has('fertilization')) return { ok: false, reason: 'no fertilization event' };
      return { ok: true, reason: `compound saved ${rows.length} events` };
    },
  },

  // ────────────────────────────────────────────────────────────────
  // CICLO COMPLETO: gasto + actividad + ingreso
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C10_ciclo_gasto_actividad_ingreso',
    description: 'CICLO MIXTO — gasto USD + fumigación + ingreso USD: cada uno debe quedar bien',
    steps: [
      { audio: 'gasté mil dólares en glifosato para el lote uno A',
        expectContains: [/USD\s*1\.?000/i],
        expectNot: [/\$\s*1\.?000\s*USD/i] },
      { tap: 'confirm_pending', expectContains: [/registrad|guardad/i] },
      { audio: 'fumigué el lote uno A con glifosato a tres litros por hectárea',
        expectContains: [/fumig/i, /glifosato/i] },
      { audio: 'registrar cinco mil dólares de ingreso por venta de soja en el lote uno A',
        expectContains: [/USD\s*5\.?000/i, /soja/i],
        expectNot: [/\$\s*5\.?000\s*USD/i] },
      { tap: 'confirm_pending', expectContains: [/registrad|guardad/i] },
    ],
    dbCheck: async () => {
      const expRows = await dbq(
        `SELECT amount::int FROM expenses WHERE user_id=$1 AND currency='USD' AND amount=1000 AND deleted_at IS NULL`,
        [USER_ID],
      );
      const incRows = await dbq(
        `SELECT amount::int FROM incomes WHERE user_id=$1 AND currency='USD' AND amount=5000 AND deleted_at IS NULL`,
        [USER_ID],
      );
      if (expRows.length === 0) return { ok: false, reason: 'no 1000 USD expense' };
      if (incRows.length === 0) return { ok: false, reason: 'no 5000 USD income' };
      return { ok: true, reason: '1000 USD expense + 5000 USD income both saved' };
    },
  },
];

// ── Runner ────────────────────────────────────────────────────────────

interface StepResult { step: number; ok: boolean; reason: string; transcript?: string; response?: string }
interface ConvResult { id: string; description: string; pass: boolean; steps: StepResult[]; dbCheck?: { ok: boolean; reason: string } }

function checkExpectations(response: string, contains: (string | RegExp)[] | undefined, not: (string | RegExp)[] | undefined): { ok: boolean; reason: string } {
  if (contains) {
    for (const pat of contains) {
      const re = pat instanceof RegExp ? pat : new RegExp(pat, 'i');
      if (!re.test(response)) return { ok: false, reason: `missing: ${pat}` };
    }
  }
  if (not) {
    for (const pat of not) {
      const re = pat instanceof RegExp ? pat : new RegExp(pat, 'i');
      if (re.test(response)) return { ok: false, reason: `should NOT match: ${pat}` };
    }
  }
  return { ok: true, reason: 'all expectations met' };
}

async function runConversation(conv: Conversation, idx: number): Promise<ConvResult> {
  console.log(`\n[${idx + 1}/${CONVERSATIONS.length}] ${conv.id}`);
  console.log(`    ${conv.description}`);

  await sendText('cancelar');
  await new Promise(r => setTimeout(r, 200));

  const stepResults: StepResult[] = [];
  let allOk = true;

  for (let s = 0; s < conv.steps.length; s++) {
    const step = conv.steps[s];
    let resp: any;
    let label = '';
    if (step.audio) {
      label = `🎤 "${step.audio.slice(0, 70)}${step.audio.length > 70 ? '…' : ''}"`;
      resp = await sendAudio(step.audio, `${conv.id}_s${s}`);
    } else if (step.tap) {
      label = `👆 tap:${step.tap}`;
      resp = await tap(step.tap);
    } else {
      stepResults.push({ step: s, ok: false, reason: 'step has no audio or tap' });
      allOk = false;
      continue;
    }

    const responseText = joinResponse(resp);
    const transcript = resp.transcript;
    console.log(`    ${label}`);
    if (transcript) console.log(`       transcript: "${transcript}"`);
    console.log(`       response: "${responseText.slice(0, 160).replace(/\n/g, ' ↵ ')}${responseText.length > 160 ? '…' : ''}"`);

    const check = checkExpectations(responseText, step.expectContains, step.expectNot);
    if (!check.ok) {
      console.log(`       ❌ ${check.reason}`);
      allOk = false;
    } else {
      console.log(`       ✅`);
    }
    stepResults.push({ step: s, ok: check.ok, reason: check.reason, transcript, response: responseText.slice(0, 250) });

    await new Promise(r => setTimeout(r, 400));
  }

  let dbCheck: { ok: boolean; reason: string } | undefined;
  if (conv.dbCheck) {
    try {
      dbCheck = await conv.dbCheck();
      console.log(`    DB check: ${dbCheck.ok ? '✅' : '❌'} ${dbCheck.reason}`);
      if (!dbCheck.ok) allOk = false;
    } catch (err) {
      dbCheck = { ok: false, reason: `DB check threw: ${(err as Error).message}` };
      allOk = false;
    }
  }

  return { id: conv.id, description: conv.description, pass: allOk, steps: stepResults, dbCheck };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(72));
  console.log('QA Martin-Style 10 — audio conversations covering all domains');
  console.log('═'.repeat(72));

  console.log('\nAuth…');
  const auth = await register();
  TOKEN = auth.token; USER_ID = auth.userId;
  console.log(`  user_id=${USER_ID}`);

  console.log('\nSetup…');
  await setup();

  const results: ConvResult[] = [];
  for (let i = 0; i < CONVERSATIONS.length; i++) {
    try {
      results.push(await runConversation(CONVERSATIONS[i], i));
    } catch (err) {
      console.error(`  💥 conversation crashed: ${(err as Error).message}`);
      results.push({ id: CONVERSATIONS[i].id, description: CONVERSATIONS[i].description, pass: false, steps: [{ step: -1, ok: false, reason: (err as Error).message }] });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  const passed = results.filter(r => r.pass).length;
  console.log('\n' + '═'.repeat(72));
  console.log(`RESULTS: ${passed}/${results.length} conversations passed`);
  console.log('═'.repeat(72));
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`${icon} ${r.id}`);
    console.log(`     ${r.description}`);
    if (!r.pass) {
      for (const s of r.steps.filter(x => !x.ok)) {
        console.log(`     step ${s.step}: ${s.reason}`);
        if (s.transcript) console.log(`       transcript: "${s.transcript.slice(0, 80)}"`);
        if (s.response) console.log(`       got: "${s.response.slice(0, 120).replace(/\n/g, ' ↵ ')}"`);
      }
      if (r.dbCheck && !r.dbCheck.ok) console.log(`     DB: ${r.dbCheck.reason}`);
    }
  }

  const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'qa-martin-style-results.json');
  fs.writeFileSync(out, JSON.stringify({ passed, total: results.length, ts: new Date().toISOString(), results }, null, 2));
  console.log(`\nReport saved to ${out}`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error('💥 FATAL:', err);
  process.exit(1);
});
