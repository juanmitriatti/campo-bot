import { ConversationStateRepository } from './conversation-state.repository.js';
import { FlowRegistry } from './flows/flow-registry.js';
import type { ConversationObserver } from './conversation-observer.js';
import type { FlowContext, FlowState, HandlerResponse, InteractiveMessage, UserId } from '../types/index.js';
import type { FlowDefinition, FlowStep, FlowStepValidationSuccess } from './flows/flow.interface.js';

import { getSettingNumber } from '../services/settings.service.js';
import { logError } from '../services/error-logger.js';

// Defaults — overridden by system_settings at runtime
const DEFAULT_FLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_STEP_FAILURES = 3;

// Cached settings (refreshed on each startFlow call)
let FLOW_TIMEOUT_MS = DEFAULT_FLOW_TIMEOUT_MS;
let MAX_STEP_FAILURES = DEFAULT_MAX_STEP_FAILURES;

async function refreshFlowSettings(): Promise<void> {
  FLOW_TIMEOUT_MS = (await getSettingNumber('FLOW_TIMEOUT_MS')) ?? DEFAULT_FLOW_TIMEOUT_MS;
  MAX_STEP_FAILURES = (await getSettingNumber('FLOW_MAX_STEP_FAILURES')) ?? DEFAULT_MAX_STEP_FAILURES;
}

// --- Spanish labels for user-facing notifications ---
const FLOW_LABELS: Record<string, string> = {
  expense_flow: 'gasto',
  income_flow: 'ingreso',
  field_flow: 'campo',
  activity_flow: 'actividad',
  rainfall_flow: 'lluvia',
  confirming: 'pendiente',
};

export function getFlowLabel(flowState: string): string {
  return FLOW_LABELS[flowState] ?? 'formulario';
}

export function buildTimeoutMessage(flowState: string): string {
  const label = getFlowLabel(flowState);
  return `⏰ Cerré el ${label} anterior por inactividad. Si querés seguir, escribime de nuevo.`;
}

export function buildHalflifeMessage(flowState: string): string {
  const label = getFlowLabel(flowState);
  return `👋 ¿Seguís ahí? Tu ${label} quedó a medias. Respondé o escribí *cancelar* para salir.`;
}

export interface FlowMessageResult {
  response: HandlerResponse;
  nextContext: FlowContext | null; // null = clear flow
}

export class ConversationEngine {
  private observer?: ConversationObserver;

  constructor(
    private stateRepo: ConversationStateRepository,
    private registry: FlowRegistry,
    observer?: ConversationObserver,
  ) {
    this.observer = observer;
  }

  async getFlowContext(userId: UserId): Promise<FlowContext> {
    const ctx = await this.stateRepo.getFlowContext(userId);
    // Flow state recovery: if state isn't idle/confirming and flow not in registry, auto-clear
    if (ctx.state !== 'idle' && ctx.state !== 'confirming' && !this.registry.has(ctx.state)) {
      await this.stateRepo.clearFlow(userId);
      return { state: 'idle', step: 0, data: {}, startedAt: null, expiresAt: null };
    }
    return ctx;
  }

  async setFlowContext(userId: UserId, ctx: FlowContext): Promise<void> {
    await this.stateRepo.setFlowContext(userId, ctx);
  }

  async clearFlow(userId: UserId): Promise<void> {
    await this.stateRepo.clearFlow(userId);
  }

  isExpired(ctx: FlowContext): boolean {
    if (!ctx.expiresAt) return false;
    return new Date() > new Date(ctx.expiresAt);
  }

  /**
   * FlowGuard: validates flow state consistency.
   * Returns null if valid, or a FlowMessageResult to send if the state is invalid.
   */
  async validateFlowState(userId: UserId, ctx: FlowContext): Promise<FlowMessageResult | null> {
    // Idle state is always valid
    if (ctx.state === 'idle') return null;

    // Confirming state — check originFlow exists
    if (ctx.state === 'confirming') {
      const originFlow = ctx.originFlow;
      if (!originFlow || !this.registry.has(originFlow)) {
        await this.stateRepo.clearFlow(userId);
        return {
          response: { messages: ['Hubo un problema con el flujo. ¿Qué querés hacer?'] },
          nextContext: null,
        };
      }
      return null;
    }

    // Active flow — check flow exists and step is in bounds
    const flow = this.registry.get(ctx.state);
    if (!flow) {
      await this.stateRepo.clearFlow(userId);
      return {
        response: { messages: ['Hubo un problema con el flujo. ¿Qué querés hacer?'] },
        nextContext: null,
      };
    }

    if (ctx.step < 0 || ctx.step >= flow.steps.length) {
      await this.stateRepo.clearFlow(userId);
      return {
        response: { messages: ['Error en el flujo. ¿Qué querés hacer?'] },
        nextContext: null,
      };
    }

    return null;
  }

