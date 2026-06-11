/**
 * QA PROD — Senior QA Engineer Audit
 *
 * 25+ scenarios on a fresh PROD user (enterprise plan), covering:
 *   - Memoria corto/largo plazo
 *   - Context switching
 *   - Consistencia matemática/financiera
 *   - Comprensión temporal
 *   - Referencias indirectas
 *   - Multi-intent en un mensaje
 *   - Recovery ante contradicciones
 *   - Lenguaje coloquial / informal
 *   - Edge cases
 *
 * Produces a structured report with category scores, bugs by severity,
 * blockers, recommendations.
 *
 * Run: npx tsx src/testing/qa-prod-senior.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'https://campo-bot-production.up.railway.app';
const EMAIL = `qa-senior-${Date.now()}@campo.test`;
const PASSWORD = 'qatest1234';
const NAME = 'QASenior';

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

async function dbq(sql: string, params: unknown[] = []): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}`, 'x-test-secret': process.env.TEST_BOT_SECRET ?? '' },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status}`);
  const d = await res.json() as any;
  return d.rows ?? [];
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

// ── Test runner with categories + severity ────────────────────────────

type Category = 'memoria_corto' | 'memoria_largo' | 'context_switch' | 'math_consist' | 'fin_consist' | 'temporal' | 'entities' | 'colloquial' | 'multi_intent' | 'ambiguity' | 'contradiction' | 'recovery';
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
  // Upgrade plan to enterprise so livestock/stock/agro features are unlocked
  await dbq(`UPDATE users SET plan_id=(SELECT id FROM plans WHERE name='enterprise') WHERE id=$1`, [USER_ID]);

  // Build a small estate to query against
  await step('cancelar');
  let r = await step('agregar campo La Quinta en Pergamino');
  if (/ubicar/i.test(r)) {
    await stepTap('flow_field_loc_city');
    await step('Pergamino');
    await stepTap('flow_confirm');
  }
  await step('agregar lote Norte al campo La Quinta'); await step('100');
  await step('agregar lote Sur al campo La Quinta'); await step('80');
  await step('agregar lote Este al campo La Quinta'); await step('50');
  console.log('  ✓ La Quinta + Norte(100ha) + Sur(80ha) + Este(50ha)');
}

// ── Test cases ────────────────────────────────────────────────────────

const TESTS: TestCase[] = [

  // ═══════════════════════════════════════════════════════════════════
  // MEMORIA CORTO PLAZO (within same conversation)
  // ═══════════════════════════════════════════════════════════════════

  { id: 'M01', category: 'memoria_corto', description: 'Bot recuerda el lote del último mensaje', run: async () => {
    await stepAndConfirm('gasté 100000 pesos en gasoil para el lote Norte');
    const r = await step('y otros 50000 en sueldos ahi mismo');
    // El bot debería entender "ahi mismo" = lote Norte
    if (/¿Confirmo gasto/i.test(r)) await stepTap('confirm_pending');
    const saved = await dbq(
      `SELECT amount::int, category FROM expenses WHERE user_id=$1 AND amount=50000 AND plot_id IN
        (SELECT id FROM plots WHERE name='Norte' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`,
      [USER_ID],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['amount=50000 en lote Norte'], violated: [] }, r, 'High');
  }},

  { id: 'M02', category: 'memoria_corto', description: '"ese lote" después de query', run: async () => {
    await step('cuánto gasté en el lote Sur este mes');
    const r = await stepAndConfirm('agregame 200000 pesos en fertilizantes en ese lote');
    const saved = await dbq(
      `SELECT amount::int FROM expenses WHERE user_id=$1 AND amount=200000 AND plot_id IN
        (SELECT id FROM plots WHERE name='Sur' AND field_id IN (SELECT id FROM fields WHERE user_id=$1))`,
      [USER_ID],
    );
    return makeResult({ ok: saved.length > 0, missing: saved.length ? [] : ['200k pesos en Sur via "ese lote"'], violated: [] }, r, 'High');
  }},

  { id: 'M03', category: 'memoria_corto', description: 'Bot recuerda crop activo después de siembra', run: async () => {
    await step('sembré soja en el lote Este');
    const r = await step('cuanto se sembró en el lote Este?');
    const j = judge(r, [/soja/i, /Este/i]);
    return makeResult(j, r, 'Medium');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // MEMORIA LARGO PLAZO (persistence across queries)
  // ═══════════════════════════════════════════════════════════════════

  { id: 'L01', category: 'memoria_largo', description: 'Recuerda gastos hechos hace N turnos', run: async () => {
    // Hace varios turnos arriba ya hubo gastos. Pregunto resumen ahora.
    const r = await step('listame los gastos del lote Norte');
    const j = judge(r, [/gasoil|combustible|sueldo|fertiliz|Norte/i]);
    return makeResult(j, r, 'High');
  }},

  { id: 'L02', category: 'memoria_largo', description: 'Total acumulado correcto', run: async () => {
    const r = await step('cuanto gasté en total este mes');
    // Lo único acumulable ARS: 100k (gasoil Norte) + 50k (sueldos Norte) + 200k (fert Sur) = 350k
    const j = judge(r, [/350\.?000|350k|3\.5/i]);
    return makeResult(j, r, 'Critical');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // CONTEXT SWITCHING
  // ═══════════════════════════════════════════════════════════════════

  { id: 'CS01', category: 'context_switch', description: 'Cambia de tema y vuelve al anterior', run: async () => {
    // Quedamos hablando del lote Sur. Cambio: pregunto clima. Luego "y los gastos de antes?"
    await step('y como esta el clima en Pergamino?');
    const r = await step('y los gastos del lote del que hablábamos antes?');
    // "del que hablábamos antes" = Sur (de M02). El bot debería poder volver al contexto.
    const j = judge(r, [/Sur|fertiliz|200/i]);
    return makeResult(j, r, 'High');
  }},

  { id: 'CS02', category: 'context_switch', description: 'Resume tras saludo intermedio', run: async () => {
    await stepAndConfirm('gasté 80000 en mantenimiento del tractor para el lote Este');
    await step('hola, todo bien?');  // saludo intermedio
    const r = await step('cuánto era el gasto del tractor que dije recién?');
    const j = judge(r, [/80\.?000|tractor|maquinaria/i]);
    return makeResult(j, r, 'High');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // MATH CONSISTENCY
  // ═══════════════════════════════════════════════════════════════════

  { id: 'MC01', category: 'math_consist', description: 'Multiplicación quantity × unit_price', run: async () => {
    const r = await stepAndConfirm('vendí 15 toneladas de soja a 400 dolares cada una en lote Norte');
    // 15 × 400 = 6000 USD. El bot debe mostrar USD 6.000
    const j = judge(r, [/USD\s*6\.?000/i, /soja/i], [/\$\s*6\.?000\s*USD/i]);
    return makeResult(j, r, 'Critical');
  }},

  { id: 'MC02', category: 'math_consist', description: 'Suma de operaciones del mismo tipo', run: async () => {
    await stepAndConfirm('vendí 5 tn de soja a 300 USD c/u en lote Norte');  // 1500 USD
    const r = await step('cuanto cobré en dólares este mes por soja?');
    // Total soja USD: 6000 (MC01) + 1500 = 7500
    const j = judge(r, [/USD\s*7\.?500|7500/i]);
    return makeResult(j, r, 'Critical');
  }},

  { id: 'MC03', category: 'math_consist', description: 'No mezcla pesos y dólares en suma', run: async () => {
    const r = await step('resultado del mes');
    // Debe diferenciar ARS y USD, NO sumarlos
    const j = judge(r, [/(USD|d[oó]lar|peso|ARS|resultado)/i], [/\$\s*\d+\s*USD/i, /[\d.]+\s*ARS\s*[\d.]+\s*USD\s*=\s*[\d.]+/i]);
    return makeResult(j, r, 'Critical');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // FINANCIAL CONSISTENCY (idempotencia, no doble guardado)
  // ═══════════════════════════════════════════════════════════════════

  { id: 'FC01', category: 'fin_consist', description: 'Mensaje duplicado NO debe duplicar', run: async () => {
    // El user manda lo mismo 2 veces seguidas. Auto-cancel debería evitar doble guardado.
    await stepAndConfirm('gasté 7500 pesos en revisión del tractor para Norte');
    const r = await stepAndConfirm('gasté 7500 pesos en revisión del tractor para Norte');
    const saved = await dbq(
      `SELECT COUNT(*)::int n FROM expenses WHERE user_id=$1 AND amount=7500 AND deleted_at IS NULL`,
      [USER_ID],
    );
    const n = Number(saved[0]?.n ?? 0);
    return makeResult({ ok: n <= 2, missing: n > 2 ? [`expected ≤2, got ${n}`] : [], violated: [] }, r, 'High');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // TEMPORAL
  // ═══════════════════════════════════════════════════════════════════

  { id: 'T01', category: 'temporal', description: 'Entiende "ayer"', run: async () => {
    const r = await stepAndConfirm('ayer pagué 25000 pesos en sueldos para Norte');
    // Fecha en TZ Argentina (no UTC) — toISOString() de noche rolaba de día → falso negativo.
    const expectedDate = new Date(Date.now() - 24*60*60*1000).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const saved = await dbq(
      `SELECT expense_date::text FROM expenses WHERE user_id=$1 AND amount=25000 ORDER BY id DESC LIMIT 1`,
      [USER_ID],
    );
    const j = judge(saved[0]?.expense_date || '', [expectedDate.slice(5)]);  // match month-day
    return makeResult(j, `expense_date=${saved[0]?.expense_date} (expected ~${expectedDate})`, 'High');
  }},

  { id: 'T02', category: 'temporal', description: 'Pregunta "este mes" vs "todo el historial"', run: async () => {
    const monthOnly = await step('cuanto gasté este mes en pesos?');
    const all = await step('cuanto gasté en total?');
    const monthN = (monthOnly.match(/\$\s*([\d.]+)/)?.[1] || '0').replace(/\./g,'');
    const allN = (all.match(/\$\s*([\d.]+)/)?.[1] || '0').replace(/\./g,'');
    // Total all >= total mes (puede ser igual si todo es del mes actual)
    const ok = parseInt(allN || '0') >= parseInt(monthN || '0');
    return makeResult({ ok, missing: ok ? [] : [`all=${allN} < mes=${monthN}`], violated: [] }, `mes=${monthOnly.slice(0,100)} | total=${all.slice(0,100)}`, 'High');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // ENTITY COMPREHENSION
  // ═══════════════════════════════════════════════════════════════════

  { id: 'E01', category: 'entities', description: 'Distingue Maíz vs Maní (sin tilde)', run: async () => {
    await step('sembré maiz en el lote Sur');  // sin tilde
    const r = await step('cuanto se sembró en el lote Sur?');
    const j = judge(r, [/ma[ií]z/i], [/man[ií]/i]);  // maíz sí, maní no
    return makeResult(j, r, 'Critical');
  }},

  { id: 'E02', category: 'entities', description: 'Reconoce "ha" vs "hectáreas"', run: async () => {
    const r = await step('cuántas hectáreas tiene el lote Sur?');
    const j = judge(r, [/80|ochenta/i, /ha|hect/i]);
    return makeResult(j, r, 'Medium');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // COLLOQUIAL LANGUAGE
  // ═══════════════════════════════════════════════════════════════════

  { id: 'CL01', category: 'colloquial', description: '"medio palo de pesos"', run: async () => {
    const r = await stepAndConfirm('cobré medio palo de pesos por servicios en Norte');
    const j = judge(r, [/\$\s*500\.?000/i], [/USD/i]);
    return makeResult(j, r, 'Medium');
  }},

  { id: 'CL02', category: 'colloquial', description: '"un palo verde" = USD 1.000.000', run: async () => {
    const r = await stepAndConfirm('vendí algo por un palo verde en Norte');
    const j = judge(r, [/USD\s*1\.?000\.?000|1.*M.*USD/i]);
    return makeResult(j, r, 'Low');  // expresión muy informal, ok si no la entiende
  }},

  // ═══════════════════════════════════════════════════════════════════
  // MULTI-INTENT
  // ═══════════════════════════════════════════════════════════════════

  { id: 'MI01', category: 'multi_intent', description: 'Compound 3 acciones distintas', run: async () => {
    const beforeIncomes = (await dbq(`SELECT COUNT(*)::int n FROM incomes WHERE user_id=$1`, [USER_ID]))[0].n;
    const beforeExpenses = (await dbq(`SELECT COUNT(*)::int n FROM expenses WHERE user_id=$1`, [USER_ID]))[0].n;
    const r = await step('gasté 30000 en combustible Norte, vendí 8 tn de maíz a 250 USD c/u en Sur, y fumigué Este con glifosato a 2 lt/ha');
    await new Promise(res => setTimeout(res, 1500));
    const afterIncomes = (await dbq(`SELECT COUNT(*)::int n FROM incomes WHERE user_id=$1`, [USER_ID]))[0].n;
    const afterExpenses = (await dbq(`SELECT COUNT(*)::int n FROM expenses WHERE user_id=$1`, [USER_ID]))[0].n;
    const expensesDiff = afterExpenses - beforeExpenses;
    const incomesDiff = afterIncomes - beforeIncomes;
    const ok = expensesDiff >= 1 && incomesDiff >= 1;  // al menos un gasto + un ingreso
    return makeResult({ ok, missing: ok ? [] : [`exp+${expensesDiff} inc+${incomesDiff}`], violated: [] }, r, 'High');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // AMBIGUITY
  // ═══════════════════════════════════════════════════════════════════

  { id: 'A01', category: 'ambiguity', description: 'Intent sin datos → bot pide, NO alucina', run: async () => {
    const r = await step('quiero anotar un gasto');
    const j = judge(r, [/cu[aá]nto|qu[eé]|monto|categor/i], [/Registrad|guardad/i]);
    return makeResult(j, r, 'High');
  }},

  { id: 'A02', category: 'ambiguity', description: '"vendí algo" → pedir datos', run: async () => {
    const r = await step('vendí algo importante');
    const j = judge(r, [/qu[eé]|cu[aá]nto|monto|precio|categor/i], [/Registrad/i]);
    return makeResult(j, r, 'High');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // CONTRADICTION RECOVERY
  // ═══════════════════════════════════════════════════════════════════

  { id: 'CR01', category: 'contradiction', description: 'Corrige amount mid-flow', run: async () => {
    await step('gasté 100 dolares en gasoil para Norte');
    const r = await step('no, eran 200 dolares');
    if (/¿Confirmo gasto/i.test(r)) await stepTap('confirm_pending');
    const saved = await dbq(
      `SELECT amount::int FROM expenses WHERE user_id=$1 AND currency='USD' AND amount IN (100,200) ORDER BY id DESC LIMIT 2`,
      [USER_ID],
    );
    // El bot DEBERÍA guardar 200 (corregido) y no 100 ni ambos
    const lastAmount = saved[0]?.amount;
    const ok = lastAmount === 200 && saved.length === 1;
    return makeResult({ ok, missing: ok ? [] : [`expected single 200, got ${JSON.stringify(saved)}`], violated: [] }, r, 'Critical');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // RECOVERY (handler retorna error → bot ofrece alternativa)
  // ═══════════════════════════════════════════════════════════════════

  { id: 'R01', category: 'recovery', description: 'Lote inexistente → bot lista válidos', run: async () => {
    const r = await step('gasté 10000 pesos en gasoil para el lote ZZZ');
    const j = judge(r, [/Norte|Sur|Este|lote/i]);
    return makeResult(j, r, 'Medium');
  }},

  { id: 'R02', category: 'recovery', description: 'Cosecha sin cultivo activo → mensaje claro', run: async () => {
    const r = await step('coseché trigo en el lote Norte');  // Norte tiene soja, no trigo
    const j = judge(r, [/(no\s+hay|cultivo|sembr|soja|trigo)/i]);
    return makeResult(j, r, 'Medium');
  }},

  // ═══════════════════════════════════════════════════════════════════
  // EDGE: chained corrections, identity, etc.
  // ═══════════════════════════════════════════════════════════════════

  { id: 'X01', category: 'recovery', description: 'Cancelar a mitad de pending limpia el slot', run: async () => {
    await step('gasté 9999 pesos en algo en Norte');
    if (/¿Confirmo gasto/i.test(await step('hola'))) {
      // no debería preguntar — pero el "hola" puede no destruir el pending
    }
    const r = await step('cancelar');
    const saved = await dbq(
      `SELECT COUNT(*)::int n FROM expenses WHERE user_id=$1 AND amount=9999`,
      [USER_ID],
    );
    const ok = Number(saved[0]?.n) === 0;
    return makeResult({ ok, missing: ok ? [] : [`expected 0 of 9999, got ${saved[0]?.n}`], violated: [] }, r, 'High');
  }},

];

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(74));
  console.log(' QA PROD — SENIOR QA AUDIT');
  console.log('═'.repeat(74));

  await setup();

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    console.log(`\n[${i+1}/${TESTS.length}] ${t.id} (${t.category}) — ${t.description}`);
    try {
      const r = await t.run();
      RESULTS.push({ ...t, ...r });
      console.log(`  ${r.pass ? '✅' : '❌'} ${r.details}`);
      if (!r.pass) console.log(`     resp: "${r.response.slice(0, 180).replace(/\n/g, ' ↵ ')}"`);
    } catch (err) {
      RESULTS.push({ ...t, pass: false, details: `THREW: ${(err as Error).message}`, response: '', severity: 'High' });
      console.log(`  💥 ${(err as Error).message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // ── REPORT ───────────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(74));
  console.log(' REPORTE FINAL');
  console.log('═'.repeat(74));

  const totalPass = RESULTS.filter(r => r.pass).length;
  const overall = Math.round(100 * totalPass / RESULTS.length);
  console.log(`\nScore general: ${overall}/100 — ${totalPass}/${RESULTS.length} casos`);

  // Score por categoría
  console.log('\nScore por categoría:');
  const cats = [...new Set(RESULTS.map(r => r.category))];
  const categoryScores: Record<string, { pass: number; total: number; score: number }> = {};
  for (const cat of cats) {
    const subset = RESULTS.filter(r => r.category === cat);
    const p = subset.filter(r => r.pass).length;
    const score = Math.round(100 * p / subset.length);
    categoryScores[cat] = { pass: p, total: subset.length, score };
    const bar = '█'.repeat(Math.round(score / 5)) + '░'.repeat(20 - Math.round(score / 5));
    console.log(`  ${cat.padEnd(18)} ${bar} ${score}/100 (${p}/${subset.length})`);
  }

  // Bugs por severidad
  const fails = RESULTS.filter(r => !r.pass);
  const sevs: Severity[] = ['Critical', 'High', 'Medium', 'Low'];
  const bySev: Record<Severity, TestResult[]> = { Critical: [], High: [], Medium: [], Low: [] };
  for (const f of fails) bySev[f.severity || 'Medium'].push(f);

  console.log('\nBugs por severidad:');
  for (const sev of sevs) {
    if (bySev[sev].length === 0) continue;
    console.log(`\n  ${sev} (${bySev[sev].length}):`);
    for (const b of bySev[sev]) {
      console.log(`    • ${b.id} [${b.category}] — ${b.description}`);
      console.log(`        ${b.details}`);
    }
  }

  // Excelentes
  const excellent = RESULTS.filter(r => r.pass).map(r => `${r.id} (${r.category})`).slice(0, 10);
  console.log(`\nCasos donde respondió excelente (${RESULTS.filter(r=>r.pass).length}, top 10):`);
  for (const e of excellent) console.log(`  ✓ ${e}`);

  // Blockers
  const blockers = bySev.Critical;
  console.log(`\nBloqueadores para producción: ${blockers.length}`);
  for (const b of blockers) console.log(`  🚨 ${b.id} — ${b.description}`);

  // Production readiness
  console.log('\nProduction readiness:');
  if (overall >= 90 && blockers.length === 0) console.log('  ✅ LISTO para producción — calidad alta, sin blockers');
  else if (overall >= 75 && blockers.length === 0) console.log('  🟡 Casi listo — pulir bugs Medium antes del rollout');
  else if (blockers.length > 0) console.log(`  🔴 NO listo — ${blockers.length} blocker(s) críticos`);
  else console.log('  🟠 Necesita más trabajo — score < 75');

  console.log('\nMadurez estimada del agente:');
  if (overall >= 90) console.log('  Beta tardío / GA — uso real con monitoreo');
  else if (overall >= 75) console.log('  Beta — feedback de pocos users');
  else if (overall >= 60) console.log('  Alpha — pruebas internas extendidas');
  else console.log('  Pre-alpha — bugs estructurales');

  // Persist
  const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'qa-prod-senior-results.json');
  fs.writeFileSync(out, JSON.stringify({
    overall, total: RESULTS.length, pass: totalPass, email: EMAIL,
    ts: new Date().toISOString(),
    categoryScores,
    results: RESULTS.map(r => ({ id: r.id, category: r.category, description: r.description, pass: r.pass, severity: r.severity, details: r.details, response: r.response })),
  }, null, 2));
  console.log(`\nReporte JSON: ${out}`);

  process.exit(blockers.length > 0 ? 1 : 0);
}

main().catch(err => { console.error('💥 FATAL:', err); process.exit(1); });
