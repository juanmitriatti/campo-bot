import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationEngine } from '../conversation-engine.js';
import { FlowRegistry } from '../flows/flow-registry.js';
import type { FlowContext, FlowState, UserId, HandlerResponse } from '../../types/index.js';
import type { FlowDefinition } from '../flows/flow.interface.js';

// --- ConversationSimulator: wraps engine with sequential message sending ---

class ConversationSimulator {
  private engine: ConversationEngine;
  private ctx: FlowContext = { state: 'idle', step: 0, data: {}, startedAt: null, expiresAt: null };
  private userId: UserId;

  constructor(engine: ConversationEngine, userId: UserId) {
    this.engine = engine;
    this.userId = userId;
  }

  async startFlow(flowState: FlowState, prefillData?: Record<string, unknown>) {
    const result = await this.engine.startFlow(this.userId, flowState, prefillData);
    if (result.nextContext) {
      this.ctx = result.nextContext;
      await this.engine.setFlowContext(this.userId, this.ctx);
    }
    return result.response;
  }

  async send(text: string) {
    const result = await this.engine.processFlowMessage(this.userId, text, this.ctx);
    if (result.nextContext) {
      this.ctx = result.nextContext;
      await this.engine.setFlowContext(this.userId, this.ctx);
    } else {
      this.ctx = { state: 'idle', step: 0, data: {}, startedAt: null, expiresAt: null };
      await this.engine.clearFlow(this.userId);
    }
    return result.response;
  }

  async skip() {
    const result = await this.engine.skipStep(this.userId, this.ctx);
    if (result.nextContext) {
      this.ctx = result.nextContext;
      await this.engine.setFlowContext(this.userId, this.ctx);
    }
    return result.response;
  }

  async back() {
    const result = await this.engine.goBack(this.userId, this.ctx);
    if (result.nextContext) {
      this.ctx = result.nextContext;
      await this.engine.setFlowContext(this.userId, this.ctx);
    }
    return result.response;
  }

  get currentContext() {
    return this.ctx;
  }
}

// --- Mock state repository ---

function createMockStateRepo() {
  let stored: FlowContext = { state: 'idle', step: 0, data: {}, startedAt: null, expiresAt: null };
  return {
    getFlowContext: vi.fn(async () => ({ ...stored })),
    setFlowContext: vi.fn(async (_userId: UserId, ctx: FlowContext) => { stored = { ...ctx }; }),
    clearFlow: vi.fn(async () => { stored = { state: 'idle', step: 0, data: {}, startedAt: null, expiresAt: null }; }),
  };
}

// --- Test flows ---

function createExpenseFlow(): FlowDefinition {
  const userFields = ['La Esperanza', 'Campo Sur', 'San Pedro'];
  return {
    id: 'expense_flow',
    name: 'Test Expense',
    steps: [
      {
        field: 'amount',
        prompt: '¿Cuánto gastaste?',
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
          const cats = ['Combustible', 'Semillas', 'Otros'];
          const match = cats.find(c => c.toLowerCase() === input.toLowerCase());
          if (!match) return { error: 'Categoría no válida.' };
          return { value: match };
        },
      },
      {
        field: 'fieldName',
        prompt: () => {
          const lines = userFields.map((f, i) => `${i + 1}. ${f}`);
          return `¿En qué campo?\n${lines.join('\n')}\n\nEscribí el nombre, número o "general".`;
        },
        validate: (input) => {
          const lower = input.toLowerCase().trim();
          if (['general', 'ninguno', 'no'].includes(lower)) return { value: null };
          return { value: input.trim() };
        },
        validateAsync: vi.fn(async (input: string) => {
          const lower = input.toLowerCase().trim();
          if (['general', 'ninguno', 'no'].includes(lower)) return { value: null };

          // Numeric selection
          const num = parseInt(input, 10);
          if (!isNaN(num) && num >= 1 && num <= userFields.length) {
            return { value: userFields[num - 1] };
          }

          // Exact match
          const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          for (const f of userFields) {
            if (norm(f) === norm(input)) return { value: f };
          }

          // Fuzzy: "esperanza" → "La Esperanza"
          for (const f of userFields) {
            if (norm(f).includes(norm(input))) return { value: f };
          }

          const lines = userFields.map((f, i) => `${i + 1}. ${f}`);
          return { error: `No encontré ese campo.\n\nTus campos:\n${lines.join('\n')}` };
        }),
        optional: true,
      },
      {
        field: 'description',
        prompt: '¿Detalle? (opcional)',
        validate: (input) => ({ value: input.trim() }),
        optional: true,
      },
    ],
    buildConfirmation: (data) => ({
      messages: [`Confirmar: $${data.amount} en ${data.category}${data.fieldName ? ` (${data.fieldName})` : ''}`],
      interactive: {
        type: 'buttons',
        body: '¿Confirmamos?',
        buttons: [
          { id: 'flow_confirm', title: 'Confirmar' },
          { id: 'flow_cancel', title: 'Cancelar' },
        ],
      },
    }),
    execute: vi.fn(async (_userId, data) => ({
      messages: [`Gasto guardado: $${data.amount} en ${data.category}`],
    })),
  };
}

