#!/usr/bin/env npx tsx
/**
 * probe-ganaderia.ts — reproducción aislada de dos hallazgos del recorrido QA,
 * para separar bug real de artefacto del test.
 *
 * A) "pasé 10 terneros a novillitos en el lote Sur" → ¿pide el origen aunque el
 *    usuario lo dijo?
 * B) un pending de sanidad ("¿a cuántos animales?") ¿se come mensajes de OTRA
 *    intención y termina registrando algo que nadie pidió?
 */
const BASE = process.env.QA_BASE_URL || 'http://localhost:3000';
let TOKEN = '';

interface BotItem { text?: string; interactive?: { body?: string; buttons?: Array<{ id: string; title: string }> } }

async function reg(): Promise<void> {
  const email = `probe-${Date.now()}@campo.test`;
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Probe', email, password: 'probe2026!' }),
  });
  const d = await r.json() as { tokens: { accessToken: string } };
  TOKEN = d.tokens.accessToken;
}

let lastButtons: Array<{ id: string; title: string }> = [];

/** Toca el primer botón cuyo título matchee. Silencioso si no hay ninguno. */
async function tap(re: RegExp): Promise<string> {
  const btn = lastButtons.find(b => re.test(b.title));
  if (!btn) return '';
  const r = await fetch(`${BASE}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ interactiveReplyId: btn.id }),
    signal: AbortSignal.timeout(60_000),
  });
  const d = await r.json() as { messages: BotItem[] };
  lastButtons = (d.messages || []).flatMap(m => m.interactive?.buttons ?? []);
  const text = (d.messages || []).map(m => m.text ?? m.interactive?.body ?? '').join(' ').replace(/\s+/g, ' ').trim();
  console.log(`\n👆 [${btn.title}]`);
  console.log(`🤖 ${text.slice(0, 200)}`);
  return text;
}

async function say(msg: string): Promise<string> {
  const r = await fetch(`${BASE}/api/test-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ message: msg }),
    signal: AbortSignal.timeout(60_000),
  });
  const d = await r.json() as { messages: BotItem[] };
  lastButtons = (d.messages || []).flatMap(m => m.interactive?.buttons ?? []);
  const text = (d.messages || []).map(m => m.text ?? m.interactive?.body ?? '').join(' ').replace(/\s+/g, ' ').trim();
  console.log(`\n👤 ${msg}`);
  console.log(`🤖 ${text.slice(0, 260)}`);
  return text;
}

async function main(): Promise<void> {
  await reg();
  console.log('=== setup ===');
  // El alta de campo abre un flow de ubicación: hay que completarlo o el campo
  // no existe y todo lo que sigue mide otra cosa.
  await say('agregar campo Probe');
  await tap(/localidad/i);
  await say('Pergamino');
  await tap(/confirm/i);
  await say('agregar lote Sur al campo Probe');
  await say('saltar');
  await say('agregué 40 terneros al lote Sur');

  console.log('\n\n=== A) recategorización con lote explícito ===');
  await say('pasé 10 terneros a novillitos en el lote Sur');

  console.log('\n\n=== B) pending de sanidad vs otra intención ===');
  const ask = await say('desparasité los terneros del lote Sur con ivermectina');
  if (/cu[aá]ntos animales/i.test(ask)) {
    console.log('   ↑ dejó pending pidiendo la cantidad');
    const r1 = await say('crear feedlot en el campo Probe');
    console.log(r1.includes('Feedlot') && !/cu[aá]ntos animales/i.test(r1)
      ? '   ✅ el pending NO se comió el mensaje'
      : '   ❌ el pending SE COMIÓ un mensaje de otra intención');
    const r2 = await say('cuántos animales tengo');
    console.log(/cu[aá]ntos animales\?/i.test(r2)
      ? '   ❌ también se comió una consulta read-only'
      : '   ✅ la consulta read-only pasó');
    const r3 = await say('crear corral 1 con capacidad 5');
    console.log(/pesaje|sanitario|registrado/i.test(r3) && !/corral/i.test(r3)
      ? '   ❌❌ registró algo que el usuario NO pidió (corrupción de datos)'
      : '   ✅ no registró nada espurio');
  } else {
    console.log('   (no dejó pending — el hallazgo no se reprodujo)');
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
