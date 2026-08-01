import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationEngine } from '../conversation-engine.js';
import { FlowRegistry } from '../flows/flow-registry.js';
import type { FlowContext, FlowState, UserId, HandlerResponse } from '../../types/index.js';
import type { FlowDefinition, FlowStep } from '../flows/flow.interface.js';

// --- Mock state repository ---

function createMockStateRepo() {
  let stored: FlowContext = { state: 'idle', step: 0, data: {}, startedAt: null, expiresAt: null };
  return {
    getFlowContext: vi.fn(async () => ({ ...stored })),
    setFlowContext: vi.fn(async (_userId: UserId, ctx: FlowContext) => { stored = { ...ctx }; }),
    clearFlow: vi.fn(async () => { stored = { state: 'idle', step: 0, data: {}, startedAt: null, expiresAt: null }; }),
    _getStored: () => stored,
  };
}

// --- Test flow definition ---

function createTestFlow(): FlowDefinition {
  return {
    id: 'expense_flow',
    name: 'Test Expense',
    steps: [
      {
        field: 'amount',
        prompt: '¿Cuánto?',
        validate: (input) => {
          const num = parseFloat(input);
          if (isNaN(num) || num <= 0) return { error: 'Monto inválido.' };
          return { value: num };
        },
      },
      {
        field: 'category',
        prompt: '¿Categoría?',
        validate: (input) => {
          if (!['Combustible', 'Semillas'].includes(input)) return { error: 'Categoría no válida.' };
          return { value: input };
        },
      },
      {
        field: 'fieldName',
        prompt: '¿Campo?',
        validate: (input) => ({ value: input || null }),
        optional: true,
      },
    ],
    buildConfirmation: (data) => ({
      messages: [`Confirmar: $${data.amount} en ${data.category}`],
      interactive: {
        type: 'buttons',
        body: '¿Confirmamos?',
        buttons: [
          { id: 'flow_confirm', title: 'Confirmar' },
          { id: 'flow_cancel', title: 'Cancelar' },
        ],
      },
    }),
    execute: vi.fn(async () => ({
      messages: ['Gasto guardado.'],
    })),
  };
}

// --- Test flow with interactive steps ---

function createInteractiveFlow(): FlowDefinition {
  return {
    id: 'interactive_flow',
    name: 'Test Interactive',
    steps: [
      {
        field: 'category',
        prompt: '¿Categoría?\n1. Combustible\n2. Semillas\nEscribí el nombre o número.',
        interactive: {
          type: 'list',
          body: '¿Categoría?',
          buttonText: 'Elegir',
          sections: [{
            title: 'Categorías',
            rows: [
              { id: 'cat_combustible', title: 'Combustible' },
              { id: 'cat_semillas', title: 'Semillas' },
            ],
          }],
        },
        validate: (input) => {
          if (!['Combustible', 'Semillas'].includes(input)) return { error: 'Categoría no válida.' };
          return { value: input };
        },
      },
      {
        field: 'amount',
        prompt: '¿Cuánto?',
        // No interactive — text-only step
        validate: (input) => {
          const num = parseFloat(input);
          if (isNaN(num) || num <= 0) return { error: 'Monto inválido.' };
          return { value: num };
        },
      },
    ],
    buildConfirmation: (data) => ({
      messages: [`Confirmar: $${data.amount} en ${data.category}`],
      interactive: {
        type: 'buttons',
        body: '¿Confirmamos?',
        buttons: [
          { id: 'flow_confirm', title: 'Confirmar' },
          { id: 'flow_cancel', title: 'Cancelar' },
        ],
      },
    }),
    execute: vi.fn(async () => ({ messages: ['Guardado.'] })),
  };
}

const userId = 1 as UserId;

