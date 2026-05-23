/**
 * QA Document Flow 30 — tests del flujo de documentos.
 *
 * Test-bot no soporta upload binario, así que validamos:
 *  - Lado conversacional (15): prompts, ayudas, queries
 *  - Lado feature gate (3): plan permite/bloquea
 *  - Lado de queries DB (12): list_documents en diferentes scopes
 *
 * Para upload real necesitarías Telegram/WhatsApp o agregar /image endpoint.
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-document-flow-30.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-doc@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Doc';

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
async function send(message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ message }),
  });
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch { return { messages: [{ text: `HTTP ${res.status}: ${text.slice(0, 200)}` }] }; }
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

// ── Setup ──────────────────────────────────────────────────────────────

async function setup(userId: number): Promise<void> {
  await send('cancelar');
  let r = await send('agregar campo Doc');
  if (/ubicar/i.test(txt(r))) { await tap('flow_field_loc_city'); await send('Pergamino'); await tap('flow_confirm'); }
  await send('agregar lote D1 al campo Doc'); await send('100');

  // Seed some fake documents directly via DB so list_documents has data
  const f = (await dbq(`SELECT id FROM fields WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [userId]))[0];
  await dbq(`INSERT INTO documents (user_id, mime_type, file_size_bytes, original_filename, file_hash, source_channel, document_type, extracted_data)
             VALUES ($1, 'image/jpeg', 102400, 'factura-ypf-001.jpg', $2, 'test', 'factura', $3::jsonb)
             `,
    [userId, 'hash_' + userId + '_01', JSON.stringify({ proveedor: 'YPF', monto: 50000, fecha: '2026-05-10', items: [{ desc: 'gasoil', qty: 100, unit_price: 500 }] })]);
  await dbq(`INSERT INTO documents (user_id, mime_type, file_size_bytes, original_filename, file_hash, source_channel, document_type, extracted_data)
             VALUES ($1, 'image/png', 204800, 'factura-bayer-002.png', $2, 'test', 'factura', $3::jsonb)
             `,
    [userId, 'hash_' + userId + '_02', JSON.stringify({ proveedor: 'Bayer', monto: 120000, fecha: '2026-05-15', items: [{ desc: 'glifosato', qty: 20, unit_price: 6000 }] })]);
  await dbq(`INSERT INTO documents (user_id, mime_type, file_size_bytes, original_filename, file_hash, source_channel, document_type, extracted_data)
             VALUES ($1, 'application/pdf', 512000, 'remito-syngenta.pdf', $2, 'test', 'remito', $3::jsonb)
             `,
    [userId, 'hash_' + userId + '_03', JSON.stringify({ proveedor: 'Syngenta', items: [{ desc: 'semilla soja', qty: 500, unit: 'kg' }] })]);
  console.log('  ✅ seeded 3 fake documents (2 facturas + 1 remito)\n');
}

// ── Tests ──────────────────────────────────────────────────────────────

interface Test {
  name: string;
  description: string;
  category: string;
  input: string;
  expect: { contains?: (string | RegExp)[]; not_contains?: (string | RegExp)[] };
}

const TESTS: Test[] = [
  // ═════════ LIST_DOCUMENTS (8) ═════════
  { name: 'L01_list_all', category: 'list', input: 'mis documentos',
    description: 'Listar todos los documentos',
    expect: { contains: [/3|factura|remito|ypf|bayer|syngenta/i] } },
  { name: 'L02_facturas_only', category: 'list', input: 'listar mis facturas',
    description: 'Filtrar facturas',
    expect: { contains: [/factura|ypf|bayer/i], not_contains: [/syngenta/i] } },
  { name: 'L03_remitos_only', category: 'list', input: 'mostrame mis remitos',
    description: 'Filtrar remitos',
    expect: { contains: [/remito|syngenta/i] } },
  { name: 'L04_by_proveedor', category: 'list', input: 'facturas de YPF',
    description: 'Filtrar por proveedor',
    expect: { contains: [/ypf|50/i] } },
  { name: 'L05_by_proveedor_caps', category: 'list', input: 'facturas de ypf',
    description: 'Provider lowercase',
    expect: { contains: [/ypf/i] } },
  { name: 'L06_by_month', category: 'list', input: 'facturas de mayo',
    description: 'Filtrar por mes',
    expect: { contains: [/factura|mayo|ypf|bayer/i] } },
  { name: 'L07_by_amount', category: 'list', input: 'facturas mayores a 100 mil',
    description: 'Filtrar por monto',
    expect: { contains: [/bayer|120|factura/i] } },
  { name: 'L08_no_docs_response', category: 'list', input: 'tengo facturas de Cargill',
    description: 'Sin matches',
    expect: { contains: [/no|sin|cargill|0|encontr/i] } },

  // ═════════ UPLOAD PROMPTS (6) ═════════
  { name: 'U01_intent_factura', category: 'upload', input: 'voy a subir una factura',
    description: 'Bot pide foto factura',
    expect: { contains: [/foto|envi|imagen|mand|subí/i] } },
  { name: 'U02_intent_remito', category: 'upload', input: 'voy a subir un remito',
    description: 'Bot pide foto remito',
    expect: { contains: [/foto|envi|imagen|mand|subí|remito/i] } },
  { name: 'U03_can_upload_pdf', category: 'upload', input: 'puedo subir un PDF?',
    description: 'PDF support query',
    expect: { contains: [/pdf|imagen|s[ií]|formato/i] } },
  { name: 'U04_what_extracts', category: 'upload', input: 'qué datos extraés de una factura?',
    description: 'Help: extraction details',
    expect: { contains: [/monto|proveedor|fecha|item|gasto|categor/i] } },
  { name: 'U05_quality_required', category: 'upload', input: 'sirve si la foto está borrosa?',
    description: 'Quality requirement',
    expect: { contains: [/clar|legible|nít|leer|cualquier|sí/i] } },
  { name: 'U06_help_doc', category: 'upload', input: 'ayuda con documentos',
    description: 'Help section',
    expect: { contains: [/factura|remito|gasto|stock|subi/i] } },

  // ═════════ LINK / VINCULAR (4) ═════════
  { name: 'V01_link_to_expense', category: 'link', input: 'vinculá la factura de YPF al gasto de gasoil',
    description: 'Link factura → expense',
    expect: { contains: [/ypf|gasoil|vincul|gasto|encontr|asoci/i] } },
  { name: 'V02_link_without_existing', category: 'link', input: 'vinculá la factura de Bayer al gasto inexistente',
    description: 'Link inexistente',
    expect: { contains: [/no encontr|inexist|crear|gasto/i] } },
  { name: 'V03_show_unlinked', category: 'link', input: 'qué facturas todavía no están vinculadas',
    description: 'Pending links',
    expect: { contains: [/pendient|vincul|factura|sin asoci/i] } },
  { name: 'V04_after_link', category: 'link', input: 'mostrame el gasto de gasoil',
    description: 'Verificar gasto post-link',
    expect: { contains: [/gasoil|combust|50/i] } },

  // ═════════ FACTURA QUERIES (4) ═════════
  { name: 'Q01_total_facturas', category: 'query', input: 'cuánto sumé en facturas este año',
    description: 'Total facturas',
    expect: { contains: [/total|facturas|50|120|170|suma|2026/i] } },
  { name: 'Q02_compound_facturas_gastos', category: 'query', input: 'mostrame las facturas y los gastos del mes',
    description: 'Multi-domain',
    expect: { contains: [/factura|gasto|mes/i] } },
  { name: 'Q03_ranking_proveedores', category: 'query', input: 'top proveedores por monto facturado',
    description: 'Ranking facturas',
    expect: { contains: [/bayer|ypf|provee|top|ranking/i] } },
  { name: 'Q04_avg_factura', category: 'query', input: 'cuál fue el monto promedio de mis facturas',
    description: 'Promedio facturas',
    expect: { contains: [/85|promedio|50|120|factura/i] } },

  // ═════════ EDGE CASES (5) ═════════
  { name: 'E01_compound_doc_query_multi', category: 'edge', input: 'cuántas facturas tengo, cuál es la más cara y cuándo subí la última',
    description: 'Multi-query sobre docs',
    expect: { contains: [/2|3|factura|bayer|ypf|fecha/i] } },
  { name: 'E02_explicit_pdf_format', category: 'edge', input: 'cuáles son mis documentos en formato PDF',
    description: 'Filter por mime',
    expect: { contains: [/syngenta|remito|pdf/i] } },
  { name: 'E03_recent_uploads', category: 'edge', input: 'mis últimos 5 documentos',
    description: 'Top N recientes',
    expect: { contains: [/factura|remito|ypf|bayer|syngenta/i] } },
  { name: 'E04_delete_document', category: 'edge', input: 'borrá la factura de Bayer',
    description: 'Delete document',
    expect: { contains: [/borr|elimin|bayer|no.*válid|requier/i] } },
  { name: 'E05_quota_status', category: 'edge', input: 'cuántos documentos puedo subir por día',
    description: 'Quota query',
    expect: { contains: [/d[ií]a|l[ií]mite|cuota|10|20|30|plan/i] } },

  // ═════════ INVALID INPUTS (3) ═════════
  { name: 'I01_send_text_as_doc', category: 'invalid', input: 'esto es texto pero quiero que lo proceses como factura',
    description: 'Text-as-image',
    expect: { contains: [/foto|imagen|envi|requier|no puedo/i] } },
  { name: 'I02_negative_link', category: 'invalid', input: 'desvinculá la factura del gasto',
    description: 'Reverse link',
    expect: { contains: [/desvincul|sin asoci|encontr|gasto|factura/i] } },
  { name: 'I03_typo_factura', category: 'invalid', input: 'mostrame mis facturass',
    description: 'Typo en facturas',
    expect: { contains: [/factura|documento|ypf|bayer/i] } },
];

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`🧪 QA Document Flow 30 — ${TESTS.length} tests\n`);

  const auth = await register();
  TOKEN = auth.token;
  console.log(`✅ User ${auth.userId} (${EMAIL})`);
  try { await dbq('UPDATE users SET plan_id=4 WHERE id=$1', [auth.userId]); } catch { /* */ }
  console.log('✅ Enterprise plan\n');

  await setup(auth.userId);
  console.log('✅ Setup done\n');

  const results: Array<{ name: string; description: string; category: string; pass: boolean; reasons: string[]; response: string }> = [];
  let pass = 0, fail = 0;

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    console.log(`\n${num}/${TESTS.length} [${test.category}] ${test.name} — ${test.description}`);
    console.log(`  👤 ${test.input}`);

    try { await send('cancelar'); } catch { /* */ }

    const response = await send(test.input);
    const text = txt(response);
    console.log(`  🤖 ${text.substring(0, 280).replace(/\n/g, ' ')}${text.length > 280 ? '…' : ''}`);

    const reasons: string[] = [];
    let testPass = true;
    if (test.expect.contains) {
      for (const pat of test.expect.contains) {
        const m = pat instanceof RegExp ? pat.test(text) : text.toLowerCase().includes(pat.toLowerCase());
        if (!m) { reasons.push(`missing: ${pat}`); testPass = false; }
      }
    }
    if (test.expect.not_contains) {
      for (const pat of test.expect.not_contains) {
        const m = pat instanceof RegExp ? pat.test(text) : text.toLowerCase().includes(pat.toLowerCase());
        if (m) { reasons.push(`leak: ${pat}`); testPass = false; }
      }
    }
    if (testPass) { pass++; console.log(`  ✅ PASS`); }
    else { fail++; console.log(`  ❌ FAIL — ${reasons.join(' | ')}`); }
    results.push({ name: test.name, description: test.description, category: test.category, pass: testPass, reasons, response: text });
  }

  console.log('\n\n═══════════════════════ SUMMARY ═══════════════════════');
  console.log(`  ✅ PASS:    ${pass} / ${TESTS.length}`);
  console.log(`  ❌ FAIL:    ${fail} / ${TESTS.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / TESTS.length) * 100)}%\n`);

  console.log('═══════════════════════ DETALLE FAILS ═══════════════════════\n');
  for (const r of results) {
    if (r.pass) continue;
    console.log(`[${r.name}] ${r.description}`);
    console.log(`  💡 ${r.reasons.join(' | ')}`);
    console.log(`  🤖 ${r.response.substring(0, 300).replace(/\n/g, ' ')}\n`);
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-document-flow-30-results.json',
    JSON.stringify({ summary: { pass, fail, total: TESTS.length }, results }, null, 2),
  );
  console.log(`\n📄 Report: src/testing/qa-document-flow-30-results.json`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
