#!/usr/bin/env npx tsx
/**
 * probe-capacidad.ts — verifica de punta a punta la advertencia de
 * sobrecapacidad de corral: se avisa, y NO se bloquea la operación.
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
  console.log(`\n👤 ${m}\n🤖 ${t.slice(0, 300)}`);
  return t;
}

async function tap(re: RegExp): Promise<string> {
  const b = BTNS.find(x => re.test(x.title));
  if (!b) return '';
  const t = await call({ interactiveReplyId: b.id });
  console.log(`👆 [${b.title}]\n🤖 ${t.slice(0, 300)}`);
  return t;
}

async function main(): Promise<void> {
  const email = `cap-${Date.now()}@campo.test`;
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cap', email, password: 'cap2026!!' }),
  });
  TOKEN = ((await r.json()) as { tokens: { accessToken: string } }).tokens.accessToken;

  await say('agregar campo Cap');
  if (BTNS.some(b => /localidad/i.test(b.title))) {
    await tap(/localidad/i);
    await say('Pergamino');
    await tap(/confirmar/i);
  }
  await say('agregar lote Norte al campo Cap');
  await say('saltar');
  await say('agregué 60 novillos al lote Norte');
  await say('crear feedlot en el campo Cap');
  await say('crear corral 1 con capacidad 10');

  const res = await say('mové 40 novillos del lote Norte al corral 1');

  console.log('\n─────────────────────────────');
  const movio = /transferencia/i.test(res);
  const aviso = /capacidad/i.test(res);
  console.log(movio ? '✅ el movimiento SE REGISTRÓ (no bloquea)' : '❌ el movimiento no se registró');
  console.log(aviso ? '✅ ADVIRTIÓ la sobrecapacidad' : '❌ no advirtió la sobrecapacidad');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
