/**
 * QA Chaos — adversarial multi-persona conversation fuzzer.
 *
 * Spawns N "persona" agents (Carlos productor, Pedro despistado, Lucia
 * pronombrera, Roberto stock, Adversario) — each one converses with the
 * test-bot for up to 20 turns trying to accomplish a concrete goal in
 * their own informal style. After every conversation, an evaluator LLM
 * scores it on objective and subjective criteria.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-chaos.ts
 *      ONLY=carlos,pedro npx tsx src/testing/qa-chaos.ts   (filter)
 *      RUNS=3 npx tsx src/testing/qa-chaos.ts              (multiple runs per persona)
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'node:fs';

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'testin@gmail.com';
const PASSWORD = 'tester123';
const NAME = 'Tester';

const PERSONA_MODEL = process.env.PERSONA_MODEL || 'claude-haiku-4-5-20251001';
const EVALUATOR_MODEL = process.env.EVALUATOR_MODEL || 'claude-sonnet-4-6';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============= API HELPERS =============

async function apiRegister(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'QA', email: EMAIL, password: PASSWORD }),
  });
  if (res.ok) { const data = await res.json() as any; return { token: data.tokens.accessToken, userId: data.user.id }; }
  if (res.status === 409) {
    const r = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const data = await r.json() as any;
    return { token: data.tokens.accessToken, userId: data.user.id };
  }
  throw new Error(`Register failed: ${res.status}`);
}

let AUTH_TOKEN = '';
let USER_ID = 0;

async function apiReset(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test-bot/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` }, body: '{}',
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}
async function apiSend(message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  return res.json();
}
async function apiTap(buttonId: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status}`);
  return res.json();
}
async function dbQuery(sql: string, params: any[] = []): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status}`);
  return ((await res.json() as any).rows || []);
}

function extractText(data: any): { text: string; buttons: Array<{ id: string; title: string }> } {
  const buttons: Array<{ id: string; title: string }> = [];
  const parts: string[] = [];
  for (const m of (data.messages || [])) {
    if (m.text) parts.push(m.text);
    if (m.interactive?.body) parts.push(m.interactive.body);
    if (m.interactive?.buttons) for (const b of m.interactive.buttons) buttons.push(b);
    if (m.interactive?.sections) for (const s of m.interactive.sections) for (const r of (s.rows || [])) buttons.push({ id: r.id, title: r.title });
  }
  return { text: parts.join('\n'), buttons };
}

// ============= PERSONAS =============

interface Persona {
  id: string;
  name: string;
  description: string;
  goal: string;
  styleRules: string;
  maxTurns: number;
  setup?: () => Promise<void>;     // optional pre-conversation seeding
  postCheck: () => Promise<{ goalAchieved: boolean; details: string }>;
}

async function seedFieldAndPlot(field: string, city: string, plot: string, hectares: number) {
  await apiSend(`agregar campo ${field}`);
  await apiTap('flow_field_loc_city');
  await apiSend(city);
  await apiTap('flow_confirm');
  await apiSend(`agregar lote ${plot} al campo ${field}`);
  await apiSend(String(hectares));
}

const PERSONAS: Persona[] = [
  {
    id: 'carlos',
    name: 'Carlos productor de maíz',
    description: 'Sos Carlos, productor de maíz en Pergamino. Tenés un campo "Don Aurelio" con un lote "11D" de 30 ha donde sembraste maíz. Hablás de manera informal pero correcta. A veces escribís nombres de lotes con espacios o variando mayúsculas (ej: "11d", "11 D", "11D"). NO usás emojis pero sí abreviaturas comunes (kg, ha, tn).',
    goal: 'Registrar la cosecha de maíz en el lote 11D con un rinde de 4500 kg/ha. Después confirmar que el rinde quedó cargado preguntando "promedio del 11D" o similar.',
    styleRules: 'Mensajes cortos, naturales. NO uses comandos formales tipo "/harvest". Hablá como un farmer en WhatsApp.',
    maxTurns: 12,
    setup: async () => {
      await apiReset();
      await seedFieldAndPlot('Don Aurelio', 'Pergamino', '11D', 30);
      // Sow first so harvest has something to close
      await apiSend('sembré maíz en el 11D');
    },
    postCheck: async () => {
      const rows = await dbQuery(
        `SELECT pc.yield_kg FROM plot_crops pc
         JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1 AND p.name='11D' AND pc.crop ILIKE 'maíz' ORDER BY pc.id DESC LIMIT 1`,
        [USER_ID],
      );
      const yieldKg = rows[0]?.yield_kg ? Number(rows[0].yield_kg) : 0;
      // Expected ~4500 kg/ha × 30 ha = 135.000 kg ± 10%
      const inRange = yieldKg >= 121500 && yieldKg <= 148500;
      return {
        goalAchieved: inRange,
        details: inRange ? `yield_kg=${yieldKg} (expected ~135000)` : `yield_kg=${yieldKg} (expected ~135000 ±10%)`,
      };
    },
  },
  {
    id: 'pedro',
    name: 'Pedro despistado',
    description: 'Sos Pedro, productor que no anota nada. Tenés un campo "La Rosa" con lote "1A" de 50 ha. Querés cargar 3 gastos del día pero no sos preciso, a veces te olvidás del lote, a veces saltás de tema, escribís con typos.',
    goal: 'Registrar los siguientes 3 gastos: gasoil $50.000 (campo La Rosa, no especifica lote), glifosato $200.000 con 100 lt en lote 1A, sueldos $300.000.',
    styleRules: 'Mensajes informales, con errores tipográficos ocasionales (ej: "compre", "fumige"). A veces te confundís de lote o mandás dos cosas en un mensaje.',
    maxTurns: 15,
    setup: async () => {
      await apiReset();
      await seedFieldAndPlot('La Rosa', 'Pergamino', '1A', 50);
    },
    postCheck: async () => {
      const expenses = await dbQuery(
        `SELECT amount, category FROM expenses WHERE user_id=$1 AND deleted_at IS NULL`,
        [USER_ID],
      );
      const total = expenses.reduce((s, e) => s + Number(e.amount), 0);
      // Goal: 3 expenses summing 550000
      const inRange = expenses.length >= 3 && total >= 495000 && total <= 605000;
      return {
        goalAchieved: inRange,
        details: `expenses=${expenses.length} total=$${total.toLocaleString('es-AR')} (expected 3 expenses ~$550000)`,
      };
    },
  },
  {
    id: 'lucia',
    name: 'Lucia pronombrera',
    description: 'Sos Lucia, querés probar pronombres y referencias implícitas. Tenés un campo "El Pedacito" con dos lotes "Norte" y "Sur" de 40 ha cada uno. Sos consciente de que el bot DEBERÍA mantener contexto entre mensajes.',
    goal: 'Sembrar soja en lote Norte. Después usar SOLO pronombres ("ahí", "ese lote", "el mismo") para preguntar info, agregar lluvia ahí, registrar una observación. NUNCA volver a nombrar el lote después de la primera mención.',
    styleRules: 'Mensajes cortos. Después de la primera mención, SIEMPRE referirte al lote como "ahí" o "ese lote" o "el mismo".',
    maxTurns: 14,
    setup: async () => {
      await apiReset();
      await apiSend('agregar campo El Pedacito');
      await apiTap('flow_field_loc_city');
      await apiSend('Pergamino');
      await apiTap('flow_confirm');
      await apiSend('agregar lote Norte al campo El Pedacito');
      await apiSend('40');
      await apiSend('agregar lote Sur al campo El Pedacito');
      await apiSend('40');
    },
    postCheck: async () => {
      const sown = await dbQuery(
        `SELECT pc.crop, p.name FROM plot_crops pc
         JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1 AND p.name='Norte' AND pc.crop ILIKE 'soja'`,
        [USER_ID],
      );
      const rain = await dbQuery(
        `SELECT r.* FROM rainfall r JOIN fields f ON f.id=r.field_id
         WHERE f.user_id=$1 AND r.deleted_at IS NULL`,
        [USER_ID],
      ).catch(() => []);
      const obs = await dbQuery(
        `SELECT o.id FROM agro_observations o JOIN plots p ON p.id=o.plot_id
         WHERE p.name='Norte' AND o.user_id=$1`,
        [USER_ID],
      ).catch(() => []);
      const sowOk = sown.length > 0;
      const rainOk = rain.length > 0;
      const obsOk = obs.length > 0;
      const score = [sowOk, rainOk, obsOk].filter(Boolean).length;
      return {
        goalAchieved: score >= 2,
        details: `sown=${sowOk} rain=${rainOk} obsOnNorte=${obsOk} score=${score}/3`,
      };
    },
  },
  {
    id: 'roberto',
    name: 'Roberto stock manager',
    description: 'Sos Roberto, manejás el stock del campo. Tenés un campo "El Robledal" con lote "C1" de 60 ha y un depósito "Galpón Central". Sos preciso con cantidades y precios.',
    goal: 'Comprar 500 lt de glifosato a $2000 c/u (carga al stock + crea gasto). Después fumigar el lote C1 con 2 lt/ha de glifosato. Confirmar consultando el stock.',
    styleRules: 'Mensajes técnicos, usás unidades correctas (lt, kg, ha). NO redondeás los números.',
    maxTurns: 14,
    setup: async () => {
      await apiReset();
      await seedFieldAndPlot('El Robledal', 'Pergamino', 'C1', 60);
      await apiSend('crear depósito Galpón Central en El Robledal');
    },
    postCheck: async () => {
      const items = await dbQuery(
        `SELECT si.current_quantity, si.unit FROM stock_items si
         JOIN warehouses w ON w.id=si.warehouse_id JOIN fields f ON f.id=w.field_id
         WHERE f.user_id=$1 AND si.name ILIKE '%glifosato%' AND si.deleted_at IS NULL`,
        [USER_ID],
      );
      const expense = await dbQuery(
        `SELECT amount FROM expenses WHERE user_id=$1 AND product ILIKE '%glifosato%' AND deleted_at IS NULL`,
        [USER_ID],
      );
      // After buying 500 and using 2*60=120, stock should be 380 lt
      const stockOk = items.length === 1 && Math.abs(Number(items[0].current_quantity) - 380) < 5;
      const expenseOk = expense.length === 1 && Math.abs(Number(expense[0].amount) - 1000000) < 10;
      return {
        goalAchieved: stockOk && expenseOk,
        details: `stock=${items[0]?.current_quantity}lt (expected 380) expense=$${expense[0]?.amount} (expected $1M)`,
      };
    },
  },
  {
    id: 'multi_campo',
    name: 'Multi-campo (dueño con 3 campos)',
    description: 'Sos un productor que tiene 3 campos: "Don Pedro" en Pergamino con lotes A1 (40ha), A2 (50ha), A3 (35ha); "La Esperanza" en Bragado con lotes Norte (60ha) y Sur (45ha); "El Pedacito" en Tandil con lotes 1B (20ha) y 1C (30ha). Querés navegar entre los 3 campos, comparar info, hacer queries cruzadas. Sos preciso pero a veces te confundís de campo cuando preguntás.',
    goal: 'Listar tus campos y lotes; preguntar info de algún lote; preguntar cuántas hectáreas tenés en total; consultar cultivos activos en uno de los 3 campos.',
    styleRules: 'Mensajes cortos. Mezclás referencias a distintos campos en la misma sesión. NO repetís el contexto cada vez (asumís que el bot recuerda).',
    maxTurns: 14,
    setup: async () => {
      await apiReset();
      await seedFieldAndPlot('Don Pedro', 'Pergamino', 'A1', 40);
      await apiSend('agregar lote A2 al campo Don Pedro');
      await apiSend('50');
      await apiSend('agregar lote A3 al campo Don Pedro');
      await apiSend('35');
      await seedFieldAndPlot('La Esperanza', 'Bragado', 'Norte', 60);
      await apiSend('agregar lote Sur al campo La Esperanza');
      await apiSend('45');
      await seedFieldAndPlot('El Pedacito', 'Tandil', '1B', 20);
      await apiSend('agregar lote 1C al campo El Pedacito');
      await apiSend('30');
    },
    postCheck: async () => {
      const fields = await dbQuery(
        `SELECT COUNT(*)::int AS n FROM fields WHERE user_id=$1 AND deleted_at IS NULL`, [USER_ID],
      );
      const plots = await dbQuery(
        `SELECT COUNT(*)::int AS n FROM plots p JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1 AND p.deleted_at IS NULL AND f.deleted_at IS NULL`, [USER_ID],
      );
      const fc = Number(fields[0]?.n || 0);
      const pc = Number(plots[0]?.n || 0);
      const ok = fc === 3 && pc === 7;
      return {
        goalAchieved: ok,
        details: `fields=${fc} (expected 3) plots=${pc} (expected 7)`,
      };
    },
  },
  {
    id: 'ganadero',
    name: 'Ganadero hardcore',
    description: 'Sos un ganadero que maneja hacienda en un campo "Estancia La Recreación" con 2 lotes "Potrero 1" (80ha) y "Potrero 2" (90ha). Hablás con vocabulario ganadero (vaca, novillo, vaquillona, ternero, toro). Sos meticuloso con números.',
    goal: 'Agregar 80 vacas Angus al Potrero 1, transferir 30 al Potrero 2, registrar 5 nacimientos en Potrero 2, vender 10 vacas del Potrero 1, consultar el inventario actual.',
    styleRules: 'Frases cortas, técnicas. Usás términos correctos. NO mezclás con agro (no sembrás, no fumigás).',
    maxTurns: 16,
    setup: async () => {
      await apiReset();
      await seedFieldAndPlot('Estancia La Recreación', 'Tandil', 'Potrero 1', 80);
      await apiSend('agregar lote Potrero 2 al campo Estancia La Recreación');
      await apiSend('90');
    },
    postCheck: async () => {
      const groups = await dbQuery(
        `SELECT lg.category, lg.count, p.name FROM livestock_groups lg
         JOIN plots p ON p.id = lg.plot_id JOIN fields f ON f.id = p.field_id
         WHERE f.user_id = $1`, [USER_ID],
      );
      const totalVacas = groups.filter(g => /vaca/i.test(g.category)).reduce((s, g) => s + Number(g.count), 0);
      // Started 80, +5 nacieron, -10 vendidas = 75; transferred so split 50/30 + 5 in P2 = 50/35 = 85? Hmm.
      // Actual: +80, -10 sold, +5 born = 75. Allow ±5 for variance.
      const ok = totalVacas >= 65 && totalVacas <= 85;
      return {
        goalAchieved: ok,
        details: `total_vacas=${totalVacas} (expected ~75) groups=${groups.length}`,
      };
    },
  },
  {
    id: 'contador',
    name: 'Contador (query-heavy)',
    description: 'Sos el contador del campo "El Algarrobo" en Pergamino con lotes "Sur" (100ha) y "Norte" (80ha). Tu rol es consultar y reportar: queres ver gastos, ingresos, comparar meses, exportar CSV. Estás interesado en NÚMEROS, no en operaciones agro.',
    goal: 'Cargar gastos diversos en distintos lotes (3 gastos por $200k cada uno), pedir resumen mensual, pedir resumen por campo, pedir reporte financiero.',
    styleRules: 'Lenguaje formal. Pedís reportes específicos. Citás categorías concretas (combustible, sueldos, agroquímicos).',
    maxTurns: 14,
    setup: async () => {
      await apiReset();
      await seedFieldAndPlot('El Algarrobo', 'Pergamino', 'Sur', 100);
      await apiSend('agregar lote Norte al campo El Algarrobo');
      await apiSend('80');
    },
    postCheck: async () => {
      const expenses = await dbQuery(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total
         FROM expenses WHERE user_id=$1 AND deleted_at IS NULL`, [USER_ID],
      );
      const n = Number(expenses[0]?.n || 0);
      const total = Number(expenses[0]?.total || 0);
      const ok = n >= 3 && total >= 500000;
      return {
        goalAchieved: ok,
        details: `expenses=${n} total=$${total.toLocaleString('es-AR')} (expected ≥3 ≥$500k)`,
      };
    },
  },
  {
    id: 'mixto',
    name: 'Productor mixto (agro + ganadero)',
    description: 'Sos un productor mixto en "La Querencia" en Pergamino con un lote "1A" (50ha) que tiene tanto siembra como hacienda. Manejás ambos worlds en el mismo lote.',
    goal: 'En el lote 1A: sembrar soja, agregar 30 vacas, registrar 25mm de lluvia, fumigar con glifosato, consultar el estado del lote.',
    styleRules: 'Mensajes cortos, prácticos. Saltás entre temas (siembra → hacienda → lluvia) sin avisar.',
    maxTurns: 14,
    setup: async () => {
      await apiReset();
      await seedFieldAndPlot('La Querencia', 'Pergamino', '1A', 50);
    },
    postCheck: async () => {
      const sown = await dbQuery(
        `SELECT pc.crop FROM plot_crops pc JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1 AND pc.crop ILIKE 'soja'`, [USER_ID],
      );
      const livestock = await dbQuery(
        `SELECT lg.count FROM livestock_groups lg JOIN plots p ON p.id=lg.plot_id JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1`, [USER_ID],
      );
      const rain = await dbQuery(
        `SELECT COUNT(*)::int AS n FROM rainfall r JOIN fields f ON f.id=r.field_id
         WHERE f.user_id=$1 AND r.deleted_at IS NULL`, [USER_ID],
      ).catch(() => [{ n: 0 }]);
      const sprayCount = await dbQuery(
        `SELECT COUNT(*)::int AS n FROM domain_events de JOIN plots p ON p.id=de.plot_id JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1 AND de.event_type='spraying'`, [USER_ID],
      );
      const sownOk = sown.length > 0;
      const livestockOk = livestock.length > 0 && livestock.reduce((s, l) => s + Number(l.count), 0) >= 25;
      const rainOk = Number(rain[0]?.n || 0) > 0;
      const sprayOk = Number(sprayCount[0]?.n || 0) > 0;
      const score = [sownOk, livestockOk, rainOk, sprayOk].filter(Boolean).length;
      return {
        goalAchieved: score >= 3,
        details: `sown=${sownOk} livestock=${livestockOk} rain=${rainOk} spray=${sprayOk} score=${score}/4`,
      };
    },
  },
  {
    id: 'despistado',
    name: 'Despistado mobile (typos masivos)',
    description: 'Estás escribiendo desde un celular en el campo, con typos masivos, abreviaturas, frases cortadas. Tenés un campo "Don Cosme" con lote "1A" (40ha). Igual queres que te entienda.',
    goal: 'Cargar un gasto de combustible $80.000, registrar siembra de soja en 1A, consultar el lote.',
    styleRules: 'Typos en cada mensaje (ej: "compre gsoil 80mil", "smbre soja en 1a"). Abreviaturas como "x" por "por", "tmb" por "también". Sin tildes.',
    maxTurns: 14,
    setup: async () => {
      await apiReset();
      await seedFieldAndPlot('Don Cosme', 'Pergamino', '1A', 40);
    },
    postCheck: async () => {
      const expenses = await dbQuery(
        `SELECT COUNT(*)::int AS n FROM expenses WHERE user_id=$1 AND deleted_at IS NULL AND category ILIKE '%combustible%'`,
        [USER_ID],
      );
      const sown = await dbQuery(
        `SELECT COUNT(*)::int AS n FROM plot_crops pc JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id
         WHERE f.user_id=$1 AND pc.crop ILIKE 'soja'`, [USER_ID],
      );
      const expOk = Number(expenses[0]?.n || 0) > 0;
      const sownOk = Number(sown[0]?.n || 0) > 0;
      return {
        goalAchieved: expOk && sownOk,
        details: `expense_combustible=${expOk} soja_sown=${sownOk}`,
      };
    },
  },
  {
    id: 'adversario',
    name: 'Adversario / breaker',
    description: 'Sos un usuario molesto que está intentando romper el bot. Cambiás de tema, escribís con typos extremos, mezclás idiomas, contradecís cosas que dijiste antes, mandás mensajes ambiguos. Tenés un campo "Test" con lote "X1" de 25 ha.',
    goal: 'Provocar comportamiento extraño en el bot: respuestas vacías, errores, contradicciones. Tu objetivo es que el evaluator detecte fallas, NO completar tareas.',
    styleRules: 'Mensajes con typos masivos, abreviaturas raras ("pq", "tmb", "x"), preguntas ambiguas, referencias vagas. Hacé que cada mensaje sea ligeramente raro.',
    maxTurns: 18,
    setup: async () => {
      await apiReset();
      await seedFieldAndPlot('Test', 'Pergamino', 'X1', 25);
    },
    postCheck: async () => {
      // Adversario "passes" if no DB corruption happened — for simplicity we
      // check that no negative stock, no orphan rows, etc.
      const negStock = await dbQuery(
        `SELECT COUNT(*)::int AS n FROM stock_items si
         JOIN warehouses w ON w.id=si.warehouse_id JOIN fields f ON f.id=w.field_id
         WHERE f.user_id=$1 AND si.current_quantity < 0`,
        [USER_ID],
      );
      const orphanCount = Number(negStock[0]?.n || 0);
      return {
        goalAchieved: orphanCount === 0,
        details: `negative_stock_rows=${orphanCount} (expected 0)`,
      };
    },
  },
];

// ============= CONVERSATION RUNNER =============

interface ConvTurn { role: 'persona' | 'bot' | 'tap'; text: string }
interface RunResult {
  persona_id: string;
  persona_name: string;
  goal: string;
  conversation: ConvTurn[];
  goal_achieved: boolean;
  goal_details: string;
  red_flags: string[];
  evaluator_score: number;       // 0-10
  evaluator_summary: string;
  status: 'PASS' | 'WARN' | 'FAIL';
}

/**
 * Step the persona LLM forward — given the conversation so far, what does
 * the persona say next?
 */
