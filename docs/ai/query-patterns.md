# Query Patterns — Source of Truth

This document catalogs **every supported natural-language query pattern** across the 8 unified query tools, with the expected tool call (view + filters) the agent must produce. It is the authoritative reference for:

- How the agent should interpret user questions
- How handlers should dispatch + render
- How regression tests verify behavior

Tested against **user 41 (juan.mitriatti@gmail.com)** seed data. Achieved aggregate **~82% PASS rate** across 600+ queries (see commit history for QA agent reports).

---

## Unified Architecture (recipe)

Every query tool follows the same pattern:

1. **SQL builder** (`src/services/expenses.js` or domain repo): rich filter set, no aggregation
2. **Tool schema** (`src/ai/tool-definitions.ts`): `view` enum + `aggregate_metric` + `group_by` + `sort_by`/`desc` + `top_n` + `inherit` + `compare_*`
3. **Mapper** (`src/ai/agent-response-mapper.ts`): translates `input.X_snake` → `cmd.XCamel`
4. **Handler dispatcher** (e.g. `handleQueryX`): inherit merge → resolve scope → date range → fetch → save state → render
5. **Renderers** (e.g. `X-renderers.ts`): one per view (detail / aggregate / max / min / avg / top_locations / rank / compare / last / timeline / monthly / volume / balance — varies per domain)
6. **Migration**: `last_X_query JSONB` on `conversation_state`
7. **Agent prefix**: prior query surfaced as `Última consulta de X: <summary>. Si refina, pasá inherit:true.`
8. **Prompt block** in `agent-prompt-builder.ts`: 4–6 PASOS (VIEW → FILTROS → PERIODO → MULTI-TURNO → DISAMBIGUACIONES)

**Transient flags excluded from inherit**: `view`, `top_n`, `compare_*` (always per-turn). Other filters carry across multi-turn.

---

## Domain 1 — `financial_report` (gastos e ingresos)

Tool: `financial_report` · Handler: `src/domain/financial/financial.handler.ts:handleFinancialReport` · Prompt block: `═══ FINANCIAL_REPORT ═══`

### Views (10)
`detail` · `aggregate` · `top_categories` · `top_locations` · `max` · `compare` · `balance` · `volume` · `last` · (legacy single-period default)

### Key disambiguation
- "en dólares" / "en USD" → `currency:'USD'` (NEVER FX-quote tool when in financial context)
- `categories[]`: "cereales" / "granos" → `["Soja","Maíz","Trigo","Girasol","Sorgo","Cebada","Avena","Centeno"]`
- `type`: gasté/compré/pagué → `expenses`; cobré/vendí/ingresos/facturé → `incomes`; balance/neto → `both`
- `period`: sin qualifier en query analítica → `'all'`; queries de movimientos recientes sin filtros → mes actual

### Query patterns (sample of 80+)

| Pattern | View / Filters |
|---|---|
| "Mostrame todos los gastos de combustible" | `view:'detail', type:'expenses', category:'Combustible', period:'all'` |
| "¿Cuánto gasté en insumos en mayo?" | `view:'detail', type:'expenses', category:'Insumos', period:'month'` |
| "Ver gastos del lote A1" | `view:'detail', type:'expenses', plot:'A1', period:'all'` |
| "Filtrá solo gastos en USD" | `view:'detail', type:'expenses', currency:'USD'` |
| "Gastos mayores a $300.000" | `amount_min:300000, type:'expenses'` |
| "¿Cuál fue el gasto más alto del mes?" | `view:'max', type:'expenses', top_n:1, period:'month'` |
| "¿En qué categoría gasté más?" | `view:'top_categories', type:'expenses'` |
| "Compará combustible vs insumos" | `view:'compare', category:'Combustible', compare_category:'Insumos'` |
| "¿Qué lote tuvo más gastos?" | `view:'top_locations', group_by:'plot', type:'expenses'` |
| "Resumen de gastos de abril y mayo" | `desde:'2026-04-01', hasta:'<today>', view:'aggregate', type:'expenses'` |
| "Balance entre ingresos y gastos de mayo" | `view:'balance', period:'month'` |
| "¿Fue rentable el lote A1?" | `view:'balance', plot:'A1', period:'all'` |
| "¿Qué cultivo fue más rentable?" | `view:'balance', group_by:'category'` |
| "¿Hubo meses con pérdida?" | `view:'balance', group_by:'month', period:'all'` |
| "Total de tn de soja vendidas" | `view:'volume', type:'incomes', category:'Soja', period:'all'` |
| "¿Cuál fue la última venta?" | `view:'last', type:'incomes', top_n:1` |
| "Promedio USD por tn de soja" | `view:'volume', category:'Soja' (handler computes USD/tn auto)` |
| "Buscar 'glifo'" | `description_search:'glifo', type:'expenses'` |

