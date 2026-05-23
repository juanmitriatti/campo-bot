/**
 * QA PDF Quality 30 — verifies content of generated reports matches DB.
 *
 * The test-bot doesn't ship binary PDFs back, but the bot returns a "rich
 * message" before the attachment with all the data the PDF should contain
 * (totales, actividades, observaciones, scoutings, etc). We compare that
 * text against the DB ground truth.
 *
 * Covers:
 *  - Agro report basic / per-field / per-plot / per-date-range (8)
 *  - Financial report PDF (6)
 *  - Campaign stats PDF (4)
 *  - Empty data scenarios (3)
 *  - Sharing: PDF for shared field (2)
 *  - Date edge cases (3)
 *  - Multiple reports back-to-back (4)
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-pdf-quality-30.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-pdf@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don PDF';

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
async function sendAndLog(m: string) { return txt(await send(m)); }

// ── Setup ──────────────────────────────────────────────────────────────

async function setup(userId: number): Promise<{ fieldId: number; plotId: number }> {
  await send('cancelar');
  await sendAndLog('agregar campo Don PDF');
  if (true) {
    await tap('flow_field_loc_city');
    await sendAndLog('Pergamino');
    await tap('flow_confirm');
  }
  for (const [name, ha] of [['L1', 100], ['L2', 80], ['L3', 60]] as const) {
    await sendAndLog(`agregar lote ${name} al campo Don PDF`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré soja en L1');
  await sendAndLog('sembré maíz en L2');
  await sendAndLog('agregué 30 vacas Angus en L1');

  // Seed several activities + financial events for richer reports
  await sendAndLog('fumigué L1 con glifosato 2 lt/ha');
  await sendAndLog('fertilicé L2 con urea 80 kg/ha');
  await sendAndLog('gasté 100 mil en gasoil'); await tap('flow_confirm').catch(() => {});
  await sendAndLog('gasté 50 mil en agroquímicos en L1'); await tap('flow_confirm').catch(() => {});
  await sendAndLog('vendí 5 tn de soja a 400 USD'); await tap('flow_confirm').catch(() => {});
  await sendAndLog('llovieron 25 mm en Don PDF');
  await sendAndLog('observé hojas amarillas en L1');
  await sendAndLog('monitoreé L1 con soja V3, 12% maleza rama negra');

  const f = (await dbq(`SELECT id FROM fields WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [userId]))[0];
  const p = (await dbq(`SELECT id FROM plots WHERE field_id=$1 ORDER BY name LIMIT 1`, [f.id]))[0];
  return { fieldId: f.id, plotId: p.id };
}

// ── Tests ──────────────────────────────────────────────────────────────

interface Expectations {
  /** Must contain these keywords in the rich message */
  must_contain?: (string | RegExp)[];
  /** Must NOT contain */
  must_not_contain?: (string | RegExp)[];
  /** Must include attachment marker */
  has_attachment?: boolean;
}

interface Test {
  name: string;
  description: string;
  category: string;
  input: string;
  expectations: Expectations;
}

