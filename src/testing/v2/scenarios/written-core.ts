import type { Scenario } from '../types.js';
import { dbExpense, dbNone, dbRowCount } from '../db-assertions.js';
import { botDidNotAsk } from '../response-assertions.js';

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
];
