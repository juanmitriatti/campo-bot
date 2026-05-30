import { execSync } from 'node:child_process';
import fs from 'fs';

const PRICING: Record<string, { in: number; out: number; cr: number; cw: number }> = {
  'claude-haiku-4-5-20251001': { in: 0.80, out: 4.00, cr: 0.08, cw: 1.00 },
  'claude-sonnet-4-6':          { in: 3.00, out: 15.00, cr: 0.30, cw: 3.75 },
};

function setModel(model: string) {
  execSync(
    `docker compose exec -T db psql -U campo -d campo_bot -c "INSERT INTO system_settings(key,value,updated_at) VALUES('AGENT_MODEL','${model}',NOW()) ON CONFLICT(key) DO UPDATE SET value='${model}', updated_at=NOW();"`,
    { stdio: 'ignore' },
  );
  execSync('docker compose restart app', { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try {
      const out = execSync('curl -s --max-time 3 http://localhost:3000/api/health').toString();
      if (out.includes('"status":"ok"')) break;
    } catch { /* retry */ }
    execSync('sleep 2');
  }
}

function parseTokens(tag: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kv of fs.readFileSync(`ab-results/v2/tokens-${tag}.txt`, 'utf8').trim().split(/\s+/)) {
    const [k, v] = kv.split('='); if (k && v) out[k] = Number(v);
  }
  return out;
}

function cost(model: string, t: Record<string, number>): number {
  const p = PRICING[model]; if (!p) return NaN;
  return ((t.in || 0) * p.in + (t.out || 0) * p.out + (t.cread || 0) * p.cr + (t.cwrite || 0) * p.cw) / 1e6;
}

function rateByAxis(results: { axes: string[]; status: string }[], axis: string): number | 'n/a' {
  const subset = results.filter((r) => r.axes.includes(axis));
  if (!subset.length) return 'n/a';
  return Math.round((subset.filter((r) => r.status === 'PASS').length / subset.length) * 100);
}

async function main() {
  const models = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (models.length !== 2) { console.error('usage: tsx compare.ts <modelA> <modelB>'); process.exit(2); }

  const tags: Record<string, string> = {};
  for (const model of models) {
    const tag = model.includes('sonnet') ? 'sonnet' : model.includes('haiku') ? 'haiku' : model.slice(0, 8);
    tags[model] = tag;
    console.log(`\n=== ${model} (tag=${tag}) ===`);
    setModel(model);
    execSync(`npx tsx src/testing/v2/runner.ts --tag ${tag}`, { stdio: 'inherit' });
  }

  setModel('claude-haiku-4-5-20251001');

  console.log('\n══ COMPARACIÓN v2 ══');
  const [a, b] = models;
  const ra = JSON.parse(fs.readFileSync(`ab-results/v2/results-${tags[a]}.json`, 'utf8'));
  const rb = JSON.parse(fs.readFileSync(`ab-results/v2/results-${tags[b]}.json`, 'utf8'));
  const pct = (r: { status: string }[]) => Math.round((r.filter((x) => x.status === 'PASS').length / r.length) * 100);
  console.log(`  PASS global:  ${a}=${pct(ra)}%   ${b}=${pct(rb)}%`);
  for (const axis of ['comprension', 'contexto', 'repreguntas']) {
    const ra_ = rateByAxis(ra, axis);
    const rb_ = rateByAxis(rb, axis);
    const fmtA = typeof ra_ === 'number' ? `${ra_}%` : ra_;
    const fmtB = typeof rb_ === 'number' ? `${rb_}%` : rb_;
    console.log(`  ${axis.padEnd(12)} ${a}=${fmtA}   ${b}=${fmtB}`);
  }
  const ca = cost(a, parseTokens(tags[a])), cb = cost(b, parseTokens(tags[b]));
  const callsA = parseTokens(tags[a]).calls || 1, callsB = parseTokens(tags[b]).calls || 1;
  console.log(`  costo/1k msg: ${a}=US$ ${(ca / callsA * 1000).toFixed(2)}   ${b}=US$ ${(cb / callsB * 1000).toFixed(2)}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(2); });
