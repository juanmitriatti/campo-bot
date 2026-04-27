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

## Deploy Gotcha

- **Railway does NOT auto-deploy on `git push`**: Must run `railway up --detach` manually after pushing to main. Otherwise prod stays on old code indefinitely.
