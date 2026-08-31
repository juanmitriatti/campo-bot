#!/usr/bin/env npx tsx
/**
 * probe-recat.ts — el origen de una transferencia/recategorización cuando el
 * agente NO lo manda.
 *
 * Antes eran tres `return` de texto suelto ("Necesito el origen"), sin pending:
 * la respuesta del usuario quedaba huérfana y se iba al agente sin contexto.
 * Ahora la pregunta deja un pending machine-readable y nombra las ubicaciones
 * reales, así que contestar "Sur" completa la operación.
 */
const BASE = process.env.QA_BASE_URL || 'http://localhost:3000';
let TOKEN = '';
let BTNS: Array<{ id: string; title: string }> = [];

interface BotItem { text?: string; interactive?: { body?: string; buttons?: Array<{ id: string; title: string }> } }

async function call(body: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${BASE}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const d = await r.json() as { messages: BotItem[] };
  BTNS = (d.messages || []).flatMap(m => m.interactive?.buttons ?? []);
  return (d.messages || []).map(m => m.text ?? m.interactive?.body ?? '').join(' ').replace(/\s+/g, ' ').trim();
}
async function say(m: string): Promise<string> {
  const t = await call({ message: m });
  console.log(`\n👤 ${m}\n🤖 ${t.slice(0, 220)}`);
  return t;
}
async function tap(re: RegExp): Promise<string> {
  const b = BTNS.find(x => re.test(x.title));
  if (!b) return '';
  const t = await call({ interactiveReplyId: b.id });
  console.log(`👆 [${b.title}] → ${t.slice(0, 160)}`);
  return t;
}

async function main(): Promise<void> {
  const email = `recat-${Date.now()}@campo.test`;
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Recat', email, password: 'recat2026!' }),
  });
  TOKEN = ((await r.json()) as { tokens: { accessToken: string } }).tokens.accessToken;

  await say('agregar campo Recat');
  if (BTNS.some(b => /localidad/i.test(b.title))) { await tap(/localidad/i); await say('Pergamino'); await tap(/confirmar/i); }
  await say('agregar lote Norte al campo Recat');
  await say('saltar');
  await say('agregar lote Sur al campo Recat');
  await say('saltar');
  await say('agregué 15 terneros al lote Norte');
  await say('agregué 40 terneros al lote Sur');

  // Sin nombrar el lote: el origen es ambiguo y el bot TIENE que preguntar.
  const ask = await say('pasé 10 terneros a novillitos');
  const pregunto = /lote o corral/i.test(ask);
  console.log(pregunto ? '   ✅ preguntó el origen' : '   ❔ resolvió solo');
  const nombra = /Norte/.test(ask) && /Sur/.test(ask);
  console.log(nombra ? '   ✅ nombró las ubicaciones reales' : '   ⚠️  no nombró las ubicaciones');

  if (pregunto) {
    // La respuesta suelta tiene que COMPLETAR la operación, no perderse.
    const res = await say('Sur');
    console.log('\n─────────────────────────────');
    if (/recategorizaci/i.test(res)) console.log('✅ la respuesta completó la recategorización');
    else if (/lote o corral/i.test(res)) console.log('❌ volvió a preguntar — la respuesta se ignoró');
    else console.log(`❔ otra respuesta`);
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
