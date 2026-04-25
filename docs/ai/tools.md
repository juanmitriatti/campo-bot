# Tool Selection Reference

> 76 Anthropic tool definitions in `src/ai/tool-definitions.ts`. Each has typed `input_schema` with enum validation.

## Tool Groups

| Group | Count | Tools |
|-------|-------|-------|
| Financial | 5 | `log_expense`, `log_income`, `create_expense_template`, `list_expense_templates`, `delete_expense_template` |
| Activities | 15 | `sow_crop`, `harvest_crop`, `query_harvest_loads`, `delete_harvest_loads`, `log_spraying`, `log_fertilization`, `log_activity`, `active_crop`, `close_campaign`, `campaign_stats`, `compare_campaigns`, `activity_stats`, `log_tacto`, `tacto_summary`, `edit_last_activity` |
| Observations | 2 | `log_observation`, `query_plot_history` |
| Crop scouting (structured) | 2 | `log_crop_scouting`, `query_scoutings` |
| Reports | 6 | `financial_report`, `generate_agro_report`, `share_report`, `show_reports_menu`, `crop_report`, `campaign_report` |
| Field/Plot Mgmt | 11 | `create_field`, `list_fields`, `delete_field`, `rename_field`, `add_plot`, `add_plots_batch`, `list_plots`, `set_plot_area`, `delete_plot`, `rename_plot`, `set_field_city` |
| Sharing | 4 | `share_field`, `accept_invite`, `list_field_members`, `remove_field_member` |
| Stock | 8 | `create_warehouse`, `list_warehouses`, `add_stock`, `remove_stock`, `adjust_stock`, `check_stock`, `stock_history`, `set_min_stock` |
| Documents | 3 | `upload_document`, `list_documents`, `link_document_to_expense` |
| Livestock | 8 | `add_livestock`, `remove_livestock`, `transfer_livestock`, `record_livestock_death`, `record_livestock_birth`, `adjust_livestock`, `list_livestock`, `livestock_history` |
| Feedlot/Corral | 7 | `create_feedlot`, `list_feedlots`, `delete_feedlot`, `create_corral`, `list_corrals`, `delete_corral`, `rename_corral` |
| System | 1 | `update_settings` |

## Disambiguation Rules (IF → THEN)

### Activity vs Expense
- IF agro verb (fumigué, sembré, coseché, fertilicé) WITHOUT explicit money amount → activity tool (NEVER `log_expense`)
- IF agro verb WITH explicit amount (e.g., "sembré soja y la semilla costó 100mil") → BOTH activity tool + `log_expense` (compound)
- IF compré/gasté + insumo product → `log_expense` (type=insumo)
- IF vendí/cobré → `log_income`

### Hectáreas vs Hacienda
- IF "has"/"hectáreas"/"superficie" + campo/lote context → `list_plots` (NOT livestock)
- IF "hacienda"/"vacas"/"novillos" → livestock tools

### Active Crop Queries
- IF "soja?"/"qué cultivo tiene el lote X" → `active_crop` (NOT `list_plots`)
- IF "has sembradas" / "cultivos activos" → `active_crop`
- IF "cuándo se fumigó/sembró el lote X" → `query_plot_history` (NOT activity registration)

### Financial Queries
- IF "gastos/ingresos + en/del + lote X" (no amount) → `financial_report(plot=X)` (NEVER `log_observation`)
- IF "gastos + campo X" → `financial_report(field=X)`

### Recurring Expenses
- IF "gasto fijo/recurrente/mensual/semanal" → `create_expense_template` (NEVER `log_expense`)
- IF "mis gastos fijos"/"gastos recurrentes" → `list_expense_templates`
- IF "borrar/cancelar gasto fijo" → `delete_expense_template`

### Campaign Comparison
- IF "comparar soja 25/26 vs 24/25"/"comparar campañas"/"cómo salió vs la anterior" → `compare_campaigns`
- IF only "comparar" without crop → compares last 2 campaigns of same plot

### PDF / Share Reports
- IF "mandame el PDF"/"exportar reporte"/"compartir reporte"/"PDF de la campaña" → `share_report`
- `report_type=campaign` for campaign reports, `report_type=financial` for financial

