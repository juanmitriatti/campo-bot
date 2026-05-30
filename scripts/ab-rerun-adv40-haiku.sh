#!/bin/bash
# Re-run ONLY adversarial-40 under Haiku (the first run died at login before the
# qa-advanced password was fixed). Captures JSON + token totals to merge into the
# haiku side of the A/B.
set -uo pipefail
cd /Users/juanpablomitriatti/Desktop/campo-bot
OUT=ab-results
PSQL_T="docker compose exec -T db psql -U campo -d campo_bot -t -A"
log () { echo "[$(date +%H:%M:%S)] $*"; }

docker compose exec -T db psql -U campo -d campo_bot -c \
  "INSERT INTO system_settings(key,value,updated_at) VALUES('AGENT_MODEL','claude-haiku-4-5-20251001',NOW()) ON CONFLICT(key) DO UPDATE SET value='claude-haiku-4-5-20251001', updated_at=NOW();" >/dev/null
log "model→haiku, restarting app..."
docker compose restart app >/dev/null 2>&1
for i in $(seq 1 40); do curl -s --max-time 3 http://localhost:3000/api/health 2>/dev/null | grep -q '"status":"ok"' && break; sleep 2; done
docker compose exec -T db psql -U campo -d campo_bot -c "UPDATE users SET plan_id=4 WHERE email='qa-advanced@campo.test';" >/dev/null

BASE=$($PSQL_T -c "SELECT COALESCE(MAX(id),0) FROM ai_usage;")
log "baseline id=$BASE — running adv40 (haiku)..."
npx tsx src/testing/qa-adversarial-advanced-40.ts > "$OUT/adv40-haiku.log" 2>&1
cp src/testing/qa-adversarial-advanced-40-results.json "$OUT/adv40-haiku.json" 2>/dev/null || log "WARN no json"
$PSQL_T -c "SELECT 'calls='||COUNT(*)||' in='||COALESCE(SUM(input_tokens),0)||' out='||COALESCE(SUM(output_tokens),0)||' cread='||COALESCE(SUM(cache_read_tokens),0)||' cwrite='||COALESCE(SUM(cache_write_tokens),0) FROM ai_usage WHERE id > $BASE;" > "$OUT/tokens-haiku-adv40.txt"
log "adv40-haiku tokens: $(cat "$OUT/tokens-haiku-adv40.txt")"
log "DONE-ADV40-HAIKU"