### Multi-turn (inherit:true)
```
Previo: financial_report(type:'expenses', category:'Combustible', period:'all')
"¿Y en La Esperanza?"  → inherit:true, field:'La Esperanza'
"Sacá sueldos"         → inherit:true, exclude_categories:['Sueldos']
"Y en dólares"         → inherit:true, currency:'USD'  (NUNCA FX-quote)
"Y el más caro"        → inherit:true, view:'max', top_n:1
```

### Edge cases
- Invalid date range ("entre mañana y ayer") → handler returns friendly "rango inválido + alternativas"
- Lote/campo inexistente → "No tengo registrado X. Tus lotes son: A1, A2, B1, B2"

---

## Domain 2 — `query_scoutings` (monitoreos)

Tool: `query_scoutings` · Handler: `src/domain/agronomy/agronomy.handler.ts:handleQueryScoutings` · Renderers: `scouting-renderers.ts`

### Views (8)
`detail` · `aggregate` · `max` · `min` · `avg` · `top_locations` · `compare` · `rank`

### Filter taxonomy
- Stage: `stage_code` (exact "V3") · `stage_prefix` ("V" → V%)
- Pests: `pest_species` (LIKE), `pest_severity_min`, `has_pest`
- Weeds: `weed_species_any[]`, `weed_min_pct`, `weed_max_pct`, `has_weeds`
- Emergence: `emergence_min_pct`, `emergence_max_pct`
- Density: `density_min`, `density_max`
- Soil moisture: `soil_moisture_min`, `soil_moisture_max`
- `aggregate_metric`: `weed_coverage_pct`, `pest_severity`, `emergence_pct`, `plant_density_m2`, `soil_moisture`, `stage` (phenology rank)

### Key disambiguation
- "sanitario/sanidad" SIN palabras animal (hacienda/vacas/rodeo/vacuna) → `query_scoutings`
- "estados V" → `stage_prefix:'V'` (NUNCA stage_code)
- "lote más sano/limpio" → `view:'min', aggregate_metric:'weed_coverage_pct'`
- "evolución/promedio/cantidad/relacioná" → NEVER persists as observation (guard in `isLikelyQuestionOrFollowUp`)
- "100% malezas" → `weed_min_pct:100, weed_max_pct:100` (handler collapses label to `=100%`)
- "estadio más avanzado" → `view:'max', aggregate_metric:'stage'` (Zadoks > R > V > VE)

### Patterns

| Pattern | View / Filters |
|---|---|
| "Mostrame todos los monitoreos" | `view:'detail', period:'all'` |
| "Mostrame lotes con rama negra" | `weed_species_any:["rama negra"]` |
| "¿Hay plagas severas?" | `pest_severity_min:4` |
| "¿Cuál es el estadio más avanzado?" | `view:'max', aggregate_metric:'stage'` |
| "Monitoreos en emergencia" | `stage_code:'VE'` |
| "Estados V" | `stage_prefix:'V', period:'all'` |
| "¿Qué lote está más sano?" | `view:'min', aggregate_metric:'weed_coverage_pct'` |
| "¿Qué lote tuvo mejor emergencia?" | `view:'max', aggregate_metric:'emergence_pct'` |
| "Filtrar emergencia menor a 80%" | `emergence_max_pct:80` |
| "Lotes con más de 10% de malezas" | `weed_min_pct:10` |
| "Promedio de cobertura de malezas" | `view:'avg', aggregate_metric:'weed_coverage_pct'` |
| "Compará A1 vs B1" | `view:'compare', plot:'A1', compare_plot:'B1'` |
| "Lotes secos" | `soil_moisture_max:2` |
| "Lotes algo secos" | `soil_moisture_max:3` |
| "Resumen sanitario de mayo" | `view:'aggregate', period:'month'` (NO query_health_events) |
| "Buscar 'orug'" | `pest_species:'orug'` |
| "Prioridad de recorrida" | `view:'rank', aggregate_metric:'pest_severity', sort_desc:true` |

