import { describe, it, expect, vi } from 'vitest';
import { SystemHandler } from '../system.handler.js';

// --- Mocks to prevent DB / external calls ---

vi.mock('../../users/user.repository.js', () => ({
  UserRepository: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../billing/plan.repository.js', () => ({
  PlanRepository: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../config/db.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock('../help-text.js', () => ({
  buildHelpText: vi.fn().mockReturnValue('help'),
  buildHelpMenu: vi.fn().mockReturnValue({ message: 'help', interactive: null }),
  HELP_SECTIONS: {},
}));

vi.mock('../../../services/localidad-lookup.service.js', () => ({
  localidadLookup: vi.fn(),
}));

vi.mock('../../../middleware/pending-field-city-handler.js', () => ({
  formatLocation: vi.fn(),
}));

vi.mock('../../../services/settings.service.js', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../utils/template.js', () => ({
  interpolate: vi.fn().mockReturnValue(''),
}));

vi.mock('../../../services/error-logger.js', () => ({
  logError: vi.fn(),
}));

vi.mock('../../../services/grain-price.service.js', () => ({
  GrainPriceService: vi.fn().mockImplementation(() => ({
    fetchAll: vi.fn().mockResolvedValue([]),
  })),
  formatGrainBoard: vi.fn().mockReturnValue(''),
  normalizeGrainCrop: vi.fn().mockReturnValue(null),
}));

// --- Helpers ---

const { UserRepository } = await import('../../users/user.repository.js');
const handler = new SystemHandler(new (UserRepository as never)());

const fakeUser = { id: 1, name: 'Pepe', phone: '549341000', telegram_id: null } as never;
const fakeSettings = {} as never;

// ============================================================================
// open_form picker
// ============================================================================

describe('SystemHandler — open_form picker', () => {
  it('open_form devuelve messages:[] + lista con los 6 formularios (WhatsApp admite 3 botones)', async () => {
    const result = await handler.handleCommand({ command: 'open_form' }, 1, fakeUser, fakeSettings);
    expect(result.messages).toEqual([]);
    const interactive = result.interactive as {
      type: string;
      sections: Array<{ rows: Array<{ id: string; title: string }> }>;
    };
    expect(interactive.type).toBe('list');
    const ids = interactive.sections.flatMap(s => s.rows.map(r => r.id));
    expect(ids).toEqual([
      'form_open_sow', 'form_open_harvest', 'form_open_expense',
      'form_open_income', 'form_open_activity', 'form_open_livestock',
    ]);
  });

  it('open_form_sow devuelve sideEffects.offerForm con action sow_crop', async () => {
    const result = await handler.handleCommand({ command: 'open_form_sow' }, 1, fakeUser, fakeSettings);
    expect(result.messages).toHaveLength(1);
    expect(result.sideEffects?.offerForm?.action).toBe('sow_crop');
    expect(result.sideEffects?.offerForm?.prefill).toEqual({});
  });

  it('open_form_harvest devuelve sideEffects.offerForm con action harvest_crop', async () => {
    const result = await handler.handleCommand({ command: 'open_form_harvest' }, 1, fakeUser, fakeSettings);
    expect(result.messages).toHaveLength(1);
    expect(result.sideEffects?.offerForm?.action).toBe('harvest_crop');
    expect(result.sideEffects?.offerForm?.prefill).toEqual({});
  });
});