describe('ConversationEngine', () => {
  let stateRepo: ReturnType<typeof createMockStateRepo>;
  let registry: FlowRegistry;
  let engine: ConversationEngine;
  let testFlow: FlowDefinition;

  beforeEach(() => {
    stateRepo = createMockStateRepo();
    registry = new FlowRegistry();
    testFlow = createTestFlow();
    registry.register(testFlow);
    engine = new ConversationEngine(stateRepo as any, registry);
  });

  // --- Flow lifecycle ---

  describe('startFlow', () => {
    it('starts at first step and returns prompt', async () => {
      const result = await engine.startFlow(userId, 'expense_flow');
      expect(result.response.messages[0]).toBe('¿Cuánto?');
      expect(result.nextContext?.state).toBe('expense_flow');
      expect(result.nextContext?.step).toBe(0);
    });

    it('skips prefilled steps', async () => {
      const result = await engine.startFlow(userId, 'expense_flow', { amount: 5000 });
      expect(result.response.messages[0]).toBe('¿Categoría?');
      expect(result.nextContext?.step).toBe(1);
    });

    it('goes directly to confirmation if all steps prefilled', async () => {
      const result = await engine.startFlow(userId, 'expense_flow', {
        amount: 5000,
        category: 'Combustible',
        fieldName: 'test',
      });
      expect(result.nextContext?.state).toBe('confirming');
      expect(result.response.messages[0]).toContain('Confirmar');
    });

    it('returns error for unknown flow', async () => {
      const result = await engine.startFlow(userId, 'nonexistent_flow' as FlowState);
      expect(result.response.messages[0]).toBe('Flujo no disponible.');
      expect(result.nextContext).toBeNull();
    });
  });

  describe('processFlowMessage', () => {
    it('validates input and advances to next step', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      const ctx = startResult.nextContext!;

      const result = await engine.processFlowMessage(userId, '5000', ctx);
      expect(result.nextContext?.step).toBe(1);
      expect(result.nextContext?.data.amount).toBe(5000);
      expect(result.response.messages[0]).toBe('¿Categoría?');
    });

    it('rejects invalid input with merged error + prompt', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      const ctx = startResult.nextContext!;

      const result = await engine.processFlowMessage(userId, 'abc', ctx);
      expect(result.response.messages).toHaveLength(1);
      expect(result.response.messages[0]).toContain('Monto inválido.');
      expect(result.response.messages[0]).toContain('¿Cuánto?');
      expect(result.nextContext?.step).toBe(0); // stays at same step
    });

    it('reaches confirmation after all steps', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      let ctx = startResult.nextContext!;

      // Step 1: amount
      let result = await engine.processFlowMessage(userId, '5000', ctx);
      ctx = result.nextContext!;

      // Step 2: category
      result = await engine.processFlowMessage(userId, 'Combustible', ctx);
      ctx = result.nextContext!;

      // Step 3: fieldName (optional)
      result = await engine.processFlowMessage(userId, 'La Esperanza', ctx);
      expect(result.nextContext?.state).toBe('confirming');
    });

    it('handles confirming state with SI', async () => {
      const ctx: FlowContext = {
        state: 'confirming',
        step: 3,
        data: { amount: 5000, category: 'Combustible', fieldName: 'test' },
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
        originFlow: 'expense_flow',
      };

      const result = await engine.processFlowMessage(userId, 'si', ctx);
      expect(result.nextContext).toBeNull();
      expect(testFlow.execute).toHaveBeenCalled();
    });

    it('rejects non-confirm text in confirming state', async () => {
      const ctx: FlowContext = {
        state: 'confirming',
        step: 3,
        data: { amount: 5000, category: 'Combustible' },
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
        originFlow: 'expense_flow',
      };

      const result = await engine.processFlowMessage(userId, 'hmm', ctx);
      expect(result.response.messages[0]).toContain('SI');
      expect(result.nextContext?.state).toBe('confirming');
    });
  });

  // --- stepFailCount ---

  describe('stepFailCount', () => {
    it('increments on validation failure', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      let ctx = startResult.nextContext!;
      expect(ctx.stepFailCount).toBe(0);

      const r1 = await engine.processFlowMessage(userId, 'abc', ctx);
      expect(r1.nextContext?.stepFailCount).toBe(1);

      const r2 = await engine.processFlowMessage(userId, 'xyz', r1.nextContext!);
      expect(r2.nextContext?.stepFailCount).toBe(2);
    });

    it('resets on successful validation', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      let ctx = startResult.nextContext!;

      // Fail once
      const r1 = await engine.processFlowMessage(userId, 'abc', ctx);
      expect(r1.nextContext?.stepFailCount).toBe(1);

      // Succeed
      const r2 = await engine.processFlowMessage(userId, '5000', r1.nextContext!);
      expect(r2.nextContext?.stepFailCount).toBe(0);
    });

    it('adds hint after 3 failures', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      let ctx = startResult.nextContext!;

      let result = await engine.processFlowMessage(userId, 'bad', ctx);
      result = await engine.processFlowMessage(userId, 'bad', result.nextContext!);
      result = await engine.processFlowMessage(userId, 'bad', result.nextContext!);

      expect(result.response.messages[0]).toContain('cancelar');
    });
  });

  // --- Flow state recovery ---

  describe('flow state recovery', () => {
    it('auto-clears unknown flow state in getFlowContext', async () => {
      stateRepo.getFlowContext.mockResolvedValueOnce({
        state: 'nonexistent_flow' as FlowState,
        step: 0,
        data: {},
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
      });

      const ctx = await engine.getFlowContext(userId);
      expect(ctx.state).toBe('idle');
      expect(stateRepo.clearFlow).toHaveBeenCalled();
    });

    it('returns friendly message when flow not found in processFlowMessage', async () => {
      const ctx: FlowContext = {
        state: 'nonexistent_flow' as FlowState,
        step: 0,
        data: {},
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
      };

      const result = await engine.processFlowMessage(userId, 'hello', ctx);
      expect(result.response.messages[0]).toContain('problema');
      expect(result.nextContext).toBeNull();
    });

    it('returns friendly message when flow not found in executeConfirm', async () => {
      const ctx: FlowContext = {
        state: 'confirming',
        step: 3,
        data: {},
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
        originFlow: 'nonexistent_flow' as FlowState,
      };

      const result = await engine.executeConfirm(userId, ctx);
      expect(result.response.messages[0]).toContain('problema');
      expect(result.nextContext).toBeNull();
    });
  });

  // --- Navigation ---

  describe('goBack', () => {
    it('goes back to previous step', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      let ctx = startResult.nextContext!;
      const r1 = await engine.processFlowMessage(userId, '5000', ctx);
      ctx = r1.nextContext!;
      expect(ctx.step).toBe(1);

      const backResult = await engine.goBack(userId, ctx);
      expect(backResult.nextContext?.step).toBe(0);
      expect(backResult.response.messages[0]).toBe('¿Cuánto?');
    });

    it('cannot go back from first step', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      const ctx = startResult.nextContext!;
      const result = await engine.goBack(userId, ctx);
      expect(result.response.messages[0]).toContain('volver');
    });
  });

  describe('skipStep', () => {
    it('skips optional step', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      let ctx = startResult.nextContext!;

      // Fill steps 0 and 1
      let r = await engine.processFlowMessage(userId, '5000', ctx);
      r = await engine.processFlowMessage(userId, 'Combustible', r.nextContext!);
      ctx = r.nextContext!;
      expect(ctx.step).toBe(2); // fieldName step (optional)

      const skipResult = await engine.skipStep(userId, ctx);
      expect(skipResult.nextContext?.state).toBe('confirming'); // no more steps
    });

    it('rejects skipping non-optional step', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      const ctx = startResult.nextContext!;
      expect(ctx.step).toBe(0); // amount step (not optional)

      const result = await engine.skipStep(userId, ctx);
      expect(result.response.messages[0]).toContain('obligatorio');
    });
  });

  // --- Expiration ---

  describe('isExpired', () => {
    it('returns false for non-expired context', () => {
      const ctx: FlowContext = {
        state: 'expense_flow',
        step: 0,
        data: {},
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
      };
      expect(engine.isExpired(ctx)).toBe(false);
    });

    it('returns true for expired context', () => {
      const ctx: FlowContext = {
        state: 'expense_flow',
        step: 0,
        data: {},
        startedAt: new Date(Date.now() - 700000),
        expiresAt: new Date(Date.now() - 100),
      };
      expect(engine.isExpired(ctx)).toBe(true);
    });
  });

  // --- getCurrentStepPrompt ---

  describe('getCurrentStepPrompt', () => {
    it('returns prompt for current step', async () => {
      const ctx: FlowContext = {
        state: 'expense_flow',
        step: 0,
        data: {},
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
      };
      const prompt = await engine.getCurrentStepPrompt(ctx, userId);
      expect(prompt?.messages[0]).toBe('¿Cuánto?');
    });

    it('returns confirmation for confirming state', async () => {
      const ctx: FlowContext = {
        state: 'confirming',
        step: 3,
        data: { amount: 5000, category: 'Combustible' },
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
        originFlow: 'expense_flow',
      };
      const prompt = await engine.getCurrentStepPrompt(ctx, userId);
      expect(prompt?.messages[0]).toContain('Confirmar');
    });

    it('returns null for unknown flow', async () => {
      const ctx: FlowContext = {
        state: 'nonexistent' as FlowState,
        step: 0,
        data: {},
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
      };
      const prompt = await engine.getCurrentStepPrompt(ctx, userId);
      expect(prompt).toBeNull();
    });
  });

  // --- Interactive step prompt suppression ---

  describe('interactive step prompt suppression', () => {
    let interactiveFlow: FlowDefinition;

    beforeEach(() => {
      interactiveFlow = createInteractiveFlow();
      registry.register(interactiveFlow);
    });

    it('startFlow with interactive step → messages empty, interactive present', async () => {
      const result = await engine.startFlow(userId, 'interactive_flow');
      expect(result.response.messages).toEqual([]);
      expect(result.response.interactive).toBeDefined();
      expect(result.response.interactive?.type).toBe('list');
    });

    it('advanceToNextStep to non-interactive step → messages has prompt', async () => {
      const startResult = await engine.startFlow(userId, 'interactive_flow');
      const ctx = startResult.nextContext!;
      // Answer category step → advances to amount (no interactive)
      const result = await engine.processFlowMessage(userId, 'Combustible', ctx);
      expect(result.response.messages).toEqual(['¿Cuánto?']);
      expect(result.response.interactive).toBeUndefined();
    });

    it('validation error with interactive step → messages has only error, no prompt', async () => {
      const startResult = await engine.startFlow(userId, 'interactive_flow');
      const ctx = startResult.nextContext!;
      const result = await engine.processFlowMessage(userId, 'invalid', ctx);
      expect(result.response.messages).toHaveLength(1);
      expect(result.response.messages[0]).toContain('Categoría no válida.');
      expect(result.response.messages[0]).not.toContain('Escribí el nombre');
      expect(result.response.interactive?.type).toBe('list');
    });

    it('getCurrentStepPrompt with interactive → messages empty', async () => {
      const ctx: FlowContext = {
        state: 'interactive_flow',
        step: 0,
        data: {},
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
      };
      const prompt = await engine.getCurrentStepPrompt(ctx, userId);
      expect(prompt?.messages).toEqual([]);
      expect(prompt?.interactive?.type).toBe('list');
    });

    it('step without interactive → messages has prompt (fallback)', async () => {
      const ctx: FlowContext = {
        state: 'interactive_flow',
        step: 1, // amount step — no interactive
        data: { category: 'Combustible' },
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600000),
      };
      const prompt = await engine.getCurrentStepPrompt(ctx, userId);
      expect(prompt?.messages).toEqual(['¿Cuánto?']);
      expect(prompt?.interactive).toBeUndefined();
    });
  });

  // --- Async validation ---

  describe('async validation', () => {
    it('uses validateAsync when available', async () => {
      const asyncFlow: FlowDefinition = {
        id: 'income_flow',
        name: 'Test Async',
        steps: [{
          field: 'fieldName',
          prompt: '¿Campo?',
          validate: () => ({ value: 'sync-fallback' }),
          validateAsync: vi.fn(async (input) => {
            if (input === 'valid') return { value: 'async-result' };
            return { error: 'No encontré ese campo.' };
          }),
        }],
        buildConfirmation: (data) => ({ messages: [`OK: ${data.fieldName}`] }),
        execute: vi.fn(async () => ({ messages: ['Done'] })),
      };
      registry.register(asyncFlow);

      const startResult = await engine.startFlow(userId, 'income_flow');
      const ctx = startResult.nextContext!;

      const result = await engine.processFlowMessage(userId, 'valid', ctx);
      expect(result.nextContext?.data.fieldName).toBe('async-result');
      expect(asyncFlow.steps[0].validateAsync).toHaveBeenCalled();
    });

    it('falls back to sync validate when validateAsync is absent', async () => {
      const startResult = await engine.startFlow(userId, 'expense_flow');
      const ctx = startResult.nextContext!;

      const result = await engine.processFlowMessage(userId, '5000', ctx);
      expect(result.nextContext?.data.amount).toBe(5000);
    });
  });
});