### Multi-turn
```
"Mostrame monitoreos de San Martin" → field:'San Martin'
"Solo los de B1"                    → inherit:true, plot:'B1'
"Ahora los que tengan plagas"       → inherit:true, has_pest:true
"Y solo arriba de 10%"              → inherit:true, weed_min_pct:10
"¿Qué malezas aparecieron?"         → inherit:false (nueva query con sujeto+verbo)
```

### Edge cases
- "roya" (no existe) → empty + listing de malezas/plagas/estadios disponibles
- "100% malezas" → handler collapses label "=100%"
- Garbage analytical queries (Q51 "Evolución del lote A1") → guard blocks log_observation (NO DB pollution)

---

## Domain 3 — `query_harvest_loads` (cosechas / camiones)

Tool: `query_harvest_loads` · Renderers: `harvest-renderers.ts`

### Views (9)
`detail` · `aggregate` · `max` · `min` · `avg` · `top_locations` · `rank` · `compare` · `volume`

### Filters
- Scope: `field`, `plot`, `crop`, `event_date`, `desde`, `hasta`
- People/transport: `driver_name` (accent-insensitive), `destinatario`, `truck_plate`
- Weight: `weight_min_kg`, `weight_max_kg`
- Quality: `humidity_min/max_pct`, `protein_min/max_pct`, `oil_min/max_pct`, `gluten_min/max_pct`
- `aggregate_metric`: `weight_kg` · `humidity_pct` · `protein_pct` · `oil_pct` · `gluten_pct` · `test_weight_kg_hl` · `count`
- `group_by`: `plot` · `field` · `crop` · `driver` · `destinatario` · `truck_plate` · `date`

### Key rules
- Quality metrics (proteína/aceite/gluten/humedad/PH) → **AVG** not SUM. Groups without that metric excluded.
- Crop accent normalization in SQL (TRANSLATE)
- Driver/destinatario accent-insensitive substring match
- Quality count shows "N cargas con dato" (not total in group)

### Patterns

| Pattern | View / Filters |
|---|---|
| "Mostrame todas las cosechas" | `view:'detail'` |
| "Total cosechado de soja" | `view:'aggregate', crop:'Soja'` (or volume) |
| "¿Cuántos viajes hizo Pedro?" | `view:'aggregate', driver_name:'Pedro'` |
| "¿Qué chofer movió más tn?" | `view:'top_locations', group_by:'driver', aggregate_metric:'weight_kg'` |
| "¿Cuál fue la carga más grande?" | `view:'max', aggregate_metric:'weight_kg'` |
| "Compará soja vs trigo" | `view:'compare', crop:'soja', compare_crop:'trigo'` |
| "¿Qué destino recibió la mejor mercadería?" | `view:'top_locations', group_by:'destinatario', aggregate_metric:'protein_pct'` (AVG) |
| "Promedio de tn por viaje" | `view:'avg', aggregate_metric:'weight_kg'` |
| "Humedad >14%" | `humidity_min_pct:14` |
| "Trigo con proteína >11%" | `crop:'trigo', protein_min_pct:11` |
| "Soja con aceite >21%" | `crop:'soja', oil_min_pct:21` |
| "Descuento por humedad" | `humidity_min_pct:14.5` (AR standard) |
| "Mostrame trigo" en harvest context | `query_harvest_loads(crop:'trigo')` |
| "¿Cuánta soja tengo en Cargill?" (saldo por acopio) | `view:'aggregate', crop:'soja', destinatario:'Cargill'` |
| "¿Cuánto entregué a cada acopio?" | `view:'top_locations', group_by:'destinatario', aggregate_metric:'weight_kg'` |
| "¿Qué tengo en el acopio / en Vicentin?" | `view:'aggregate', destinatario:'Vicentin'` — NUNCA check_stock (eso es insumos en depósito propio) |

### Multi-turn
```
"Cargas de soja" → crop:'soja'
"Solo las de Vicentin" → inherit:true, destinatario:'Vicentin'
"Ordenalas por toneladas" → inherit:true, sort_by:'weight'
"Y arriba de 60 tn" → inherit:true, weight_min_kg:60000
```

---

## Domain 4 — `check_stock` (inventario)

Tool: `check_stock` · Handler: `src/domain/stock/stock.handler.ts:handleQueryStock` · Renderers: `stock-renderers.ts`

### Views (8)
`detail` · `aggregate` · `max` · `min` · `avg` · `top_locations` · `rank` · `compare`

### Filters
- `category`: Agroquímicos, Fertilizantes, Semillas, Combustible, Granos
- `warehouse`, `field`, `product` (LIKE, accent-insensitive)
- `low_stock_only:true` → current ≤ min
- `quantity_min`/`max`, `has_min_stock`
- `group_by`: category · warehouse · field · unit · **product** (sum same name across warehouses)

