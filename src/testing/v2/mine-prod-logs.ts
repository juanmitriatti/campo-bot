import pg from 'pg';
import fs from 'fs';

// Prod connection string is passed via env to avoid hardcoding secrets in the repo.
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Set PROD_DATABASE_URL (read-only use).'); process.exit(2); }

const SUSPICIOUS = /no entend|no encontr|me falta|no pude|fallback|sin reconocer|no s[ée] qu[ée]/i;

function anonymize(text: string): string {
  return (text || '')
    .replace(/\+?54?9?\d{8,12}/g, '<TEL>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<EMAIL>');
}

async function main() {
  const limit = Number(process.argv[process.argv.indexOf('--limit') + 1] || 300);
  const pool = new pg.Pool({ connectionString: PROD_URL, max: 2 });
  // Pull recent conversations ordered per-user/time so multi-turn context is reconstructable.
  // `tool_calls` holds the agent's actual tool_use blocks → invaluable for diagnosing the miss.
  const { rows } = await pool.query(
    `SELECT user_id, message_text, response_text, intent_type, intent_command, agent_mode,
            channel, tool_calls, confidence, was_correct, processing_time_ms, created_at
     FROM conversation_logs
     WHERE message_text IS NOT NULL AND direction = 'inbound'
     ORDER BY user_id, created_at DESC
     LIMIT $1`, [limit],
  );

  const flagged = rows
    .filter((r) =>
      r.was_correct === false ||
      SUSPICIOUS.test(r.response_text || '') ||
      (r.processing_time_ms || 0) > 8000 ||
      !r.response_text ||
      (r.confidence != null && Number(r.confidence) < 0.5),
    )
    .map((r) => ({
      user_id: r.user_id,
      message: anonymize(r.message_text),
      response: anonymize(r.response_text || ''),
      intent_type: r.intent_type, intent_command: r.intent_command, agent_mode: r.agent_mode,
      channel: r.channel, tool_calls: r.tool_calls, confidence: r.confidence, was_correct: r.was_correct,
      ms: r.processing_time_ms, at: r.created_at,
      reason: r.was_correct === false ? 'admin_flagged_wrong'
        : !r.response_text ? 'empty_response'
        : SUSPICIOUS.test(r.response_text || '') ? 'failure_phrase'
        : (r.confidence != null && Number(r.confidence) < 0.5) ? 'low_confidence'
        : 'slow',
    }));

  fs.mkdirSync('ab-results/v2', { recursive: true });
  fs.writeFileSync('ab-results/v2/prod-candidates.json', JSON.stringify(flagged, null, 2));
  console.log(`Flagged ${flagged.length}/${rows.length} conversations → ab-results/v2/prod-candidates.json`);
  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(2); });
