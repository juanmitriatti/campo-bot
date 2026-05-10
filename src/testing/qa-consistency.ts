/**
 * QA Bot-Says-vs-Bot-Does Consistency Tester
 *
 * Compares what the bot SAYS in its response vs what actually happened in the
 * DB after the action. Catches bugs like:
 *   - "📦 Stock actualizado +10 lt" but the row never persisted
 *   - "Cosecha 4500 kg/ha" but plot_crops.yield_kg = 0 (rate not applied)
 *   - "Lote A1 — 50 ha" but plots.area_hectares = NULL
 *   - "Compré 100 vacas a $600k" but no linked expense was created
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-consistency.ts
 *      ONLY=01,03 npx tsx src/testing/qa-consistency.ts
 */

import { writeFileSync } from 'node:fs';

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'testin@gmail.com';
const PASSWORD = 'tester123';
const NAME = 'Consistency';

// ============= API HELPERS =============

async function apiLogin(): Promise<{ token: string; userId: number }> {
  let res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'QA', email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  }
  const d = await res.json() as any;
  return { token: d.tokens.accessToken, userId: d.user.id };
}
async function apiReset(token: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test-bot/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: '{}',
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}
async function apiSend(token: string, message: string): Promise<{ text: string; raw: any }> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  const d = await res.json() as any;
  let text = '';
  for (const m of d.messages || []) {
    if (m.text) text += m.text + '\n';
    if (m.interactive?.body) text += m.interactive.body + '\n';
  }
  return { text: text.trim(), raw: d };
}
async function apiTap(token: string, buttonId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status}`);
  const d = await res.json() as any;
  let text = '';
  for (const m of d.messages || []) {
    if (m.text) text += m.text + '\n';
  }
  return text.trim();
}
async function apiDb(token: string, sql: string, params: any[] = []): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  return ((await res.json() as any).rows || []);
}

let TOKEN = '';
let USER_ID = 0;

// ============= ASSERTIONS =============

interface Assertion {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
}

interface ConsistencyResult {
  id: string;
  name: string;
  category: string;
  bot_response: string;
  db_state_excerpt: string;
  asserts: Assertion[];
  status: 'CONSISTENT' | 'INCONSISTENT' | 'PARTIAL';
}

function expect(name: string, expected: any, actual: any): Assertion {
  const e = String(expected);
  const a = String(actual);
  return { name, pass: e === a, expected: e, actual: a };
}
function expectIncludes(name: string, haystack: string, needle: string): Assertion {
  return { name, pass: haystack.includes(needle), expected: `contains "${needle}"`, actual: haystack.slice(0, 80) };
}
function expectGTE(name: string, value: number, min: number): Assertion {
  return { name, pass: value >= min, expected: `>= ${min}`, actual: String(value) };
}

// ============= SETUP =============

async function setup(): Promise<void> {
  console.log('  Setup: reset + create field + 1 plot of 50ha...');
  await apiReset(TOKEN);
  await apiSend(TOKEN, 'agregar campo Consistency en Pergamino');
  await apiSend(TOKEN, 'agregar lote A1 al campo Consistency');
  await apiSend(TOKEN, '50');
  console.log('    ✓ field=Consistency, plot=A1 (50ha)');
}

// ============= TEST CASES =============

interface TestCase {
  id: string;
  name: string;
  category: string;
  run: () => Promise<ConsistencyResult>;
}

const TESTS: TestCase[] = [
  // ── A. STOCK CONSISTENCY ──
  {
    id: '01',
    name: 'add_stock with unit price → stock + linked expense',
    category: 'stock',
    run: async () => {
      const { text } = await apiSend(TOKEN, 'compré 100 lt de glifosato a 2000 c/u en Consistency');
      const items = await apiDb(TOKEN, `SELECT * FROM stock_items WHERE user_id=$1 AND name ILIKE 'glifosato'`, [USER_ID]);
      const moves = await apiDb(TOKEN, `SELECT * FROM stock_movements WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [USER_ID]);
      const exps = await apiDb(TOKEN, `SELECT * FROM expenses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [USER_ID]);
      const asserts: Assertion[] = [
        expectIncludes('bot-says-100-lt', text, '100 lt'),
        expectIncludes('bot-says-gasto-200000', text, '200.000'),
        expect('db-stock-items-count', 1, items.length),
        expect('db-stock-quantity', 100, Number(items[0]?.current_quantity)),
        expect('db-stock-movement-quantity', 100, Number(moves[0]?.quantity)),
        expect('db-stock-movement-type', 'entrada', moves[0]?.movement_type),
        expect('db-expense-amount', 200000, Number(exps[0]?.amount)),
        expect('db-stock-movement-linked-to-expense', exps[0]?.id, moves[0]?.expense_id),
      ];
      const passed = asserts.every(a => a.pass);
      return {
        id: '01', name: 'add_stock + linked expense', category: 'stock',
        bot_response: text.slice(0, 200),
        db_state_excerpt: `stock=${items[0]?.current_quantity}lt, mov=${moves[0]?.quantity}/${moves[0]?.movement_type}, expense=$${exps[0]?.amount} (id=${exps[0]?.id}, mov.expense_id=${moves[0]?.expense_id})`,
        asserts, status: passed ? 'CONSISTENT' : (asserts.filter(a => a.pass).length >= asserts.length / 2 ? 'PARTIAL' : 'INCONSISTENT'),
      };
    },
  },

  // ── B. HARVEST YIELD COMPUTATION ──
  {
    id: '02',
    name: 'harvest with kg/ha → plot_crops.yield_kg = rate × area',
    category: 'harvest',
    run: async () => {
      // First sembrar
      await apiSend(TOKEN, 'sembré soja en A1');
      const cosechaResp = await apiSend(TOKEN, 'coseché soja en A1, 4500 kg/ha');
      // skip silo prompt if any
      const r = cosechaResp.raw;
      for (const m of r.messages || []) {
        if (m.interactive?.buttons) {
          const noBtn = m.interactive.buttons.find((b: any) => b.id?.startsWith('stock_grain_no_'));
          if (noBtn) await apiTap(TOKEN, noBtn.id);
        }
      }
      const text = cosechaResp.text;
      const crop = await apiDb(TOKEN, `SELECT pc.* FROM plot_crops pc JOIN plots p ON p.id=pc.plot_id JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND pc.crop='soja' ORDER BY pc.id DESC LIMIT 1`, [USER_ID]);
      const expectedYield = 4500 * 50; // 225,000
      const asserts: Assertion[] = [
        expectIncludes('bot-says-225k', text, '225.000'),
        expectIncludes('bot-says-4500-kg-ha', text, '4.500 kg/ha'),
        expect('db-yield-kg', expectedYield, Number(crop[0]?.yield_kg)),
        expect('db-crop', 'soja', crop[0]?.crop),
      ];
      const passed = asserts.every(a => a.pass);
      return {
        id: '02', name: 'harvest yield rate→total', category: 'harvest',
        bot_response: text.slice(0, 200),
        db_state_excerpt: `plot_crops.yield_kg=${crop[0]?.yield_kg} (esperado ${expectedYield})`,
        asserts, status: passed ? 'CONSISTENT' : (asserts.filter(a => a.pass).length >= asserts.length / 2 ? 'PARTIAL' : 'INCONSISTENT'),
      };
    },
  },

  // ── C. RAINFALL ──
  {
    id: '03',
    name: 'rainfall says X mm → rainfall row has X mm in correct field',
    category: 'rainfall',
    run: async () => {
      const { text } = await apiSend(TOKEN, 'llovieron 25mm');
      const rain = await apiDb(TOKEN, `SELECT r.*, f.name AS field_name FROM rainfall r JOIN fields f ON f.id=r.field_id WHERE r.user_id=$1 ORDER BY r.id DESC LIMIT 1`, [USER_ID]);
      const asserts: Assertion[] = [
        expectIncludes('bot-says-25mm', text, '25mm'),
        expect('db-mm', 25, Number(rain[0]?.millimeters)),
        expectIncludes('db-field-consistency', String(rain[0]?.field_name).toLowerCase(), 'consistency'),
      ];
      const passed = asserts.every(a => a.pass);
      return {
        id: '03', name: 'rainfall mm consistency', category: 'rainfall',
        bot_response: text.slice(0, 200),
        db_state_excerpt: `rainfall.mm=${rain[0]?.mm}, field=${rain[0]?.field_name}`,
        asserts, status: passed ? 'CONSISTENT' : (asserts.filter(a => a.pass).length >= asserts.length / 2 ? 'PARTIAL' : 'INCONSISTENT'),
      };
    },
  },

  // ── D. PLOT AREA ──
  {
    id: '04',
    name: 'agregar lotes batch with "de N ha cada uno" → plots.area_hectares = N',
    category: 'plots',
    run: async () => {
      // Use NEW field to keep test isolated
      await apiSend(TOKEN, 'agregar campo BatchTest en Pergamino');
      const { text } = await apiSend(TOKEN, 'agregar lotes B1, B2, B3 al campo BatchTest de 80 ha cada uno');
      const plots = await apiDb(TOKEN, `SELECT p.name, p.area_hectares FROM plots p JOIN fields f ON f.id=p.field_id WHERE f.user_id=$1 AND f.name ILIKE 'batchtest' ORDER BY p.name`, [USER_ID]);
      const asserts: Assertion[] = [
        expectIncludes('bot-says-80-ha', text, '80 ha'),
        expect('db-3-plots', 3, plots.length),
        expect('db-B1-area', 80, Number(plots[0]?.area_hectares)),
        expect('db-B2-area', 80, Number(plots[1]?.area_hectares)),
        expect('db-B3-area', 80, Number(plots[2]?.area_hectares)),
      ];
      const passed = asserts.every(a => a.pass);
      return {
        id: '04', name: 'batch plot area persisted', category: 'plots',
        bot_response: text.slice(0, 200),
        db_state_excerpt: `plots: ${plots.map(p => `${p.name}=${p.area_hectares}ha`).join(', ')}`,
        asserts, status: passed ? 'CONSISTENT' : (asserts.filter(a => a.pass).length >= asserts.length / 2 ? 'PARTIAL' : 'INCONSISTENT'),
      };
    },
  },

  // ── E. LIVESTOCK + LINKED EXPENSE ──
  {
    id: '05',
    name: 'compré N vacas a $X → livestock_groups + linked expense',
    category: 'livestock',
    run: async () => {
      const { text } = await apiSend(TOKEN, 'compré 50 vacas Angus a 600 mil c/u en A1');
      const groups = await apiDb(TOKEN, `SELECT * FROM livestock_groups WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [USER_ID]);
      const moves = await apiDb(TOKEN, `SELECT * FROM livestock_movements WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [USER_ID]);
      const exps = await apiDb(TOKEN, `SELECT * FROM expenses WHERE user_id=$1 AND deleted_at IS NULL AND id=$2`, [USER_ID, moves[0]?.linked_expense_id]);
      const asserts: Assertion[] = [
        expectIncludes('bot-says-50', text, '50'),
        expectIncludes('bot-says-vaca', text.toLowerCase(), 'vaca'),
        expect('db-livestock-count', 50, Number(groups[0]?.count)),
        expect('db-movement-count', 50, Number(moves[0]?.count)),
        expect('db-movement-has-expense-link', true, moves[0]?.linked_expense_id != null),
        expect('db-linked-expense-amount', 30000000, Number(exps[0]?.amount)), // 50 × 600,000
      ];
      const passed = asserts.every(a => a.pass);
      return {
        id: '05', name: 'livestock purchase + linked expense', category: 'livestock',
        bot_response: text.slice(0, 200),
        db_state_excerpt: `livestock.qty=${groups[0]?.quantity}, mov.qty=${moves[0]?.quantity}, mov.linked_expense=${moves[0]?.linked_expense_id}, exp.amount=${exps[0]?.amount}`,
        asserts, status: passed ? 'CONSISTENT' : (asserts.filter(a => a.pass).length >= asserts.length / 2 ? 'PARTIAL' : 'INCONSISTENT'),
      };
    },
  },

  // ── F. INCOME (USD → ARS) ──
  {
    id: '06',
    name: 'vendí en USD → income.amount + currency persisted',
    category: 'income',
    run: async () => {
      const r1 = await apiSend(TOKEN, 'vendí 30 tn de soja a 300 dólares en A1');
      let text = r1.text;
      let raw = r1.raw;
      // Handle confirmation step (income has a "¿Confirmo?" guard)
      const findConfirmBtn = (r: any): string | null => {
        for (const m of r.messages || []) {
          for (const b of (m.interactive?.buttons || [])) {
            if (typeof b.id === 'string' && b.id.startsWith('confirm_pending')) return b.id;
          }
        }
        return null;
      };
      const confirmId = findConfirmBtn(raw);
      if (confirmId) {
        const tapText = await apiTap(TOKEN, confirmId);
        text = tapText;
      } else if (/¿confirm/i.test(text)) {
        // Fallback: tap "si"
        const r2 = await apiSend(TOKEN, 'si');
        text = r2.text;
      }
      const inc = await apiDb(TOKEN, `SELECT * FROM incomes WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [USER_ID]);
      const expectedUsd = 30 * 300; // 9000 USD
      const asserts: Assertion[] = [
        expectIncludes('bot-says-9000-or-9-mil', text, '9'),
        expect('db-amount', expectedUsd, Number(inc[0]?.amount)),
        expect('db-currency', 'USD', inc[0]?.currency),
        expect('db-category', 'Soja', inc[0]?.category),
      ];
      const passed = asserts.every(a => a.pass);
      return {
        id: '06', name: 'USD income persisted correctly', category: 'income',
        bot_response: text.slice(0, 200),
        db_state_excerpt: `income.amount=${inc[0]?.amount}, currency=${inc[0]?.currency}, category=${inc[0]?.category}`,
        asserts, status: passed ? 'CONSISTENT' : (asserts.filter(a => a.pass).length >= asserts.length / 2 ? 'PARTIAL' : 'INCONSISTENT'),
      };
    },
  },
];

