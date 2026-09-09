#!/usr/bin/env npx tsx
/**
 * qa-prod-e2e.ts — recorrido de QA de punta a punta (productor mixto desde
 * cero) contra el pipeline REAL de un servidor, con el plan en
 * `qa-prod-e2e.plan.json` (fuente única: el mismo archivo se rinde a HTML
 * para revisarlo antes de correr).
 *
 * Contra prod usa el canal test-bot, que es el mismo `processTextMessage`
 * que WhatsApp con otro transporte: los handlers, el agente, la DB y los
 * pendings son los de producción. En prod el endpoint exige rol admin, así
 * que la cuenta de QA tiene que ser un admin (create-admin.ts --plan enterprise).
 *
 * Usage:
 *   npx tsx src/testing/qa-prod-e2e.ts --html qa-reports/plan.html   # solo rinde el plan
 *   TEST_BOT_URL=https://... QA_EMAIL=... QA_PASSWORD=... npx tsx src/testing/qa-prod-e2e.ts --run
 *   ... --run --from hacienda     # arranca en una fase (la cuenta ya tiene lo anterior)
 *   ... --run --no-reset          # no borra los datos de la cuenta de QA antes de arrancar
 *   ... --plan src/testing/qa-prod-ganaderia.plan.json   # otro plan con el MISMO runner
 *
 * Deja `qa-reports/<plan>-<timestamp>.md` + `.json` con cada mensaje,
 * cada respuesta del bot, los botones y el veredicto por paso.
 *
 * Botones con token dinámico (`animal_batch_move_<token>`, `lv_loc_lote_<token>`):
 * en `tap` y `buttons` un id terminado en `*` se resuelve por prefijo contra el
 * último botón que el bot mostró con ese prefijo. Sin eso, ningún paso que
 * dependa de un tap con payload podría escribirse en el plan.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestBotClient, type BotResponseItem } from './test-bot-client.js';

interface Step {
  send?: string;
  tap?: string;
  expect?: string;
  avoid?: string;
  buttons?: string[];
  checks?: string;
}
interface Phase { id: string; title: string; domain: string; why: string; steps: Step[] }
interface Plan { name: string; title?: string; persona: string; notes: string[]; phases: Phase[] }

interface StepResult {
  phase: string;
  n: number;
  input: string;
  kind: 'send' | 'tap';
  reply: string;
  buttons: string[];
  pass: boolean;
  reasons: string[];
  ms: number;
  checks?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const planPath = arg('--plan') ?? join(__dirname, 'qa-prod-e2e.plan.json');
const planSlug = basename(planPath).replace(/\.plan\.json$/, '').replace(/\.json$/, '');
const plan: Plan = JSON.parse(readFileSync(planPath, 'utf-8'));

/**
 * Ids con `*` final se resuelven por prefijo contra los botones que el bot
 * mostró más recientemente con ese prefijo (un tap con token no es escribible
 * de antemano). `seen` recuerda el último id por prefijo durante toda la
 * corrida, así un segundo tap sobre el mismo botón (doble toque) también se
 * puede expresar en el plan.
 */
const seenButtons: string[] = [];
function rememberButtons(ids: string[]): void {
  seenButtons.push(...ids);
}
function resolveButtonId(pattern: string): string | null {
  if (!pattern.endsWith('*')) return pattern;
  const prefix = pattern.slice(0, -1);
  for (let i = seenButtons.length - 1; i >= 0; i--) if (seenButtons[i].startsWith(prefix)) return seenButtons[i];
  return null;
}

function allText(items: BotResponseItem[]): string {
  return items.map(i => i.type === 'text' ? (i.text ?? '') : (i.interactive?.body ?? '')).join('\n');
}
function allButtons(items: BotResponseItem[]): string[] {
  const out: string[] = [];
  for (const i of items) {
    if (i.type !== 'interactive') continue;
    for (const b of i.interactive?.buttons ?? []) out.push(b.id);
    for (const s of i.interactive?.sections ?? []) for (const r of s.rows) out.push(r.id);
  }
  return out;
}

