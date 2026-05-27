/**
 * QA PROD — Regression V2 (post-pronoun-expander fix)
 *
 * Different conversations from qa-prod-senior, but targeting the same
 * categories that were weak in the previous run (after fix 6d6099c):
 *   - memoria_corto: pronouns ("ahí mismo", "ese lote", "el de antes")
 *   - memoria_largo: context across many turns
 *   - context_switch: switching plots/topics mid-conversation
 *   - temporal: relative dates (ayer, anteayer, hace N días)
 *   - fin_consist: currency consistency (no $ before USD)
 *   - multi_intent: compound actions
 *   - contradiction/correction: mid-flow corrections
 *   - recovery: bot doesn't get stuck after weird inputs
 *
 * Different surface forms — same underlying capabilities.
 *
 * Run: npx tsx src/testing/qa-prod-regression-v2.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'https://campo-bot-production.up.railway.app';
const EMAIL = `qa-regv2-${Date.now()}@campo.test`;
const PASSWORD = 'qatest1234';
const NAME = 'QARegV2';

let TOKEN = '';
let USER_ID = 0;

// ── Auth + HTTP ───────────────────────────────────────────────────────

async function register(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'QA', email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Register failed: ${res.status} ${await res.text()}`);
  const d = await res.json() as any;
  TOKEN = d.tokens.accessToken;
  USER_ID = d.user.id;
  console.log(`  ✓ registered ${EMAIL} (user_id=${USER_ID})`);
}

async function sendText(message: string, attempt = 1): Promise<{ messages: any[] }> {
  try {
    const res = await fetch(`${BASE_URL}/api/test-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ message }),
    });
    const t = await res.text().catch(() => '');
    try { return JSON.parse(t); } catch { return { messages: [{ text: `HTTP ${res.status}` }] }; }
  } catch (err) {
    if (attempt < 3) { await new Promise(r => setTimeout(r, 2000)); return sendText(message, attempt + 1); }
    throw err;
  }
}

async function tap(buttonId: string): Promise<{ messages: any[] }> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  return res.json();
}

async function dbq(sql: string, params: unknown[] = [], attempt = 1): Promise<any[]> {
  try {
    const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ sql, params }),
    });
    // Railway sometimes returns transient 500/502/504 — retry with backoff
    if (!res.ok) {
      if ((res.status === 500 || res.status === 502 || res.status === 504) && attempt < 4) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
        return dbq(sql, params, attempt + 1);
      }
      throw new Error(`DB query failed: ${res.status}`);
    }
    const d = await res.json() as any;
    return d.rows ?? [];
  } catch (err: any) {
    // Network/parsing errors also retried
    if (attempt < 4 && /fetch|network|ENOTFOUND|ECONN/i.test(err.message)) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return dbq(sql, params, attempt + 1);
    }
    throw err;
  }
}

function flat(r: { messages: any[] }): string {
  return (r.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}

async function step(msg: string): Promise<string> { return flat(await sendText(msg)); }
async function stepTap(id: string): Promise<string> { return flat(await tap(id)); }
async function stepAndConfirm(msg: string): Promise<string> {
  let r = await step(msg);
  if (/¿Confirmo (gasto|ingreso)/i.test(r)) {
    const c = await stepTap('confirm_pending');
    return r + '\n' + c;
  }
  return r;
}

// ── Runner ────────────────────────────────────────────────────────────

type Category = 'memoria_corto' | 'memoria_largo' | 'context_switch' | 'temporal' | 'fin_consist' | 'multi_intent' | 'contradiction' | 'recovery' | 'colloquial' | 'currency_fmt';
type Severity = 'Low' | 'Medium' | 'High' | 'Critical';

interface TestCase {
  id: string;
  category: Category;
  description: string;
  run: () => Promise<{ pass: boolean; details: string; response: string; severity?: Severity }>;
}
interface TestResult extends TestCase {
  pass: boolean;
  details: string;
  response: string;
  severity?: Severity;
}

const RESULTS: TestResult[] = [];

function judge(response: string, contains: (string|RegExp)[], notContains: (string|RegExp)[] = []): { ok: boolean; missing: string[]; violated: string[] } {
  const missing: string[] = [];
  const violated: string[] = [];
  for (const pat of contains) {
    const re = pat instanceof RegExp ? pat : new RegExp(pat, 'i');
    if (!re.test(response)) missing.push(String(pat));
  }
  for (const pat of notContains) {
    const re = pat instanceof RegExp ? pat : new RegExp(pat, 'i');
    if (re.test(response)) violated.push(String(pat));
  }
  return { ok: missing.length === 0 && violated.length === 0, missing, violated };
}
function makeResult(j: ReturnType<typeof judge>, response: string, severity: Severity = 'Medium'): { pass: boolean; details: string; response: string; severity?: Severity } {
  if (j.ok) return { pass: true, details: 'OK', response: response.slice(0, 300) };
  const details = [
    j.missing.length ? `missing: ${j.missing.join(' / ')}` : '',
    j.violated.length ? `should NOT match: ${j.violated.join(' / ')}` : '',
  ].filter(Boolean).join(' | ');
  return { pass: false, details, response: response.slice(0, 300), severity };
}

// ── Setup ──────────────────────────────────────────────────────────────

async function setup(): Promise<void> {
  console.log('\nSetup…');
  await register();
  await dbq(`UPDATE users SET plan_id=(SELECT id FROM plans WHERE name='enterprise') WHERE id=$1`, [USER_ID]);

  await step('cancelar');
  // Create field — flow requires tapping a button to choose location method
  await step('agregar campo Don Pedro');
  await stepTap('flow_field_loc_city');
  await step('Pergamino');           // Pergamino is unique — no province needed
  await stepTap('flow_confirm');
  // Create 3 plots — name them with distinct words to avoid pronoun ambiguity
  await step('agregar lote Verde al campo Don Pedro'); await step('120');
  await step('agregar lote Amarillo al campo Don Pedro'); await step('90');
  await step('agregar lote Rojo al campo Don Pedro'); await step('60');
  // Verify
  const fs = await dbq(`SELECT name FROM fields WHERE user_id=$1`, [USER_ID]);
  const ps = await dbq(`SELECT name FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id=$1)`, [USER_ID]);
  console.log(`  ✓ fields=${fs.length} plots=${ps.length} (${ps.map((p:any)=>p.name).join(',')})`);
  if (fs.length !== 1 || ps.length !== 3) throw new Error(`Setup failed: fields=${fs.length} plots=${ps.length}`);
}

// ── Test cases ────────────────────────────────────────────────────────

const TESTS: TestCase[] = [

  // ═══════════════════════════════════════════════════════════════════
  // MEMORIA CORTO PLAZO — pronoun resolution
  // ═══════════════════════════════════════════════════════════════════

  { id: 'P01', category: 'memoria_corto', description: 'Pronombre "ahí mismo" en gasto consecutivo', run: async () => {
    await stepAndConfirm('cargué 80 mil en gasoil para el lote Verde');
    const r = await stepAndConfirm('y otros 25 mil en sueldos ahí mismo');
    const saved = await dbq(
      `SELECT amount::int, category FROM expenses WHERE user_id=$1 AND amount=25000 AND plot_id IN
        (SELECT id FROM plots WHERE name='Verde' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`,
      [USER_ID],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['25k sueldos en lote Verde'], violated: [] }, r, 'Critical');
  }},

  { id: 'P02', category: 'memoria_corto', description: '"ese lote" después de una consulta', run: async () => {
    await step('cuánto gasté en el lote Amarillo este mes');
    const r = await stepAndConfirm('cargame 150 mil en fertilizante en ese lote');
    const saved = await dbq(
      `SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=150000 AND plot_id IN
        (SELECT id FROM plots WHERE name='Amarillo' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`,
      [USER_ID],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['150k en Amarillo via "ese lote"'], violated: [] }, r, 'Critical');
  }},

  { id: 'P03', category: 'memoria_corto', description: 'Pronombre "el mismo" sin "lote"', run: async () => {
    await stepAndConfirm('gasté 40 mil en semillas para el lote Rojo');
    const r = await stepAndConfirm('y 20 mil más en flete para el mismo');
    const saved = await dbq(
      `SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=20000 AND plot_id IN
        (SELECT id FROM plots WHERE name='Rojo' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`,
      [USER_ID],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['20k flete en Rojo via "el mismo"'], violated: [] }, r, 'High');
  }},

  { id: 'P04', category: 'memoria_corto', description: '"allá" después de actividad agronómica completa', run: async () => {
    // Use a complete fumigation (with dose) so no pending hangs
    await step('fumigué 2 lt/ha de glifosato en el lote Verde');
    const r = await step('llovieron 18mm allá ayer');
    // Verifica que NO pregunta "¿en qué campo?" — debería resolverse a Don Pedro/Verde
    const j = judge(r, [/(?:registrad|mm|verde|don pedro|lluvia)/i], [/¿En qué (campo|lote)\?/i]);
    return makeResult(j, r, 'High');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // MEMORIA LARGO PLAZO — recall after several turns
  // ═══════════════════════════════════════════════════════════════════

  { id: 'L01', category: 'memoria_largo', description: 'Recuerda contexto después de 4 mensajes intermedios', run: async () => {
    await stepAndConfirm('cargué 30 mil en herbicida para el lote Amarillo');
    await step('cuánto llovió este mes?');
    await step('lista de campos');
    await step('hola');
    await step('ayuda');
    const r = await stepAndConfirm('y 15 mil más en ese lote en flete');
    const saved = await dbq(
      `SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=15000 AND plot_id IN
        (SELECT id FROM plots WHERE name='Amarillo' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`,
      [USER_ID],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['15k flete en Amarillo después de 5 turnos'], violated: [] }, r, 'High');
  }},

  { id: 'L02', category: 'memoria_largo', description: 'Acumulado correcto después de pronoun-chain', run: async () => {
    await stepAndConfirm('200 mil en semillas para el lote Rojo');
    await stepAndConfirm('y 80 mil ahí mismo en gasoil');
    await stepAndConfirm('y 50 mil ahí mismo en sueldos');
    const r = await step('cuánto gasté en el lote Rojo este mes?');
    // Setup: P03 gastó 40 mil semillas + 20 mil flete = 60 mil
    // Aquí: 200k + 80k + 50k = 330k
    // Total esperado: 60k + 330k = 390k
    // El bot debe mostrar al menos 330k (los 3 nuevos)
    const hasAtLeast330k = /3\d{2}\.?\d{3}|3\d{2}\.?\d{3,3}/.test(r) || /330\.?000|390\.?000/.test(r);
    return makeResult({ ok: hasAtLeast330k, missing: hasAtLeast330k ? [] : ['acumulado ≥ 330k en Rojo'], violated: [] }, r, 'High');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // CONTEXT SWITCH — switching plots mid-stream
  // ═══════════════════════════════════════════════════════════════════

  { id: 'C01', category: 'context_switch', description: 'Switch explícito de lote después de pronoun', run: async () => {
    await stepAndConfirm('cargué 40 mil en gasoil en el lote Verde');
    await stepAndConfirm('y 25 mil más ahí mismo en sueldos');  // Verde
    const r = await stepAndConfirm('y 60 mil en herbicida en el lote Amarillo');  // SWITCH
    const saved = await dbq(
      `SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=60000 AND plot_id IN
        (SELECT id FROM plots WHERE name='Amarillo' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`,
      [USER_ID],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['60k herbicida en Amarillo (no Verde)'], violated: [] }, r, 'High');
  }},

  { id: 'C02', category: 'context_switch', description: 'Pronombre después de switch — apunta al nuevo lote', run: async () => {
    // Setup: previous test left context = Amarillo
    const r = await stepAndConfirm('y 10 mil más ahí mismo en flete');
    // Should attach to Amarillo (most recent context, not Verde)
    const saved = await dbq(
      `SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=10000 AND plot_id IN
        (SELECT id FROM plots WHERE name='Amarillo' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`,
      [USER_ID],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['10k flete en Amarillo (último contexto)'], violated: [] }, r, 'Critical');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // TEMPORAL — relative dates
  // ═══════════════════════════════════════════════════════════════════

  { id: 'T01', category: 'temporal', description: '"ayer" se resuelve a fecha real', run: async () => {
    await stepAndConfirm('ayer pagué 35 mil pesos en sueldos en el lote Verde');
    const yesterday = new Date(Date.now() - 24*60*60*1000).toISOString().substring(0, 10);
    const saved = await dbq(
      `SELECT amount::int, expense_date::text FROM expenses WHERE user_id=$1 AND amount=35000
        AND expense_date::text = $2`,
      [USER_ID, yesterday],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : [`expense con date=${yesterday}`], violated: [] }, '', 'High');
  }},

  { id: 'T02', category: 'temporal', description: '"anteayer" se resuelve a hace 2 días', run: async () => {
    await stepAndConfirm('anteayer cargué 45 mil pesos de gasoil para el lote Rojo');
    const twoDaysAgo = new Date(Date.now() - 2*24*60*60*1000).toISOString().substring(0, 10);
    const saved = await dbq(
      `SELECT amount::int, expense_date::text FROM expenses WHERE user_id=$1 AND amount=45000
        AND expense_date::text = $2`,
      [USER_ID, twoDaysAgo],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : [`expense con date=${twoDaysAgo}`], violated: [] }, '', 'High');
  }},

  { id: 'T03', category: 'temporal', description: '"hace 3 días" se resuelve a fecha relativa', run: async () => {
    await stepAndConfirm('hace 3 días gasté 22 mil pesos en herbicida en el lote Amarillo');
    const threeDaysAgo = new Date(Date.now() - 3*24*60*60*1000).toISOString().substring(0, 10);
    const saved = await dbq(
      `SELECT amount::int, expense_date::text FROM expenses WHERE user_id=$1 AND amount=22000
        AND expense_date::text = $2`,
      [USER_ID, threeDaysAgo],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : [`expense con date=${threeDaysAgo}`], violated: [] }, '', 'Medium');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // CURRENCY FORMAT — USD never prefixed with $
  // ═══════════════════════════════════════════════════════════════════

  { id: 'CF01', category: 'currency_fmt', description: 'USD sin $ delante en confirmación', run: async () => {
    const r = await step('cargué 5000 dólares en semillas en el lote Verde');
    // Should show "USD 5.000" or "5.000 USD" — NEVER "$5.000 USD" or "$5000 USD"
    const j = judge(r, [/USD/i], [/\$\s?5\.?000\s*USD/i, /\$5000\s*USD/i]);
    if (/¿Confirmo gasto/i.test(r)) await stepTap('confirm_pending');
    return makeResult(j, r, 'High');
  }},

  { id: 'CF02', category: 'currency_fmt', description: 'USD en ingreso sin $ delante', run: async () => {
    // Use clear income wording — "ingresé" is unambiguous (income verb)
    const r = await step('ingresé 8000 USD por venta de soja del lote Rojo');
    // Should show USD without $ prefix anywhere
    const j = judge(r, [/USD/i], [/\$\s?\d[\d.]*\s*USD/i, /\$8/]);
    if (/¿Confirmo ingreso/i.test(r)) await stepTap('confirm_pending');
    return makeResult(j, r, 'High');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // MULTI-INTENT (compound) — multiple tools in one message
  // ═══════════════════════════════════════════════════════════════════

  { id: 'MI01', category: 'multi_intent', description: 'Compound: 2 gastos + 1 lluvia en un mensaje', run: async () => {
    await step('cancelar');
    const r = await step('cargué 12 mil en gasoil en el lote Verde, 18 mil en sueldos en el lote Amarillo y llovieron 14mm en el lote Rojo');
    // Auto-confirm any pendings
    if (/¿Confirmo/i.test(r)) await stepTap('confirm_pending');
    if (/¿Confirmo/i.test(r)) await stepTap('confirm_pending');
    // Wait for compound to finish writing
    await new Promise(r => setTimeout(r, 2500));
    const expVerde = await dbq(`SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=12000`, [USER_ID]);
    const expAmar = await dbq(`SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=18000`, [USER_ID]);
    // rainfall table uses `millimeters` not `mm`
    const rain = await dbq(`SELECT millimeters::int FROM rainfall WHERE user_id=$1 AND millimeters=14`, [USER_ID]);
    const all3 = expVerde.length > 0 && expAmar.length > 0 && rain.length > 0;
    return makeResult({ ok: all3, missing: all3 ? [] : [`12k=${expVerde.length>0} 18k=${expAmar.length>0} 14mm=${rain.length>0}`], violated: [] }, r, 'High');
  }},

  { id: 'MI02', category: 'multi_intent', description: 'Compound: siembra + gasto en una sola frase', run: async () => {
    const r = await step('sembré maíz en el lote Verde y gasté 95 mil pesos en semillas ahí mismo');
    if (/¿Confirmo gasto/i.test(r)) await stepTap('confirm_pending');
    await new Promise(r => setTimeout(r, 2500));
    const exp = await dbq(`SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=95000 AND plot_id IN
      (SELECT id FROM plots WHERE name='Verde' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`, [USER_ID]);
    // plot_crops uses `harvested_at` not `closed_at`
    const sow = await dbq(`SELECT crop FROM plot_crops WHERE plot_id IN (SELECT id FROM plots WHERE name='Verde' AND field_id IN (SELECT id FROM fields WHERE user_id=$1)) AND crop ILIKE 'ma%' AND harvested_at IS NULL`, [USER_ID]);
    const ok = exp.length > 0 && sow.length > 0;
    return makeResult({ ok, missing: ok ? [] : [`semillas 95k Verde=${exp.length>0} siembra maíz Verde=${sow.length>0}`], violated: [] }, r, 'High');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // CONTRADICTION / CORRECTION
  // ═══════════════════════════════════════════════════════════════════

  { id: 'CR01', category: 'contradiction', description: 'Corrección de monto antes de confirmar', run: async () => {
    await step('cargame 70 mil pesos de gasoil en el lote Verde');
    const r = await stepAndConfirm('no, eran 75 mil');
    const saved = await dbq(`SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=75000 AND plot_id IN
      (SELECT id FROM plots WHERE name='Verde' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`, [USER_ID]);
    const wrongAmount = await dbq(`SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=70000 AND created_at > NOW() - INTERVAL '2 min'`, [USER_ID]);
    const ok = saved.length > 0 && wrongAmount.length === 0;
    return makeResult({ ok, missing: ok ? [] : [`75k guardado=${saved.length>0} 70k NO guardado=${wrongAmount.length===0}`], violated: [] }, r, 'High');
  }},

  { id: 'CR02', category: 'contradiction', description: 'Corrección de categoría', run: async () => {
    await step('cargame 33 mil pesos en gasoil en el lote Amarillo');
    const r = await stepAndConfirm('no, era en sueldos');
    const saved = await dbq(`SELECT amount::int, category FROM expenses WHERE user_id=$1 AND amount=33000 AND category ILIKE 'sueldo%' AND plot_id IN
      (SELECT id FROM plots WHERE name='Amarillo' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`, [USER_ID]);
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['33k en categoría Sueldos en Amarillo'], violated: [] }, r, 'High');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // RECOVERY — bot doesn't get stuck after weird inputs
  // ═══════════════════════════════════════════════════════════════════

  { id: 'R01', category: 'recovery', description: 'Bot se recupera de mensaje completamente vacío', run: async () => {
    await step('cancelar');
    await step('   ');
    const r = await stepAndConfirm('cargué 8 mil en gasoil para el lote Verde');
    const saved = await dbq(`SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=8000 AND created_at > NOW() - INTERVAL '2 min'`, [USER_ID]);
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['8k después de mensaje vacío'], violated: [] }, r, 'Medium');
  }},

  { id: 'R02', category: 'recovery', description: 'Bot se recupera de mensaje sin sentido', run: async () => {
    await step('xyz qwerty asdf 1234');
    const r = await stepAndConfirm('cargué 9 mil en sueldos en el lote Rojo');
    const saved = await dbq(`SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=9000 AND created_at > NOW() - INTERVAL '2 min'`, [USER_ID]);
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['9k después de mensaje sin sentido'], violated: [] }, r, 'Medium');
  }},

  { id: 'R03', category: 'recovery', description: 'Cancelar pending y arrancar nuevo flow', run: async () => {
    await step('cargame 100 mil de algo');  // intencional incompleto
    await step('cancelar');
    const r = await stepAndConfirm('cargué 7 mil en flete en el lote Amarillo');
    const saved = await dbq(`SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=7000 AND created_at > NOW() - INTERVAL '2 min'`, [USER_ID]);
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['7k después de cancel + nuevo flow'], violated: [] }, r, 'Medium');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // COLLOQUIAL — Argentine slang
  // ═══════════════════════════════════════════════════════════════════

  { id: 'CL01', category: 'colloquial', description: '"medio palo" = 500.000', run: async () => {
    const r = await stepAndConfirm('cargué medio palo en herbicida para el lote Verde');
    const saved = await dbq(`SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=500000 AND created_at > NOW() - INTERVAL '2 min'`, [USER_ID]);
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['500.000 (medio palo)'], violated: [] }, r, 'Medium');
  }},

  { id: 'CL02', category: 'colloquial', description: '"un palo" = 1.000.000', run: async () => {
    const r = await stepAndConfirm('cargame un palo de fertilizante para el lote Amarillo');
    const saved = await dbq(`SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=1000000 AND created_at > NOW() - INTERVAL '2 min'`, [USER_ID]);
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['1.000.000 (un palo)'], violated: [] }, r, 'Medium');
  }},

  { id: 'CL03', category: 'colloquial', description: '"chau" / "listo" no son comandos', run: async () => {
    const r = await step('listo gracias');
    // El bot NO debería interpretar "listo" como confirmación de algo inexistente
    const j = judge(r, [], [/^.*registrad.*$/i, /No pude/i]);
    return makeResult(j, r, 'Low');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // FIN CONSIST — financial reports consistency
  // ═══════════════════════════════════════════════════════════════════

  { id: 'F01', category: 'fin_consist', description: 'Reporte financiero muestra acumulado', run: async () => {
    const r = await step('cuánto gasté este mes?');
    // Debe responder con un número (total gastado en el mes)
    const j = judge(r, [/(?:gasto|total|gastast|gastad)/i, /\$|pesos|ARS/]);
    return makeResult(j, r, 'Medium');
  }},

  { id: 'F02', category: 'fin_consist', description: 'Reporte por lote específico', run: async () => {
    const r = await step('gastos del lote Verde');
    const j = judge(r, [/(?:verde|lote|gastos|total)/i]);
    return makeResult(j, r, 'Medium');
  }},

];

// ── Run ───────────────────────────────────────────────────────────────

async function runTest(t: TestCase): Promise<TestResult> {
  process.stdout.write(`  ${t.id} (${t.category}) ${t.description}... `);
  // Auto-cancel any pending state from previous test. This isolates tests so
  // a hanging pending (e.g. unfinished flow) from test N doesn't pollute
  // test N+1. Without this, failures cascade artificially.
  try { await sendText('cancelar'); } catch { /* tolerated */ }
  try {
    const r = await t.run();
    const result: TestResult = { ...t, ...r };
    console.log(r.pass ? '✓' : `✗ — ${r.details}`);
    return result;
  } catch (err: any) {
    console.log(`✗ ERROR: ${err.message}`);
    return { ...t, pass: false, details: `ERROR: ${err.message}`, response: '', severity: 'Critical' as Severity };
  }
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  QA PROD Regression V2 — post-pronoun-expander fix');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Target: ${BASE_URL}`);

  await setup();
  console.log(`\nRunning ${TESTS.length} tests…\n`);

  for (const t of TESTS) {
    const r = await runTest(t);
    RESULTS.push(r);
    await new Promise(res => setTimeout(res, 350));
  }

  // ── Report ─────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  REPORT');
  console.log('═══════════════════════════════════════════════════════════');

  const byCategory: Record<string, { pass: number; fail: number }> = {};
  for (const r of RESULTS) {
    if (!byCategory[r.category]) byCategory[r.category] = { pass: 0, fail: 0 };
    if (r.pass) byCategory[r.category].pass++; else byCategory[r.category].fail++;
  }
  console.log('\nBy category:');
  for (const [cat, s] of Object.entries(byCategory)) {
    const total = s.pass + s.fail;
    const pct = Math.round(s.pass / total * 100);
    const bar = '█'.repeat(Math.round(pct / 5));
    console.log(`  ${cat.padEnd(18)} ${String(s.pass).padStart(2)}/${total} (${pct.toString().padStart(3)}%) ${bar}`);
  }

  const fails = RESULTS.filter(r => !r.pass);
  const totalPass = RESULTS.length - fails.length;
  const overall = Math.round(totalPass / RESULTS.length * 100);

  console.log(`\n📊 OVERALL: ${totalPass}/${RESULTS.length} (${overall}%)`);

  if (fails.length > 0) {
    console.log('\n❌ FAILS:');
    const bySev: Record<string, TestResult[]> = { Critical: [], High: [], Medium: [], Low: [] };
    for (const f of fails) (bySev[f.severity ?? 'Medium'] ??= []).push(f);
    for (const sev of ['Critical', 'High', 'Medium', 'Low']) {
      if (bySev[sev].length === 0) continue;
      console.log(`\n  ${sev}:`);
      for (const f of bySev[sev]) {
        console.log(`    [${f.id}] ${f.description}`);
        console.log(`      → ${f.details}`);
        if (f.response) console.log(`      response: "${f.response.replace(/\n/g, ' ⏎ ').slice(0, 200)}"`);
      }
    }
  }

  // Verdict
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('═══════════════════════════════════════════════════════════');
  let verdict = '';
  if (overall >= 95) verdict = '🟢 EXCELENTE — listo para más usuarios';
  else if (overall >= 88) verdict = '🟢 PRODUCCIÓN OK — bugs aislados, no críticos';
  else if (overall >= 75) verdict = '🟡 ACEPTABLE — hay bugs altos, tratables';
  else if (overall >= 60) verdict = '🟠 RIESGO — fallos importantes, fix antes de scale';
  else verdict = '🔴 BLOQUEANTE — fix urgente';
  console.log(`\n${verdict}\n`);

  // Save JSON report
  const reportPath = path.join(__dirname, 'qa-prod-regression-v2-results.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    overall, total: RESULTS.length, pass: totalPass, email: EMAIL,
    byCategory, results: RESULTS.map(r => ({ id: r.id, category: r.category, pass: r.pass, severity: r.severity, details: r.details, response: r.response.slice(0, 200) })),
  }, null, 2));
  console.log(`Report saved to ${reportPath}\n`);

  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