async function personaStep(persona: Persona, convo: ConvTurn[]): Promise<string> {
  const lines: string[] = [];
  for (const t of convo) {
    if (t.role === 'persona') lines.push(`Vos: ${t.text}`);
    else if (t.role === 'bot') lines.push(`Bot: ${t.text}`);
  }
  const recent = lines.slice(-20).join('\n');

  const systemPrompt = `${persona.description}

OBJETIVO: ${persona.goal}

ESTILO: ${persona.styleRules}

REGLAS:
- Generás SÓLO el siguiente mensaje del usuario. NO incluyas el prefijo "Vos:" ni nada que no sea el mensaje.
- Si lograste el objetivo o no podés avanzar más, respondé exactamente "__END__".
- Cada mensaje debe ser corto (máximo 100 palabras).
- NO inventes lotes/campos que no te dije que existen.`;

  const resp = await anthropic.messages.create({
    model: PERSONA_MODEL,
    max_tokens: 200,
    system: systemPrompt,
    messages: [
      { role: 'user', content: `Conversación hasta ahora:\n${recent || '(vacío — es tu primer mensaje)'}\n\n¿Cuál es tu próximo mensaje?` },
    ],
  });
  const content = resp.content.find(c => c.type === 'text');
  return content && content.type === 'text' ? content.text.trim() : '__END__';
}

