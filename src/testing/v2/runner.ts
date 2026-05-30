import { Harness, responseText } from './harness.js';
import type { Scenario, ScenarioResult, BotResponseItem, AssertContext } from './types.js';
import { ALL_SCENARIOS } from './scenarios/index.js';
import fs from 'fs';

const EMAIL = 'qa-v2@campo.test';
const PASSWORD = 'qatestv2';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function runScenario(h: Harness, sc: Scenario): Promise<ScenarioResult> {
  const base = { id: sc.id, source: sc.source, domains: sc.domains, axes: sc.axes };
  try {
    await h.reset();
    await h.setEnterprise();
    await h.runSeed(sc.seed);

    let lastResponse: BotResponseItem[] = [];
    for (const t of sc.turns) {
      lastResponse = 'send' in t ? await h.send(t.send) : await h.tap(t.tap);
    }

    const ctx: AssertContext = {
      userId: h.userId,
      lastResponse,
      lastText: responseText(lastResponse),
      query: (sql, params) => h.query(sql, params),
    };

    const failed: string[] = [];
    const details: string[] = [];
    for (const a of sc.assert) {
      const r = await a.run(ctx);
      if (!r.ok) { failed.push(a.label); details.push(`${a.label}: ${r.detail}`); }
    }
    return { ...base, status: failed.length ? 'FAIL' : 'PASS', failed, detail: details.join(' | ') };
  } catch (err) {
    return { ...base, status: 'ERROR', failed: ['<runtime>'], detail: (err as Error).message };
  }
}

async function main() {
  const tag = arg('tag') || 'local';
  const onlyAxis = arg('axis');
  const h = new Harness();
  await h.ensureUser(EMAIL, PASSWORD);
  await h.setEnterprise();

  const scenarios = ALL_SCENARIOS.filter((s) => !onlyAxis || s.axes.includes(onlyAxis as never));
  console.log(`QA v2 — running ${scenarios.length} scenario(s) [tag=${tag}]`);

  const baseRows = await h.query('SELECT COALESCE(MAX(id),0) AS m FROM ai_usage', []);
  const baseId = Number(baseRows[0].m);

  const results: ScenarioResult[] = [];
  for (const sc of scenarios) {
    const r = await runScenario(h, sc);
    results.push(r);
    const icon = r.status === 'PASS' ? '✅' : r.status === 'ERROR' ? '💥' : '❌';
    console.log(`  ${icon} ${r.id} [${r.axes.join(',')}]${r.status !== 'PASS' ? ' — ' + r.detail : ''}`);
  }

  const tok = await h.query(
    `SELECT COUNT(*)::int calls, COALESCE(SUM(input_tokens),0)::int in_t, COALESCE(SUM(output_tokens),0)::int out_t,
            COALESCE(SUM(cache_read_tokens),0)::int cread, COALESCE(SUM(cache_write_tokens),0)::int cwrite
     FROM ai_usage WHERE id > $1`, [baseId],
  );
  const t = tok[0];

  fs.mkdirSync('ab-results/v2', { recursive: true });
  fs.writeFileSync(`ab-results/v2/results-${tag}.json`, JSON.stringify(results, null, 2));
  fs.writeFileSync(`ab-results/v2/tokens-${tag}.txt`,
    `calls=${t.calls} in=${t.in_t} out=${t.out_t} cread=${t.cread} cwrite=${t.cwrite}`);

  const pass = results.filter((r) => r.status === 'PASS').length;
  console.log(`\n  PASS ${pass}/${results.length}  (${Math.round((pass / results.length) * 100)}%)`);
  console.log(`  tokens: ${fs.readFileSync(`ab-results/v2/tokens-${tag}.txt`, 'utf8')}`);
  process.exit(results.some((r) => r.status !== 'PASS') ? 1 : 0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(2); });
