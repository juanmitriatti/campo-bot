#!/usr/bin/env npx tsx
/**
 * qa-ganaderia-live.ts — recorrido completo del módulo de Ganadería contra un
 * entorno REAL (por defecto producción), pensado para cazar regresiones entre
 * lo que ya funcionaba (grupos) y lo que se agregó (animal individual + RFID).
 *
 * A diferencia del eval, acá NO hay reset: corre de forma aditiva sobre una
 * cuenta y verifica el estado final contra la API del dashboard. Por eso está
 * pensado para una cuenta descartable, no para la del productor.
 *
 * Uso:
 *   QA_EMAIL=... QA_PASSWORD=... npx tsx src/testing/qa-ganaderia-live.ts
 *   QA_BASE_URL=http://localhost:3000 ... (default: producción)
 *
 * Cada paso declara qué espera. Un `expect` que no se cumple NO corta el
 * recorrido: se anota y se sigue, porque lo que interesa es el mapa completo de
 * qué anda y qué no, no el primer tropiezo.
 */

const BASE = process.env.QA_BASE_URL || 'https://campo-bot-production.up.railway.app';
const EMAIL = process.env.QA_EMAIL || '';
const PASSWORD = process.env.QA_PASSWORD || '';

if (!EMAIL || !PASSWORD) {
  console.error('Faltan QA_EMAIL / QA_PASSWORD');
  process.exit(1);
}

let TOKEN = '';
let USER_ID = 0;

/**
 * Forma real de la respuesta (ver `BotResponseItem` en message-pipeline.ts): el
 * cuerpo de un mensaje interactivo vive en `interactive.body`, NO en la raíz.
 * Leerlo mal hace que toda confirmación con botones parezca "respuesta vacía".
 */
interface BotItem {
  type?: 'text' | 'interactive';
  text?: string;
  interactive?: {
    type?: string;
    body?: string;
    buttons?: Array<{ id: string; title: string }>;
    sections?: Array<{ rows?: Array<{ id: string; title: string }> }>;
  };
}
interface SendResult { messages: BotItem[] }