### Patterns

| Pattern | View / Filters |
|---|---|
| "Mostrame todo el stock" | `view:'detail'` or `aggregate` |
| "¿Qué productos están bajo mínimo?" | `low_stock_only:true` |
| "¿Cuánto glifosato queda?" | `product:'glifosato'` |
| "¿Qué hay en Galpón Norte?" | `warehouse:'Galpón Norte'` |
| "Filtrá solo fertilizantes" | `category:'Fertilizantes'` |
| "Producto con más stock" | `view:'max'` |
| "¿Qué categoría tiene más inventario?" | `view:'top_locations', group_by:'category'` |
| "Promedio de stock por categoría" | `view:'avg', group_by:'category'` |
| "Compará Principal vs Galpón Norte" | `view:'compare', warehouse:'Principal', compare_warehouse:'Galpón Norte'` |
| "Compará maíz vs soja" | `view:'compare', product:'maíz', compare_product:'soja'` |
| "Top 5 productos" | `view:'rank', top_n:5` |
| "Productos sin mínimo definido" | `has_min_stock:false` |

### Multi-turn
```
"Agroquímicos" → category:'Agroquímicos'
"Solo bajo stock" → inherit:true, low_stock_only:true
"Ahora solo San Martin" → inherit:true, field:'San Martin'
"Ordenalos por cantidad" → inherit:true, sort_by:'quantity'
```

**Transient flags NO se heredan**: `low_stock_only`, `has_min_stock`, `view`.

---

## Domain 5 — `list_livestock` (hacienda inventario)

Tool: `list_livestock` · Handler: `livestock.handler.ts:handleQueryInventory` · Renderers: `livestock-renderers.ts`

### Views (8)
`detail` · `aggregate` · `max` · `min` · `avg` · `top_locations` · `rank` · `compare`

### Filters
- `category` (vaca/vaquillona/ternero/novillo/toro/etc.)
- `field`, `plot`, `corral` — corral resolution accepts "1" → "Corral 1"
- `in_feedlot:true/false`, `breed` (substring), `weight_min_kg`, `weight_max_kg`, `count_min/max`
- `aggregate_metric`: `count`, `avg_weight_kg`, `total_weight_kg`
- `group_by`: category · field · plot · corral · breed

### Patterns

| Pattern | View / Filters |
|---|---|
| "¿Cuántos animales tenemos?" | `view:'aggregate'` |
| "Mostrame todos los grupos de hacienda" | `view:'aggregate'` (NUNCA list_plots) |
| "¿Cuántas vacas hay?" | `category:'vaca'` |
| "¿Qué hay en Corral 1?" | `corral:'Corral 1'` |
| "Animales del feedlot" | `in_feedlot:true` |
| "¿Qué lote tiene más hacienda?" | `view:'top_locations', group_by:'plot'` |
| "Peso promedio La Esperanza" | `view:'avg', field:'La Esperanza', aggregate_metric:'avg_weight_kg'` (weighted by count) |
| "Categoría más pesada" | `view:'max', aggregate_metric:'avg_weight_kg'` |
| "Compará vacas vs novillos" | `view:'compare', category:'vaca', compare_category:'novillo'` |
| "Grupo menor peso" | `view:'min', aggregate_metric:'avg_weight_kg'` |
| "Total kg vivos" | `view:'aggregate'` (includes total_weight_kg) |

### Disambiguation
- "grupos" en contexto hacienda → `list_livestock` (NUNCA list_plots)
- "categorías del campo X" cuando hay hacienda → `list_livestock(field:X, view:'aggregate')` (NUNCA check_stock)

### IMPORTANT — health/repro/weighing NOT yet refactored
`query_health_events`, `query_repro_events`, `query_weighings` use **legacy handlers**. Work for basic queries; rich view dispatch pending.

---

## Domain 6 — `query_plot_history` (actividades agronómicas)

Tool: `query_plot_history` · Handler: `agronomy.handler.ts:handleQueryActivities` · Renderers: `activity-renderers.ts`

### Views (10)
`detail` · `aggregate` · `max` · `min` · `avg` · `top_locations` · `rank` · `compare` · `last` · `timeline`

### Filters
- `activity_types[]`: planting · spraying · fertilization · harvest · tillage · irrigation
- `crop` (accent-insensitive), `product_search` (LIKE substring)
- `quantity_min`/`max`, `desde`/`hasta`
- `aggregate_metric`: `count` · `quantity`
- `group_by`: plot · field · crop · activity_type · product

