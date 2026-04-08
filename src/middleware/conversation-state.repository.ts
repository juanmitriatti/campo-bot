import { query, queryOne } from '../config/database.js';
import type { FlowContext, FlowState, UserId } from '../types/index.js';

export interface ActiveFlowRow {
  userId: UserId;
  phone: string | null;
  telegramId: string | null;
  flowState: FlowState;
  flowStep: number;
  flowStartedAt: Date | null;
  flowExpiresAt: Date | null;
  halflifeNotifiedAt: Date | null;
}

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

    // Extract meta fields from flow_data JSONB (stored alongside user data)
    const rawData = row.flow_data ?? {};
    const { _originFlow, _stepFailCount, ...data } = rawData as Record<string, unknown>;

    return {
      state: row.flow_state as FlowState,
      step: row.flow_step,
      data,
      startedAt: row.flow_started_at,
      expiresAt: row.flow_expires_at,
      originFlow: (_originFlow as FlowState) ?? undefined,
      stepFailCount: (typeof _stepFailCount === 'number') ? _stepFailCount : undefined,
    };
  }

  async setFlowContext(userId: UserId, ctx: FlowContext): Promise<void> {
    // Embed meta fields into flow_data JSONB so they survive DB round-trips
    const dataToStore: Record<string, unknown> = { ...ctx.data };
    if (ctx.originFlow) dataToStore._originFlow = ctx.originFlow;
    if (ctx.stepFailCount) dataToStore._stepFailCount = ctx.stepFailCount;

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
      [userId, ctx.state, ctx.step, JSON.stringify(dataToStore), ctx.startedAt, ctx.expiresAt],
    );
  }

  async clearFlow(userId: UserId): Promise<void> {
    await query(
      `UPDATE conversation_state
       SET flow_state = 'idle', flow_step = 0, flow_data = '{}',
           flow_started_at = NULL, flow_expires_at = NULL,
           flow_halflife_notified_at = NULL, updated_at = NOW()
       WHERE user_id = $1`,
      [userId],
    );
  }

  /**
   * Find all active (non-idle) flows joined with user contact info.
   * Used by the scheduler to send half-life reminders and timeout notifications.
   */
  async findActiveFlowsForReminder(): Promise<ActiveFlowRow[]> {
    const rows = await query<{
      user_id: number;
      phone_number: string | null;
      telegram_id: string | null;
      flow_state: string;
      flow_step: number;
      flow_started_at: Date | null;
      flow_expires_at: Date | null;
      flow_halflife_notified_at: Date | null;
    }>(
      `SELECT cs.user_id, u.phone_number, u.telegram_id,
              cs.flow_state, cs.flow_step,
              cs.flow_started_at, cs.flow_expires_at, cs.flow_halflife_notified_at
         FROM conversation_state cs
         JOIN users u ON u.id = cs.user_id
        WHERE cs.flow_state != 'idle'
          AND cs.flow_started_at IS NOT NULL`,
    );
    return rows.map((r) => ({
      userId: r.user_id as UserId,
      phone: r.phone_number,
      telegramId: r.telegram_id,
      flowState: r.flow_state as FlowState,
      flowStep: r.flow_step,
      flowStartedAt: r.flow_started_at,
      flowExpiresAt: r.flow_expires_at,
      halflifeNotifiedAt: r.flow_halflife_notified_at,
    }));
  }

  async markHalflifeNotified(userId: UserId): Promise<void> {
    await query(
      `UPDATE conversation_state
          SET flow_halflife_notified_at = NOW(), updated_at = NOW()
        WHERE user_id = $1`,
      [userId],
    );
  }
}