### Livestock Disambiguation
- IF "N vacas con N terneros" → 2x `add_livestock` (NEVER `record_livestock_birth`)
- IF explicit birth verb (nacieron/parieron/nació) → `record_livestock_birth`
- IF "pasé N terneros a novillos en lote X" → `transfer_livestock` (auto-detects recategorización)

### Report Routing
- IF "reporte agronómico" → `generate_agro_report` (needs agent for date range parsing)
- IF "reporte financiero" / "cómo vamos" → `financial_report`
- IF "reportes"/"informes" (generic, no type) → `show_reports_menu`

### Sow Crop
- `sow_crop` accepts optional `hectares` param for partial-plot sowing
- Stored in `plot_crops.sowed_hectares`

### Harvest Loads (Per-Truck Tracking)
- `harvest_crop` accepts optional `loads[]` array: `{ driver_name, weight_kg, destination?, destinatario?, truck_plate? }`
- Only `driver_name` + `weight_kg` required on each load. Destinatario and kg unit optional.
- Extraction: in cosecha context, ANY list of `nombre número` (line-separated or comma-separated) is loads[], with or without "kg" unit or "a destinatario".
- Argentine number convention: "31.320 kg" = 31320 (dot = thousands separator). Values in tn auto-convert to kg (*1000).
- Dedup: if same plot already harvested today → appends loads to existing event (no duplicate harvest)
- `updateYieldFromLoads()` auto-sums all loads into `plot_crops.yield_kg`
- `query_harvest_loads` queries stored loads with filters (plot, field, date, driver, destinatario)
- `delete_harvest_loads` removes loads by criteria (plot, date, driver_names[], only_without_destination)
- `campaign_stats` includes loads detail in the yield section + cost/tn and income/tn metrics
- "Cosecha del lote X" WITHOUT driver/weight list → `query_harvest_loads` (query intent), NOT `harvest_crop` (register)
- If `harvest_crop` called with no new loads but plot already has stored loads → response appends existing-loads summary

### Expense Metadata (Insumos)
- `log_expense` accepts `unit_price` (number) — for "a X c/u" / "a X el kg/lt" patterns. Ex: "50 bolsas urea a 8000 c/u" → quantity=50, unit_price=8000, amount=400000.
- Parity with `log_income.unit_price` (added in migration 067).
- `ExpenseEditModal` + `IncomeEditModal` expose unit_price field when `expense_type=insumo`.
- `ExpenseCard` / `IncomeCard` render "Producto · Qty unit · @ precio" line below description when data present.

### Weather Queries
- `weather_full` accepts `city` + `province` (optional). Agent MUST extract city when user mentions it ("clima en Ameghino" → city="Ameghino").
- Handler runs `localidadLookup` on the city name:
  - `exact` → use matched city
  - `disambiguate` (Ameghino in Bs As vs La Pampa) → respond with options asking user to clarify with province
  - `suggestions` (typo) → offer fuzzy alternatives
  - `not_found` → try OpenWeather with the raw name (tolerant)
- No city in query → falls back to `user.city` (current behavior).

### Livestock ↔ Financial Integration
- `add_livestock` with `unit_price_ars` or `unit_price_usd` → auto-creates expense (category "Hacienda") with total = count × unit_price.
- `remove_livestock` with `unit_price_*` → auto-creates income (category "Hacienda").
- Currency priority: ARS if present, else USD.
- Persisted in `livestock_movements.linked_expense_id` / `linked_income_id` for traceability.
- Best-effort: if financial write fails, movement still succeeds (logged, not thrown).

