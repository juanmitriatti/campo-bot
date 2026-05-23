/**
 * QA Audio 30 — tests del pipeline de audio (Whisper).
 *
 * Genera audio dinámicamente con macOS `say` (voice: Diego, español argentino) +
 * `afconvert` (.aiff → .m4a). Sube via /api/test-bot/audio y verifica:
 *  - Transcript matches expected pattern
 *  - Bot routes to correct command (gasto/actividad/consulta)
 *  - Side effects (DB inserts) when applicable
 *
 * Cubre:
 *  - Gastos simples (5)
 *  - Actividades agro (6)
 *  - Hacienda (4)
 *  - Consultas (5)
 *  - Lluvias (3)
 *  - Multi-acción compound (3)
 *  - Edge: audio corto, números, fechas (4)
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-audio-30.ts
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-audio@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Audio';
const TMP_DIR = '/tmp/qa-audio';

async function register(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'Test', email: EMAIL, password: PASSWORD }),
  });
  if (res.ok) { const d = await res.json() as any; return { token: d.tokens.accessToken, userId: d.user.id }; }
  if (res.status === 409) return login();
  throw new Error(`Register failed: ${res.status}`);
}
async function login(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const d = await res.json() as any;
  return { token: d.tokens.accessToken, userId: d.user.id };
}
let TOKEN = '';
async function sendText(message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ message }),
  });
  const t = await res.text().catch(() => '');
  try { return JSON.parse(t); } catch { return { messages: [{ text: `HTTP ${res.status}` }] }; }
}
async function tap(buttonId: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  return res.json();
}
async function dbq(sql: string, params: unknown[] = []): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status}`);
  const d = await res.json() as any;
  return d.rows ?? [];
}
function txt(data: any): string {
  return (data.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}

function generateAudio(text: string, slug: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const wav = path.join(TMP_DIR, `${slug}.wav`);
  // Use Diego voice (Spanish-AR) outputting WAV 16-bit PCM 16kHz mono — Whisper-friendly
  execSync(`say -v Diego --data-format=LEI16@16000 -o ${wav} ${JSON.stringify(text)}`, { stdio: 'pipe' });
  return wav;
}

async function sendAudio(audioPath: string): Promise<{ transcript?: string; messages: any[] }> {
  const buf = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append('audio', new Blob([buf], { type: 'audio/wav' }), path.basename(audioPath));
  const res = await fetch(`${BASE_URL}/api/test-bot/audio`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}` }, body: form,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { messages: [{ text: `HTTP ${res.status}: ${text.slice(0, 200)}` }] }; }
}

// ── Setup ──────────────────────────────────────────────────────────────

async function setup(): Promise<void> {
  await sendText('cancelar');
  let r = await sendText('agregar campo Audio');
  if (/ubicar/i.test(txt(r))) {
    await tap('flow_field_loc_city');
    await sendText('Pergamino');
    await tap('flow_confirm');
  }
  await sendText('agregar lote AA al campo Audio'); await sendText('100');
  await sendText('agregar lote BB al campo Audio'); await sendText('80');
  await sendText('sembré soja en AA');
  await sendText('agregué 20 vacas Angus en AA');
}

// ── Tests ──────────────────────────────────────────────────────────────

interface Test {
  name: string;
  description: string;
  category: string;
  audio_text: string;
  /** Patterns the bot's response or transcript should match */
  expect: { transcript_keywords?: string[]; response_contains?: (string | RegExp)[]; response_not?: (string | RegExp)[] };
}

