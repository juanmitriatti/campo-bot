import type { Scenario, Assertion, AssertContext } from '../types.js';
import { dbExpense, dbNone, dbRowCount, dbActivity, dbLivestockCount } from '../db-assertions.js';
import { botAsked, botDidNotAsk } from '../response-assertions.js';

const FIELD_SEED = [
  { send: 'agregar campo La Esperanza' },
  { tap: 'flow_field_loc_city' },
  { send: 'Pergamino' },
  { tap: 'flow_confirm' },
  { send: 'agregar lote Norte al campo La Esperanza' },
  { send: '150' },
  { send: 'sembré soja en el lote Norte' },
];

export const WRITTEN_CORE: Scenario[] = [
  {
    // Mirrors adv30 test 17 (a FALSE-FAIL under the old substring suite): a visual
    // observation must be stored as an observation (agro_observations), NOT trigger an
    // agronomic activity (no spraying/fertilization domain_event).
    id: 'obs-not-activity',
    source: 'written',
    domains: ['observaciones'],
    axes: ['comprension'],
    seed: FIELD_SEED,
    turns: [{ send: 'la soja del norte está un poco amarilla' }],
    assert: [
      dbNone('domain_events', { event_type: 'spraying' }),
      dbNone('domain_events', { event_type: 'fertilization' }),
      // agro_observations has no deleted_at → includeDeleted:true is required.
      dbRowCount('agro_observations', {}, 1, { includeDeleted: true }),
    ],
  },
  {
    // Over-asking axis: a fully-specified expense (single plot) must register WITHOUT a
    // clarifying question for MISSING DATA (plot/category/amount). The bot shows a
    // confirmation dialog (expected UX), the user confirms, and the expense is saved.
    // botDidNotAsk() is tested on the post-confirm response, which must be a plain receipt.
    id: 'expense-complete-no-ask',
    source: 'written',
    domains: ['gastos'],
    axes: ['repreguntas'],
    seed: FIELD_SEED,
    turns: [
      { send: 'gasté 50000 en gasoil' },
      { tap: 'confirm_pending' },
    ],
    assert: [
      botDidNotAsk(),
      dbExpense({ amount: 50000, category: 'Combustible' }),
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // SCENARIO 1: pronoun "ahí mismo" resolves to previous plot
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'context-pronoun-same-plot',
    source: 'written',
    domains: ['actividades'],
    axes: ['contexto'],
    seed: FIELD_SEED,
    turns: [
      { send: 'fumigué el lote Norte con glifosato 2 lt/ha' },
      { send: 'y fertilicé ahí mismo con urea 100 kg/ha' },
    ],
    assert: [
      // Both activities must land on plot Norte
      dbActivity({ eventType: 'spraying', plotName: 'Norte' }),
      dbActivity({ eventType: 'fertilization', plotName: 'Norte' }),
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // SCENARIO 2: agro verb WITHOUT amount → activity only, no expense
  // The agent may ask for quantity (pending flow is acceptable), then registers.
  // Provide the quantity so we get a final DB check, OR verify no expense is created.
  // Key invariant: an agro verb without "$" must NEVER create an expense row.
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'comprension-expense-vs-activity',
    source: 'written',
    domains: ['actividades', 'gastos'],
    axes: ['comprension'],
    seed: FIELD_SEED,
    turns: [
      { send: 'fumigué Norte con glifosato 2 lt/ha' },
    ],
    assert: [
      dbActivity({ eventType: 'spraying', plotName: 'Norte' }),
      dbNone('expenses', {}),
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // SCENARIO 3: livestock sale reduces count + creates income
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'comprension-livestock-no-ghost',
    source: 'written',
    domains: ['hacienda'],
    axes: ['comprension'],
    seed: [
      ...FIELD_SEED,
      { send: 'agregué 20 vacas Angus al lote Norte' },
    ],
    turns: [
      { send: 'vendí 5 vacas a 1000 USD c/u' },
    ],
    assert: [
      // 20 - 5 = 15 vacas remaining
      dbLivestockCount({ category: 'vaca', count: 15 }),
      // The sale creates one income row with category Hacienda
      dbRowCount('incomes', { category: 'Hacienda' }, 1),
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // SCENARIO 4: income with unit price (20 tn × 300 USD = 6000 USD)
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'comprension-income-unit-price',
    source: 'written',
    domains: ['ingresos'],
    axes: ['comprension'],
    seed: FIELD_SEED,
    turns: [
      { send: 'vendí 20 tn de soja a 300 usd' },
      // confirm if a confirmation dialog appears (single-action income shows confirm dialog)
      { tap: 'confirm_pending' },
    ],
    assert: [
      dbRowCount('incomes', { amount: 6000, currency: 'USD' }, 1),
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // SCENARIO 5: sow without crop name → bot asks for the crop
  // Uses "Sur" plot (no existing crop) to avoid ambiguity with Norte (soja already sown).
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'repreguntas-missing-crop-asks',
    source: 'written',
    domains: ['siembra'],
    axes: ['repreguntas'],
    seed: [
      ...FIELD_SEED,
      { send: 'agregar lote Sur al campo La Esperanza' },
      { send: '80' },
    ],
    turns: [
      { send: 'sembré 10 ha en el lote Sur' },
    ],
    assert: [
      // The bot must ask which crop was sown — it should NOT invent one
      botAsked(),
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // SCENARIO 6 (skipped — duplicate of expense-complete-no-ask):
  // repreguntas-expense-complete-no-ask is already covered above.
  // ──────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────
  // SCENARIO 7: a query turn must not create a new expense
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'context-followup-query',
    source: 'written',
    domains: ['gastos', 'reportes'],
    axes: ['contexto'],
    seed: [
      ...FIELD_SEED,
      { send: 'gasté 30000 en gasoil' },
      { tap: 'confirm_pending' },
    ],
    turns: [
      { send: '¿cuánto gasté?' },
    ],
    assert: [
      // The query turn must NOT create a second expense; exactly 1 expense remains
      dbRowCount('expenses', {}, 1),
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // SCENARIO 8: compound multi-verb → 3 different domains in one message
  // In bulk mode a confirm dialog is NOT shown; records are saved directly.
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'compound-multi-verb',
    source: 'written',
    domains: ['gastos', 'actividades', 'hacienda'],
    axes: ['comprension'],
    seed: FIELD_SEED,
    turns: [
      { send: 'gasté 50 mil en gasoil, fumigué Norte con glifosato 3 lt/ha y agregué 10 vaquillonas Angus en Norte' },
    ],
    assert: [
      dbExpense({ amount: 50000 }),
      dbActivity({ eventType: 'spraying', plotName: 'Norte' }),
      dbLivestockCount({ category: 'vaquillona', count: 10 }),
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // SCENARIO 9: "ayer gasté" → relative date resolved; expense_date = yesterday
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'context-temporal-ayer',
    source: 'written',
    domains: ['gastos'],
    axes: ['contexto', 'temporal'],
    seed: FIELD_SEED,
    turns: [
      { send: 'ayer gasté 30000 en gasoil' },
      { tap: 'confirm_pending' },
    ],
    assert: [
      dbRowCount('expenses', { amount: 30000 }, 1),
      // Custom: verify expense_date is strictly before today (i.e. yesterday in AR time)
      {
        label: 'expense_date == yesterday',
        run: async (ctx: AssertContext) => {
          const rows = await ctx.query(
            'SELECT expense_date::text AS expense_date FROM expenses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
            [ctx.userId],
          );
          const d = rows[0]?.expense_date as string | undefined;
          // Compare as ISO date strings (YYYY-MM-DD). AR "today" may be UTC yesterday, so
          // we compare against Argentina date: UTC-3.
          const nowAR = new Date(Date.now() - 3 * 60 * 60 * 1000);
          const todayAR = nowAR.toISOString().slice(0, 10);
          const ok = !!d && d < todayAR;
          return { ok, detail: `expense_date=${d}, todayAR=${todayAR}` };
        },
      } satisfies Assertion,
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // SCENARIO 10: stock entry with a named warehouse → stock_items row created
  // ──────────────────────────────────────────────────────────────────
  {
    id: 'repreguntas-stock-complete',
    source: 'written',
    domains: ['stock'],
    axes: ['repreguntas'],
    seed: [
      ...FIELD_SEED,
      { send: 'crear galpón Principal' },
    ],
    turns: [
      { send: 'agregué 100 bolsas de urea al galpón Principal' },
    ],
    assert: [
      dbRowCount('stock_items', {}, 1),
    ],
  },
];