### Type label mapping
- siembras → `["planting"]`
- fumigaciones/aplicaciones → `["spraying"]`
- fertilizaciones → `["fertilization"]`
- cosechas → `["harvest"]`
- labranza/preparación suelo → `["tillage"]`
- riego/riegos → `["irrigation"]`
- "químicas" → `["spraying","fertilization"]`

### Patterns

| Pattern | View / Filters |
|---|---|
| "Mostrame todas las actividades" | `view:'detail', period:'all'` |
| "¿Qué se sembró en abril?" | `activity_types:["planting"], period:'month abril'` |
| "Mostrame fumigaciones" | `activity_types:["spraying"]` |
| "¿Cuánto glifosato usamos?" | `product_search:'glifosato', view:'aggregate'` |
| "¿Qué lote tuvo más actividades?" | `view:'top_locations', group_by:'plot'` |
| "Compará maíz vs soja" | `view:'compare', crop:'maíz', compare_crop:'soja'` |
| "Timeline del lote A1" | `view:'timeline', plot:'A1'` |
| "Última siembra" | `view:'last', top_n:1, activity_types:["planting"]` |
| "Cantidad de fumigaciones" | `view:'aggregate', activity_types:["spraying"]` |
| "Donde usamos más glifosato" | `view:'top_locations', group_by:'plot', product_search:'glifo'` |
| "Actividad más frecuente" | `view:'top_locations', group_by:'activity_type'` |

### Multi-turn
```
"Mostrame fumigaciones" → activity_types:["spraying"]
"Solo las de soja"      → inherit:true, crop:'soja'
"Ahora La Esperanza"    → inherit:true, field:'La Esperanza'
"Mostrame cosechas"     → inherit:false (cambia tipo = nueva query)
```

### Legacy fallback
Queries simples sin params analíticos ("qué pasó en A1?", "actividades de soja") routean al handler legacy `formatHistoryResponse` que incluye obs + lluvia mezclados — defensible (vista holística) pero formato distinto.

---

## Domain 7 — `rainfall_report` (lluvias)

Tool: `rainfall_report` · Handler: `agronomy.handler.ts:handleQueryRainfall` · Renderers: `rainfall-renderers.ts`

### Views (10)
`detail` · `aggregate` · `max` · `min` · `avg` · `top_locations` · `rank` · `compare` · `last` · `monthly`

### Filters
- `field`, `plot`
- `period`: today · week · month · year · last_week · last_month · all
- `desde`/`hasta`, `days`
- `mm_min`/`mm_max`
- `aggregate_metric`: `mm` · `count`
- `group_by`: plot · field · month

### Patterns

| Pattern | View / Filters |
|---|---|
| "Mostrame registros de lluvia" | `view:'detail', period:'all'` |
| "Cuánto llovió en mayo" | `period:'month', view:'aggregate'` |
| "Cuánto llovió en A1" | `plot:'A1'` |
| "Compará La Esperanza vs San Martin" | `view:'compare', field:'La Esperanza', compare_field:'San Martin'` |
| "Qué campo recibió más lluvia" | `view:'top_locations', group_by:'field'` |
| "Lluvia más intensa" | `view:'max'` |
| "Acumulado mensual" | `view:'monthly'` (or top_locations group_by:month) |
| "Última lluvia" | `view:'last', top_n:1` (output incluye "hace N días sin lluvia") |
| "Eventos arriba de 30 mm" | `mm_min:30` |
| "Eventos fuertes" / "tormentas" | `mm_min:20` |
| "Promedio mm por evento" | `view:'avg'` |
| "Descuento por humedad" (cosecha) | NO es rainfall — usar query_harvest_loads(humidity_min:14.5) |
| "Estamos secos?" | `view:'last', top_n:1` (renderer adds "hace N días") |
| "Cuánto llovió últimos 30 días" | `days:30, view:'aggregate'` |

### Multi-turn
```
"Lluvias en San Martin" → field:'San Martin'
"Solo B1"               → inherit:true, plot:'B1'
"Comparalo con A1"      → inherit:true, view:'compare', compare_plot:'A1'
"Y arriba de 30 mm"     → inherit:true, mm_min:30
```

### Cross-domain
Queries que cruzan lluvia + scoutings / actividades / cosechas → ejecutar `rainfall_report(view:'aggregate')` y describir en `respond_text` que el usuario puede pedir comparación contra `query_scoutings` / `query_plot_history` / `query_harvest_loads`.

