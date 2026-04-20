# Tool Selection Reference

> 74 Anthropic tool definitions in `src/ai/tool-definitions.ts`. Each has typed `input_schema` with enum validation.

## Tool Groups

| Group | Count | Tools |
|-------|-------|-------|
| Financial | 5 | `log_expense`, `log_income`, `create_expense_template`, `list_expense_templates`, `delete_expense_template` |
| Activities | 15 | `sow_crop`, `harvest_crop`, `query_harvest_loads`, `delete_harvest_loads`, `log_spraying`, `log_fertilization`, `log_activity`, `active_crop`, `close_campaign`, `campaign_stats`, `compare_campaigns`, `activity_stats`, `log_tacto`, `tacto_summary`, `edit_last_activity` |
| Observations | 2 | `log_observation`, `query_plot_history` |
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
- Argentine number convention: "31.320 kg" = 31320 (dot = thousands separator)
- Dedup: if same plot already harvested today → appends loads to existing event (no duplicate harvest)
- `updateYieldFromLoads()` auto-sums all loads into `plot_crops.yield_kg`
- `query_harvest_loads` queries stored loads with filters (plot, field, date, driver, destinatario)
- `delete_harvest_loads` removes loads by criteria (plot, date, driver_names[], only_without_destination)
- `campaign_stats` includes loads detail in the yield section + cost/tn and income/tn metrics

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