describe('inheritAmountScale — corrección "no, eran 350" tras monto en miles (Ago 2026)', () => {
  it('hereda la escala: 350 tras $200.000 → $350.000', async () => {
    const { inheritAmountScale } = await import('../conversation-engine.js');
    expect(inheritAmountScale(350, 200_000, 'no, eran 350')).toBe(350_000);
  });
  it('NO toca correcciones con unidad explícita chica ("350 pesos")', async () => {
    const { inheritAmountScale } = await import('../conversation-engine.js');
    expect(inheritAmountScale(350, 200_000, 'no, eran 350 pesos')).toBe(350);
  });
  it('NO toca cuando el nuevo monto ya viene en escala ("350 mil" → 350000)', async () => {
    const { inheritAmountScale } = await import('../conversation-engine.js');
    expect(inheritAmountScale(350_000, 200_000, 'no, eran 350 mil')).toBe(350_000);
  });
  it('NO toca cuando el monto previo es chico o no-redondo', async () => {
    const { inheritAmountScale } = await import('../conversation-engine.js');
    expect(inheritAmountScale(350, 800, 'no, eran 350')).toBe(350);
    expect(inheritAmountScale(350, 200_500, 'no, eran 350')).toBe(350);
    expect(inheritAmountScale(350, null, 'no, eran 350')).toBe(350);
  });
});