function judge(step: Step, reply: string, buttons: string[]): string[] {
  const reasons: string[] = [];
  if (step.expect && !new RegExp(step.expect, 'i').test(reply)) reasons.push(`no apareció /${step.expect}/`);
  if (step.avoid && new RegExp(step.avoid, 'i').test(reply)) reasons.push(`apareció /${step.avoid}/ (prohibido)`);
  if (/^\s*$/.test(reply) && buttons.length === 0) reasons.push('respuesta vacía (silencio)');
  for (const b of step.buttons ?? []) {
    const hit = b.endsWith('*') ? buttons.some(id => id.startsWith(b.slice(0, -1))) : buttons.includes(b);
    if (!hit) reasons.push(`falta el botón ${b}`);
  }
  return reasons;
}

/**
 * `.qa-env` en la raíz del repo (gitignoreado): KEY=VALUE por línea. Existe
 * para que la contraseña de la cuenta de QA la escriba el operador una vez y
 * no viaje por la línea de comandos ni por el chat del agente que lanza el QA.
 */
function loadQaEnv(): void {
  const p = join(__dirname, '..', '..', '.qa-env');
  let raw = '';
  try { raw = readFileSync(p, 'utf-8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function run(): Promise<void> {
  loadQaEnv();
  const baseUrl = process.env.TEST_BOT_URL || 'http://localhost:3000';
  const email = process.env.QA_EMAIL;
  const password = process.env.QA_PASSWORD;
  if (!email || !password) {
    console.error('Faltan QA_EMAIL / QA_PASSWORD (cuenta admin de QA en el servidor destino).');
    process.exit(1);
  }
  const from = arg('--from');
  const noReset = args.includes('--no-reset');
  const client = new TestBotClient(baseUrl, 60_000);
  await client.login(email, password);
  console.log(`QA E2E → ${baseUrl} como ${email} (user ${client.userId})`);

  // --probe: solo mira en qué estado está la cuenta (¿vacía?) y sale.
  if (args.includes('--probe')) {
    const r = await client.send('mis campos');
    console.log(allText(r.messages));
    return;
  }

  if (!noReset && !from) {
    // En prod el reset exige TEST_BOT_SECRET (variable del servicio en Railway).
    await client.reset(process.env.TEST_BOT_SECRET);
    console.log('Cuenta de QA vaciada (reset).');
  }

  const results: StepResult[] = [];
  let started = !from;
  let n = 0;
  for (const phase of plan.phases) {
    if (!started && phase.id === from) started = true;
    if (!started) continue;
    console.log(`\n== ${phase.title}`);
    for (const step of phase.steps) {
      n++;
      const kind: 'send' | 'tap' = step.tap ? 'tap' : 'send';
      const pattern = (step.tap ?? step.send)!;
      const resolved = kind === 'tap' ? resolveButtonId(pattern) : pattern;
      const input = resolved ?? pattern;
      const t0 = Date.now();
      let items: BotResponseItem[] = [];
      let err: string | null = null;
      if (kind === 'tap' && resolved === null) {
        err = `ningún botón previo coincide con ${pattern}`;
      } else {
        try {
          items = kind === 'tap' ? (await client.tap(input)).messages : (await client.send(input)).messages;
        } catch (e) {
          err = (e as Error).message;
        }
      }
      const reply = err ? `[ERROR] ${err}` : allText(items);
      const buttons = allButtons(items);
      rememberButtons(buttons);
      const reasons = err ? [`error HTTP: ${err}`] : judge(step, reply, buttons);
      const r: StepResult = { phase: phase.id, n, input, kind, reply, buttons, pass: reasons.length === 0, reasons, ms: Date.now() - t0, checks: step.checks };
      results.push(r);
      console.log(`${r.pass ? '  ✓' : '  ✗'} ${String(n).padStart(2)} ${kind === 'tap' ? '[tap] ' : ''}${input.slice(0, 70)}${r.pass ? '' : `\n       → ${reasons.join('; ')}\n       ← ${reply.replace(/\n/g, ' | ').slice(0, 200)}`}`);
      // Respiro entre mensajes: el pipeline serializa por usuario, pero los
      // pendings con TTL y los tips diarios se comportan como en la vida real.
      await new Promise(res => setTimeout(res, 400));
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(__dirname, '..', '..', 'qa-reports');
  mkdirSync(dir, { recursive: true });
  const passed = results.filter(r => r.pass).length;
  const md: string[] = [
    `# ${plan.name}`,
    ``,
    `Servidor: ${baseUrl} — cuenta: ${email} — ${new Date().toISOString()}`,
    ``,
    `**${passed}/${results.length} pasos OK**`,
    ``,
  ];
  for (const phase of plan.phases) {
    const rows = results.filter(r => r.phase === phase.id);
    if (rows.length === 0) continue;
    md.push(`## ${phase.title} (${rows.filter(r => r.pass).length}/${rows.length})`, ``);
    for (const r of rows) {
      md.push(`### ${r.n}. ${r.pass ? '✅' : '❌'} ${r.kind === 'tap' ? `[tap] ${r.input}` : `«${r.input}»`}`);
      if (r.checks) md.push(`_${r.checks}_`);
      md.push(``, '```', r.reply || '(sin texto)', '```');
      if (r.buttons.length) md.push(`Botones: ${r.buttons.join(', ')}`);
      if (!r.pass) md.push(`**Falló:** ${r.reasons.join('; ')}`);
      md.push(`_${r.ms} ms_`, ``);
    }
  }
  writeFileSync(join(dir, `${planSlug}-${stamp}.md`), md.join('\n'), 'utf-8');
  writeFileSync(join(dir, `${planSlug}-${stamp}.json`), JSON.stringify({ baseUrl, email, results }, null, 2), 'utf-8');
  console.log(`\n${passed}/${results.length} OK — reporte en qa-reports/${planSlug}-${stamp}.md`);
  process.exit(passed === results.length ? 0 : 1);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Rinde el plan (solo el JSON, sin correr nada) a un HTML para revisarlo. */
function renderHtml(): string {
  const total = plan.phases.reduce((a, p) => a + p.steps.length, 0);
  const domainLabel: Record<string, string> = { sistema: 'Sistema', agro: 'Agronomía', plata: 'Plata', hacienda: 'Hacienda' };
  let n = 0;
  const phases = plan.phases.map(p => {
    const rows = p.steps.map(s => {
      n++;
      const kind = s.tap ? 'tap' : 'msg';
      const input = s.tap ?? s.send ?? '';
      const expectBits: string[] = [];
      if (s.expect) expectBits.push(`<span class="rx"><b>debe decir</b> /${esc(s.expect)}/</span>`);
      if (s.avoid) expectBits.push(`<span class="rx"><b>nunca</b> /${esc(s.avoid)}/</span>`);
      if (s.buttons?.length) expectBits.push(`<span class="rx"><b>botones</b> ${esc(s.buttons.join(', '))}</span>`);
      return `<li class="step">
  <span class="n">${n}</span>
  <div class="bubble ${kind}">${kind === 'tap' ? `<span class="tapmark">tap</span>` : ''}${esc(input)}</div>
  <div class="meta">
    ${s.checks ? `<p class="checks">${esc(s.checks)}</p>` : ''}
    <p class="expects">${expectBits.join('')}</p>
  </div>
</li>`;
    }).join('\n');
    return `<section class="phase" id="${p.id}" data-domain="${p.domain}">
  <header class="phase-head">
    <span class="domain">${domainLabel[p.domain] ?? p.domain}</span>
    <h2>${esc(p.title)}</h2>
    <p class="why">${esc(p.why)}</p>
    <p class="count">${p.steps.length} pasos</p>
  </header>
  <ol class="steps">${rows}</ol>
</section>`;
  }).join('\n');

  const nav = plan.phases.map(p => `<li><a href="#${p.id}"><span class="dot" data-domain="${p.domain}"></span>${esc(p.title)}<span class="cnt">${p.steps.length}</span></a></li>`).join('');
  const notes = plan.notes.map(t => `<li>${esc(t)}</li>`).join('');

  return `<title>${esc(plan.title ?? 'QA E2E Campo Bot')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root{
  --bg:#F2F4F0;--surface:#FFFFFF;--ink:#1B221C;--ink-2:#4F5A51;--muted:#7A857C;--line:#D6DCD4;
  --accent:#2F6B3A;--accent-ink:#FFFFFF;--bubble:#E7EFE4;--bubble-tap:#F4EBDD;
  --agro:#2F6B3A;--hacienda:#9A6B1F;--plata:#2B5F7A;--sistema:#5B5F66;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --body:'Instrument Sans',system-ui,-apple-system,Segoe UI,sans-serif;
  --display:'Bricolage Grotesque','Instrument Sans',system-ui,sans-serif;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#141816;--surface:#1C2320;--ink:#E6EAE4;--ink-2:#B7C0B8;--muted:#8A948C;--line:#2E3733;
  --accent:#7DBB8A;--accent-ink:#0F1A12;--bubble:#22302A;--bubble-tap:#33291B;
  --agro:#7DBB8A;--hacienda:#D9A64A;--plata:#78B4D4;--sistema:#A6ACB4;
}}
:root[data-theme="dark"]{
  --bg:#141816;--surface:#1C2320;--ink:#E6EAE4;--ink-2:#B7C0B8;--muted:#8A948C;--line:#2E3733;
  --accent:#7DBB8A;--accent-ink:#0F1A12;--bubble:#22302A;--bubble-tap:#33291B;
  --agro:#7DBB8A;--hacienda:#D9A64A;--plata:#78B4D4;--sistema:#A6ACB4;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.5}
a{color:inherit}
.wrap{display:grid;grid-template-columns:260px minmax(0,1fr);gap:40px;max-width:1180px;margin:0 auto;padding:40px 28px 80px}
@media (max-width:820px){.wrap{grid-template-columns:1fr;gap:24px}.rail{position:static}}
.rail{position:sticky;top:24px;align-self:start;display:flex;flex-direction:column;gap:22px}
h1{font-family:var(--display);font-weight:700;font-size:30px;line-height:1.05;margin:0 0 6px;text-wrap:balance;letter-spacing:-.01em}
.kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.persona{color:var(--ink-2);font-size:14px;margin:0}
.rail nav ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.rail nav a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;text-decoration:none;font-size:14px;color:var(--ink-2)}
.rail nav a:hover,.rail nav a:focus-visible{background:var(--surface);color:var(--ink);outline:none}
.dot{width:9px;height:9px;border-radius:50%;flex:none}
.dot[data-domain="agro"]{background:var(--agro)}.dot[data-domain="hacienda"]{background:var(--hacienda)}.dot[data-domain="plata"]{background:var(--plata)}.dot[data-domain="sistema"]{background:var(--sistema)}
.cnt{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;font-size:13px;color:var(--ink-2);margin:0;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.facts dt{color:var(--muted);font-size:11px;letter-spacing:.1em;text-transform:uppercase}
.facts dd{margin:0;font-variant-numeric:tabular-nums;font-weight:600;color:var(--ink)}
.notes{margin:0;padding-left:18px;font-size:13px;color:var(--ink-2)}
.notes li+li{margin-top:6px}
.prereq{border-left:3px solid var(--hacienda);padding:2px 0 2px 14px;font-size:13px;color:var(--ink-2)}
.prereq h3{margin:0 0 6px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink)}
.prereq ol{margin:0;padding-left:18px}
.prereq li+li{margin-top:4px}
.prereq code,.cmd{font-family:var(--mono);font-size:12px}
.cmd{display:block;white-space:pre;overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin-top:8px;color:var(--ink)}
main{display:flex;flex-direction:column;gap:44px;min-width:0}
.phase-head{display:grid;grid-template-columns:1fr auto;gap:2px 16px;align-items:baseline;margin-bottom:14px}
.domain{grid-column:1;font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
.phase[data-domain="agro"] .domain{color:var(--agro)}.phase[data-domain="hacienda"] .domain{color:var(--hacienda)}.phase[data-domain="plata"] .domain{color:var(--plata)}.phase[data-domain="sistema"] .domain{color:var(--sistema)}
.phase-head h2{grid-column:1;font-family:var(--display);font-weight:700;font-size:22px;margin:0;letter-spacing:-.01em;text-wrap:balance}
.why{grid-column:1;margin:4px 0 0;color:var(--ink-2);max-width:66ch}
.count{grid-column:2;grid-row:1/4;margin:0;color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.step{display:grid;grid-template-columns:34px minmax(0,1fr);gap:4px 12px;align-items:start}
.n{font-family:var(--mono);font-size:12px;color:var(--muted);padding-top:9px;text-align:right;font-variant-numeric:tabular-nums}
.bubble{grid-column:2;justify-self:start;max-width:62ch;background:var(--bubble);border-radius:14px 14px 14px 4px;padding:8px 13px;font-family:var(--mono);font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.bubble.tap{background:var(--bubble-tap);border-radius:8px;display:inline-flex;gap:8px;align-items:center}
.tapmark{font-family:var(--body);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--hacienda);font-weight:600}
.meta{grid-column:2;display:flex;flex-direction:column;gap:2px;padding-left:2px}
.checks{margin:0;color:var(--ink-2);font-size:13.5px;max-width:70ch}
.expects{margin:0;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);font-family:var(--mono)}
.rx b{font-family:var(--body);font-weight:600;color:var(--ink-2);margin-right:4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
@media (prefers-reduced-motion:no-preference){.phase{scroll-margin-top:16px}}
</style>
<div class="wrap">
  <aside class="rail">
    <div>
      <p class="kicker">Plan de QA · producción</p>
      <h1>${esc(plan.name.replace(/^QA E2E prod — /, ''))}</h1>
      <p class="persona">${esc(plan.persona)}</p>
    </div>
    <dl class="facts">
      <div><dt>Mensajes</dt><dd>${total}</dd></div>
      <div><dt>Fases</dt><dd>${plan.phases.length}</dd></div>
      <div><dt>Canal</dt><dd>test-bot prod</dd></div>
      <div><dt>Costo IA est.</dt><dd>≈ USD 0,40</dd></div>
    </dl>
    <nav><ol>${nav}</ol></nav>
    <ul class="notes">${notes}</ul>
    <div class="prereq">
      <h3>Antes de correr</h3>
      <ol>
        <li>Cuenta <b>admin de QA</b> en prod con plan Enterprise (el test-bot en prod solo acepta admins; agro y hacienda son Pro+).</li>
        <li>Vacía: el runner hace <code>reset</code> de esa cuenta al arrancar. Nunca usar una cuenta real.</li>
        <li>Se corre con <code>--run</code> y deja el reporte en <code>qa-reports/</code>.</li>
      </ol>
      <code class="cmd">TEST_BOT_URL=https://campo-bot-production.up.railway.app
QA_EMAIL=qa-e2e@campobot.ar  QA_PASSWORD=…
npx tsx src/testing/qa-prod-e2e.ts --run${planSlug === 'qa-prod-e2e' ? '' : ` --plan src/testing/${esc(basename(planPath))}`}</code>
    </div>
  </aside>
  <main>${phases}</main>
</div>`;
}

const htmlOut = arg('--html');
if (htmlOut) {
  mkdirSync(dirname(htmlOut), { recursive: true });
  writeFileSync(htmlOut, renderHtml(), 'utf-8');
  console.log(`Plan rendido en ${htmlOut}`);
} else if (args.includes('--run')) {
  run().catch(err => { console.error('Error:', err.message); process.exit(1); });
} else {
  console.log('Usage: --html <out.html> | --run [--from <fase>] [--no-reset]');
}