async function login(): Promise<void> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${r.status}: ${await r.text()}`);
  const d = await r.json() as { tokens: { accessToken: string }; user: { id: number } };
  TOKEN = d.tokens.accessToken;
  USER_ID = d.user.id;
}

async function post(body: Record<string, unknown>): Promise<SendResult> {
  const r = await fetch(`${BASE}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`test-bot ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<SendResult>;
}

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}/api/auth${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

const textOf = (res: SendResult) =>
  (res.messages || []).map(m => m.text ?? m.interactive?.body ?? '').join(' \n');
/** Botones de `buttons` y también las filas de una lista (el picker de categorías usa `sections`). */
const buttonsOf = (res: SendResult) =>
  (res.messages || []).flatMap(m => [
    ...(m.interactive?.buttons ?? []),
    ...(m.interactive?.sections ?? []).flatMap(s => s.rows ?? []),
  ]);

// ── registro de resultados ──────────────────────────────────────────────

interface StepLog {
  group: string;
  sent: string;
  reply: string;
  ok: boolean;
  why: string;
  isNew: boolean;   // ¿ejercita la capa individual (nueva) o el modelo por grupos?
}
const LOG: StepLog[] = [];
let lastResult: SendResult | null = null;

interface Check { has?: string[]; hasNot?: string[]; buttons?: boolean }

async function step(group: string, sent: string, check: Check = {}, isNew = false): Promise<SendResult> {
  let res = await post({ message: sent });
  lastResult = res;

  // Un usuario real toca "Confirmar" cuando el bot le muestra la tarjeta. Sin
  // esto, el paso siguiente arranca con un pending abierto y arrastra el error.
  const confirm = buttonsOf(res).find(b => /^confirmar/i.test(b.title.trim()));
  if (confirm) {
    res = await post({ interactiveReplyId: confirm.id });
    lastResult = res;
  }

  record(group, sent, res, check, isNew);
  return res;
}

async function tapTitle(group: string, title: string, check: Check = {}, isNew = true): Promise<SendResult | null> {
  const btn = (buttonsOf(lastResult ?? { messages: [] }))
    .find(b => b.title.toLowerCase().includes(title.toLowerCase()));
  if (!btn) {
    LOG.push({ group, sent: `[tap "${title}"]`, reply: '(botón no encontrado)', ok: false, why: 'el botón esperado no estaba', isNew });
    return null;
  }
  const res = await post({ interactiveReplyId: btn.id });
  lastResult = res;
  record(group, `[tap "${btn.title}"]`, res, check, isNew);
  return res;
}

function record(group: string, sent: string, res: SendResult, check: Check, isNew: boolean): void {
  const reply = textOf(res).replace(/\s+/g, ' ').trim();
  const problems: string[] = [];

  for (const h of check.has ?? []) {
    if (!reply.toLowerCase().includes(h.toLowerCase())) problems.push(`falta "${h}"`);
  }
  for (const h of check.hasNot ?? []) {
    if (reply.toLowerCase().includes(h.toLowerCase())) problems.push(`NO debía decir "${h}"`);
  }
  if (check.buttons && buttonsOf(res).length === 0) problems.push('esperaba botones');
  if (!reply) problems.push('respuesta vacía');
  if (/error|no pude|no entend/i.test(reply) && (check.has ?? []).length > 0) {
    problems.push('respuesta de error');
  }

  LOG.push({ group, sent, reply, ok: problems.length === 0, why: problems.join('; '), isNew });
  const mark = problems.length === 0 ? '✅' : '❌';
  console.log(`${mark} [${group}] ${sent.slice(0, 70).replace(/\n/g, ' ⏎ ')}`);
  console.log(`      → ${reply.slice(0, 150)}`);
  if (problems.length) console.log(`      ⚠️  ${problems.join('; ')}`);
}

// ── recorrido ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🐄 QA Ganadería LIVE — ${BASE}\n   usuario: ${EMAIL}\n`);
  await login();
  console.log(`   userId: ${USER_ID}\n`);

  const CAMPO = 'La Federala';

  // ---------- SETUP ----------
  console.log('\n═══ SETUP ═══');
  await step('setup', `agregar campo ${CAMPO}`, {});
  // El alta de campo puede pedir ubicación por botones; se resuelve si aparece.
  if (buttonsOf(lastResult!).some(b => /localidad|ciudad/i.test(b.title))) {
    await tapTitle('setup', 'localidad', {}, false);
    await step('setup', 'Pergamino', {}, false);
    if (buttonsOf(lastResult!).some(b => /confirm/i.test(b.title))) await tapTitle('setup', 'confirm', {}, false);
  }
  await step('setup', `agregar lote Norte al campo ${CAMPO}`, {});
  await step('setup', '150', {}, false);
  await step('setup', `agregar lote Sur al campo ${CAMPO}`, {});
  await step('setup', '90', {}, false);

  // ---------- GRUPOS (lo que ya funcionaba) ----------
  console.log('\n═══ GRUPOS — inventario y movimientos ═══');
  await step('grupos', 'compré 120 vacas Angus para el lote Norte a 1.500.000 cada una',
    { has: ['120'] });
  await step('grupos', 'agregué 40 terneros al lote Sur', { has: ['40'] });
  await step('grupos', 'cuántas vacas tengo', { has: ['120'] });
  await step('grupos', 'mové 30 vacas del lote Norte al lote Sur', { has: ['30'] });
  await step('grupos', 'se murieron 2 terneros en el lote Sur', { has: ['2'] });
  await step('grupos', 'nacieron 15 terneros en el lote Norte', { has: ['15'] });
  await step('grupos', 'pasé 10 terneros a novillitos en el lote Sur', { has: ['10'] });
  await step('grupos', 'vendí 20 vacas del lote Sur a 1800 el kilo, pesaban 420 kg', { has: ['20'] });
  await step('grupos', 'inventario de hacienda', { has: ['animales'] });
  await step('grupos', 'historial de hacienda', {});
  await step('grupos', 'cuántos animales tengo en el lote Sur', {});

  // ---------- SANIDAD / REPRO / PESAJE (ya funcionaba) ----------
  console.log('\n═══ SANIDAD · REPRODUCCIÓN · PESAJE ═══');
  await step('sanidad', 'vacuné 100 vacas contra aftosa en el lote Norte', { has: ['aftosa'] });
  await step('sanidad', 'desparasité los terneros del lote Sur con ivermectina', { has: ['ivermectina'] });
  await step('sanidad', 'historial sanitario del lote Norte', { has: ['aftosa'] });
  await step('repro', 'eché el toro Angus a 80 vacas en el lote Norte', {});
  await step('repro', 'desteté 15 terneros en el lote Sur', {});
  await step('repro', 'historial reproductivo', {});
  await step('pesaje', 'pesé los novillitos del lote Sur, 280 kg promedio', { has: ['280'] });
  await step('pesaje', 'cuánto pesan los novillitos', { has: ['280'] });

  // ---------- FEEDLOT + capacidad (capacidad = NUEVO) ----------
  console.log('\n═══ FEEDLOT · capacidad ═══');
  await step('feedlot', `crear feedlot en el campo ${CAMPO}`, {});
  await step('feedlot', 'crear corral 1 con capacidad 5', {});
  await step('feedlot', 'mové 10 novillitos del lote Sur al corral 1',
    { has: ['capacidad'] }, true);   // debe ADVERTIR sin bloquear

  // ---------- ANIMAL INDIVIDUAL (nuevo) ----------
  console.log('\n═══ ANIMAL INDIVIDUAL · caravanas ═══');
  const tags = ['0000000101', '0000000102', '0000000103', '0000000104', '0000000105'];
  for (const t of tags) {
    await step('individual', `dar de alta una vaca Angus con caravana 032 01 ${t} en el lote Norte`,
      { has: ['registrado'] }, true);
  }
  await step('individual', 'qué pasó con la caravana 0000000101',
    { has: ['vaca'], hasNot: ['No tengo'] }, true);
  await step('individual', 'qué animales tengo con caravana', { has: ['Vaca'] }, true);
  await step('individual', 'dónde está la caravana 0000000999',
    { has: ['No tengo'] }, true);

  // ---------- LISTA PEGADA (RFID) ----------
  console.log('\n═══ LISTA PEGADA DE CARAVANAS ═══');
  const pegado = [...tags.map(t => `03201${t}`), '032010000000901'].join('\n');
  await step('rfid', pegado, { has: ['5', 'sin registrar'], buttons: true }, true);
  await tapTitle('rfid', 'Mover', { has: ['lote o corral'] }, true);
  await step('rfid', 'Sur', { has: ['5'] }, true);
  await step('rfid', 'qué pasó con la caravana 0000000103', { has: ['Sur'] }, true);

  // ---------- RE-IDENTIFICACIÓN ----------
  console.log('\n═══ REEMPLAZO DE CARAVANA ═══');
  await step('reid', 'la 0000000101 perdió la caravana, le puse la 032 01 0000000201',
    { has: ['reemplaz'] }, true);
  await step('reid', 'dónde está la caravana 0000000201', { has: ['vaca'] }, true);
  await step('reid', 'dónde está la caravana 0000000101', { has: ['No tengo'] }, true);

  // ---------- MOVIMIENTO INDIVIDUAL + REVERSIÓN ----------
  console.log('\n═══ MOVIMIENTO INDIVIDUAL · REVERSIÓN ═══');
  await step('mov', 'mové la caravana 0000000102 y la 0000000104 al lote Norte',
    { has: ['2'], hasNot: ['Transferencia'] }, true);
  await step('mov', 'revertí el último movimiento', {}, true);

  // ---------- REGRESIÓN: el camino por grupos sigue intacto ----------
  console.log('\n═══ REGRESIÓN — grupo vs individual ═══');
  await step('regresion', 'mové 20 vacas del lote Norte al lote Sur',
    { has: ['Transferencia'], hasNot: ['caravana'] });
  await step('regresion', 'cuántas vacas tengo', { hasNot: ['No tenés hacienda'] });
  await step('regresion', 'inventario de hacienda', { has: ['animales'] });

  // ---------- VERIFICACIÓN CONTRA EL DASHBOARD ----------
  console.log('\n═══ ESTADO FINAL (API del dashboard) ═══');
  const animals = await api<{ total: number; items: Array<{ current_rfid: string | null; plot_name: string | null; category: string }> }>('/animals');
  const groups = await api<{ totalAnimals: number; totalGroups: number; items: Array<{ category: string; count: number; individualized_count: number; plot_name: string | null; corral_name: string | null }> }>('/livestock?limit=100');
  const cons = await api<{ issues: Array<{ kind: string; message: string }> }>('/animals/consistency');

  console.log(`  animales individuales: ${animals.total}`);
  for (const a of animals.items) {
    console.log(`    • ${a.category} ${a.current_rfid ?? 'sin caravana'} — ${a.plot_name ?? '—'}`);
  }
  console.log(`  grupos: ${groups.totalGroups} · cabezas: ${groups.totalAnimals}`);
  for (const g of groups.items) {
    const loc = g.plot_name ?? g.corral_name ?? '—';
    const ind = g.individualized_count > 0 ? ` (${g.individualized_count} con caravana)` : '';
    console.log(`    • ${g.category} ${loc}: ${g.count}${ind}`);
  }
  console.log(`  inconsistencias: ${cons.issues.length}`);
  for (const i of cons.issues) console.log(`    ⚠️  [${i.kind}] ${i.message}`);

  // ---------- REPORTE ----------
  const fails = LOG.filter(s => !s.ok);
  const nuevos = LOG.filter(s => s.isNew);
  const viejos = LOG.filter(s => !s.isNew);
  console.log('\n' + '═'.repeat(60));
  console.log('  RESUMEN');
  console.log('═'.repeat(60));
  console.log(`  Total pasos:            ${LOG.length}`);
  console.log(`  OK:                     ${LOG.length - fails.length}`);
  console.log(`  Con observaciones:      ${fails.length}`);
  console.log(`  — capa NUEVA:           ${nuevos.filter(s => !s.ok).length} / ${nuevos.length}`);
  console.log(`  — camino YA EXISTENTE:  ${viejos.filter(s => !s.ok).length} / ${viejos.length}  ← regresiones`);

  if (fails.length) {
    console.log('\n  DETALLE');
    for (const f of fails) {
      console.log(`\n  ❌ [${f.group}${f.isNew ? ' · NUEVO' : ' · existente'}] ${f.sent.slice(0, 90).replace(/\n/g, ' ⏎ ')}`);
      console.log(`     motivo: ${f.why}`);
      console.log(`     bot: ${f.reply.slice(0, 260)}`);
    }
  }

  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  fs.writeFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'qa-ganaderia-live-results.json'),
    JSON.stringify({
      base: BASE, email: EMAIL, userId: USER_ID,
      summary: { total: LOG.length, ok: LOG.length - fails.length, fail: fails.length },
      finalState: { animals: animals.total, groups: groups.totalGroups, cabezas: groups.totalAnimals, issues: cons.issues },
      steps: LOG,
    }, null, 2),
  );
  console.log('\n📄 src/testing/qa-ganaderia-live-results.json\n');
}

main().catch((e) => { console.error('\nFATAL:', e); process.exit(1); });