---

## Cross-cutting disambiguation rules

| User phrase | Tool | Reason |
|---|---|---|
| "en dólares" (con contexto financial) | `financial_report(currency:'USD')` | NEVER FX-quote |
| "vendí maíz" como consulta | `financial_report(category:'Maíz', view:'detail')` | NEVER query_harvest_loads |
| "sanidad/sanitario" sin animal | `query_scoutings` | NEVER query_health_events |
| "sanitario del rodeo/hacienda" | `query_health_events` | livestock context |
| "grupos" en context hacienda | `list_livestock` | NEVER list_plots |
| "categorías" en context hacienda | `list_livestock` | NEVER check_stock |
| "Mostrame trigo" en harvest session | `query_harvest_loads(crop:'trigo')` | sin contexto → active_crop |
| "Mostrame soja" en stock session | `check_stock(product:'soja')` | sin contexto → active_crop |
| "evolución / promedio / cantidad / relacioná" en agro | guard blocks log_observation | analytical = NEVER persists |
| "buscar X" (X no es lote ni cultivo) | `description_search:X` o `product_search:X` | NEVER active_crop |

---

## Multi-turn inheritance rules (universal)

**Inherit when** the user starts/contains: `y`, `solo`, `ahora`, `sin`, `también`, `ordenalos`, `arriba de`, `comparalo`, `ese`, `esos`.

**Don't inherit when** the message has a full subject+verb question: `¿qué malezas?`, `mostrame X`, `promedio Y`, `cuánto Z`. Agent should set `inherit:false`.

**Transient flags excluded from inherit** (vary by domain, common subset):
`view`, `top_n`, `compare_*`, `low_stock_only`, `has_min_stock`, `is_ultima_vez`.

---

## Edge case handling (universal)

| Case | Behavior |
|---|---|
| Invalid date range (desde > hasta) | Friendly "rango inválido" + suggest valid ranges |
| Lote/campo inexistente | "No tengo registrado X. Tus lotes son: A1, A2, B1, B2" |
| Empty result with filter | Proactive listing of available species/products/crops |
| Same category in 2 currencies | "Insumos (USD): USD 500" disambiguation |
| Quality metric AVG groups with no data | Excluded from ranking (no "ACA: 0%" cuando ACA no tiene proteína) |
| "Lotes/productos sin X" (negation) | Currently returns all (negation not implemented — known limitation) |

---

## Dev workflow

When adding/modifying queries:

1. **Document the pattern HERE first** (this file)
2. Update tool schema in `src/ai/tool-definitions.ts`
3. Add mapper line in `src/ai/agent-response-mapper.ts` if new param
4. Update prompt block in `src/ai/agent-prompt-builder.ts` (PASO 4 disambiguation)
5. Add renderer in `<domain>-renderers.ts` if new view
6. If new state column, add migration `NNN_conversation_X_state.sql` + read in `agent.service.ts`
7. Test with the live test-bot endpoint: `POST /api/test-bot {message: "..."}`
8. Verify with bash batch (the QA agent times out for 75+ queries — use direct curl loop)

## Known limitations (won't fix without major rewrite)

- Negation queries ("X sin Y") not natively supported — handler returns all matches
- Cross-domain analytical correlations (lluvia vs plagas, humedad vs calidad cosecha) require 2 separate tool calls + synthesis
- Health/repro/weighing tools (livestock) NOT yet refactored to view-dispatch pattern
- `documents`, `tacto_summary`, `weather_*`, `sharing` tools NOT yet refactored

## Reference test data (user 41)

See `MEMORY.md` and earlier conversation context for full seed data. Summary:

- **Fields**: La Esperanza (110 ha), San Martin (120 ha)
- **Plots**: A1, A2 (La Esperanza); B1, B2 (San Martin)
- **Corrals**: Corral 1, 2, 3 (Feedlot Las Acacias, San Martin)
- **Livestock**: 649 cabezas (vacas, vaquillonas, terneros, novillos, toros)
- **Stock**: 12 items, 3 bajo mínimo
- **Activities**: 11 (3 cosechas + 2 fumigaciones + 1 fertilización + 3 siembras + 1 labranza + 1 riego)
- **Harvest loads**: 8 cargas (745 tn total — maíz 280, trigo 240, soja 225)
- **Scoutings**: 6 monitoreos
- **Rainfall**: 10 eventos (244 mm total)
- **Finance**: 18 gastos + 5 ingresos