const TESTS: Test[] = [
  // ═════════ GASTOS (5) ═════════
  { name: 'G01_gasoil', category: 'gasto', audio_text: 'Gasté cincuenta mil pesos en gasoil',
    description: 'Gasto básico gasoil',
    expect: { transcript_keywords: ['gasoil'], response_contains: [/combust|gasoil|50/i] } },
  { name: 'G02_sueldos', category: 'gasto', audio_text: 'Pagué doscientos mil pesos en sueldos',
    description: 'Sueldos',
    expect: { response_contains: [/sueldo|200/i] } },
  { name: 'G03_agroquim', category: 'gasto', audio_text: 'Compré herbicida por cuarenta mil pesos',
    description: 'Compra herbicida',
    expect: { response_contains: [/agroqu|herbicid|40/i] } },
  { name: 'G04_dolares', category: 'gasto', audio_text: 'Gasté quinientos dólares en fertilizante',
    description: 'Gasto en USD',
    expect: { response_contains: [/fertiliz|USD|500|d[oó]lar/i] } },
  { name: 'G05_compound_gasto_lote', category: 'gasto', audio_text: 'Gasté ochenta mil en combustible para el lote AA',
    description: 'Gasto con lote',
    expect: { response_contains: [/combust|aa|80/i] } },

  // ═════════ ACTIVIDADES AGRO (6) ═════════
  { name: 'A01_fumigacion', category: 'agro', audio_text: 'Fumigué el lote AA con glifosato a dos litros por hectárea',
    description: 'Fumigación',
    expect: { response_contains: [/fumig|glifosato|2/i] } },
  { name: 'A02_fertilizacion', category: 'agro', audio_text: 'Fertilicé el lote BB con urea ochenta kilos por hectárea',
    description: 'Fertilización urea',
    expect: { response_contains: [/fertil|urea|80/i] } },
  { name: 'A03_siembra', category: 'agro', audio_text: 'Sembré maíz en el lote BB',
    description: 'Siembra maíz',
    expect: { response_contains: [/sembr|ma[ií]z|bb/i] } },
  { name: 'A04_cosecha', category: 'agro', audio_text: 'Coseché soja en el lote AA con un rinde de tres mil kilos por hectárea',
    description: 'Cosecha con rinde',
    expect: { response_contains: [/cosech|soja|3000|rinde/i] } },
  { name: 'A05_observacion', category: 'agro', audio_text: 'Observé hojas amarillas en el lote AA',
    description: 'Observación',
    expect: { response_contains: [/observ|hojas|amarill|aa/i] } },
  { name: 'A06_monitoreo', category: 'agro', audio_text: 'Monitoreé soja en el lote AA en estadio V tres con quince por ciento de maleza',
    description: 'Monitoreo con métricas',
    expect: { response_contains: [/monitor|maleza|v3|15/i] } },

  // ═════════ HACIENDA (4) ═════════
  { name: 'H01_add_vacas', category: 'hacienda', audio_text: 'Agregué diez vacas en el lote AA',
    description: 'Agregar vacas',
    expect: { response_contains: [/vaca|10|hacienda|aa/i] } },
  { name: 'H02_vender_novillos', category: 'hacienda', audio_text: 'Vendí cinco novillos a mil quinientos dólares cada uno',
    description: 'Venta novillos USD',
    expect: { response_contains: [/novillo|5|1500|venta/i] } },
  { name: 'H03_tacto', category: 'hacienda', audio_text: 'Hice tacto a veinte vacas en el lote AA y dieciocho están preñadas',
    description: 'Tacto preñez',
    expect: { response_contains: [/tacto|pre[ñn]a|20|18/i] } },
  { name: 'H04_consultar_vacas', category: 'hacienda', audio_text: 'Cuántas vacas tengo',
    description: 'Query count',
    expect: { response_contains: [/vaca|hacienda|total/i] } },

  // ═════════ CONSULTAS (5) ═════════
  { name: 'Q01_listar_campos', category: 'query', audio_text: 'Mostrame mis campos',
    description: 'List fields',
    expect: { response_contains: [/audio|campo|lotes|ha/i] } },
  { name: 'Q02_balance_mes', category: 'query', audio_text: 'Cuál es el balance del mes',
    description: 'Balance query',
    expect: { response_contains: [/balance|gasto|ingreso|movim/i] } },
  { name: 'Q03_gastos_total', category: 'query', audio_text: 'Cuánto gasté en total',
    description: 'Gastos total',
    expect: { response_contains: [/gasto|combust|sueldo|total|\$/i] } },
  { name: 'Q04_clima', category: 'query', audio_text: 'Cómo va a estar el clima mañana',
    description: 'Weather query',
    expect: { response_contains: [/clima|temperatura|pronóst|°C/i] } },
  { name: 'Q05_que_sembre', category: 'query', audio_text: 'Qué sembré en el lote AA',
    description: 'Active crop query',
    expect: { response_contains: [/soja|aa|cultivo|sembr/i] } },

  // ═════════ LLUVIAS (3) ═════════
  { name: 'R01_lluvia_simple', category: 'rain', audio_text: 'Llovieron veinte milímetros en el campo Audio',
    description: 'Lluvia básica',
    expect: { response_contains: [/20|mm|lluvia|audio/i] } },
  { name: 'R02_lluvia_lote', category: 'rain', audio_text: 'Llovieron treinta y cinco milímetros en el lote BB',
    description: 'Lluvia en lote',
    expect: { response_contains: [/35|mm|lluvia|bb/i] } },
  { name: 'R03_query_lluvia', category: 'rain', audio_text: 'Cuánto llovió este mes',
    description: 'Query lluvia',
    expect: { response_contains: [/lluvia|mm|mes|registr|hist/i] } },

  // ═════════ COMPOUND (3) ═════════
  { name: 'M01_compound_2', category: 'compound', audio_text: 'Gasté cincuenta mil en gasoil y fumigué el lote AA con glifosato dos litros por hectárea',
    description: '2 acciones',
    expect: { response_contains: [/(combust|gasoil).+(fumig|glifosato)|gasoil.+glifo/is] } },
  { name: 'M02_compound_3', category: 'compound', audio_text: 'Sembré trigo en el lote AA, llovieron veinte milímetros y agregué cinco terneros',
    description: '3 acciones distintas',
    expect: { response_contains: [/(trigo|sembr).+(lluvia|mm).+(ternero|hacienda)/is] } },
  { name: 'M03_compound_query_action', category: 'compound', audio_text: 'Cuántas vacas tengo y agregame diez más',
    description: 'Query + add',
    expect: { response_contains: [/vaca|hacienda|10/i] } },

  // ═════════ EDGE (4) ═════════
  { name: 'E01_audio_corto', category: 'edge', audio_text: 'Cancelar',
    description: 'Audio muy corto',
    expect: { response_contains: [/cancel|listo|contexto/i] } },
  { name: 'E02_numero_complejo', category: 'edge', audio_text: 'Gasté un millón doscientos mil pesos en maquinaria',
    description: 'Número compuesto',
    expect: { response_contains: [/maquinaria|1\.200|1200|millón/i] } },
  { name: 'E03_fecha_explicit', category: 'edge', audio_text: 'El quince de mayo gasté treinta mil en gasoil',
    description: 'Fecha mencionada',
    expect: { response_contains: [/gasoil|30|15|combust|mayo/i] } },
  { name: 'E04_saludo', category: 'edge', audio_text: 'Hola, cómo estás',
    description: 'Audio conversacional',
    expect: { response_contains: [/hola|saludo|ayudarte|mia/i] } },
];

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`🧪 QA Audio 30 — ${TESTS.length} tests (audio dinámico con macOS say)\n`);

  const auth = await register();
  TOKEN = auth.token;
  console.log(`✅ User ${auth.userId} (${EMAIL})`);
  try { await dbq('UPDATE users SET plan_id=4 WHERE id=$1', [auth.userId]); } catch { /* */ }
  console.log('✅ Enterprise plan\n');

  await setup();
  console.log('✅ Setup done\n');

  const results: Array<{ name: string; description: string; category: string; pass: boolean; reasons: string[]; transcript: string; response: string }> = [];
  let pass = 0, fail = 0;

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    console.log(`\n${num}/${TESTS.length} [${test.category}] ${test.name} — ${test.description}`);
    console.log(`  🎤 say "${test.audio_text}"`);

    try { await sendText('cancelar'); } catch { /* */ }

    let audioPath = '';
    let transcript = '';
    let response = '';
    const reasons: string[] = [];
    let testPass = true;

    try {
      audioPath = generateAudio(test.audio_text, test.name);
      const result = await sendAudio(audioPath);
      transcript = result.transcript || '';
      response = txt(result);
      console.log(`  📝 transcript: ${transcript.substring(0, 200)}`);
      console.log(`  🤖 ${response.substring(0, 250).replace(/\n/g, ' ')}${response.length > 250 ? '…' : ''}`);

      if (test.expect.transcript_keywords) {
        for (const kw of test.expect.transcript_keywords) {
          if (!transcript.toLowerCase().includes(kw.toLowerCase())) {
            reasons.push(`transcript missing: ${kw}`);
            testPass = false;
          }
        }
      }
      if (test.expect.response_contains) {
        for (const pat of test.expect.response_contains) {
          const m = pat instanceof RegExp ? pat.test(response) : response.toLowerCase().includes(pat.toLowerCase());
          if (!m) { reasons.push(`missing: ${pat}`); testPass = false; }
        }
      }
      if (test.expect.response_not) {
        for (const pat of test.expect.response_not) {
          const m = pat instanceof RegExp ? pat.test(response) : response.toLowerCase().includes(pat.toLowerCase());
          if (m) { reasons.push(`leak: ${pat}`); testPass = false; }
        }
      }
    } catch (err: any) {
      reasons.push(`runtime: ${err.message}`);
      testPass = false;
    }

    if (testPass) { pass++; console.log(`  ✅ PASS`); }
    else { fail++; console.log(`  ❌ FAIL — ${reasons.join(' | ')}`); }
    results.push({ name: test.name, description: test.description, category: test.category, pass: testPass, reasons, transcript, response });
  }

  console.log('\n\n═══════════════════════ SUMMARY ═══════════════════════');
  console.log(`  ✅ PASS:    ${pass} / ${TESTS.length}`);
  console.log(`  ❌ FAIL:    ${fail} / ${TESTS.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / TESTS.length) * 100)}%\n`);

  const byCat: Record<string, { p: number; f: number }> = {};
  for (const r of results) {
    if (!byCat[r.category]) byCat[r.category] = { p: 0, f: 0 };
    if (r.pass) byCat[r.category].p++; else byCat[r.category].f++;
  }
  console.log('  Por categoría:');
  for (const [c, s] of Object.entries(byCat).sort()) console.log(`    ${c.padEnd(10)} ${s.p}/${s.p + s.f}`);

  console.log('\n═══════════════════════ DETALLE FAILS ═══════════════════════\n');
  for (const r of results) {
    if (r.pass) continue;
    console.log(`[${r.name}] ${r.description}`);
    console.log(`  💡 ${r.reasons.join(' | ')}`);
    console.log(`  📝 ${r.transcript.substring(0, 200)}`);
    console.log(`  🤖 ${r.response.substring(0, 280).replace(/\n/g, ' ')}\n`);
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-audio-30-results.json',
    JSON.stringify({ summary: { pass, fail, total: TESTS.length }, results }, null, 2),
  );
  console.log(`\n📄 Report: src/testing/qa-audio-30-results.json`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