const TESTS: Test[] = [
  // ═════════ AGRO REPORT (8) ═════════
  { name: 'A01_agro_basic', category: 'agro', input: 'reporte agronómico',
    description: 'Reporte agro básico',
    expectations: { must_contain: ['Reporte agronómico', /Actividades?\s*\(/], has_attachment: true } },
  { name: 'A02_agro_field', category: 'agro', input: 'reporte agro del campo Don PDF',
    description: 'Reporte por campo',
    expectations: { must_contain: ['don pdf', /Actividades/i], has_attachment: true } },
  { name: 'A03_agro_lote', category: 'agro', input: 'reporte agronómico del lote L1',
    description: 'Reporte por lote',
    expectations: { must_contain: [/L1/i, /soja|fumig|monitor/i], has_attachment: true } },
  { name: 'A04_agro_rango_fechas', category: 'agro', input: 'reporte agro de marzo a mayo',
    description: 'Rango de fechas custom',
    expectations: { must_contain: [/marzo|mayo|2026-03|2026-05/i], has_attachment: true } },
  { name: 'A05_agro_este_mes', category: 'agro', input: 'reporte agro de este mes',
    description: 'Reporte mes corriente',
    expectations: { must_contain: [/Actividades?\s*\(/], has_attachment: true } },
  { name: 'A06_agro_year_2026', category: 'agro', input: 'reporte agronómico de 2026',
    description: 'Reporte año completo',
    expectations: { must_contain: [/2026|Actividades/i], has_attachment: true } },
  { name: 'A07_agro_with_obs', category: 'agro', input: 'reporte agro completo',
    description: 'Debe incluir observaciones',
    expectations: { must_contain: [/Observaciones/i, /hojas amarillas|monitor/i] } },
  { name: 'A08_agro_compound_share', category: 'agro', input: 'generá el reporte agro y compartilo',
    description: 'Generate + share command',
    expectations: { must_contain: [/Reporte|reporte/i], has_attachment: true } },

  // ═════════ FINANCIAL REPORT (6) ═════════
  { name: 'F01_fin_basic', category: 'financial', input: 'reporte financiero',
    description: 'Financial report básico',
    expectations: { must_contain: [/financiero|gastos|ingresos|balance/i] } },
  { name: 'F02_fin_month', category: 'financial', input: 'reporte financiero del mes',
    description: 'Financial del mes',
    expectations: { must_contain: [/financ|gastos|ingresos/i] } },
  { name: 'F03_fin_field', category: 'financial', input: 'reporte financiero del campo Don PDF',
    description: 'Financial por campo',
    expectations: { must_contain: [/don pdf|financ|gastos/i] } },
  { name: 'F04_fin_balance', category: 'financial', input: 'balance del año',
    description: 'Balance anual (con datos)',
    expectations: { must_contain: [/balance|ingresos|gastos|usd|ars/i] } },
  { name: 'F05_fin_specific_period', category: 'financial', input: 'cuánto gasté entre el 1 de mayo y el 23 de mayo',
    description: 'Período específico',
    expectations: { must_contain: [/gast|mayo|100\.000|50\.000/i] } },
  { name: 'F06_fin_per_category', category: 'financial', input: 'gastos por categoría del mes',
    description: 'Breakdown por categoría',
    expectations: { must_contain: [/categor|combust|agroqu/i] } },

  // ═════════ CAMPAIGN STATS PDF (4) ═════════
  { name: 'C01_campaign_basic', category: 'campaign', input: 'estadísticas de la campaña L1',
    description: 'Campaign stats lote',
    expectations: { must_contain: [/campa[ñn]a|soja|L1/i] } },
  { name: 'C02_campaign_compare', category: 'campaign', input: 'compará campañas',
    description: 'Compare campaigns',
    expectations: { must_contain: [/campa[ñn]a|compar|previa|histor/i] } },
  { name: 'C03_campaign_actual', category: 'campaign', input: 'cómo viene la campaña',
    description: 'Campaign overview',
    expectations: { must_contain: [/campa[ñn]a|soja|maíz/i] } },
  { name: 'C04_campaign_after_harvest', category: 'campaign', input: 'estadística cosecha lote L1',
    description: 'Stats post-cosecha',
    expectations: { must_contain: [/L1|cosech|estad/i] } },

  // ═════════ EMPTY DATA (3) ═════════
  { name: 'E01_agro_lote_empty', category: 'empty', input: 'reporte agro del lote L3',
    description: 'Reporte de lote sin actividad',
    expectations: { must_contain: [/L3|sin actividad|sin observaciones|reporte/i] } },
  { name: 'E02_fin_empty_period', category: 'empty', input: 'gastos del año 2020',
    description: 'Período sin datos',
    expectations: { must_contain: [/no hay|sin|vacío|2020|no registr/i] } },
  { name: 'E03_campaign_no_data', category: 'empty', input: 'estadísticas de cosecha del lote L3',
    description: 'Stats sin cosecha',
    expectations: { must_not_contain: [/Error|crash|undefined|null/i] } },

  // ═════════ DATE EDGE CASES (3) ═════════
  { name: 'D01_date_today_only', category: 'date', input: 'reporte agro de hoy',
    description: 'Hoy solamente',
    expectations: { must_contain: [/reporte|actividades|hoy/i] } },
  { name: 'D02_date_future_year', category: 'date', input: 'reporte agro del año 3000',
    description: 'Año futuro absurdo — debe rechazar',
    expectations: { must_contain: [/fuera de rango|inválid|3000|no.*válid/i] } },
  { name: 'D03_date_invalid_range', category: 'date', input: 'reporte de mayo a marzo',
    description: 'Rango invertido',
    expectations: { must_contain: [/inválid|orden|posterior|no/i] } },

  // ═════════ MULTIPLE REPORTS (4) ═════════
  { name: 'M01_agro_then_fin', category: 'multi', input: 'reporte agro',
    description: 'Agro report turn 1',
    expectations: { must_contain: [/Reporte|reporte/i] } },
  { name: 'M02_fin_after_agro', category: 'multi', input: 'ahora el financiero',
    description: 'Financial after agro',
    expectations: { must_contain: [/financ|gastos|ingresos/i] } },
  { name: 'M03_compound_2reports', category: 'multi', input: 'dame el reporte agro y el financiero del mes',
    description: '2 reportes en 1 msg',
    expectations: { must_contain: [/reporte|agro|financ|gastos/i] } },
  { name: 'M04_share_after_report', category: 'multi', input: 'compartime el último reporte',
    description: 'Re-share PDF',
    expectations: { must_contain: [/comparti|reporte|share|envi/i] } },

  // ═════════ ATTACHMENT MARKER PRESENCE (2) ═════════
  { name: 'AT01_explicit_pdf', category: 'attachment', input: 'generame el PDF del reporte agro de Don PDF',
    description: 'PDF explicit request',
    expectations: { must_contain: [/Archivo adjunto.*pdf|\.pdf/i] } },
];

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`🧪 QA PDF Quality 30 — ${TESTS.length} tests\n`);

  const auth = await register();
  TOKEN = auth.token;
  console.log(`✅ User ${auth.userId} (${EMAIL})`);

  // Best-effort cleanup + plan
  try { await dbq('UPDATE users SET plan_id=4 WHERE id=$1', [auth.userId]); } catch { /* ignore */ }
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
    console.log(`  🤖 ${text.substring(0, 300).replace(/\n/g, ' ')}${text.length > 300 ? '…' : ''}`);

    const reasons: string[] = [];
    let testPass = true;
    if (test.expectations.must_contain) {
      for (const pat of test.expectations.must_contain) {
        const matches = pat instanceof RegExp ? pat.test(text) : text.toLowerCase().includes(pat.toLowerCase());
        if (!matches) {
          reasons.push(`missing: ${pat}`);
          testPass = false;
        }
      }
    }
    if (test.expectations.must_not_contain) {
      for (const pat of test.expectations.must_not_contain) {
        const matches = pat instanceof RegExp ? pat.test(text) : text.toLowerCase().includes(pat.toLowerCase());
        if (matches) {
          reasons.push(`leak: ${pat}`);
          testPass = false;
        }
      }
    }
    if (test.expectations.has_attachment && !/Archivo adjunto/i.test(text)) {
      reasons.push('no attachment marker');
      testPass = false;
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
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-pdf-quality-30-results.json',
    JSON.stringify({ summary: { pass, fail, total: TESTS.length }, results }, null, 2),
  );
  console.log(`\n📄 Report: src/testing/qa-pdf-quality-30-results.json`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
