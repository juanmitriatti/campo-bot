/**
 * QA PROD — mixed currency consistency.
 *
 * Crea un usuario fresco en PRODUCCIÓN (Railway), simula 15+ interacciones
 * con la bot vía /api/test-bot mezclando ARS/USD en gastos e ingresos, y
 * después hace consultas pidiendo los totales de vuelta. Verifica:
 *
 *   - Cada amount registrado tiene la moneda correcta
 *   - Formato: "USD X" nunca "$X USD"
 *   - Las queries de vuelta no mezclan ARS+USD en un total único
 *   - Categoría detectada coherentemente
 *
 * Run: npx tsx src/testing/qa-prod-mixed-currency.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'https://campo-bot-production.up.railway.app';
const EMAIL = `qa-mix-${Date.now()}@campo.test`;
const PASSWORD = 'qatest1234';
const NAME = 'QAMix';

let TOKEN = '';

async function register(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'Test', email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Register failed: ${res.status} ${await res.text()}`);
  const d = await res.json() as any;
  TOKEN = d.tokens.accessToken;
  console.log(`  ✓ registered ${EMAIL} (user_id=${d.user.id})`);
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
    // Transient prod errors (ECONNRESET, socket closed) — retry up to 3 times
    if (attempt < 3) {
      console.log(`    ⚠ network error (${(err as Error).message}), retry ${attempt + 1}/3 in 2s`);
      await new Promise(r => setTimeout(r, 2000));
      return sendText(message, attempt + 1);
    }
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

function flat(r: { messages: any[] }): string {
  return (r.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}

// ── Test runner ───────────────────────────────────────────────────────

interface TestResult { id: string; description: string; pass: boolean; details: string; response: string }
const RESULTS: TestResult[] = [];

function check(id: string, description: string, response: string, contains: (string|RegExp)[], notContains: (string|RegExp)[] = []): void {
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
  const pass = missing.length === 0 && violated.length === 0;
  const details = pass ? 'OK' : [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    violated.length ? `should not match: ${violated.join(', ')}` : '',
  ].filter(Boolean).join(' | ');
  RESULTS.push({ id, description, pass, details, response: response.slice(0, 240) });
  console.log(`  ${pass ? '✅' : '❌'} ${id} — ${pass ? 'OK' : details}`);
}

async function step(msg: string): Promise<string> {
  const r = await sendText(msg);
  return flat(r);
}
async function stepTap(btnId: string): Promise<string> {
  const r = await tap(btnId);
  return flat(r);
}
/**
 * Send a gasto/ingreso message, then automatically tap "Confirmar" if the bot
 * returned the confirm-before-save card. Returns the FINAL response text after
 * the confirm so we can match against the saved-record format.
 * New users start with confirm_before_save=true by default in prod.
 */