  async startFlow(
    userId: UserId,
    flowState: FlowState,
    prefillData?: Record<string, unknown>,
  ): Promise<FlowMessageResult> {
    // Refresh settings from DB (cached 5 min)
    await refreshFlowSettings();

    const flow = this.registry.get(flowState);
    if (!flow) {
      return {
        response: { messages: ['Flujo no disponible.'] },
        nextContext: null,
      };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + FLOW_TIMEOUT_MS);
    const data = prefillData ?? {};

    // Find the first non-skippable step
    let startStep = 0;
    while (startStep < flow.steps.length) {
      const step = flow.steps[startStep];
      if (step.skipIf && step.skipIf(data)) {
        startStep++;
        continue;
      }
      // If data already has this field from prefill, skip
      if (data[step.field] !== undefined) {
        startStep++;
        continue;
      }
      break;
    }

    // If all steps already filled (e.g., from prefill), go to confirmation
    if (startStep >= flow.steps.length) {
      const ctx: FlowContext = {
        state: 'confirming',
        step: flow.steps.length,
        data,
        startedAt: now,
        expiresAt,
        originFlow: flowState,
      };
      await this.stateRepo.setFlowContext(userId, ctx);
      return {
        response: flow.buildConfirmation(data),
        nextContext: ctx,
      };
    }

    const ctx: FlowContext = {
      state: flowState,
      step: startStep,
      data,
      startedAt: now,
      expiresAt,
      stepFailCount: 0,
    };
    await this.stateRepo.setFlowContext(userId, ctx);

    const stepDef = flow.steps[startStep];
    const prompt = await this.resolvePrompt(stepDef, data, userId);
    const interactive = await this.resolveInteractive(stepDef, data, userId);

    return {
      response: {
        messages: interactive ? [] : [prompt],
        interactive,
      },
      nextContext: ctx,
    };
  }

  async processFlowMessage(
    userId: UserId,
    text: string,
    ctx: FlowContext,
  ): Promise<FlowMessageResult> {
    // If in confirming state, handle text-based confirm/cancel
    if (ctx.state === 'confirming') {
      const lower = text.toLowerCase().trim();
      if (['si', 'sí', 'confirmar', 'confirmado', 'dale', 'ok', 'listo', 'perfecto', 'va', 'vamos', 'seguro', 'claro', '👍'].includes(lower)) {
        return this.executeConfirm(userId, ctx);
      }
      // Any other text in confirming state — treat as cancel
      return {
        response: { messages: ['Respondé *SI* para confirmar o *NO* para cancelar.'] },
        nextContext: ctx,
      };
    }

    const flowState = ctx.state as FlowState;
    const flow = this.registry.get(flowState);
    if (!flow) {
      return {
        response: { messages: ['Hubo un problema con el flujo. ¿Qué querés hacer?'] },
        nextContext: null,
      };
    }

    const stepDef = flow.steps[ctx.step];
    if (!stepDef) {
      return {
        response: { messages: ['Error en el flujo. ¿Qué querés hacer?'] },
        nextContext: null,
      };
    }

    // Validate input: prefer async, fallback to sync
    const result = stepDef.validateAsync
      ? await stepDef.validateAsync(text, ctx.data, userId)
      : stepDef.validate(text, ctx.data);

    if ('error' in result) {
      // Increment step failure count
      ctx.stepFailCount = (ctx.stepFailCount ?? 0) + 1;
      this.observer?.logFlowStep(userId, ctx.state, ctx.step, { field: stepDef.field, validationFailed: true });

      const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
      const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);

      // After MAX_STEP_FAILURES, add hint
      let errorMsg = result.error;
      if (ctx.stepFailCount >= MAX_STEP_FAILURES) {
        errorMsg += '\n\n_Escribí *cancelar* para salir o elegí de la lista._';
      }

      // Merge error + re-prompt into single message (suppress prompt when interactive provides it)
      return {
        response: {
          messages: interactive ? [errorMsg] : [`${errorMsg}\n\n${prompt}`],
          interactive,
        },
        nextContext: ctx,
      };
    }

