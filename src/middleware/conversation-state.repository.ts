import { query, queryOne } from '../config/database.js';
import type { FlowContext, FlowState, UserId } from '../types/index.js';

const IDLE_CONTEXT: FlowContext = {
  state: 'idle',
  step: 0,
  data: {},
  startedAt: null,
  expiresAt: null,
};

interface FlowRow {
  flow_state: string;
  flow_step: number;
  flow_data: Record<string, unknown>;
  flow_started_at: Date | null;
  flow_expires_at: Date | null;
}

export class ConversationStateRepository {
  async getFlowContext(userId: UserId): Promise<FlowContext> {
    const row = await queryOne<FlowRow>(
      `SELECT flow_state, flow_step, flow_data, flow_started_at, flow_expires_at
       FROM conversation_state WHERE user_id = $1`,
      [userId],
    );
    if (!row || row.flow_state === 'idle') return { ...IDLE_CONTEXT };
    return {
      state: row.flow_state as FlowState,
      step: row.flow_step,
      data: row.flow_data ?? {},
      startedAt: row.flow_started_at,
      expiresAt: row.flow_expires_at,
    };
  }

  async setFlowContext(userId: UserId, ctx: FlowContext): Promise<void> {
    await query(
      `INSERT INTO conversation_state (user_id, flow_state, flow_step, flow_data, flow_started_at, flow_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         flow_state = $2,
         flow_step = $3,
         flow_data = $4,
         flow_started_at = $5,
         flow_expires_at = $6,
         updated_at = NOW()`,
      [userId, ctx.state, ctx.step, JSON.stringify(ctx.data), ctx.startedAt, ctx.expiresAt],
    );
  }

  async clearFlow(userId: UserId): Promise<void> {
    await query(
      `UPDATE conversation_state
       SET flow_state = 'idle', flow_step = 0, flow_data = '{}',
           flow_started_at = NULL, flow_expires_at = NULL, updated_at = NOW()
       WHERE user_id = $1`,
      [userId],
    );
  }
}