// ============= MAIN =============

async function main() {
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(s => s.trim())) : null;

  console.log('\n=== QA Consistency Tester (bot-says vs bot-does) ===');
  console.log(`Target: ${BASE_URL}`);
  const auth = await apiLogin();
  TOKEN = auth.token; USER_ID = auth.userId;
  console.log(`User id: ${USER_ID}`);

  await setup();

  const subset = only ? TESTS.filter(t => only.has(t.id)) : TESTS;
  console.log(`\nRunning ${subset.length} consistency tests...\n`);

  const results: ConsistencyResult[] = [];
  for (const t of subset) {
    process.stdout.write(`[${t.id}] ${t.name.padEnd(55)}`);
    try {
      const r = await t.run();
      results.push(r);
      const icon = { CONSISTENT: '✅', PARTIAL: '🟨', INCONSISTENT: '❌' }[r.status];
      const pass = r.asserts.filter(a => a.pass).length;
      console.log(`${icon} ${r.status.padEnd(13)} (${pass}/${r.asserts.length} asserts)`);
    } catch (e: any) {
      console.log(`❌ ERROR: ${e.message}`);
      results.push({
        id: t.id, name: t.name, category: t.category,
        bot_response: '(crash)', db_state_excerpt: e.message,
        asserts: [], status: 'INCONSISTENT',
      });
    }
  }

  // Detailed report
  console.log('\n\n=== DETAILED REPORT ===\n');
  for (const r of results) {
    const icon = { CONSISTENT: '✅', PARTIAL: '🟨', INCONSISTENT: '❌' }[r.status];
    console.log(`${icon} [${r.id}] ${r.name}`);
    console.log(`  Bot dijo : ${r.bot_response.replace(/\n/g, ' ').slice(0, 140)}`);
    console.log(`  DB tiene : ${r.db_state_excerpt}`);
    for (const a of r.asserts.filter(x => !x.pass)) {
      console.log(`    ❌ ${a.name}: expected=${a.expected}, actual=${a.actual}`);
    }
    console.log();
  }

  const totals = { CONSISTENT: 0, PARTIAL: 0, INCONSISTENT: 0 };
  for (const r of results) totals[r.status]++;
  console.log(`SUMMARY: ✅ ${totals.CONSISTENT}  🟨 ${totals.PARTIAL}  ❌ ${totals.INCONSISTENT}`);

  writeFileSync('src/testing/qa-consistency-results.json', JSON.stringify(results, null, 2));
  console.log(`\nFull results → src/testing/qa-consistency-results.json`);

  if (totals.INCONSISTENT > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