    // Store validated value, reset fail count
    ctx.data[stepDef.field] = (result as FlowStepValidationSuccess).value;
    ctx.stepFailCount = 0;

    // Advance to next step
    return this.advanceToNextStep(userId, flow.id, ctx, flow);
  }

  async skipStep(
    userId: UserId,
    ctx: FlowContext,
  ): Promise<FlowMessageResult> {
    const flowState = ctx.state as FlowState;
    const flow = this.registry.get(flowState);
    if (!flow) {
      return { response: { messages: ['Hubo un problema con el flujo. ¿Qué querés hacer?'] }, nextContext: null };
    }

    const stepDef = flow.steps[ctx.step];
    if (!stepDef?.optional) {
      const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
      const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);
      return {
        response: {
          messages: interactive ? ['Este paso es obligatorio.'] : [`Este paso es obligatorio.\n\n${prompt}`],
          interactive,
        },
        nextContext: ctx,
      };
    }

    return this.advanceToNextStep(userId, flow.id, ctx, flow);
  }

  async goBack(
    userId: UserId,
    ctx: FlowContext,
  ): Promise<FlowMessageResult> {
    const flowState = ctx.state === 'confirming' ? (ctx.originFlow ?? ctx.state) : ctx.state;
    const flow = this.registry.get(flowState as FlowState);
    if (!flow || ctx.step <= 0) {
      return { response: { messages: ['No podés volver más atrás.'] }, nextContext: ctx };
    }

    let prevStep = (ctx.state === 'confirming' ? flow.steps.length : ctx.step) - 1;
    while (prevStep >= 0) {
      const step = flow.steps[prevStep];
      if (step.skipIf && step.skipIf(ctx.data)) {
        prevStep--;
        continue;
      }
      break;
    }

    if (prevStep < 0) {
      return { response: { messages: ['No podés volver más atrás.'] }, nextContext: ctx };
    }

    // Remove current field data
    const stepDef = flow.steps[prevStep];
    delete ctx.data[stepDef.field];

    ctx.state = flowState as FlowState;
    ctx.step = prevStep;
    ctx.stepFailCount = 0;
    await this.stateRepo.setFlowContext(userId, ctx);

    const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
    const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);

    return {
      response: { messages: interactive ? [] : [prompt], interactive },
      nextContext: ctx,
    };
  }

  async executeConfirm(
    userId: UserId,
    ctx: FlowContext,
  ): Promise<FlowMessageResult> {
    // Guard: stale/idle state (e.g. double-tap on confirm button)
    if (ctx.state === 'idle') {
      return { response: { messages: ['No hay nada pendiente para confirmar.'] }, nextContext: null };
    }

    const flowState = ctx.originFlow ?? ctx.state;
    const flow = this.registry.get(flowState as FlowState);
    if (!flow) {
      await this.stateRepo.clearFlow(userId);
      return { response: { messages: ['Hubo un problema con el flujo. ¿Qué querés hacer?'] }, nextContext: null };
    }

    // Validate required data: every non-optional, non-skipped step must have a value
    for (const step of flow.steps) {
      if (step.skipIf && step.skipIf(ctx.data)) continue;
      if (!step.optional && ctx.data[step.field] === undefined) {
        await this.stateRepo.clearFlow(userId);
        console.error(`[FLOW_CONFIRM] Missing required field "${step.field}" in ${flowState} for user ${userId}`);
        logError('flow-engine', 'MISSING_FIELD', `Missing required field "${step.field}" in ${flowState}`, { userId, context: { flowState, field: step.field } });
        return { response: { messages: ['Faltan datos en el flujo. Empezá de nuevo.'] }, nextContext: null };
      }
    }

    try {
      const response = await flow.execute(userId, ctx.data);
      await this.stateRepo.clearFlow(userId);
      const durationMs = ctx.startedAt ? Date.now() - new Date(ctx.startedAt).getTime() : undefined;
      this.observer?.logFlowCompleted(userId, flowState as string, ctx.step, { durationMs, dataKeys: Object.keys(ctx.data) });
      return { response, nextContext: null };
    } catch (err: unknown) {
      await this.stateRepo.clearFlow(userId);
      const msg = (err as Error).message;
      console.error(`[FLOW_CONFIRM] execute() failed for ${flowState}, user ${userId}:`, msg);
      logError('flow-engine', 'FLOW_EXECUTE_FAILED', err as Error, { userId, context: { flowState } });
      return { response: { messages: ['Hubo un error al guardar. Intentá de nuevo.'] }, nextContext: null };
    }
  }

  async startFlowAtConfirmation(
    userId: UserId,
    flowState: FlowState,
    data: Record<string, unknown>,
  ): Promise<HandlerResponse> {
    const flow = this.registry.get(flowState);
    if (!flow) return { messages: ['Flujo no disponible.'] };

    const now = new Date();
    const expiresAt = new Date(now.getTime() + FLOW_TIMEOUT_MS);
    const ctx: FlowContext = {
      state: 'confirming',
      step: flow.steps.length,
      data,
      startedAt: now,
      expiresAt,
      originFlow: flowState,
    };
    await this.stateRepo.setFlowContext(userId, ctx);
    return flow.buildConfirmation(data);
  }

  /**
   * Get the current step's prompt response (for re-prompting after safe interruptions).
   */
  async getCurrentStepPrompt(ctx: FlowContext, userId: UserId): Promise<HandlerResponse | null> {
    if (ctx.state === 'confirming') {
      const originFlow = ctx.originFlow ?? ctx.state;
      const flow = this.registry.get(originFlow as FlowState);
      if (flow) return flow.buildConfirmation(ctx.data);
      return null;
    }
    const flow = this.registry.get(ctx.state as FlowState);
    if (!flow || ctx.step >= flow.steps.length) return null;
    const stepDef = flow.steps[ctx.step];
    const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
    const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);
    return { messages: interactive ? [] : [prompt], interactive };
  }

  // --- Private helpers ---

  private async resolvePrompt(
    stepDef: FlowStep,
    data: Record<string, unknown>,
    userId: UserId,
  ): Promise<string> {
    if (stepDef.promptAsync) return stepDef.promptAsync(data, userId);
    return typeof stepDef.prompt === 'function' ? stepDef.prompt(data) : stepDef.prompt;
  }

  private async resolveInteractive(
    stepDef: FlowStep,
    data: Record<string, unknown>,
    userId: UserId,
  ): Promise<InteractiveMessage | undefined> {
    if (stepDef.interactiveAsync) {
      const result = await stepDef.interactiveAsync(data, userId);
      return result ?? undefined;
    }
    const interactive = typeof stepDef.interactive === 'function'
      ? stepDef.interactive(data)
      : stepDef.interactive;
    return interactive ?? undefined;
  }

  private async advanceToNextStep(
    userId: UserId,
    flowState: FlowState,
    ctx: FlowContext,
    flow: FlowDefinition,
  ): Promise<FlowMessageResult> {
    let nextStep = ctx.step + 1;
    while (nextStep < flow.steps.length) {
      const step = flow.steps[nextStep];
      if (step.skipIf && step.skipIf(ctx.data)) {
        nextStep++;
        continue;
      }
      // Skip steps already pre-filled (e.g., city from "agregar campo en Vedia")
      if (ctx.data[step.field] !== undefined) {
        nextStep++;
        continue;
      }
      break;
    }

    // All steps done → confirmation
    if (nextStep >= flow.steps.length) {
      this.observer?.logFlowStep(userId, flowState, flow.steps.length, { field: '_confirmation' });
      const confirmCtx: FlowContext = {
        state: 'confirming',
        step: flow.steps.length,
        data: ctx.data,
        startedAt: ctx.startedAt,
        expiresAt: ctx.expiresAt,
        originFlow: flowState,
      };
      await this.stateRepo.setFlowContext(userId, confirmCtx);
      return {
        response: flow.buildConfirmation(ctx.data),
        nextContext: confirmCtx,
      };
    }

    // Prompt next step
    this.observer?.logFlowStep(userId, flowState, nextStep, { field: flow.steps[nextStep].field });
    ctx.state = flowState;
    ctx.step = nextStep;
    ctx.stepFailCount = 0;
    await this.stateRepo.setFlowContext(userId, ctx);

    const nextStepDef = flow.steps[nextStep];
    const prompt = await this.resolvePrompt(nextStepDef, ctx.data, userId);
    const interactive = await this.resolveInteractive(nextStepDef, ctx.data, userId);

    return {
      response: {
        messages: interactive ? [] : [prompt],
        interactive,
      },
      nextContext: ctx,
    };
  }
}
