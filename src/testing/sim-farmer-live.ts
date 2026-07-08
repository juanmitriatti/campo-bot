/**
 * sim-farmer-live.ts — Simulación de productor real contra PRODUCCIÓN (live).
 * Verifica los fixes deployados (lotes con artículo "El Bajo"/"La Loma",
 * compound multi-siembra, "qué tengo sembrado", "dónde sembré maíz") + un
 * recorrido más amplio (gasto, ingreso, fumigación, lluvia, consulta financiera).
 *
 * Usa un usuario de prueba DEDICADO y limpia sus datos al final (reset es
 * WHERE user_id=$1, solo toca esa cuenta). Endpoints gated requieren x-test-secret.
 *
 * Run: BASE_URL=<prod> TEST_BOT_SECRET=<secret> npx tsx src/testing/sim-farmer-live.ts
 */

const BASE_URL = process.env.BASE_URL || 'https://campo-bot-production.up.railway.app';
const SECRET = process.env.TEST_BOT_SECRET || '';
const EMAIL = 'sim-live-qa@campo-test.local';
const PASSWORD = 'SimLive12345!';

let TOKEN = '';
let USER_ID = 0;

async function register(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Carlos', last_name: 'ProductorLive', email: EMAIL, password: PASSWORD }),
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
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'x-test-secret': SECRET }, body: '{}',
  });
  if (!res.ok) throw new Error(`reset ${res.status}: ${await res.text()}`);
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
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'x-test-secret': SECRET },
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

async function say(msg: string): Promise<{ text: string; buttons: Array<{ id: string; title: string }> }> {
  console.log(`\n👨‍🌾 USUARIO: ${msg}`);
  const data = await rawSend({ message: msg });
  const r = fmt(data);
  console.log(`🤖 BOT: ${r.text}`);
  if (r.buttons.length) console.log(`   [BOTONES: ${r.buttons.map(b => `"${b.title}"(${b.id})`).join(' | ')}]`);
  await sleep(500);
  return r;
}
async function tap(buttonId: string, label: string): Promise<{ text: string; buttons: Array<{ id: string; title: string }> }> {
  console.log(`\n👆 USUARIO TOCA: "${label}" (${buttonId})`);
  const data = await rawSend({ interactiveReplyId: buttonId });
  const r = fmt(data);
  console.log(`🤖 BOT: ${r.text}`);
  if (r.buttons.length) console.log(`   [BOTONES: ${r.buttons.map(b => `"${b.title}"(${b.id})`).join(' | ')}]`);
  await sleep(500);
  return r;
}
function header(t: string) { console.log(`\n\n${'='.repeat(70)}\n  ${t}\n${'='.repeat(70)}`); }

async function snapshotDB(label: string) {
  const fields = await dbQuery('SELECT id, name FROM fields WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id', [USER_ID]);
  const plots = await dbQuery('SELECT p.id, p.name, p.field_id FROM plots p JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND p.deleted_at IS NULL ORDER BY p.id', [USER_ID]);
  const crops = await dbQuery("SELECT pc.crop, pc.plot_id FROM plot_crops pc JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND pc.harvested_at IS NULL ORDER BY pc.id", [USER_ID]);
  const live = await dbQuery('SELECT category, count AS quantity, plot_id, corral_id FROM livestock_groups WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id', [USER_ID]);
  const exp = await dbQuery('SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM expenses WHERE user_id=$1 AND deleted_at IS NULL', [USER_ID]);
  const inc = await dbQuery('SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM incomes WHERE user_id=$1 AND deleted_at IS NULL', [USER_ID]);
  const acts = await dbQuery("SELECT event_type, COUNT(*) AS n FROM domain_events WHERE user_id=$1 GROUP BY event_type ORDER BY event_type", [USER_ID]);
  const rain = await dbQuery('SELECT COALESCE(SUM(mm),0) AS mm, COUNT(*) AS n FROM rainfall WHERE user_id=$1', [USER_ID]).catch(() => [{ mm: 0, n: 0 }]);
  console.log(`\n📊 DB SNAPSHOT [${label}]`);
  console.log(`   Campos (${fields.length}): ${fields.map(f => `${f.name}`).join(', ') || '—'}`);
  console.log(`   Lotes (${plots.length}): ${plots.map(p => `${p.name}`).join(', ') || '—'}`);
  console.log(`   Cultivos (${crops.length}): ${crops.map(c => `${c.crop}@lote${c.plot_id}`).join(', ') || '—'}`);
  console.log(`   Hacienda: ${live.map(l => `${l.quantity} ${l.category}(lote:${l.plot_id ?? '—'},corral:${l.corral_id ?? '—'})`).join(', ') || '—'}`);
  console.log(`   Gastos: ${exp[0].n} ($${Number(exp[0].total).toLocaleString('es-AR')}) | Ingresos: ${inc[0].n} ($${Number(inc[0].total).toLocaleString('es-AR')})`);
  console.log(`   Actividades: ${acts.map((a: any) => `${a.event_type}×${a.n}`).join(', ') || '—'} | Lluvia: ${rain[0].mm}mm (${rain[0].n})`);
  return { fields, plots, crops, live, exp: exp[0], inc: inc[0], acts, rain: rain[0] };
}