/**
 * Score the conversation with a stronger model. Outputs JSON with score (0-10),
 * red_flags (list of strings), and a one-sentence summary.
 */
async function evaluate(persona: Persona, convo: ConvTurn[], goalAchieved: boolean, goalDetails: string): Promise<{ score: number; red_flags: string[]; summary: string }> {
  const transcript = convo.map(t => {
    if (t.role === 'persona') return `Usuario: ${t.text}`;
    if (t.role === 'tap') return `Usuario: [tap "${t.text}"]`;
    return `Bot: ${t.text}`;
  }).join('\n\n');

  const sys = `Sos un evaluator estricto de conversaciones agente-usuario. Evaluás la calidad UX de una conversación entre un usuario simulado (persona) y un bot WhatsApp/Telegram para productores agropecuarios.

Devolvé EXCLUSIVAMENTE un JSON con esta forma exacta (sin texto antes/después):
{
  "score": <número 0-10>,
  "red_flags": [<lista de strings cortos describiendo problemas concretos detectados>],
  "summary": "<una oración resumiendo cómo fue la conversación>"
}

Red flags a buscar:
- Respuestas vacías del bot
- Bot que pregunta lo mismo varias veces
- Bot que pierde el contexto del lote/campo (responde sobre otro lote)
- Loops o crashes ("Error interno", "no encontré" cuando claramente debería encontrar)
- Información incorrecta (números mal calculados, fechas raras, etc.)
- Bot que ignora el filtro de lote en consultas
- Pronombres ("ahí", "ese lote") mal resueltos
- Mensajes confusos o demasiado verbosos del bot

Score:
- 9-10: Conversación fluida, sin friction, objetivo logrado
- 7-8: Algún round extra pero objetivo logrado
- 5-6: Logró el objetivo pero con friction notable
- 3-4: Friction grave, objetivo parcialmente logrado
- 0-2: Bot rompe, no responde, o falla en hacer la tarea`;

  const userMsg = `Persona: ${persona.name}
Objetivo de la persona: ${persona.goal}
Resultado objetivo (verificado en DB): ${goalAchieved ? '✅ logrado' : '❌ no logrado'} — ${goalDetails}

Conversación:
${transcript}

Devolvé el JSON.`;

  const resp = await anthropic.messages.create({
    model: EVALUATOR_MODEL,
    max_tokens: 800,
    system: sys,
    messages: [{ role: 'user', content: userMsg }],
  });
  const content = resp.content.find(c => c.type === 'text');
  const text = content && content.type === 'text' ? content.text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { score: 0, red_flags: ['evaluator_failed_to_return_json'], summary: 'Evaluator returned non-JSON output.' };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: Number(parsed.score) || 0,
      red_flags: Array.isArray(parsed.red_flags) ? parsed.red_flags : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    };
  } catch {
    return { score: 0, red_flags: ['evaluator_json_parse_error'], summary: text.substring(0, 200) };
  }
}

