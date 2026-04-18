# Known Failure Patterns & Pitfalls

## AI Agent Hallucinations

- **Amount=0 expense alongside agro activity**: Agent sometimes returns `log_expense` with amount=0 alongside a real activity tool. Smart filter in `agent-response-mapper.ts` drops it only when amount=0, keeps legitimate expenses with real amounts.
- **Agro verbs misclassified as `log_expense`**: "fumigué", "sembré" etc. should be activities. Prompt rules in `agent-prompt-builder.ts` explicitly prevent this unless user mentions an explicit money amount.

## Disambiguation Failures

- **"hectáreas"/"has" confused with "hacienda"**: Must route to `list_plots`, not livestock tools. Explicit disambiguation rule in agent prompt.
- **Questions classified as observations**: `isLikelyQuestionOrFollowUp()` guard in `agronomy.handler.ts` prevents non-agro text from being saved as observations. `STRONG_OBS_SIGNALS` regex (plaga, maleza, hongo, roya, helada, etc.) bypasses the guard for legitimate agro observations.
- **`record_livestock_birth` used for "20 vacas con 10 terneros"**: Must be 2x `add_livestock`. Birth tool only with explicit birth verbs (nacieron/parieron/nació).
- **"cuándo se fumigó" classified as activity**: Should be `query_plot_history`, not activity registration.

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

## Deploy Gotcha

- **Railway does NOT auto-deploy on `git push`**: Must run `railway up --detach` manually after pushing to main. Otherwise prod stays on old code indefinitely.
