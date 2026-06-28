/**
 * sim-farmer.ts — Simulación de un productor real (no técnico) usando el bot.
 * Flujo: registro → campo+lote → siembras+vacas (no sabe si lote o feedlot)
 *        → varios lotes + varias siembras juntas → consultas estilo "no entiende de IT".
 * Imprime la transcripción completa + verifica escrituras en DB para medir consistencia.
 *
 * Run: npx tsx src/testing/sim-farmer.ts
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL = 'sim-farmer@example.com';
const PASSWORD = 'Sim12345!';

let TOKEN = '';
let USER_ID = 0;

// ---------- API helpers ----------
async function register(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Juan', last_name: 'Productor', email: EMAIL, password: PASSWORD }),
  });
  if (res.ok) { const d: any = await res.json(); TOKEN = d.tokens.accessToken; USER_ID = d.user.id; return; }
  if (res.status === 409) { return login(); }
  throw new Error(`register ${res.status}: ${await res.text()}`);
}
async function login(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const d: any = await res.json(); TOKEN = d.tokens.accessToken; USER_ID = d.user.id;
}
async function reset(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test-bot/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: '{}',
  });
  if (!res.ok) throw new Error(`reset ${res.status}`);
}
async function rawSend(body: any): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`send ${res.status}: ${await res.text()}`);
  return res.json();
}
async function dbQuery(sql: string, params: any[] = []): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`dbq ${res.status}: ${await res.text()}`);
  const d: any = await res.json(); return d.rows || [];
}

function fmt(data: any): { text: string; buttons: Array<{ id: string; title: string }> } {
  const parts: string[] = [];
  const buttons: Array<{ id: string; title: string }> = [];
  for (const m of (data.messages || [])) {
    if (m.text) parts.push(m.text);
    if (m.interactive?.body) parts.push(m.interactive.body);
    if (m.interactive?.buttons) for (const b of m.interactive.buttons) buttons.push(b);
    if (m.interactive?.sections) for (const s of m.interactive.sections) for (const r of (s.rows || [])) buttons.push({ id: r.id, title: r.title });
  }
  return { text: parts.join('\n'), buttons };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// pretty print a turn
async function say(msg: string): Promise<{ text: string; buttons: Array<{ id: string; title: string }> }> {
  console.log(`\n👨‍🌾 USUARIO: ${msg}`);
  const data = await rawSend({ message: msg });
  const r = fmt(data);
  console.log(`🤖 BOT: ${r.text}`);
  if (r.buttons.length) console.log(`   [BOTONES: ${r.buttons.map(b => `"${b.title}"(${b.id})`).join(' | ')}]`);
  await sleep(400);
  return r;
}
async function tap(buttonId: string, label: string): Promise<{ text: string; buttons: Array<{ id: string; title: string }> }> {
  console.log(`\n👆 USUARIO TOCA: "${label}" (${buttonId})`);
  const data = await rawSend({ interactiveReplyId: buttonId });
  const r = fmt(data);
  console.log(`🤖 BOT: ${r.text}`);
  if (r.buttons.length) console.log(`   [BOTONES: ${r.buttons.map(b => `"${b.title}"(${b.id})`).join(' | ')}]`);
  await sleep(400);
  return r;
}

function header(t: string) { console.log(`\n\n${'='.repeat(70)}\n  ${t}\n${'='.repeat(70)}`); }

async function snapshotDB(label: string) {
  const fields = await dbQuery('SELECT id, name FROM fields WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id', [USER_ID]);
  const plots = await dbQuery('SELECT p.id, p.name, p.field_id FROM plots p JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND p.deleted_at IS NULL ORDER BY p.id', [USER_ID]);
  const crops = await dbQuery("SELECT pc.id, pc.crop, pc.plot_id, CASE WHEN pc.harvested_at IS NULL THEN 'activo' ELSE 'cosechado' END AS status FROM plot_crops pc JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 ORDER BY pc.id", [USER_ID]);
  const live = await dbQuery('SELECT id, category, count AS quantity, plot_id, corral_id FROM livestock_groups WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id', [USER_ID]);
  const corrals = await dbQuery('SELECT c.id, c.name FROM corrals c JOIN feedlots fl ON fl.id=c.feedlot_id WHERE fl.user_id=$1 AND c.deleted_at IS NULL ORDER BY c.id', [USER_ID]).catch(() => []);
  const feedlots = await dbQuery('SELECT id, name FROM feedlots WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id', [USER_ID]).catch(() => []);
  console.log(`\n📊 DB SNAPSHOT [${label}]`);
  console.log(`   Campos (${fields.length}): ${fields.map(f => `#${f.id} ${f.name}`).join(', ') || '—'}`);
  console.log(`   Lotes (${plots.length}): ${plots.map(p => `#${p.id} ${p.name}(campo ${p.field_id})`).join(', ') || '—'}`);
  console.log(`   Cultivos (${crops.length}): ${crops.map(c => `${c.crop}@lote${c.plot_id}[${c.status}]`).join(', ') || '—'}`);
  console.log(`   Hacienda (${live.length}): ${live.map(l => `${l.quantity} ${l.category}(lote:${l.plot_id ?? '—'},corral:${l.corral_id ?? '—'})`).join(', ') || '—'}`);
  console.log(`   Corrales: ${corrals.map((c: any) => c.name).join(', ') || '—'} | Feedlots: ${feedlots.map((f: any) => f.name).join(', ') || '—'}`);
  return { fields, plots, crops, live, corrals, feedlots };
}

async function main() {
  header('SETUP — registro + plan enterprise + reset');
  await register();
  console.log(`Usuario #${USER_ID} autenticado (${EMAIL})`);
  await dbQuery('UPDATE users SET plan_id=4 WHERE id=$1', [USER_ID]); // enterprise -> livestock/stock
  await reset();
  console.log('Datos reseteados a CERO. El productor arranca de cero.');

  // ---- FASE 1: alta de campo + lote como lo diría un productor ----
  header('FASE 1 — "Quiero dar de alta mi campo y un lote"');
  await say('hola');
  await say('quiero cargar mi campo, se llama El Ombú y está en Pergamino');
  await say('tiene un lote que le decimos La Loma de 80 hectáreas');
  await snapshotDB('post alta campo+lote');

  // ---- FASE 2: siembras + vacas, sin saber si lote o feedlot ----
  header('FASE 2 — siembras + vacas (no sabe si lote o feedlot)');
  await say('sembré soja en La Loma');
  // la parte ambigua: mete vacas sin saber dónde van
  const r1 = await say('y tengo 50 vacas, no sé si van en un lote o en un feedlot');
  // si el bot pregunta con botones, el productor elige feedlot/corral
  if (r1.buttons.length) {
    const fb = r1.buttons.find(b => /feed|corral/i.test(b.title)) || r1.buttons[0];
    await tap(fb.id, fb.title);
  } else {
    await say('ponelas en el feedlot');
  }
  await snapshotDB('post siembra + vacas');

  // ---- FASE 3: varios lotes + varias siembras al mismo tiempo (compound) ----
  header('FASE 3 — varios lotes y varias siembras juntas (mensaje largo)');
  await say('agregá tres lotes más al campo El Ombú: El Bajo de 120 has, La Cañada de 95 has y El Monte de 60 has');
  await say('sembré maíz en El Bajo, trigo en La Cañada y girasol en El Monte');
  const snap3 = await snapshotDB('post varios lotes + siembras');

  // ---- FASE 4: consultas estilo "no entiende de IT" ----
  header('FASE 4 — consultas como las haría un productor (lenguaje informal)');
  await say('che, qué tengo sembrado?');
  await say('cuántas vacas tengo?');
  await say('qué lotes tengo cargados?');
  await say('en La Loma qué hay?');
  await say('cuántas hectáreas tengo en total?');
  await say('dónde sembré maíz?');
  await say('mostrame todo lo del campo El Ombú');

  // ---- Resumen final ----
  header('RESUMEN FINAL — consistencia');
  const fin = await snapshotDB('FINAL');
  const issues: string[] = [];
  if (fin.fields.length !== 1) issues.push(`Esperaba 1 campo, hay ${fin.fields.length}`);
  if (fin.plots.length !== 4) issues.push(`Esperaba 4 lotes (La Loma, El Bajo, La Cañada, El Monte), hay ${fin.plots.length}`);
  const cropNames = fin.crops.map((c: any) => c.crop.toLowerCase());
  for (const c of ['soja', 'maíz', 'trigo', 'girasol']) {
    if (!cropNames.some((x: string) => x.includes(c.replace('í', 'i')) || x.includes(c))) issues.push(`Falta cultivo: ${c}`);
  }
  const totalVacas = fin.live.filter((l: any) => /vaca/i.test(l.category)).reduce((s: number, l: any) => s + Number(l.quantity), 0);
  if (totalVacas !== 50) issues.push(`Esperaba 50 vacas, hay ${totalVacas}`);

  console.log(`\n${'─'.repeat(70)}`);
  if (issues.length === 0) {
    console.log('✅ CONSISTENCIA OK — todo lo que el productor dijo quedó registrado correctamente.');
  } else {
    console.log('⚠️ INCONSISTENCIAS DETECTADAS:');
    for (const i of issues) console.log(`   - ${i}`);
  }
  console.log('─'.repeat(70));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