async function runPersona(persona: Persona): Promise<RunResult> {
  console.log(`\n  --- ${persona.id}: ${persona.name} ---`);
  if (persona.setup) {
    try { await persona.setup(); }
    catch (e: any) {
      console.log(`    [SETUP FAILED] ${e.message}`);
    }
  }

  const convo: ConvTurn[] = [];

  for (let turn = 0; turn < persona.maxTurns; turn++) {
    let next: string;
    try { next = await personaStep(persona, convo); }
    catch (e: any) {
      console.log(`    persona LLM failed: ${e.message}`);
      break;
    }
    if (!next || next === '__END__' || /^_+END_+$/i.test(next)) {
      console.log(`    [persona ended at turn ${turn}]`);
      break;
    }
    console.log(`    👤 ${next.substring(0, 80)}${next.length > 80 ? '...' : ''}`);
    convo.push({ role: 'persona', text: next });

    let botResp: { text: string; buttons: Array<{ id: string; title: string }> };
    try { botResp = extractText(await apiSend(next)); }
    catch (e: any) {
      console.log(`    [bot send error] ${e.message}`);
      convo.push({ role: 'bot', text: `[ERROR: ${e.message}]` });
      break;
    }
    const botSummary = botResp.text.substring(0, 80).replace(/\n/g, ' ');
    console.log(`    🤖 ${botSummary}${botResp.text.length > 80 ? '...' : ''}`);
    convo.push({ role: 'bot', text: botResp.text + (botResp.buttons.length ? `\n[buttons: ${botResp.buttons.map(b => b.id).join(', ')}]` : '') });

    // Auto-tap confirm_pending if surfaced (otherwise persona has to know to tap)
    const confirmBtn = botResp.buttons.find(b => b.id === 'confirm_pending');
    if (confirmBtn) {
      try {
        const tapResp = extractText(await apiTap('confirm_pending'));
        console.log(`    [auto-tap confirm_pending] ${tapResp.text.substring(0, 60).replace(/\n/g, ' ')}...`);
        convo.push({ role: 'tap', text: 'confirm_pending' });
        convo.push({ role: 'bot', text: tapResp.text });
      } catch { /* ignore */ }
    }
  }

  // Post-conversation goal check
  let goalAchieved = false;
  let goalDetails = 'check failed';
  try {
    const check = await persona.postCheck();
    goalAchieved = check.goalAchieved;
    goalDetails = check.details;
  } catch (e: any) {
    goalDetails = `postCheck error: ${e.message}`;
  }

  // Evaluator
  console.log('    [evaluating...]');
  let evalResult = { score: 0, red_flags: ['evaluator_skipped'] as string[], summary: '' };
  try { evalResult = await evaluate(persona, convo, goalAchieved, goalDetails); }
  catch (e: any) {
    evalResult = { score: 0, red_flags: [`evaluator_error: ${e.message}`], summary: '' };
  }

  let status: 'PASS' | 'WARN' | 'FAIL';
  if (goalAchieved && evalResult.score >= 8) status = 'PASS';
  else if (goalAchieved && evalResult.score >= 5) status = 'WARN';
  else if (!goalAchieved && evalResult.score >= 7) status = 'WARN';
  else status = 'FAIL';

  console.log(`    [${status}] score=${evalResult.score}/10 goal=${goalAchieved ? '✅' : '❌'} flags=${evalResult.red_flags.length}`);
  if (evalResult.red_flags.length > 0) {
    console.log(`         red_flags: ${evalResult.red_flags.slice(0, 3).join(' | ')}`);
  }

  return {
    persona_id: persona.id,
    persona_name: persona.name,
    goal: persona.goal,
    conversation: convo,
    goal_achieved: goalAchieved,
    goal_details: goalDetails,
    red_flags: evalResult.red_flags,
    evaluator_score: evalResult.score,
    evaluator_summary: evalResult.summary,
    status,
  };
}