describe('inheritAmountScale — moneda USD nunca hereda escala (regresión barrido Ago 2026)', () => {
  it('registro USD: "eran 500 dólares" y hasta "eran 500" pelado NO se multiplican', async () => {
    const { inheritAmountScale } = await import('../conversation-engine.js');
    expect(inheritAmountScale(500, 300_000, 'no, eran 500 dólares', 'USD')).toBe(500);
    expect(inheritAmountScale(500, 300_000, 'no, eran 500', 'USD')).toBe(500);
    expect(inheritAmountScale(500, 300_000, 'eran 500 usd', null)).toBe(500); // palabra usd en el texto
  });
});

describe('correcciones de lote NO se leen como monto (barrido Ago 2026)', () => {
  it('"el gasto de herbicida era en el lote Dos" no devuelve monto', async () => {
    const { extractReferencedAmountCorrection, extractAmountCorrection } = await import('../conversation-engine.js');
    expect(extractReferencedAmountCorrection('el gasto de herbicida era en el lote Dos')).toBeNull();
    expect(extractAmountCorrection('no, era en el lote Dos')).toBeNull();
  });
  it('las correcciones de monto reales siguen andando', async () => {
    const { extractReferencedAmountCorrection } = await import('../conversation-engine.js');
    expect(extractReferencedAmountCorrection('el gasto de herbicida eran 500 mil')?.newAmount).toBe(500_000);
  });
});
