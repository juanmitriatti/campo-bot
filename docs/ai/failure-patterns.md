# Known Failure Patterns & Pitfalls

## AI Agent Hallucinations

- **Amount=0 expense alongside agro activity**: Agent sometimes returns `log_expense` with amount=0 alongside a real activity tool. Smart filter in `agent-response-mapper.ts` drops it only when amount=0, keeps legitimate expenses with real amounts.
- **Agro verbs misclassified as `log_expense`**: "fumigué", "sembré" etc. should be activities. Prompt rules in `agent-prompt-builder.ts` explicitly prevent this unless user mentions an explicit money amount.

## Disambiguation Failures

- **"hectáreas"/"has" confused with "hacienda"**: Must route to `list_plots`, not livestock tools. Explicit disambiguation rule in agent prompt.
- **Questions classified as observations**: `isLikelyQuestionOrFollowUp()` guard in `agronomy.handler.ts` prevents non-agro text from being saved as observations. `STRONG_OBS_SIGNALS` regex (plaga, maleza, hongo, roya, helada, etc.) bypasses the guard for legitimate agro observations.
- **`record_livestock_birth` used for "20 vacas con 10 terneros"**: Must be 2x `add_livestock`. Birth tool only with explicit birth verbs (nacieron/parieron/nació).
- **"cuándo se fumigó" classified as activity**: Should be `query_plot_history`, not activity registration.
- **Weather ignoring mentioned city**: Before the `city`/`province` params existed on `weather_full`, any query like "en Ameghino va a llover?" silently fell back to `user.city`. Tool now has explicit city param + prompt rule requiring extraction. Handler uses `localidadLookup` for disambiguation.
- **Harvest loads dropped when no destinatario**: AI originally required the "a X con" pattern and ignored plain "driver weight" lists. Prompt now has a strong rule: ANY "nombre número" list in a cosecha context is loads[] — destinatario is optional.
- **Harvest loads silently lost on "no active crop"**: If `harvest_crop` is called with `loads[]` but the plot has no active crop, handler now warns about the N dropped loads so the user knows to sow first and re-send.
- **"Cosecha del lote X" as ambiguous query**: Without a driver/weight list, should route to `query_harvest_loads` (not register a new duplicate harvest). Prompt rule added.
- **Livestock purchases bypassing financials**: Before Apr 2026, cattle buy/sell never touched expenses/incomes. Now `add_livestock` / `remove_livestock` with `unit_price_ars|usd` auto-create a linked expense/income (category "Hacienda") — best-effort, non-blocking.
- **Structured metrics buried in free text**: Until migration 072, "soja V3 con 15% rama negra" was saved as opaque `agro_observations.observation_text`. Now `log_crop_scouting` extracts stage_code, weed_coverage_pct, pest_species, severity, etc. into typed columns. Prompt rule: scouting wins over observation when the message has metrics (%/severity/stage/density). Free-text without metrics stays as `log_observation`.
- **Pest severity ambiguity**: "leve", "moderada", "alta", "severa" need consistent encoding. Prompt has explicit calibration: ausente=1, leve=2, moderada=3, alta=4, severa=5. The agent translates wording to the integer before persisting.
- **Stuck pending field-city loop**: When the agent called `set_field_city` without a city (because user said only "agregar ubicación"), the pending state was set and every subsequent message bounced as "¿En qué ciudad?". Three fixes: (1) prompt rule blocks `set_field_city` without explicit city — falls back to `respond_text` asking; (2) regex in `pending-field-city-handler.ts` handles correction patterns ("no, es X" / "está mal, es en Y") via ordered patterns; (3) `looksLikeNonCity()` escape hatch detects numbers/agro verbs/cancels and exits pending state with a "decime cuando quieras: ubicar campo X en [localidad]" message.
- **Trivial parser smuggling compound clauses into `add_field.city`**: For inputs like "agregar campo X en Y, lotes A y B de 50 ha", the regex `(?:agregar|crear)\s+campo\s+(...)\s+en\s+(.+)` captured "Y, lotes A y B de 50 ha" as city, then localidadLookup couldn't resolve it and started the city flow stuck. Fix: `add_field` regex now stops at the first comma (`[^,]+`) AND the extractor returns null when the original message contains additional clauses (`, lotes` / `sembré` / `fumigué` / `llovió`), letting the agent handle compounds end-to-end.
- **`set_field_city` regex hijacking unrelated mentions**: The pattern `(lote|campo)\s+\w+\s+(esta|queda)\s+...en\s+(.+)` was unanchored, so messages like "el soybean del lote 1A está en V4 con buen plant stand" matched as a city update for "lote 1A" with city "V4 con buen plant stand". Fix: anchored at `^(?:el|la|mi)?\s*(lote|campo|parcela)...` AND now requires explicit "ubicad[oa]" (no longer triggers on bare "está en X").
- **English crop names not recognized**: "soybean", "corn", "wheat" silently fell through. Both the regex parser (`synonyms.js`) and the agent layer (`agent-response-mapper.normalizeCropName()`) translate them now: soybean→soja, corn/maize→maíz, wheat→trigo, sunflower→girasol, sorghum→sorgo, barley→cebada, oat/oats→avena, cotton→algodón, rye→centeno.
- **Mid-flow rename ignored**: User saying "se llama X, no Y" while inside `field_flow` re-prompted the same step. Fix: `extractRenameCorrection()` parses corrections ("se llama X" / "es X, no Y" / "no Y, es X" / "el nombre es X"), mutates `data.name`, and re-prompts the current step. Lives in `conversation-engine.ts`.
- **Agent silently truncated on max_tokens**: Long compounds ("hoy hice un montón: …10 acciones…") would emit only the first ~6 tools and the user thought everything saved. Fix: `AgentResult.truncated=true` when `stop_reason=max_tokens`, surfaced as `_truncated` flag on ParseResult, controllers append a "⚠️ El mensaje era largo y se cortó…" line. Always check `AGENT_MAX_TOKENS` (default 1500) when seeing this in logs.
- **Stage code accepted blindly for crop**: "soja R12" was saved without validation (R12 doesn't exist for soja, only R1..R8). Fix: `stage-code-validator.ts` validates against per-crop ranges and appends a non-blocking "⚠️ El estadio R12 no es típico de soja." line with the valid range hint.
- **Multiple rainfalls one prompt per rain**: "20mm el lunes, 35mm el martes, 12mm el miércoles" generated 3 separate "¿En qué campo?" prompts, only the last one's button worked, the other 2 mm were lost. Fix: `compound-executor.consolidateRainfallPrompts()` collapses them into one batched prompt with callback `rain_batch_<field>_<base64>`. New `log_rainfall_batch` command persists all entries with their dates.
- **Pronombre "ahí" only worked for registrations**: In queries like "¿cuánta lluvia hubo ahí?" the agent dropped the plot context. Prompt rule now explicitly states pronouns apply to TANTO registros COMO consultas (rainfall_report ahí, financial_report ese lote, etc.).
- **Agent fabricates `<UNKNOWN>` for required string params**: When `sow_crop`/`harvest_crop` schema marks `crop` as required and the user message omits the crop ("sembramos 20 ha en el lote de tommy"), the agent fills in a placeholder string like `<UNKNOWN>` to satisfy the contract — silently writing it to `plot_crops.crop` and rendering it in the response. Two-layer fix: (1) prompt rule splits "no pidas datos faltantes" into IDENTIFICATION (campo/lote/fecha — system auto-resolves) vs BUSINESS DATA (cultivo/producto/categoría — must use `respond_text` to ask, never invent placeholders); (2) defensive `isPlaceholder()` guard in `src/utils/guards.ts` catches `<UNKNOWN>`, "desconocido", "?", empty, generic field-name echoes ("cultivo", "producto"), etc. Applied in `agronomy.handler.ts` `sow_crop` + `harvest_crop` cases AND in `savePendingActivity` for both — re-prompts "🌱 ¿Qué cultivo sembraste?" instead of persisting. Eval scenario: `19-sow-crop-missing.json`.

## Data Integrity

- **UTC timezone shift in frontend dates**: Use `toLocalDate()` helper (in frontend) for date inputs. Argentina is UTC-3, so `.slice(0,10)` on UTC ISO strings shifts +1 day.
- **Soft hyphens (U+00AD) in city names**: 53 Buenos Aires entries in census data contain invisible soft hyphens. Normalizer in `localidad-lookup.service.ts` strips them.
- **PlotDiscoveryService is LOOKUP-ONLY**: Never auto-creates fields or plots. Returns `notFound`/`needPlotSelection`/`needPlotCreation` info for unresolved entities.
- **Soft delete everywhere**: Expenses, incomes, fields, plots all use `deleted_at` column. Queries must filter `WHERE deleted_at IS NULL`.

## Flow Engine Gotchas

- **`flow_field_loc_*` callbacks MUST be handled BEFORE generic `flow_field_*` prefix**: Otherwise prefix strip turns `flow_field_loc_map` into `"loc map"` which fails validation. All 3 controllers have this ordering.
- **Compound actions force `confirm_before_save=false`**: So expenses/incomes save directly without user confirmation step.
- **Stop at `startFlow` sideEffect in compound execution**: If any step returns a flow, execution stops there because flow needs user input.
- **`skipIf` check in `executeConfirm`**: Bug fix — `skipIf` now runs in `executeConfirm()` to properly skip steps with pre-filled data.

## Cost Optimization

- **Input tokens were not cached on tools**: Until Apr 2026, only the system prompt had `cache_control`. The 82-tool definitions block was sent uncached every call. Now `agent.service.ts` marks the last tool and last few-shot message with `cache_control` — cache hit rate visible in `AI_AGENT CACHE: Nread/Nwrite` log line.
- **Cache invalidated between consecutive calls**: The system prompt used to include `lastFieldName`/`lastPlotName` from user context, which changed per message. That shifted the cached prefix and forced a ~24k-token cache rewrite every call. Fix: `AgentPromptBuilder.build()` now returns only stable content; `buildUserMessagePrefix()` emits user context + today's date into the user message (not cached). See commit 98b8a26.
- **Few-shot `ORDER BY RANDOM()` thrashed cache**: Each call picked 5 different examples, shifting the cached prefix. Replaced with `ORDER BY md5(id::text || CURRENT_DATE::text)` — deterministic per day, rotates across days. See commit aca29ad.
- **AGENT_MAX_TOKENS=400 truncated big outputs**: A harvest_crop call with 17 loads needed ~850 output tokens, hit the 400 ceiling, produced broken JSON, and the handler discarded loads[]. Bumped to 1500 via the `AGENT_MAX_TOKENS` setting. You only pay for tokens actually generated.
- **Dashboard under-reported Anthropic bill ~15×**: `ai_usage` only stored `input_tokens` / `output_tokens`, so cache writes (1.25× of input rate) and reads (0.10×) were invisible. Migration 070 added `cache_read_tokens` and `cache_write_tokens`. Dashboard cost formulas now include all four terms. **No change in actual billing — just visibility into what Anthropic was already charging.**

## Weather Alerts

- **Inline alert hardcoded to 10mm**: `checkRainAlert()` used to ignore `user_settings.rain_alert_mm` and compare against a literal 10. Now accepts threshold as param; handlers pass `settings.rain_alert_mm` for parity with scheduled alerts.
- **Scheduled alert skipping today**: The 06:00 AR scheduler only checked tomorrow + day after. Now includes today too (`{ includeToday: true }`) — by 6am the day is still ahead, so today's rain/wind matters.
- **No dry-window or wind alerts**: Added 2 new alert types: `checkDryWindow` (consecutive days below 1mm rain, useful for planning applications) and `checkWindAlert` (any day ≥ threshold km/h). Settings: `dry_window_days` (default 3), `wind_alert_kmh` (default 20). All weather alerts now include "_Es un pronóstico, puede cambiar._" disclaimer.

## Deploy Gotcha (resolved 2026-05-02)

- **Push to `main` now auto-deploys via GitHub Actions**: tests → `railway up` → smoke test that polls `/api/health` for the new SHA. Configured in `.github/workflows/deploy.yml`. See [docs/operations.md](../operations.md#railway-deploy) for full details.
- **Historical context**: previously prod required a manual `railway up --detach` after every push, and prod regularly drifted to days-old code while the commit sat on GitHub. The pipeline closes that gap.
- **`.deploy-sha` must NOT be in `.gitignore`**: `railway up` respects gitignore and would exclude the file from upload, causing the smoke test to time out forever (`/api/health` returns `sha:null`).
