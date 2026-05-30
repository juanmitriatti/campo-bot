/**
 * Analyze A/B results: Haiku vs Sonnet.
 * Reads the per-suite results JSON + token totals, prints a comparison table
 * (overall, per-category, mapped to the 3 axes the user cares about) + cost.
 */
import fs from 'fs';

const OUT = 'ab-results';

interface TestResult { test_name: string; category: string; severity?: string; status: 'PASS' | 'FAIL' | 'WARN'; }

function load(path: string): TestResult[] {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return []; }
}

// Map a test (by category + name) to one of the user's 3 axes.
function axisOf(t: TestResult): 'comprension' | 'contexto' | 'repreguntas' | 'otro' {
  const s = `${t.category} ${t.test_name}`.toLowerCase();
  if (/context|memor|reference|referen|drift|temporal|conversation|inconsist|collision|confusion|implicit|relative_date|long_conversation/.test(s)) return 'contexto';
  if (/asks|missing|clarif|ambig|without_warehouse|incomplete/.test(s)) return 'repreguntas';
  if (/typo|disambig|classif|vs_|_vs|observation_vs|hectares|query_vs|birth_vs|severity|unit|crop_name|routing|intent/.test(s)) return 'comprension';
  return 'otro';
}

function rate(rs: TestResult[]): { pass: number; warn: number; fail: number; n: number; pct: number; pctLenient: number } {
  const pass = rs.filter(r => r.status === 'PASS').length;
  const warn = rs.filter(r => r.status === 'WARN').length;
  const fail = rs.filter(r => r.status === 'FAIL').length;
  const n = rs.length || 1;
  return { pass, warn, fail, n: rs.length, pct: Math.round((pass / n) * 100), pctLenient: Math.round(((pass + warn) / n) * 100) };
}

function parseTokens(tag: string): Record<string, number> {
  try {
    const txt = fs.readFileSync(`${OUT}/tokens-${tag}.txt`, 'utf8').trim();
    const out: Record<string, number> = {};
    for (const kv of txt.split(/\s+/)) { const [k, v] = kv.split('='); if (k && v) out[k] = Number(v); }
    return out;
  } catch { return {}; }
}

// per-MTok pricing
const PRICING: Record<string, { in: number; out: number; cr: number; cw: number }> = {
  haiku:  { in: 0.80, out: 4.00,  cr: 0.08, cw: 1.00 },
  sonnet: { in: 3.00, out: 15.00, cr: 0.30, cw: 3.75 },
};

function cost(tag: string, t: Record<string, number>): number {
  const p = PRICING[tag];
  return ((t.in || 0) * p.in + (t.out || 0) * p.out + (t.cread || 0) * p.cr + (t.cwrite || 0) * p.cw) / 1e6;
}

function bar(label: string, h: number, s: number, suffix = '%') {
  const arrow = s > h ? '↑' : s < h ? '↓' : '=';
  const delta = s - h;
  console.log(`  ${label.padEnd(26)} Haiku ${String(h).padStart(4)}${suffix}   Sonnet ${String(s).padStart(4)}${suffix}   ${arrow} ${delta >= 0 ? '+' : ''}${delta}${suffix === '%' ? ' pts' : ''}`);
}