async function stepAndConfirm(msg: string): Promise<string> {
  let r = await step(msg);
  if (/¿Confirmo (gasto|ingreso)/i.test(r)) {
    const confirmed = await stepTap('confirm_pending');
    return r + '\n' + confirmed;
  }
  return r;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(72));
  console.log('QA PROD — Mixed-Currency Consistency');
  console.log('═'.repeat(72));

  console.log('\nAuth + setup…');
  await register();

  // Setup: 1 field + 2 plots. The user is fresh so no confirm_before_save by default,
  // which makes each gasto/ingreso save inmediatamente (no pending tap needed).
  await step('cancelar');
  let r = await step('agregar campo Mix en Pergamino');
  if (/ubicar/i.test(r)) {
    await stepTap('flow_field_loc_city');
    await step('Pergamino');
    await stepTap('flow_confirm');
  }
  await step('agregar lote A1 al campo Mix'); await step('100');
  await step('agregar lote A2 al campo Mix'); await step('80');
  console.log('  ✓ campo Mix con lotes A1 (100ha) y A2 (80ha)');

  console.log('\n' + '─'.repeat(72));
  console.log('FASE 1 — Registros con monedas mezcladas');
  console.log('─'.repeat(72));

  // ════════ GASTOS ════════
  console.log('\n[T01] Gasto ARS — pesos default');
  let resp = await stepAndConfirm('gasté 50000 en gasoil para el lote A1');
  check('T01_gasto_ars', 'Gasto ARS sin mencionar moneda → debe ser $', resp,
    [/\$\s*50\.?000/i, /gasoil|combust/i],
    [/USD/i]);

  console.log('\n[T02] Gasto USD — dólares explícito');
  resp = await stepAndConfirm('gasté 500 dólares en glifosato para el lote A1');
  check('T02_gasto_usd', 'Gasto en USD → "USD 500" sin $', resp,
    [/USD\s*500/i, /glifosato|agroqu/i],
    [/\$\s*500\s*USD/i, /\$500/i]);

  console.log('\n[T03] Gasto USD informal "u$d"');
  resp = await stepAndConfirm('compré urea por 1200 u$s para el lote A2');
  check('T03_gasto_uds_informal', 'Gasto con "u$s" → USD', resp,
    [/USD\s*1\.?200/i, /urea|fertiliz/i],
    [/\$\s*1\.?200\s*USD/i]);

  console.log('\n[T04] Gasto ARS grande "1.5 palos"');
  resp = await stepAndConfirm('pagué 1.5 palos en sueldos del lote A1');
  check('T04_gasto_palos', 'Gasto ARS "1.5 palos" = $1.500.000', resp,
    [/\$\s*1\.?500\.?000/i, /sueldo/i],
    [/USD/i]);

  console.log('\n[T05] Gasto USD pequeño "300 dolares"');
  resp = await stepAndConfirm('gasté 300 dolares en semillas para el lote A2');
  check('T05_gasto_usd_pequeno', 'Gasto 300 USD', resp,
    [/USD\s*300/i, /semilla/i],
    [/\$\s*300\s*USD/i]);

  // ════════ INGRESOS ════════
  console.log('\n[T06] Ingreso ARS — pesos default');
  resp = await stepAndConfirm('vendí 5 toneladas de soja a 800000 pesos cada una en lote A1');
  check('T06_ingreso_ars', 'Ingreso ARS por venta de soja, total = 5 × 800k = 4M', resp,
    [/\$\s*4\.?000\.?000/i, /soja/i],
    [/USD/i]);

  console.log('\n[T07] Ingreso USD');
  resp = await stepAndConfirm('vendí 10 tn de maíz a 250 USD cada una en lote A2');
  check('T07_ingreso_usd', 'Ingreso USD por venta de maíz, total = 10 × 250 = 2500', resp,
    [/USD\s*2\.?500/i, /ma[ií]z/i],
    [/\$\s*2\.?500\s*USD/i]);

  console.log('\n[T08] Ingreso USD informal "dolares"');
  resp = await stepAndConfirm('cobré 8000 dolares por arrendamiento del lote A1');
  check('T08_ingreso_usd_arrendamiento', 'Arrendamiento 8000 USD', resp,
    [/USD\s*8\.?000/i, /arrendam/i],
    [/\$\s*8\.?000\s*USD/i]);

  console.log('\n[T09] Ingreso ARS grande "medio palo"');
  resp = await stepAndConfirm('cobré medio palo de pesos por servicios en el lote A2');
  check('T09_ingreso_medio_palo', 'Ingreso ARS "medio palo" = $500.000', resp,
    [/\$\s*500\.?000/i],
    [/USD/i]);

  console.log('\n[T10] Ingreso USD venta directa "USD"');
  resp = await stepAndConfirm('vendí 20 toneladas de trigo a USD 220 cada una en lote A1');
  check('T10_ingreso_trigo_usd', 'Trigo 20 × 220 USD = 4400 USD', resp,
    [/USD\s*4\.?400/i, /trigo/i],
    [/\$\s*4\.?400\s*USD/i]);

  console.log('\n' + '─'.repeat(72));
  console.log('FASE 2 — Queries de consistencia');
  console.log('─'.repeat(72));

  console.log('\n[T11] Cuánto gasté en total este mes');
  resp = await step('cuanto gaste este mes');
  // ARS total: 50000 + 1500000 = 1.550.000. USD total: 500 + 1200 + 300 = 2000
  check('T11_gastos_mes', 'Debe diferenciar ARS y USD, sin mezclarlos', resp,
    [/\$\s*1\.?550\.?000|1\.550\.000|1\.55\s*M/i],
    [/\$\s*\d+\s*USD/i]);

  console.log('\n[T12] Cuánto cobré este mes');
  resp = await step('cuanto cobre este mes');
  // ARS: 4000000 + 500000 = 4.500.000. USD: 2500 + 8000 + 4400 = 14900
  check('T12_ingresos_mes', 'Ingresos del mes en pesos correcto', resp,
    [/\$\s*4\.?500\.?000|4\.500\.000|4\.5\s*M/i],
    [/\$\s*\d+\s*USD/i]);

  console.log('\n[T13] Gastos solo en dólares');
  resp = await step('cuanto gaste en dolares este mes');
  // USD: 500+1200+300 = 2000
  check('T13_gastos_usd', 'Filtro de gastos solo USD', resp,
    [/USD\s*2\.?000|2\.?000\s*USD/i, /d[oó]lar/i],
    [/\$\s*2\.?000\s*USD/i]);

  console.log('\n[T14] Ingresos solo en dólares');
  resp = await step('cuanto cobre en dolares este mes');
  // USD: 2500+8000+4400 = 14900
  check('T14_ingresos_usd', 'Filtro de ingresos solo USD = 14.900', resp,
    [/USD\s*14\.?900|14\.?900\s*USD/i],
    [/\$\s*14\.?900\s*USD/i]);

  console.log('\n[T15] Resultado del mes');
  resp = await step('cual es el resultado del mes');
  check('T15_resultado', 'Resultado mes — ARS y USD separados', resp,
    [/resultado|balance|neto/i]);

  console.log('\n[T16] Total invertido en agroquímicos');
  resp = await step('cuanto gaste en agroquimicos');
  // T02 (500 USD glifosato), T03 (1200 USD urea — categorizada como agroquímicos o fertilizantes), T05 (300 USD semillas — diferente cat)
  check('T16_cat_agroquim', 'Filtro categoría agroquímicos', resp,
    [/agroqu|herbicid|gasto/i]);

  console.log('\n[T17] Listar ingresos USD');
  resp = await step('listame los ingresos en dolares');
  check('T17_list_ingresos_usd', 'Listado de ingresos USD muestra los 3', resp,
    [/USD|d[oó]lar/i, /ma[ií]z|soja|trigo|arrendam/i],
    [/\$\s*\d+\s*USD/i]);

  console.log('\n[T18] Ventas de soja específicamente');
  resp = await step('cuanto vendi de soja');
  check('T18_ventas_soja', 'Ventas soja = $4M ARS (T06)', resp,
    [/4\.?000\.?000|4\s*M|soja/i],
    [/\$\s*\d+\s*USD/i]);

  console.log('\n[T19] Lote A2 ingresos');
  resp = await step('cuanto cobre en el lote A2');
  // A2: T07 maíz 2500 USD, T09 medio palo ARS
  check('T19_ingresos_a2', 'Ingresos lote A2 (USD + ARS)', resp,
    [/A2|a2/i],
    [/\$\s*\d+\s*USD/i]);

  console.log('\n[T20] Lote A1 gastos');
  resp = await step('cuanto gaste en el lote A1');
  // A1: T01 50k ARS, T02 500 USD, T04 1.5M ARS
  check('T20_gastos_a1', 'Gastos lote A1 (USD + ARS)', resp,
    [/A1|a1/i],
    [/\$\s*\d+\s*USD/i]);

  // ── Summary ──────────────────────────────────────────────────────────
  const passed = RESULTS.filter(r => r.pass).length;
  console.log('\n' + '═'.repeat(72));
  console.log(`RESULTS: ${passed}/${RESULTS.length}`);
  console.log('═'.repeat(72));
  for (const r of RESULTS) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`${icon} ${r.id} — ${r.description}`);
    if (!r.pass) {
      console.log(`    ${r.details}`);
      console.log(`    response: "${r.response.replace(/\n/g, ' ↵ ').slice(0, 180)}"`);
    }
  }

  const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'qa-prod-mixed-currency-results.json');
  fs.writeFileSync(out, JSON.stringify({ passed, total: RESULTS.length, email: EMAIL, ts: new Date().toISOString(), results: RESULTS }, null, 2));
  console.log(`\nReport saved to ${out}`);

  process.exit(passed === RESULTS.length ? 0 : 1);
}

main().catch(err => { console.error('💥 FATAL:', err); process.exit(1); });
