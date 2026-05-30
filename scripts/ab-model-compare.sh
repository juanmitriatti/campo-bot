#!/bin/bash
# A/B comparison: Haiku vs Sonnet on the agent pipeline.
# Runs qa-adversarial-30 + qa-adversarial-advanced-40 against local Docker
# for each model, capturing per-test results JSON + real token usage for cost.
set -uo pipefail
cd /Users/juanpablomitriatti/Desktop/campo-bot

OUT=ab-results
mkdir -p "$OUT"
PSQL_T="docker compose exec -T db psql -U campo -d campo_bot -t -A"

log () { echo "[$(date +%H:%M:%S)] $*"; }

set_setting () {
  docker compose exec -T db psql -U campo -d campo_bot -c \
    "INSERT INTO system_settings(key,value,updated_at) VALUES('$1','$2',NOW()) ON CONFLICT(key) DO UPDATE SET value='$2', updated_at=NOW();" >/dev/null
}

wait_health () {
  for i in $(seq 1 40); do
    if curl -s --max-time 3 http://localhost:3000/api/health 2>/dev/null | grep -q '"status":"ok"'; then
      return 0
    fi
    sleep 2
  done
  log "WARN: health never came up"
}

# --- One-time fixed config (identical for both models) ---
set_setting AGENT_ENABLED true
set_setting AGENT_MAX_TOKENS 1500

# --- Ensure both QA users exist + are enterprise (reset doesn't touch plan_id) ---
for EMAIL in qa-adversarial@campo.test qa-advanced@campo.test; do
  curl -s --max-time 10 -X POST http://localhost:3000/api/auth/register \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"QA\",\"last_name\":\"Test\",\"email\":\"$EMAIL\",\"password\":\"qatest123\"}" >/dev/null 2>&1 || true
done
# adversarial-30 uses qatest123, advanced-40 uses qaadv123 — register the second pw too
curl -s --max-time 10 -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"QA\",\"last_name\":\"Test\",\"email\":\"qa-advanced@campo.test\",\"password\":\"qaadv123\"}" >/dev/null 2>&1 || true
docker compose exec -T db psql -U campo -d campo_bot -c \
  "UPDATE users SET plan_id=4 WHERE email IN ('qa-adversarial@campo.test','qa-advanced@campo.test');" >/dev/null

run_model () {
  local MODEL="$1" TAG="$2"
  log "=== MODEL=$MODEL (tag=$TAG) ==="
  set_setting AGENT_MODEL "$MODEL"
  log "restarting app to clear settings cache..."
  docker compose restart app >/dev/null 2>&1
  wait_health
  # keep enterprise plan (in case anything reset it)
  docker compose exec -T db psql -U campo -d campo_bot -c \
    "UPDATE users SET plan_id=4 WHERE email IN ('qa-adversarial@campo.test','qa-advanced@campo.test');" >/dev/null

  local BASE
  BASE=$($PSQL_T -c "SELECT COALESCE(MAX(id),0) FROM ai_usage;")
  log "ai_usage baseline id=$BASE"

  log "running qa-adversarial-30..."
  npx tsx src/testing/qa-adversarial-30.ts > "$OUT/adv30-$TAG.log" 2>&1
  cp src/testing/qa-adversarial-results.json "$OUT/adv30-$TAG.json" 2>/dev/null || log "WARN no adv30 json"

  log "running qa-adversarial-advanced-40..."
  npx tsx src/testing/qa-adversarial-advanced-40.ts > "$OUT/adv40-$TAG.log" 2>&1
  cp src/testing/qa-adversarial-advanced-40-results.json "$OUT/adv40-$TAG.json" 2>/dev/null || log "WARN no adv40 json"

  # token usage for this model's whole window
  $PSQL_T -c "SELECT 'calls='||COUNT(*)||' in='||COALESCE(SUM(input_tokens),0)||' out='||COALESCE(SUM(output_tokens),0)||' cread='||COALESCE(SUM(cache_read_tokens),0)||' cwrite='||COALESCE(SUM(cache_write_tokens),0) FROM ai_usage WHERE id > $BASE;" > "$OUT/tokens-$TAG.txt"
  log "tokens: $(cat "$OUT/tokens-$TAG.txt")"
}

run_model "claude-haiku-4-5-20251001" haiku
run_model "claude-sonnet-4-6" sonnet

# restore default model (remove override → falls back to Haiku default)
set_setting AGENT_MODEL "claude-haiku-4-5-20251001"
docker compose restart app >/dev/null 2>&1
wait_health
log "DONE — results in $OUT/"
