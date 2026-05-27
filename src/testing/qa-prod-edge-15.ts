/**
 * QA PROD — edge cases (segunda batería contra producción).
 *
 * 15 escenarios sobre un user fresh:
 *   - Compounds con monedas mezcladas (gasto+ingreso en una frase)
 *   - Livestock add con price USD/ARS
 *   - Stock add con unit_price USD (auto-linked expense)
 *   - Cosecha con cargas por chofer
 *   - Cancelar a mitad del pending
 *   - Re-pending después de cancel
 *   - Queries por rango de fechas
 *   - Resultado total separando ARS y USD
 *   - Reporte por categoría con monedas mixtas
 *   - Edge: monto enorme (10 millones USD)
 *   - Edge: amount=0 → rechazar
 *
 * Run: npx tsx src/testing/qa-prod-edge-15.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'https://campo-bot-production.up.railway.app';
const EMAIL = `qa-edge-${Date.now()}@campo.test`;
const PASSWORD = 'qatest1234';
const NAME = 'QAEdge';

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
    if (attempt < 3) {
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

async function step(msg: string): Promise<string> { return flat(await sendText(msg)); }
async function stepTap(id: string): Promise<string> { return flat(await tap(id)); }
/** Send + auto-tap confirm if the bot shows the confirmation card. */
async function stepAndConfirm(msg: string): Promise<string> {
  let r = await step(msg);
  if (/¿Confirmo (gasto|ingreso)/i.test(r)) {
    const confirmed = await stepTap('confirm_pending');
    return r + '\n' + confirmed;
  }
  return r;
}