async function main() {
  if (!SECRET) throw new Error('Falta TEST_BOT_SECRET (endpoints gated en prod).');
  header(`SETUP LIVE — ${BASE_URL}`);
  const health: any = await (await fetch(`${BASE_URL}/api/health`)).json();
  console.log(`Prod SHA live: ${health.sha}`);
  await register();
  console.log(`Usuario de prueba #${USER_ID} (${EMAIL})`);
  await dbQuery('UPDATE users SET plan_id=4 WHERE id=$1', [USER_ID]); // enterprise (features completas)
  await reset();
  console.log('Datos del usuario de prueba reseteados a CERO.');

  header('FASE 1 — alta campo + lote');
  await say('hola');
  await say('quiero cargar mi campo, se llama El Ombú y está en Pergamino');
  await say('tiene un lote que le decimos La Loma de 80 hectáreas');

  header('FASE 2 — siembra + vacas (no sabe si lote o feedlot)');
  await say('sembré soja en La Loma');
  const r1 = await say('y tengo 50 vacas, no sé si van en un lote o en un feedlot');
  if (r1.buttons.length) {
    const fb = r1.buttons.find(b => /feed|corral/i.test(b.title)) || r1.buttons[0];
    await tap(fb.id, fb.title);
  } else {
    await say('ponelas en el feedlot');
  }

  header('FASE 3 — varios lotes (con artículo) + varias siembras juntas');
  await say('agregá tres lotes más al campo El Ombú: El Bajo de 120 has, La Cañada de 95 has y El Monte de 60 has');
  await say('sembré maíz en El Bajo, trigo en La Cañada y girasol en El Monte');
  const snap3 = await snapshotDB('post siembras');

  header('FASE 4 — gastos, ingresos, fumigación, lluvia (recorrido amplio)');
  await say('gasté 150 mil en gasoil');
  await say('vendí 30 toneladas de soja a 320 dólares la tonelada');
  await say('fumigué El Bajo con glifosato');
  await say('llovieron 25mm en La Loma');
  await snapshotDB('post recorrido amplio');

  header('FASE 5 — consultas como un productor (no técnico)');
  await say('che, qué tengo sembrado?');
  await say('dónde sembré maíz?');
  await say('cuántas vacas tengo?');
  await say('cuántas hectáreas tengo en total?');
  await say('en La Loma qué hay?');
  await say('cuánto gasté este mes?');
  await say('cómo venimos de plata?');

  header('RESUMEN — consistencia (live)');
  const fin = await snapshotDB('FINAL');
  const issues: string[] = [];
  if (fin.fields.length !== 1) issues.push(`Campos: esperaba 1, hay ${fin.fields.length}`);
  if (fin.plots.length !== 4) issues.push(`Lotes: esperaba 4, hay ${fin.plots.length}`);
  const cropset = fin.crops.map((c: any) => c.crop.toLowerCase());
  for (const c of ['soja', 'maíz', 'trigo', 'girasol']) if (!cropset.some((x: string) => x.includes(c) || x.includes(c.replace('í', 'i')))) issues.push(`Falta cultivo: ${c}`);
  const vacas = fin.live.filter((l: any) => /vaca/i.test(l.category)).reduce((s: number, l: any) => s + Number(l.quantity), 0);
  if (vacas !== 50) issues.push(`Vacas: esperaba 50, hay ${vacas}`);
  if (Number(fin.inc.n) < 1) issues.push('Falta el ingreso de soja');
  if (Number(fin.exp.n) < 1) issues.push('Falta el gasto de gasoil');

  console.log(`\n${'─'.repeat(70)}`);
  if (issues.length === 0) console.log('✅ CONSISTENCIA OK EN LIVE — todo lo que el productor dijo quedó registrado.');
  else { console.log('⚠️ INCONSISTENCIAS EN LIVE:'); for (const i of issues) console.log(`   - ${i}`); }
  console.log('─'.repeat(70));

  // Limpieza: borrar datos del usuario de prueba para no dejar basura en prod.
  header('CLEANUP — borrando datos del usuario de prueba');
  await reset();
  const left = await dbQuery('SELECT (SELECT COUNT(*) FROM fields WHERE user_id=$1 AND deleted_at IS NULL) AS f, (SELECT COUNT(*) FROM expenses WHERE user_id=$1 AND deleted_at IS NULL) AS e', [USER_ID]);
  console.log(`Datos restantes tras reset: campos=${left[0].f}, gastos=${left[0].e} (debe ser 0/0).`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
