import { query } from '../config/database.js';
import type { UserId } from '../types/index.js';

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
  ): Promise<void> {
    const truncatedResponse = responseText ? responseText.slice(0, 500) : null;
    await query(
      `INSERT INTO conversation_logs
       (user_id, phone, direction, message_text, intent_type, intent_command,
        flow_state, flow_step, ai_used, response_text, response_interactive, processing_time_ms, confidence,
        tool_calls, agent_mode)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