// ============= MAIN =============

async function main() {
  console.log('\n=======================================================');
  console.log('  QA CHAOS -- multi-persona conversation fuzzer');
  console.log('=======================================================\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('  ANTHROPIC_API_KEY not set. Export it before running.');
    process.exit(1);
  }

  const { token, userId } = await apiRegister();
  AUTH_TOKEN = token; USER_ID = userId;
  console.log(`  Auth OK (userId=${userId})`);
  await dbQuery(`UPDATE users SET plan_id = 4 WHERE id = $1`, [userId]);
  console.log('  Upgraded to enterprise plan\n');

  const onlyEnv = (process.env.ONLY || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const personas = onlyEnv.length > 0 ? PERSONAS.filter(p => onlyEnv.includes(p.id)) : PERSONAS;
  const runs = parseInt(process.env.RUNS || '1', 10);

  console.log(`  Personas: ${personas.map(p => p.id).join(', ')} | runs/persona: ${runs}`);
  console.log(`  Models: persona=${PERSONA_MODEL} evaluator=${EVALUATOR_MODEL}\n`);

  const results: RunResult[] = [];
  let lastAuthRefresh = Date.now();
  for (const p of personas) {
    for (let i = 0; i < runs; i++) {
      // Re-auth every ~10 min to avoid JWT expiry on multi-persona runs
      // (default JWT TTL is ~15 min and the LAST persona of 5x5 was getting
      // 401s consistently — refresh threshold needs to be well under TTL).
      if (Date.now() - lastAuthRefresh > 10 * 60 * 1000) {
        const fresh = await apiRegister();
        AUTH_TOKEN = fresh.token;
        lastAuthRefresh = Date.now();
        console.log('  [auth refreshed]');
      }
      const r = await runPersona(p);
      results.push(r);
    }
  }

  // Summary
  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;

  console.log('\n=======================================================');
  console.log(`  RESULTS: ${pass} PASS | ${warn} WARN | ${fail} FAIL  (${results.length} runs)`);
  console.log('=======================================================\n');

  if (fail > 0) {
    console.log('  FAILURES:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`    [${r.persona_id}] score=${r.evaluator_score}/10 goal=${r.goal_achieved ? '✅' : '❌'}`);
      console.log(`      ${r.evaluator_summary}`);
      if (r.red_flags.length > 0) console.log(`      flags: ${r.red_flags.slice(0, 4).join(' | ')}`);
    }
    console.log('');
  }
  if (warn > 0) {
    console.log('  WARNINGS:');
    for (const r of results.filter(r => r.status === 'WARN')) {
      console.log(`    [${r.persona_id}] score=${r.evaluator_score}/10`);
      if (r.red_flags.length > 0) console.log(`      flags: ${r.red_flags.slice(0, 3).join(' | ')}`);
    }
    console.log('');
  }

  // Aggregate red flags
  const flagCounts = new Map<string, number>();
  for (const r of results) for (const f of r.red_flags) flagCounts.set(f, (flagCounts.get(f) || 0) + 1);
  if (flagCounts.size > 0) {
    console.log('  TOP RED FLAGS:');
    for (const [flag, count] of [...flagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    ×${count}: ${flag}`);
    }
    console.log('');
  }

  const outPath = 'src/testing/qa-chaos-results.json';
  writeFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), models: { persona: PERSONA_MODEL, evaluator: EVALUATOR_MODEL }, pass, warn, fail, total: results.length, results }, null, 2));
  console.log(`  Results written to ${outPath}\n`);

  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
