import { AsyncLocalStorage } from 'node:async_hooks';
import { query } from '../config/database.js';
import type { UserId } from '../types/index.js';

/**
 * Turno de conversación en curso: si quedó en el historial y qué comandos
 * ejecutó el router. Los caminos determinísticos (respuesta a un pending,
 * flows, "¿lo creo?") no llamaban a `log()`, así que esos turnos no existían
 * para el agente: en prod (12 oct 2026) "compramos 50 vacas" → "¿en qué lote?"
 * → "Monte" registró las vacas por el pending, pero el agente solo veía la
 * pregunta sin contestar y al siguiente "Monte" volvió a comprarlas.
 */
interface TurnState { logged: boolean; commands: string[] }
const turnStore = new AsyncLocalStorage<TurnState>();

export function runConversationTurn<T>(fn: () => Promise<T>): Promise<T> {
  return turnStore.run({ logged: false, commands: [] }, fn);
}

/** El router anota cada comando que ejecuta en el turno en curso. */
export function recordTurnCommand(command: string): void {
  turnStore.getStore()?.commands.push(command);
}

/** Estado del turno en curso (null fuera de `runConversationTurn`). */
export function currentTurn(): Readonly<TurnState> | null {
  return turnStore.getStore() ?? null;
}

export class ConversationLogger {
  async log(
    userId: UserId,
    phone: string,
    messageText: string | null,
    responseText: string | null,
    intentType?: string | null,
    intentCommand?: string | null,
    flowState?: string | null,
    flowStep?: number | null,
    aiUsed?: boolean,
    processingTimeMs?: number | null,
    responseInteractive?: boolean,
    confidence?: number | null,
    toolCalls?: object[] | null,
    agentMode?: string | null,
    channel?: string | null,
  ): Promise<void> {
    const truncatedResponse = responseText ? responseText.slice(0, 500) : null;
    const turn = turnStore.getStore();
    if (turn) turn.logged = true;
    await query(
      `INSERT INTO conversation_logs
       (user_id, phone, direction, message_text, intent_type, intent_command,
        flow_state, flow_step, ai_used, response_text, response_interactive, processing_time_ms, confidence,
        tool_calls, agent_mode, channel)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        userId,
        phone,
        messageText,
        intentType ?? null,
        intentCommand ?? null,
        flowState ?? null,
        flowStep ?? null,
        aiUsed ?? false,
        truncatedResponse,
        responseInteractive ?? false,
        processingTimeMs ?? null,
        confidence ?? null,
        toolCalls ? JSON.stringify(toolCalls) : null,
        agentMode ?? null,
        channel ?? 'whatsapp',
      ],
    );
  }

  async logError(
    userId: UserId,
    errorType: string,
    errorMessage: string,
    userInput?: string | null,
    flowState?: string | null,
    flowStep?: number | null,
    flowData?: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO conversation_errors (user_id, flow_state, step, error_type, error_message, user_input, flow_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          flowState ?? null,
          flowStep ?? null,
          errorType,
          errorMessage,
          userInput ?? null,
          flowData ? JSON.stringify(flowData) : null,
        ],
      );
    } catch {
      // Fire-and-forget — don't crash on logging failure
    }
  }
}
