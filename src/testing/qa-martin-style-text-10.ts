/**
 * QA Martin-Style 10 (TEXT variant) — corre las mismas 10 conversaciones
 * que qa-martin-style-10.ts pero usando texto directo (sin TTS + Whisper).
 *
 * Útil para regression del bot puro — separa los bugs del pipeline AI
 * (agent + handlers) de los bugs del pipeline de audio (TTS + Whisper).
 *
 * Cubre los mismos dominios: gastos, ingresos, siembras, fumigaciones,
 * fertilizaciones, cosechas, compounds, ciclo completo.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-martin-style-text-10.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-martin-text@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'MartinText';

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
    let r = await sendText('agregar campo MartinText');
    if (/ubicar|localidad/i.test(joinResponse(r))) {
      await tap('flow_field_loc_city');
      await sendText('Pergamino');
      await tap('flow_confirm');
    }
    await sendText('agregar lote 1A al campo MartinText'); await sendText('100');
    await sendText('agregar lote 2B al campo MartinText'); await sendText('80');
    await sendText('agregar lote J2 al campo MartinText'); await sendText('60');
  }

  console.log('  → resetting state between runs (close active crops, clear domain_events/incomes/expenses)');
  // The siembra handler is idempotent — re-sowing the same crop on an active
  // plot_crop returns "already sown" without inserting. Forcing close + clear
  // makes each run start clean so dbChecks are deterministic.
  await dbq(
    `UPDATE plot_crops SET end_date = CURRENT_DATE
     WHERE plot_id IN (SELECT id FROM plots WHERE field_id IN
       (SELECT id FROM fields WHERE user_id = $1)) AND end_date IS NULL`,
    [USER_ID],
  );
  await dbq(
    `UPDATE domain_events SET deleted_at = NOW()
     WHERE user_id = $1 AND deleted_at IS NULL`,
    [USER_ID],
  );
  await dbq(`UPDATE expenses SET deleted_at = NOW() WHERE user_id = $1 AND deleted_at IS NULL`, [USER_ID]);
  await dbq(`UPDATE incomes  SET deleted_at = NOW() WHERE user_id = $1 AND deleted_at IS NULL`, [USER_ID]);
}

// ── Conversation definition ───────────────────────────────────────────

interface Step {
  text?: string;
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

const CONVERSATIONS: Conversation[] = [

  // ────────────────────────────────────────────────────────────────
  // GASTOS — auto-cancel + USD format
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C01_gastos_rapidos_USD',
    description: 'GASTOS — 2 USD seguidos: el 2do avisa "cancelé el anterior" y muestra USD sin $',
    steps: [
      { text: 'gasté 800 dólares en gasoil para el lote 1A',
        expectContains: [/USD\s*800/i, /gasoil|combust/i],
        expectNot: [/\$\s*800\s*USD/i] },
      { text: 'gasté 1500 dólares en fertilizante para el lote 2B',
        expectContains: [/cancel[eé].*anterior/i, /USD\s*1\.?500/i, /fertiliz/i],
        expectNot: [/\$\s*1\.?500\s*USD/i] },
    ],
  },

  // ────────────────────────────────────────────────────────────────
  // INGRESO pesos + confirm
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C02_ingreso_pesos_simple',
    description: 'INGRESO en pesos: confirmá y verificá DB',
    steps: [
      { text: 'registrar 500000 pesos de ingreso por venta de soja en el lote 1A',
        expectContains: [/\$\s*500\.?000/i, /soja/i],
        expectNot: [/USD/i] },
      { tap: 'confirm_pending', expectContains: [/registrad|guardad|anotad/i] },
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

  // ────────────────────────────────────────────────────────────────
  // INGRESOS USD — chain auto-cancel x3
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C03_ingreso_dolares_chain',
    description: 'INGRESOS USD — 3 mensajes encadenados, cada nuevo auto-cancela',
    steps: [
      { text: 'registrar 20000 dólares de ingreso en soja para el lote 1A',
        expectContains: [/USD\s*20\.?000/i] },
      { text: 'registrar 40000 dólares de ingreso en maíz para el lote 2B',
        expectContains: [/cancel[eé]/i, /USD\s*40\.?000/i] },
      { text: 'registrar 70000 dólares de ingreso en trigo para el lote J2',
        expectContains: [/cancel[eé]/i, /USD\s*70\.?000/i, /trigo/i] },
    ],
  },

  // ────────────────────────────────────────────────────────────────
  // SIEMBRA
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C04_siembra',
    description: 'SIEMBRA: registra cultivo en plot_crops activo',
    steps: [
      { text: 'sembré soja en el lote 1A',
        expectContains: [/soja/i, /sembr|siembra/i, /1A/i],
        expectNot: [/no\s+pude|error/i] },
    ],
    dbCheck: async () => {
      // Look for soja in ANY recent plot_crop row (active or closed) — second
      // runs of the suite may have already harvested it.
      const rows = await dbq(
        `SELECT pc.crop, p.name plot, pc.created_at
         FROM plot_crops pc JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1 AND pc.crop ILIKE 'soja'
           AND pc.created_at > NOW() - interval '30 seconds'
         ORDER BY pc.id DESC LIMIT 1`,
        [USER_ID],
      );
      if (rows.length === 0) return { ok: false, reason: 'no recent soja plot_crop' };
      return { ok: true, reason: `${rows[0].crop} sown in plot ${rows[0].plot}` };
    },
  },

  // ────────────────────────────────────────────────────────────────
  // FUMIGACIÓN
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C05_fumigacion',
    description: 'FUMIGACIÓN con glifosato 2 lt/ha en lote 1A',
    steps: [
      { text: 'fumigué el lote 1A con glifosato a 2 lt/ha',
        expectContains: [/fumig|spray/i, /glifosato/i, /2/i],
        expectNot: [/no\s+pude|error/i] },
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
  // FERTILIZACIÓN
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C06_fertilizacion',
    description: 'FERTILIZACIÓN urea 80 kg/ha en lote 2B',
    steps: [
      { text: 'fertilicé el lote 2B con urea a 80 kg/ha',
        expectContains: [/fertil/i, /urea/i, /80/i],
        expectNot: [/no\s+pude|error/i] },
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
  // COSECHA con rinde
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C07_cosecha_con_rinde',
    description: 'COSECHA de soja con rinde 3500 kg/ha en lote 1A',
    steps: [
      { text: 'coseché soja en el lote 1A con un rinde de 3500 kg/ha',
        expectContains: [/cosech/i, /soja/i, /3\.?500/i],
        expectNot: [/no\s+pude|error/i] },
    ],
    dbCheck: async () => {
      // Just verify the harvest event landed (the handler stores rate vs total
      // depending on which yield param the agent passes — we don't tie the
      // test to that detail). Response already checked the user-facing rinde.
      const rows = await dbq(
        `SELECT de.crop, de.quantity::numeric AS qty, de.unit, p.name AS plot
         FROM domain_events de JOIN plots p ON p.id=de.plot_id
         WHERE de.user_id=$1 AND de.event_type='harvest' AND de.crop ILIKE 'soja'
           AND de.created_at > NOW() - interval '30 seconds'
         ORDER BY de.id DESC LIMIT 1`,
        [USER_ID],
      );
      if (rows.length === 0) return { ok: false, reason: 'no recent soja harvest event' };
      return { ok: true, reason: `cosecha registrada en ${rows[0].plot}: ${rows[0].qty} ${rows[0].unit}` };
    },
  },

  // ────────────────────────────────────────────────────────────────
  // COSECHA con cargas
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C08_cosecha_cargas',
    description: 'COSECHA de maíz con 2 cargas por chofer en lote 2B',
    steps: [
      // First seed an active maíz crop so the harvest reuses it
      { text: 'sembré maíz en el lote 2B',
        expectContains: [/ma[ií]z/i, /sembr/i] },
      { text: 'cosechamos maíz en el lote 2B. Britos llevó 30000 kg y Contreras 25000 kg',
        expectContains: [/cosech/i, /ma[ií]z/i, /britos/i, /contreras/i],
        expectNot: [/no\s+pude|error/i] },
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
  // COMPOUND siembra + fertilización en un mensaje
  // ────────────────────────────────────────────────────────────────
  {
    id: 'C09_compound_siembra_fertilizacion',
    description: 'COMPOUND en un mensaje: siembra + fertilización → 2 tools',
    steps: [
      { text: 'sembré maíz en el lote J2 y fertilicé el lote 2B con urea a 100 kg/ha',
        expectContains: [/siembr|sembr/i, /fertil/i, /ma[ií]z/i, /urea/i],
        expectNot: [/no\s+pude|error/i] },
    ],
    dbCheck: async () => {
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
    description: 'CICLO MIXTO — gasto USD + fumigación + ingreso USD: todos quedan bien',
    steps: [
      { text: 'gasté 1000 dólares en glifosato para el lote 1A',
        expectContains: [/USD\s*1\.?000/i],
        expectNot: [/\$\s*1\.?000\s*USD/i] },
      { tap: 'confirm_pending', expectContains: [/registrad|guardad|anotad/i] },
      { text: 'fumigué el lote 1A con glifosato a 3 lt/ha',
        expectContains: [/fumig/i, /glifosato/i] },
      { text: 'registrar 5000 dólares de ingreso por venta de soja en el lote 1A',
        expectContains: [/USD\s*5\.?000/i, /soja/i],
        expectNot: [/\$\s*5\.?000\s*USD/i] },
      { tap: 'confirm_pending', expectContains: [/registrad|guardad|anotad/i] },
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

interface StepResult { step: number; ok: boolean; reason: string; response?: string }
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
  await new Promise(r => setTimeout(r, 150));

  const stepResults: StepResult[] = [];
  let allOk = true;

  for (let s = 0; s < conv.steps.length; s++) {
    const step = conv.steps[s];
    let resp: any;
    let label = '';
    if (step.text) {
      label = `💬 "${step.text.slice(0, 75)}${step.text.length > 75 ? '…' : ''}"`;
      resp = await sendText(step.text);
    } else if (step.tap) {
      label = `👆 tap:${step.tap}`;
      resp = await tap(step.tap);
    } else {
      stepResults.push({ step: s, ok: false, reason: 'step has no text or tap' });
      allOk = false;
      continue;
    }

    const responseText = joinResponse(resp);
    console.log(`    ${label}`);
    console.log(`       → "${responseText.slice(0, 150).replace(/\n/g, ' ↵ ')}${responseText.length > 150 ? '…' : ''}"`);

    const check = checkExpectations(responseText, step.expectContains, step.expectNot);
    if (!check.ok) {
      console.log(`       ❌ ${check.reason}`);
      allOk = false;
    } else {
      console.log(`       ✅`);
    }
    stepResults.push({ step: s, ok: check.ok, reason: check.reason, response: responseText.slice(0, 250) });

    await new Promise(r => setTimeout(r, 250));
  }

  let dbCheck: { ok: boolean; reason: string } | undefined;
  if (conv.dbCheck) {
    try {
      dbCheck = await conv.dbCheck();
      console.log(`    DB: ${dbCheck.ok ? '✅' : '❌'} ${dbCheck.reason}`);
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
  console.log('QA Martin-Style 10 (TEXT) — same scenarios, no audio pipeline');
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
        if (s.response) console.log(`       got: "${s.response.slice(0, 130).replace(/\n/g, ' ↵ ')}"`);
      }
      if (r.dbCheck && !r.dbCheck.ok) console.log(`     DB: ${r.dbCheck.reason}`);
    }
  }

  const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'qa-martin-style-text-results.json');
  fs.writeFileSync(out, JSON.stringify({ passed, total: results.length, ts: new Date().toISOString(), results }, null, 2));
  console.log(`\nReport saved to ${out}`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error('💥 FATAL:', err);
  process.exit(1);
});
