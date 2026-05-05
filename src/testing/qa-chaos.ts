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
  for (const p of personas) {
    for (let i = 0; i < runs; i++) {
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
