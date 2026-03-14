/**
 * Conversation Health Check
 * Standalone diagnostic script that analyzes conversation_events data.
 *
 * Usage: npx tsx src/scripts/conversation-health-check.ts
 */

import { pool } from '../config/db.js';

interface Problem {
  severity: 'critical' | 'warning' | 'info';
  type: string;
  details: Record<string, unknown>;
}

async function run() {
  const PERIOD_DAYS = 30;
  const problems: Problem[] = [];

  // --- Flow completion rates ---
  const flowStats = await pool.query(
    `SELECT
       flow_state,
       COUNT(*) FILTER (WHERE event_type = 'flow_started') AS started,
       COUNT(*) FILTER (WHERE event_type = 'flow_completed') AS completed,
       COUNT(*) FILTER (WHERE event_type = 'flow_abandoned') AS abandoned
     FROM conversation_events
     WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
       AND flow_state IS NOT NULL
       AND event_type IN ('flow_started', 'flow_completed', 'flow_abandoned')
     GROUP BY flow_state`,
    [PERIOD_DAYS],
  );

  for (const row of flowStats.rows) {
    const started = parseInt(row.started);
    const completed = parseInt(row.completed);
    if (started >= 5) {
      const completionRate = (completed / started) * 100;
      if (completionRate < 60) {
        problems.push({
          severity: 'warning',
          type: 'low_completion_rate',
          details: {
            flowState: row.flow_state,
            started,
            completed,
            abandoned: parseInt(row.abandoned),
            completionRate: Math.round(completionRate * 10) / 10,
          },
        });
      }
    }
  }

  // --- High abandonment steps ---
  const abandonSteps = await pool.query(
    `SELECT flow_state, flow_step, COUNT(*) AS count
     FROM conversation_events
     WHERE event_type = 'flow_abandoned'
       AND created_at >= NOW() - $1::int * INTERVAL '1 day'
     GROUP BY flow_state, flow_step`,
    [PERIOD_DAYS],
  );

  const abandonByFlow: Record<string, { total: number; steps: { step: number; count: number }[] }> = {};
  for (const row of abandonSteps.rows) {
    const key = row.flow_state;
    if (!abandonByFlow[key]) abandonByFlow[key] = { total: 0, steps: [] };
    const count = parseInt(row.count);
    abandonByFlow[key].total += count;
    abandonByFlow[key].steps.push({ step: row.flow_step, count });
  }

  for (const [flowState, data] of Object.entries(abandonByFlow)) {
    for (const { step, count } of data.steps) {
      if (data.total > 0 && (count / data.total) > 0.4) {
        problems.push({
          severity: 'info',
          type: 'high_abandonment_step',
          details: {
            flowState,
            step,
            count,
            totalAbandoned: data.total,
            pct: Math.round((count / data.total) * 1000) / 10,
          },
        });
      }
    }
  }

  // --- Frequent unknown phrases ---
  const unknownPhrases = await pool.query(
    `SELECT message, COUNT(*) AS count
     FROM unparsed_messages
     WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
     GROUP BY message
     HAVING COUNT(*) >= 5
     ORDER BY count DESC
     LIMIT 20`,
    [PERIOD_DAYS],
  );

  for (const row of unknownPhrases.rows) {
    problems.push({
      severity: 'critical',
      type: 'frequent_unknown_phrase',
      details: {
        phrase: row.message,
        count: parseInt(row.count),
      },
    });
  }

  // --- High AI fallback rate ---
  const fallbackRate = await pool.query(
    `SELECT
       date_trunc('day', created_at)::date AS day,
       COUNT(*) FILTER (WHERE event_type = 'intent_detected') AS intents,
       COUNT(*) FILTER (WHERE event_type = 'fallback_ai') AS fallbacks
     FROM conversation_events
     WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
       AND event_type IN ('intent_detected', 'fallback_ai')
     GROUP BY day
     ORDER BY day`,
    [PERIOD_DAYS],
  );

  for (const row of fallbackRate.rows) {
    const intents = parseInt(row.intents);
    const fallbacks = parseInt(row.fallbacks);
    if (intents > 0) {
      const rate = (fallbacks / intents) * 100;
      if (rate > 20) {
        problems.push({
          severity: 'warning',
          type: 'high_ai_fallback_rate',
          details: {
            day: row.day,
            intents,
            fallbacks,
            rate: Math.round(rate * 10) / 10,
          },
        });
      }
    }
  }

  // --- Summary metrics ---
  const metricsResult = await pool.query(
    `SELECT
       COUNT(*) AS total_events,
       COUNT(*) FILTER (WHERE event_type = 'message_received') AS messages,
       COUNT(*) FILTER (WHERE event_type = 'intent_detected') AS intents,
       COUNT(*) FILTER (WHERE event_type = 'flow_started') AS flows_started,
       COUNT(*) FILTER (WHERE event_type = 'flow_completed') AS flows_completed,
       COUNT(*) FILTER (WHERE event_type = 'flow_abandoned') AS flows_abandoned,
       COUNT(*) FILTER (WHERE event_type = 'fallback_ai') AS fallbacks,
       COUNT(*) FILTER (WHERE event_type = 'error') AS errors,
       COUNT(DISTINCT user_id) AS unique_users
     FROM conversation_events
     WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'`,
    [PERIOD_DAYS],
  );

  const metrics = metricsResult.rows[0];

  const report = {
    generatedAt: new Date().toISOString(),
    period: { days: PERIOD_DAYS },
    problems,
    metrics: {
      totalEvents: parseInt(metrics.total_events),
      messages: parseInt(metrics.messages),
      intents: parseInt(metrics.intents),
      flowsStarted: parseInt(metrics.flows_started),
      flowsCompleted: parseInt(metrics.flows_completed),
      flowsAbandoned: parseInt(metrics.flows_abandoned),
      fallbacks: parseInt(metrics.fallbacks),
      errors: parseInt(metrics.errors),
      uniqueUsers: parseInt(metrics.unique_users),
    },
  };

  console.log(JSON.stringify(report, null, 2));
  await pool.end();
}

run().catch((err) => {
  console.error('Health check failed:', err);
  process.exit(1);
});
