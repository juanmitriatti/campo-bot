// Vínculo entre un formulario ofrecido y el flujo de chat que quedó preguntando
// lo mismo (gasto, ingreso, labor). Sin esto, enviar el formulario dejaba la
// pregunta abierta y al vencer el flujo guardaba el registro OTRA vez a nivel
// campo (nov 2026).
import { pool } from '../config/db.js';
import type { FormAction, HandlerResponse } from '../types/index.js';

const ACTION_BY_FLOW: Record<string, FormAction> = {
  expense_flow: 'log_expense',
  income_flow: 'log_income',
  activity_flow: 'log_activity',
};

export interface FlowMarker { action: FormAction; startedAt: string }

interface OpenFlow { action: FormAction; startedAt: string }

async function openFlow(userId: number): Promise<OpenFlow | null> {
  const { rows } = await pool.query(
    `SELECT flow_state, flow_data->>'_originFlow' AS origin, flow_started_at
       FROM conversation_state WHERE user_id = $1 AND flow_state <> 'idle'`,
    [userId],
  );
  const row = rows[0] as { flow_state: string; origin: string | null; flow_started_at: Date | null } | undefined;
  const action = row ? ACTION_BY_FLOW[row.origin ?? row.flow_state] : undefined;
  if (!row || !action || !row.flow_started_at) return null;
  return { action, startedAt: new Date(row.flow_started_at).toISOString() };
}

/** Marca para guardar en la sesión del formulario (solo si hay un flujo de esa acción). */
export async function flowMarkerFor(
  userId: number,
  response: HandlerResponse,
  action: FormAction,
): Promise<{ _flow?: FlowMarker }> {
  if (!response.sideEffects?.startFlow) return {};
  const flow = await openFlow(userId);
  return flow && flow.action === action ? { _flow: flow } : {};
}

/** ¿Sigue abierto EL MISMO flujo que acompañaba al formulario? */
export async function isSameFlowOpen(userId: number, marker: FlowMarker): Promise<boolean> {
  const flow = await openFlow(userId);
  return !!flow && flow.action === marker.action && flow.startedAt === marker.startedAt;
}

export async function closeLinkedFlow(userId: number): Promise<void> {
  await pool.query(
    `UPDATE conversation_state
        SET flow_state = 'idle', flow_step = 0, flow_data = '{}', flow_started_at = NULL,
            flow_expires_at = NULL, flow_halflife_notified_at = NULL, updated_at = NOW()
      WHERE user_id = $1`,
    [userId],
  );
}