### Prompt Caching (Cost Optimization)
- `agent.service.ts` sets `cache_control` on three breakpoints:
  1. System prompt (stable: core rules + disambiguation only; user context + today's date moved to user-message prefix so the cached prefix hits across users)
  2. Last tool definition — caches the 74-tool block (~24k tokens when serialized for cache)
  3. Last few-shot message — caches examples (~830 tokens). Selection is deterministic per day via `ORDER BY md5(id::text || CURRENT_DATE::text)` so the cache doesn't thrash with random reshuffles.
- TTL is configurable via `AGENT_CACHE_TTL` setting: `short` (5 min, 1.25× write, default) / `long` (1 hour, 2× write). Wiring in `agent.service.ts` translates this into `cache_control.ttl`.
- Few-shot count configurable via `AGENT_FEW_SHOT_LIMIT` (default 5). Each example ~166 tokens. Going from 5 → 10 adds ~$0.02/day at 100 calls.
- `AGENT_TEMPERATURE` is read from settings (was hardcoded to 0 before Apr 2026). Default 0.
- Logs `CACHE: Nread/Nwrite` in `AI_AGENT` line so hit rate can be observed in Railway logs.

### Cost Tracking (Migration 070)
- `ai_usage` table now stores `cache_read_tokens` and `cache_write_tokens` alongside `input_tokens` / `output_tokens`. Without these, dashboard under-reported cost ~15× on cache-heavy calls.
- `saveAiUsage()` in `src/services/expenses.js` persists all 4 token types and computes the real Haiku 4.5 cost: input 0.80/M, cache read 0.08/M (10%), cache write 1.00/M (125% for 5-min TTL), output 4.00/M.
- Dashboard `/admin/api/stats` "Costo IA del Mes" + `/api/users` `costToday` / `costMonth` use the same 4-term formula.
- The "Costo Total USD" / "Costo Promedio" tiles under the Audio and Fallback subsections now labelled "Costo Audio (hist.)" / "Costo Fallback (hist.)" to avoid being confused with bot-wide totals.

### Crop Scouting (Migration 072) — Structured Agronomic Monitoring
- New table `crop_scoutings` separates structured scouting from free-text `agro_observations`. Different conceptual entities — scoutings are analytical data that need to be queryable by metric.
- 9 optional metrics per row: `stage_code` (V3, R5, Z3 → matches `crop_stages`), `weed_coverage_pct` (0-100), `weed_species[]`, `pest_species`, `pest_severity_1_5` (1=ausente, 2=leve, 3=moderada, 4=alta, 5=severa), `pest_affected_pct`, `soil_moisture_1_5`, `emergence_pct`, `plant_density_m2`. Plus free-text `notes`.
- `plot_id` REQUIRED (analytics depend on it); `plot_crop_id` auto-derived from active campaign so per-campaign rollups work.
- **`log_crop_scouting`**: extracts the metrics from messages like "soja V3 con 15% de rama negra y presencia leve de chinche" → `stage_code=V3, weed_coverage_pct=15, weed_species=["rama negra"], pest_species="chinche", pest_severity_1_5=2`. Severity calibration documented inline in the prompt.
- **`query_scoutings`**: filters by plot, field, date range, min severity, stage. Triggered by phrases like "cómo viene la sanidad", "presión de plagas", "evolución del cultivo".
- Disambiguation: scouting wins over `log_observation` when the message contains structured metrics (% , severity keyword, stage code, density). Free-text without metrics still goes to `log_observation`.
- **`campaign_stats`** includes a `scouting` block: last stage observed (+ date), avg weed coverage %, max pest severity (+ species), avg plant density, last emergence pct.
- **Agro PDF report**: new "Monitoreo del cultivo" section (toggle `AGRO_REPORT_SHOW_SCOUTING`, default on). Period summary + last-10 detail with notes inline.
- **End-user dashboard**: tab "Monitoreos" 🔍 next to Observaciones (gated by `agronomy` feature). Auth endpoint `GET /api/auth/scoutings` with filters. Read-only — captura va por bot.

## Common Tool Params

All registration tools (activities, expenses, incomes, observations, livestock) include:
- `event_date` (YYYY-MM-DD) — for user-mentioned dates. Agent prompt includes dynamic today's date
- `field` / `plot` — resolved via PlotDiscoveryService (lookup-only, never auto-creates)

## Compound Actions

When agent returns multiple tool calls (e.g., "Sembré soja en A1 y la semilla costó 100mil"):
- `CompoundExecutor` (`src/domain/compound-executor.ts`) processes all sequentially
- `IntentClassifier` attaches `_compoundResults` metadata when `parseResults.length > 1`
- All 3 controllers check for `_compoundResults` before normal routing
- `confirm_before_save` forced `false` for expenses/incomes in compound context
- Stops at `startFlow` sideEffect (flow needs user input)
- Livestock consolidation: same-plot livestock commands merged into single response
