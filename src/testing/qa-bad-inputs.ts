/**
 * Entradas malas contra el pipeline real (agente incluido), mirando la BASE:
 * tipeos, unidades cruzadas, números sueltos, contradicciones, imposibles.
 *
 *   npx tsx src/testing/qa-bad-inputs.ts            # servidor local en :3000
 *   npx tsx src/testing/qa-bad-inputs.ts --only 6,7
 *
 * No aprueba ni reprueba solo: imprime respuesta + filas que cambiaron por caso
 * para revisarlas. Consume créditos de API. Solo contra la base local.
 */
import 'dotenv/config';
import crypto from 'crypto';
import { pool } from '../config/db.js';
import { TestBotClient, type SendResult } from './test-bot-client.js';

const CASES: string[] = [
  'gaste 50 mill en gasoil',
  'gasté 1.5000 en semillas',
  'fumige el lotte 2 con glifosaato 2 lts por ha',
  'sembre soja en el lote 22',
  'vendi 30 tn de soya a 300 dolares la tonelada',
  'coseché el trigo del lote 2, rindió 40 kg/ha',
  'el trigo del lote 2 rindió 40 tn/ha',
  'fumigué el lote 2 con 2 tn/ha de glifosato',
  'llovieron 3 metros en La Esperanza',
  'llovieron 800 mm en La Esperanza',
  'sembré 500 ha de maíz en el lote 3',
  'gasté 200 litros en gasoil',
  '50000',
  '200 el 2',
  'el lote 2 150',
  '3500 dólares',
  'gasté 50 mil, no, 5 mil en flete, perdón 500 mil',
  'sembré soja, no, maíz, en el lote 2 o en el 3',
  'compré 10 vacas, bah no compré nada',
  'no registres que gasté 10000 en gasoil',
  'gasté -5000 en gasoil',
  'coseché -40 qq/ha en el lote 2',
  'compré 2,5 vacas para el lote 3',
  'compré 1000000 de vacas para el lote 3',
  'el 31 de febrero fumigué el lote 2 con 2 lt de glifosato',
  'el año que viene gasto 50 mil en gasoil',
  'mañana voy a vender 20 tn de soja',
  'se me murieron 50 vacas',
  'gasté 100 euros en repuestos',
  'borrá todo',
  'cuánto gasté en gasoil?',
  'asdfgh 123 qwer',
];

const TABLES: Array<[string, string]> = [
  ['gasto', `SELECT id, amount::float AS monto, currency, category, plot_id, expense_date::text AS f FROM expenses WHERE user_id = $1 AND deleted_at IS NULL`],
  ['ingreso', `SELECT id, amount::float AS monto, currency, category, quantity::float AS cant, unit, income_date::text AS f FROM incomes WHERE user_id = $1 AND deleted_at IS NULL`],
  ['evento', `SELECT id, event_type AS tipo, crop, product, quantity::float AS cant, unit, plot_id, event_date::text AS f FROM domain_events WHERE user_id = $1 AND deleted_at IS NULL`],
  ['campaña', `SELECT pc.id, pc.crop, p.name AS lote, pc.sowed_hectares::float AS ha, pc.yield_kg::float AS rinde_kg, (pc.end_date IS NOT NULL) AS cerrada FROM plot_crops pc JOIN plots p ON p.id = pc.plot_id JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1`],
  ['lote', `SELECT p.id, p.name, p.area_hectares::float AS ha FROM plots p JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1 AND p.deleted_at IS NULL`],
  ['lluvia', `SELECT id, millimeters::float AS mm, rainfall_date::text AS f FROM rainfall WHERE user_id = $1`],
  ['hacienda', `SELECT id, category::text AS cat, count AS n, plot_id FROM livestock_groups WHERE user_id = $1 AND deleted_at IS NULL`],
  ['recordatorio', `SELECT id, description, due_date::text AS f FROM task_reminders WHERE user_id = $1`],
];

type Snapshot = Map<string, string>;

async function snapshot(userId: number): Promise<Snapshot> {
  const out: Snapshot = new Map();
  for (const [label, sql] of TABLES) {
    const { rows } = await pool.query(sql, [userId]);
    for (const row of rows as Array<Record<string, unknown>>) {
      const { id, ...rest } = row;
      out.set(`${label}#${id}`, JSON.stringify(rest));
    }
  }
  return out;
}

function diff(before: Snapshot, after: Snapshot): string[] {
  const lines: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) lines.push(`+ ${k} ${v}`);
    else if (before.get(k) !== v) lines.push(`~ ${k} ${before.get(k)} → ${v}`);
  }
  for (const k of before.keys()) if (!after.has(k)) lines.push(`- ${k} ${before.get(k)}`);
  return lines;
}

const show = (r: SendResult) => r.messages.map(m => {
  const body = m.text ?? m.interactive?.body ?? '';
  const buttons = m.interactive?.buttons?.map(b => b.title)
    ?? m.interactive?.sections?.flatMap(s => s.rows.map(x => x.title));
  return body.replace(/\n+/g, ' ').slice(0, 260) + (buttons?.length ? ` [${buttons.slice(0, 5).join(' | ')}]` : '');
}).join(' // ');

const i = process.argv.indexOf('--only');
const only = i >= 0 ? new Set(process.argv[i + 1].split(',').map(Number)) : null;

const client = new TestBotClient('http://localhost:3000', 60_000);
await client.register(`malas-${Date.now()}@prueba.test`, crypto.randomBytes(12).toString('base64url'), 'Malas');
const userId = client.userId;

for (const msg of [
  'Agregar campo La Esperanza en Pergamino',
  'Agregar lote 2 de 100 hectáreas al campo La Esperanza',
  'Agregar lote 3 de 80 hectáreas al campo La Esperanza',
  'Sembré trigo en el lote 2 el 10 de junio',
]) await client.send(msg);
// Un rodeo conocido para los casos de hacienda.
await client.send('tengo 10 vacas en el lote 3');
await client.send('cancelar');
console.log(`usuario ${userId} — estado inicial:`);
for (const line of diff(new Map(), await snapshot(userId))) console.log('  ', line);

for (const [n, message] of CASES.entries()) {
  if (only && !only.has(n + 1)) continue;
  const before = await snapshot(userId);
  const started = Date.now();
  let reply: string;
  try {
    reply = show(await client.send(message));
  } catch (err) {
    reply = `ERROR ${(err as Error).message}`;
  }
  const changes = diff(before, await snapshot(userId));
  console.log(`\n${n + 1}. ${message}   (${Date.now() - started} ms)\n   < ${reply}`);
  for (const line of changes) console.log(`   DB ${line}`);
  await client.send('cancelar').catch(() => {});
}
await pool.end();
process.exit(0);