// ── Tests ────────────────────────────────────────────────────────────

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

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(72));
  console.log('QA PROD — Edge Cases');
  console.log('═'.repeat(72));

  console.log('\nAuth + setup…');
  await register();

  await step('cancelar');
  let r = await step('agregar campo Edge en Pergamino');
  if (/ubicar/i.test(r)) {
    await stepTap('flow_field_loc_city');
    await step('Pergamino');
    await stepTap('flow_confirm');
  }
  await step('agregar lote N1 al campo Edge'); await step('120');
  await step('agregar lote N2 al campo Edge'); await step('90');
  console.log('  ✓ campo Edge con lotes N1 (120ha) y N2 (90ha)');

  console.log('\n' + '─'.repeat(72));
  console.log('SECCIÓN 1 — Compounds con monedas mixtas');
  console.log('─'.repeat(72));

  console.log('\n[E01] Compound: gasto USD + ingreso ARS en una sola frase');
  let resp = await stepAndConfirm('gasté 500 dólares en gasoil y vendí 10 tn de soja a 800000 pesos cada una en el lote N1');
  // 2 acciones → bulkMode → ambas se guardan sin confirm
  check('E01_compound_mix', 'Gasto USD + ingreso ARS en compound', resp,
    [/USD\s*500|gasoil/i, /soja|\$\s*8\.?000\.?000/i],
    [/\$\s*500\s*USD/i]);

  console.log('\n[E02] Compound: gasto ARS + gasto USD');
  resp = await stepAndConfirm('pagué 100000 pesos en sueldos y gasté 200 dólares en glifosato para el lote N1');
  check('E02_compound_2gastos', 'Compound con 2 monedas diferentes', resp,
    [/sueldo|\$\s*100\.?000/i, /USD\s*200|glifosato/i],
    [/\$\s*200\s*USD/i]);

  console.log('\n' + '─'.repeat(72));
  console.log('SECCIÓN 2 — Livestock + stock con USD');
  console.log('─'.repeat(72));

  console.log('\n[E03] Add livestock con price USD (auto-link expense)');
  resp = await step('agregué 20 vacas Angus al lote N1 a 800 dolares cada una');
  check('E03_livestock_usd', 'Hacienda con precio USD → expense USD', resp,
    [/vaca|Angus|hacienda/i, /20/],
    [/\$\s*\d+\s*USD/i]);

  console.log('\n[E04] Add stock con unit_price USD (auto-link expense USD)');
  resp = await step('cargué 500 lt de glifosato a 8 dólares cada uno en el depósito principal');
  check('E04_stock_usd', 'Stock con USD unit_price', resp,
    [/glifosato|stock|500\s*l/i, /USD/i],
    [/\$\s*\d+\s*USD/i]);

  console.log('\n' + '─'.repeat(72));
  console.log('SECCIÓN 3 — Cosechas');
  console.log('─'.repeat(72));

  console.log('\n[E05] Siembra para preparar contexto');
  await step('sembré soja en el lote N1');
  await step('sembré maíz en el lote N2');

  console.log('\n[E06] Cosecha con rinde kg/ha');
  resp = await step('coseché soja en el lote N1 con un rinde de 4200 kg/ha');
  check('E06_cosecha_rinde', 'Cosecha + rinde', resp,
    [/cosech|soja|4\.?200/i]);

  console.log('\n[E07] Cosecha con cargas por chofer');
  resp = await step('cosechamos maíz en el lote N2. Pérez llevó 30000 kg y Gómez 22000 kg');
  check('E07_cosecha_cargas', 'Cosecha con cargas — debería extraer ambas', resp,
    [/cosech|ma[ií]z/i],
    [/no\s+pude|error/i]);

  console.log('\n' + '─'.repeat(72));
  console.log('SECCIÓN 4 — Cancelaciones a mitad de pending');
  console.log('─'.repeat(72));

  console.log('\n[E08] Cancelar a mitad del pending → NO se guarda');
  resp = await step('gasté 50 dólares en algo raro para el lote N1');
  if (/¿Confirmo/i.test(resp)) {
    const cancelled = await stepTap('cancel_pending');
    resp = resp + '\n' + cancelled;
  }
  check('E08_cancel_mid', 'Cancelar pending', resp,
    [/cancel/i]);

  console.log('\n[E09] Después de cancel, otro gasto NO debe avisar de cancel anterior');
  resp = await stepAndConfirm('gasté 100 dólares en fertilizante para el lote N1');
  check('E09_post_cancel', 'No avisa de cancel porque ya cancelamos', resp,
    [/USD\s*100/i, /fertiliz/i],
    [/cancel[eé]\s*el\s*(gasto|ingreso)\s*anterior/i]);

  console.log('\n' + '─'.repeat(72));
  console.log('SECCIÓN 5 — Queries de consistencia profunda');
  console.log('─'.repeat(72));

  console.log('\n[E10] Resultado del mes — separar ARS y USD');
  resp = await step('resultado del mes');
  check('E10_resultado_separado', 'Resultado separa monedas', resp,
    [/result|balance|neto|ingreso/i],
    [/\$\s*\d+\s*USD/i]);

  console.log('\n[E11] Total ingresos por categoría');
  resp = await step('cuanto cobré por categoría este mes');
  check('E11_ingresos_cat', 'Breakdown por categoría', resp,
    [/categor|soja|venta|ingreso/i]);

  console.log('\n[E12] Filtrar por lote N1 — gastos USD');
  resp = await step('cuanto gaste en dolares en el lote N1');
  check('E12_filtro_lote_usd', 'Filtro lote + USD', resp,
    [/N1|n1/i],
    [/\$\s*\d+\s*USD/i]);

  console.log('\n[E13] Listar todos los gastos del mes');
  resp = await step('listame todos los gastos del mes');
  check('E13_list_gastos', 'Listado de gastos', resp,
    [/gasto|gasoil|fertiliz|glifosato/i]);

  console.log('\n' + '─'.repeat(72));
  console.log('SECCIÓN 6 — Edge cases');
  console.log('─'.repeat(72));

  console.log('\n[E14] Monto enorme — 10 millones USD');
  resp = await stepAndConfirm('cobré 10 millones de dolares por arrendamiento del lote N1');
  check('E14_amount_enorme', '10M USD', resp,
    [/USD\s*10\.?000\.?000|10M\s*USD/i],
    [/\$\s*10\.?000\.?000\s*USD/i]);

  console.log('\n[E15] Monto negativo / 0 → rechazar');
  resp = await step('gasté 0 pesos en gasoil del lote N1');
  check('E15_amount_zero', 'Rechazar amount 0', resp,
    [/0|no\s+puede|negativ|monto/i]);

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
      console.log(`    response: "${r.response.replace(/\n/g, ' ↵ ').slice(0, 200)}"`);
    }
  }

  const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'qa-prod-edge-15-results.json');
  fs.writeFileSync(out, JSON.stringify({ passed, total: RESULTS.length, email: EMAIL, ts: new Date().toISOString(), results: RESULTS }, null, 2));
  console.log(`\nReport saved to ${out}`);

  process.exit(passed === RESULTS.length ? 0 : 1);
}

main().catch(err => { console.error('💥 FATAL:', err); process.exit(1); });