const userId = 1 as UserId;

describe('Conversation Flow Integration', () => {
  let stateRepo: ReturnType<typeof createMockStateRepo>;
  let registry: FlowRegistry;
  let engine: ConversationEngine;
  let expenseFlow: FlowDefinition;
  let sim: ConversationSimulator;

  beforeEach(() => {
    stateRepo = createMockStateRepo();
    registry = new FlowRegistry();
    expenseFlow = createExpenseFlow();
    registry.register(expenseFlow);
    engine = new ConversationEngine(stateRepo as any, registry);
    sim = new ConversationSimulator(engine, userId);
  });

  // --- Happy path ---

  it('complete expense flow happy path', async () => {
    const r0 = await sim.startFlow('expense_flow');
    expect(r0.messages[0]).toContain('¿Cuánto');

    const r1 = await sim.send('50000');
    expect(r1.messages[0]).toContain('¿Categoría?');

    const r2 = await sim.send('Combustible');
    expect(r2.messages[0]).toContain('¿En qué campo?');

    const r3 = await sim.send('La Esperanza');
    expect(r3.messages[0]).toContain('¿Detalle?');

    const r4 = await sim.skip();
    expect(r4.messages[0]).toContain('Confirmar');
    expect(sim.currentContext.state).toBe('confirming');

    const r5 = await sim.send('si');
    expect(r5.messages[0]).toContain('Gasto guardado');
    expect(sim.currentContext.state).toBe('idle');
  });

  // --- Numeric field selection ---

  it('selects field by number', async () => {
    await sim.startFlow('expense_flow');
    await sim.send('50000');
    await sim.send('Combustible');

    // At field step, type "2" for Campo Sur
    const r = await sim.send('2');
    expect(r.messages[0]).toContain('¿Detalle?');
    expect(sim.currentContext.data.fieldName).toBe('Campo Sur');
  });

  // --- Invalid field name → error with list → valid retry ---

  it('rejects invalid field name and shows list', async () => {
    await sim.startFlow('expense_flow');
    await sim.send('50000');
    await sim.send('Combustible');

    // At field step, type gibberish
    const r1 = await sim.send('asdfgh');
    expect(r1.messages[0]).toContain('No encontré ese campo');
    expect(r1.messages[0]).toContain('La Esperanza');
    expect(sim.currentContext.step).toBe(2); // still at field step

    // Now retry with valid field
    const r2 = await sim.send('1');
    expect(r2.messages[0]).toContain('¿Detalle?');
    expect(sim.currentContext.data.fieldName).toBe('La Esperanza');
  });

  // --- "general" → null field ---

  it('accepts "general" as null field', async () => {
    await sim.startFlow('expense_flow');
    await sim.send('50000');
    await sim.send('Combustible');

    const r = await sim.send('general');
    expect(r.messages[0]).toContain('¿Detalle?');
    expect(sim.currentContext.data.fieldName).toBeNull();
  });

  // --- Cancel mid-flow ---

  it('cancel mid-flow does not auto-process (handled by controller)', async () => {
    await sim.startFlow('expense_flow');
    await sim.send('50000');

    // In the real app, "cancelar" is intercepted by the controller before processFlowMessage.
    // Here we verify that the engine treats it as normal text (invalid category),
    // confirming the controller must handle cancel.
    const r = await sim.send('cancelar');
    expect(r.messages[0]).toContain('Categoría no válida');
  });

  // --- Flow expiration graceful fallthrough ---

  it('detects expired flow', async () => {
    await sim.startFlow('expense_flow');
    // Manually expire the context
    const ctx = sim.currentContext;
    ctx.expiresAt = new Date(Date.now() - 1000);
    expect(engine.isExpired(ctx)).toBe(true);
  });

  // --- Back navigation from confirmation ---

  it('goes back from confirmation to last step', async () => {
    await sim.startFlow('expense_flow');
    await sim.send('50000');
    await sim.send('Combustible');
    await sim.send('La Esperanza');
    await sim.skip(); // skip description → confirmation
    expect(sim.currentContext.state).toBe('confirming');

    const r = await sim.back();
    expect(r.messages[0]).toContain('¿Detalle?');
    expect(sim.currentContext.state).toBe('expense_flow');
  });

  // --- Multiple validation failures show hint ---

  it('shows hint after 3 consecutive failures', async () => {
    await sim.startFlow('expense_flow');

    await sim.send('bad');
    await sim.send('bad');
    const r3 = await sim.send('bad');
    expect(r3.messages[0]).toContain('cancelar');
  });
});
