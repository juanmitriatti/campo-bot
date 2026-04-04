import { query } from '../config/database.js';
import type { UserId } from '../types/index.js';
import { logError } from '../services/error-logger.js';

interface EmitParams {
  userId: UserId;
  eventType: string;
  flowState?: string | null;
  flowStep?: number | null;
  intentType?: string | null;
  intentCommand?: string | null;
  confidence?: number | null;
  source?: string | null;
  metadata?: Record<string, unknown>;
  sessionId?: string | null;
}

export class ConversationObserver {
  private async emit(params: EmitParams): Promise<void> {
    try {
      await query(
        `INSERT INTO conversation_events
         (user_id, event_type, flow_state, flow_step, intent_type, intent_command, confidence, source, metadata, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          params.userId,
          params.eventType,
          params.flowState ?? null,
          params.flowStep ?? null,
          params.intentType ?? null,
          params.intentCommand ?? null,
          params.confidence ?? null,
          params.source ?? null,
          params.metadata ? JSON.stringify(params.metadata) : '{}',
          params.sessionId ?? null,
        ],
      );
    } catch (err) {
      console.error('[conversation-observer] emit failed:', params.eventType, (err as Error).message);
      logError('observer', 'EMIT_FAILED', err as Error, { context: { eventType: params.eventType } });
    }
  }

  logMessageReceived(
    userId: UserId,
    meta: { phone: string; messageType: string; messageLength: number },
    sessionId?: string,
  ): void {
    this.emit({
      userId,
      eventType: 'message_received',
      metadata: { messageType: meta.messageType, messageLength: meta.messageLength, phone: meta.phone },
      sessionId,
    }).catch(() => {});
  }

  logIntentDetected(
    userId: UserId,
    intentType: string,
    intentCommand: string | null,
    confidence: number,
    source: string,
    meta?: { aiUsed?: boolean; missingFields?: string[] },
  ): void {
    this.emit({
      userId,
      eventType: 'intent_detected',
      intentType,
      intentCommand,
      confidence,
      source,
      metadata: meta ? { aiUsed: meta.aiUsed, missingFields: meta.missingFields } : {},
    }).catch(() => {});
  }

  logFlowStarted(
    userId: UserId,
    flowState: string,
    meta?: { prefillFields?: string[]; trigger?: string },
  ): void {
    this.emit({
      userId,
      eventType: 'flow_started',
      flowState,
      flowStep: 0,
      metadata: meta ?? {},
    }).catch(() => {});
  }

  logFlowStep(
    userId: UserId,
    flowState: string,
    step: number,
    meta?: { field?: string; validationFailed?: boolean },
  ): void {
    this.emit({
      userId,
      eventType: 'flow_step',
      flowState,
      flowStep: step,
      metadata: meta ?? {},
    }).catch(() => {});
  }

  logFlowCompleted(
    userId: UserId,
    flowState: string,
    totalSteps: number,
    meta?: { durationMs?: number; dataKeys?: string[] },
  ): void {
    this.emit({
      userId,
      eventType: 'flow_completed',
      flowState,
      flowStep: totalSteps,
      metadata: meta ?? {},
    }).catch(() => {});
  }

  logFlowAbandoned(
    userId: UserId,
    flowState: string,
    step: number,
    reason: string,
    meta?: { durationMs?: number; filledFields?: string[] },
  ): void {
    this.emit({
      userId,
      eventType: 'flow_abandoned',
      flowState,
      flowStep: step,
      metadata: { reason, ...meta },
    }).catch(() => {});
  }

  logFallbackUsed(
    userId: UserId,
    meta?: { inputText?: string; resultType?: string },
  ): void {
    const truncatedInput = meta?.inputText ? meta.inputText.slice(0, 200) : undefined;
    this.emit({
      userId,
      eventType: 'fallback_ai',
      metadata: { inputText: truncatedInput, resultType: meta?.resultType },
    }).catch(() => {});
  }

  logError(
    userId: UserId,
    meta: { errorType: string; errorMessage: string; flowState?: string; flowStep?: number },
  ): void {
    this.emit({
      userId,
      eventType: 'error',
      flowState: meta.flowState,
      flowStep: meta.flowStep,
      metadata: { errorType: meta.errorType, errorMessage: meta.errorMessage },
    }).catch(() => {});
  }

  logMenuOpened(
    userId: UserId,
    meta?: { trigger?: string },
  ): void {
    this.emit({
      userId,
      eventType: 'menu_opened',
      metadata: meta ?? {},
    }).catch(() => {});
  }

  logCommandExecuted(
    userId: UserId,
    command: string,
    meta?: { aiUsed?: boolean; confidence?: number },
  ): void {
    this.emit({
      userId,
      eventType: 'command_executed',
      intentCommand: command,
      confidence: meta?.confidence,
      metadata: { aiUsed: meta?.aiUsed },
    }).catch(() => {});
  }
}