function main() {
  const data = {
    haiku: { adv30: load(`${OUT}/adv30-haiku.json`), adv40: load(`${OUT}/adv40-haiku.json`) },
    sonnet: { adv30: load(`${OUT}/adv30-sonnet.json`), adv40: load(`${OUT}/adv40-sonnet.json`) },
  };

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('   A/B MODELO — Haiku 4.5  vs  Sonnet 4.6  (agente campo-bot)');
  console.log('══════════════════════════════════════════════════════════\n');

  console.log('── PASS RATE POR SUITE (strict: solo PASS) ──');
  for (const suite of ['adv30', 'adv40'] as const) {
    const h = rate((data.haiku as any)[suite]);
    const s = rate((data.sonnet as any)[suite]);
    const name = suite === 'adv30' ? 'adversarial-30' : 'adversarial-advanced-40';
    console.log(`\n  ${name}  (n=${h.n || s.n})`);
    bar('  pass rate (strict)', h.pct, s.pct);
    bar('  pass rate (PASS+WARN)', h.pctLenient, s.pctLenient);
    console.log(`     Haiku  : ${h.pass}P / ${h.warn}W / ${h.fail}F`);
    console.log(`     Sonnet : ${s.pass}P / ${s.warn}W / ${s.fail}F`);
  }

  // Combined
  const allH = [...data.haiku.adv30, ...data.haiku.adv40];
  const allS = [...data.sonnet.adv30, ...data.sonnet.adv40];
  const cH = rate(allH), cS = rate(allS);
  console.log('\n── COMBINADO (70 escenarios) ──');
  bar('pass rate (strict)', cH.pct, cS.pct);
  bar('pass rate (PASS+WARN)', cH.pctLenient, cS.pctLenient);

  // By axis
  console.log('\n── POR EJE (los 3 que te importan) ──');
  for (const axis of ['comprension', 'contexto', 'repreguntas'] as const) {
    const h = rate(allH.filter(t => axisOf(t) === axis));
    const s = rate(allS.filter(t => axisOf(t) === axis));
    bar(axis, h.pct, s.pct);
  }

  // By raw category (top movers)
  console.log('\n── POR CATEGORÍA (donde más cambió) ──');
  const cats = [...new Set([...allH, ...allS].map(t => t.category))];
  const rows = cats.map(c => {
    const h = rate(allH.filter(t => t.category === c));
    const s = rate(allS.filter(t => t.category === c));
    return { c, h: h.pct, s: s.pct, d: s.pct - h.pct, n: Math.max(h.n, s.n) };
  }).filter(r => r.n > 0).sort((a, b) => b.d - a.d);
  for (const r of rows) bar(`${r.c} (n=${r.n})`, r.h, r.s);

  // Cost
  console.log('\n── COSTO REAL (tokens medidos en la corrida) ──');
  // Haiku adv40 ran separately (login bug on first pass) → merge its tokens.
  const th = parseTokens('haiku');
  const th40 = parseTokens('haiku-adv40');
  for (const k of Object.keys(th40)) th[k] = (th[k] || 0) + th40[k];
  const ts = parseTokens('sonnet');
  const ch = cost('haiku', th), cs = cost('sonnet', ts);
  const callsH = th.calls || 1, callsS = ts.calls || 1;
  console.log(`  Haiku : ${th.calls} calls | in ${th.in} out ${th.out} cread ${th.cread} cwrite ${th.cwrite} → US$ ${ch.toFixed(4)}  (US$ ${(ch / callsH * 1000).toFixed(3)} /1k msgs)`);
  console.log(`  Sonnet: ${ts.calls} calls | in ${ts.in} out ${ts.out} cread ${ts.cread} cwrite ${ts.cwrite} → US$ ${cs.toFixed(4)}  (US$ ${(cs / callsS * 1000).toFixed(3)} /1k msgs)`);
  const perMsgH = ch / callsH, perMsgS = cs / callsS;
  console.log(`  → Sonnet cuesta ${(perMsgS / perMsgH).toFixed(1)}x por mensaje que Haiku.`);

  console.log('\n── VEREDICTO ──');
  const qDelta = cS.pct - cH.pct;
  console.log(`  Calidad (strict): ${cH.pct}% → ${cS.pct}%  (${qDelta >= 0 ? '+' : ''}${qDelta} pts, mejora relativa ${cH.pct ? Math.round((qDelta / cH.pct) * 100) : 0}%)`);
  console.log(`  Costo/mensaje   : ${(perMsgS / perMsgH).toFixed(1)}x`);
  console.log('');
}

main();
