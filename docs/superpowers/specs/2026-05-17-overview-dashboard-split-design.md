# Overview Dashboard Split — Resumen / Agronómico / Ganadero

**Status:** Design approved by user · awaiting written-spec review
**Owner:** Juan Pablo Mitriatti
**Date:** 2026-05-17

## Goal

Reorganize the end-user dashboard's "Resumen" tab into **three horizontal sub-tabs** (`Resumen`, `Agronómico`, `Ganadero`) that coexist inside the same primary tab. Each sub-tab shows a dedicated set of charts. Within the existing `Resumen` view, the "Tendencia mensual" chart is replaced by a new "Rentabilidad por lote" chart.

## Scope

- **In scope:** New sub-tab navigation, three view components, one new chart on Resumen, four new charts on Agronómico, seven new charts on Ganadero, two new backend analytics endpoints, feature-gated rendering, URL-based sub-tab persistence.
- **Out of scope:** Changes to the primary sidebar/bottom-nav, modifications to non-overview tabs (Gastos, Ingresos, Actividades, etc.), drilldown pages from a chart, exports.

## UI Architecture

`OverviewPage.tsx` is refactored from a content-rendering component into a thin **router/container**. It reads `?overview=…` from the URL and renders one of three view components.

```
frontend/src/components/overview/
├── OverviewPage.tsx              (router + sub-tabs nav)
├── OverviewTabs.tsx              NEW — horizontal sub-tab nav
├── OverviewSummaryView.tsx       NEW — extracted from current OverviewPage body
├── OverviewAgronomicView.tsx     NEW
├── OverviewLivestockView.tsx     NEW
└── charts/                       NEW subfolder for new charts
    ├── RentabilidadPorLoteChart.tsx
    ├── RainfallYieldTrendChart.tsx
    ├── ScoutingFieldMap.tsx
    ├── YieldByCropChart.tsx
    ├── HarvestQualityVsHumidityScatter.tsx
    ├── LivestockStockByCategoryChart.tsx
    ├── LivestockHeadcountTrendChart.tsx
    ├── FeedlotWeightCurveChart.tsx
    ├── AvgWeightByCategoryChart.tsx
    ├── LivestockHealthEventsChart.tsx
    ├── LivestockReproEventsChart.tsx
    └── FeedlotOccupancyChart.tsx
```

### Sub-tab navigation

`OverviewTabs.tsx` sits in the same flex row as the existing "Resumen del mes" header (replaces the heading text with a tab group; the "Actualizar" button stays at the right). Three buttons:

- **Resumen** (default)
- **Agronómico** (hidden when `agronomy` is missing from `useAuth().features`)
- **Ganadero** (hidden when `livestock` is missing from `useAuth().features`)

Active tab styling: `border-b-2 border-campo-600 text-campo-700`. Inactive: `text-gray-500 hover:text-gray-700`.

If the user lands on `?overview=ganadero` without the `livestock` feature, the router silently rewrites the URL to `?overview=resumen` (replace, not push, so the history stack stays clean).

### URL persistence hook

New small hook `useOverviewTab()`:

- Reads `?overview=…` from `URLSearchParams`
- Writes via `history.replaceState` (so the back button doesn't fill with tab toggles)
- Returns `[tab, setTab]` typed as `'resumen' | 'agronomico' | 'ganadero'`
- Falls back to `'resumen'` for missing or unknown values
- No new dependency; no need to introduce react-router for the dashboard

## Data Flow / Backend

Three endpoints, one per sub-tab. Each frontend hook fires its fetch **only when its view mounts** (lazy by tab).

### Resumen — `GET /api/auth/analytics` (existing, unchanged)

Already returns `monthlyTrend`, `rainfallDaily`, `expenseBreakdown`, `incomeBreakdown`. `monthlyTrend` stays in the JSON (not removed — could be reused later) but is no longer rendered.

**Rentabilidad por lote** is computed **client-side** in `OverviewSummaryView` from `expenseBreakdown` + `incomeBreakdown`: filter by currency, drop `plotId === null`, group by `plotId`, then compute `incomes - expenses` per plot. No backend change.

### Agronómico — `GET /api/auth/analytics/agronomic` **NEW**

Feature-gated: requires `agronomy`. Mounted in `src/routes/auth.routes.ts` alongside `/analytics`.

Returns:

```ts
{
  rainfallMonthly: Array<{ month: string; label: string; mm: number }>,          // last 12 months
  harvestsMonthly: Array<{ month: string; label: string; yieldKgPerHa: number; crop: string; plotName: string }>, // last 12 months
  scoutingByPlot: Array<{                                                         // last scouting per plot
    plotId: number; plotName: string; fieldId: number; fieldName: string;
    weedCoveragePct: number | null; weedSpecies: string[];
    pestSeverity1to5: number | null; pestSpecies: string | null;
    scoutedAt: string;
  }>,
  yieldByCrop: Array<{ crop: string; avgKgPerHa: number; harvests: number }>,    // all-time avg, last 12 months
  harvestQualityLoads: Array<{
    loadId: number; crop: string;
    humidityPct: number; qualityValue: number;  qualityField: string;            // e.g. 'oil_pct', 'protein_pct'
    plotName: string; harvestedAt: string;
  }>,
}
```

Source tables: `rainfall`, `domain_events` (harvest events), `crop_scoutings`, `harvest_loads` (with `humidity_pct` + `quality_metrics` JSONB).

### Ganadero — `GET /api/auth/analytics/livestock` **NEW**

Feature-gated: requires `livestock`. Mounted same place.

Returns:

```ts
{
  stockByCategory: Array<{ category: string; headcount: number }>,
  headcountTrendMonthly: Array<{ month: string; label: string; byCategory: Record<string, number> }>,  // last 12 months
  feedlotWeightCurve: Array<{                                                                          // per group active in any corral
    groupId: number; groupLabel: string; corralName: string;
    points: Array<{ date: string; avgWeightKg: number }>;
  }>,
  avgWeightByCategory: Array<{ category: string; avgWeightKg: number; lastWeighedAt: string }>,        // last 90 days
  healthEventsMonthly: Array<{ month: string; label: string; byType: Record<string, number> }>,        // last 12 months, byType keys: vacunacion/desparasitacion/tratamiento/revision_sanitaria
  reproEventsMonthly: Array<{ month: string; label: string; byType: Record<string, number> }>,         // last 12 months, byType keys: servicio/destete/inseminacion/deteccion_celo
  feedlotOccupancy: Array<{ corralId: number; corralName: string; capacity: number | null; currentHeadcount: number }>,
}
```

Source tables: `livestock_groups`, `livestock_movements`, `domain_events` (health + repro + weighings), `corrals`.

### Hooks

| Hook | Endpoint | Fires when |
|---|---|---|
| `useAnalyticsData()` (existing) | `/analytics` | OverviewSummaryView mounts (same as today) |
| `useAgronomicAnalyticsData()` NEW | `/analytics/agronomic` | OverviewAgronomicView mounts |
| `useLivestockAnalyticsData()` NEW | `/analytics/livestock` | OverviewLivestockView mounts |

All three follow the same shape as the existing `useAnalyticsData` (state: `data | loading | error | refresh`). The top-level "Actualizar" button refreshes only the active sub-tab's hook (plus `useDashboardData` for KPIs which are shared across tabs).

## Component Specs

### Tab Resumen — layout

Unchanged structure except for the bottom row:

1. KPI cards (5) — unchanged
2. Donut row: Gastos por categoría + Ingresos por categoría — unchanged
3. FieldMap — unchanged
4. **RecentFeed (4 cols) + RentabilidadPorLoteChart (8 cols)** — replaces RecentFeed + MonthlyTrend
5. AlertsBanner — unchanged

### `RentabilidadPorLoteChart`

- **Visual:** `recharts` `ComposedChart`. Grouped bars (Gastos rojo `#ef4444`, Ingresos verde `#22c55e`) + line for Resultado on top. Resultado line color is `#3b82f6` (blue) when ≥0 and `#ef4444` when <0, using per-segment color or a custom Dot.
- **X axis:** plot label `${fieldName} — ${plotName}` (or just `plotName` when only one field).
- **Y axis:** monto en la moneda seleccionada, formato compacto (`$1.2M`, `$50k`).
- **Tooltip:** muestra los 3 valores con formato local (`es-AR`).
- **Currency toggle:** botones ARS / USD arriba a la derecha del card, default ARS.
- **Subtitle below title:** "Gastos sin lote excluidos" (helps users not double-count).
- **Empty state:** "Aún no hay gastos ni ingresos asignados a lotes este mes."
- **Source data:** `analytics.data.expenseBreakdown` + `incomeBreakdown` (filtered + grouped client-side).

### Tab Agronómico — layout

Grid `lg:grid-cols-12`, 3 rows:

| Row | Component | Cols |
|---|---|---|
| 1 | RainfallYieldTrendChart | 12 |
| 2 | ScoutingFieldMap | 8 |
| 2 | YieldByCropChart | 4 |
| 3 | HarvestQualityVsHumidityScatter | 12 |

#### `RainfallYieldTrendChart`

- `ComposedChart`. Barras azules `#3b82f6` para `mm` por mes + scatter points para cada cosecha (eje Y secundario en `kg/ha`), color de punto por cultivo.
- 12 meses fijos en eje X (incluye meses vacíos).
- Tooltip mes-a-mes muestra: total mm + lista de cosechas (`Lote X — Soja: 4200 kg/ha`).
- Empty state si no hay lluvias ni cosechas en 12 meses.

#### `ScoutingFieldMap`

- Nuevo componente que reusa el setup de Leaflet de `FieldMap` (mismas tile + iconos default).
- **Cambio clave:** color del marker/polígono = peor severidad de scouting del campo. Cálculo: `max(weed_coverage_pct / 20, pest_severity_1_5)` por plot (escala 0–5), tomar el peor sobre todos los plots del field.
- Escala de colores (5 buckets):
  - 0 → `#22c55e` (verde, sin problemas)
  - 1 → `#84cc16` (lima)
  - 2 → `#eab308` (amarillo)
  - 3 → `#f97316` (naranja)
  - 4–5 → `#dc2626` (rojo)
- Tooltip lista por plot del field: nombre, fecha del último scouting, `weed_coverage_pct`, `pest_severity_1_5`, `weed_species[]`, `pest_species`.
- Empty state si ningún field tiene scouting.

#### `YieldByCropChart`

- Barras horizontales: cultivo en Y, kg/ha promedio en X.
- Color por cultivo (paleta determinística por nombre de cultivo).
- Agregación: **promedio simple** de `yield_kg_per_ha` por cultivo sobre todas las cosechas de los últimos 12 meses.
- Tooltip: nombre del cultivo, promedio, `harvests` count.
- Empty state si no hubo cosechas en 12 meses.

#### `HarvestQualityVsHumidityScatter`

- Scatter `recharts`. Cada punto = una carga de cosecha. Eje X: `humidity_pct`. Eje Y: métrica de calidad (`oil_pct` para soja/girasol, `protein_pct` para trigo). Color del punto por cultivo.
- Cargas sin calidad o sin humedad se omiten.
- Líneas de referencia verticales para humedad base recomendada del cultivo (soja 13.5%, trigo 14%, maíz 14.5%, girasol N/A).
- Tooltip: cultivo, lote, fecha, humedad, calidad.
- Empty state: "No hay cargas con humedad y calidad cargadas."

### Tab Ganadero — layout

Grid `lg:grid-cols-12`, 4 rows:

| Row | Component | Cols |
|---|---|---|
| 1 | LivestockStockByCategoryChart | 4 |
| 1 | AvgWeightByCategoryChart | 4 |
| 1 | FeedlotOccupancyChart | 4 |
| 2 | LivestockHeadcountTrendChart | 12 |
| 3 | FeedlotWeightCurveChart | 12 |
| 4 | LivestockHealthEventsChart | 6 |
| 4 | LivestockReproEventsChart | 6 |

#### `LivestockStockByCategoryChart`

- Donut `recharts`. Slices por categoría (`vacas`, `vaquillonas`, `novillos`, `terneros`, etc.).
- Centro del donut: total general de cabezas.
- Tooltip: categoría + headcount + %.
- Empty state: "Aún no hay hacienda registrada."

#### `LivestockHeadcountTrendChart`

- Área stacked `recharts`. Eje X: 12 meses. Eje Y: cabezas. Una serie por categoría.
- Tooltip mes-a-mes muestra cada categoría con su delta vs mes anterior.
- Empty state si no hubo movimientos.

#### `FeedlotWeightCurveChart`

- Línea `recharts`. Eje X: tiempo. Eje Y: peso promedio en kg. **Una línea por grupo activo en corral** (color determinístico por groupId).
- Legenda con el label del grupo (`${corralName} · ${groupLabel}`).
- Si hay más de 8 grupos, mostrar legend scroll y un dropdown "Mostrar grupo:" arriba a la derecha para enfocar uno.
- Tooltip: fecha, grupo, peso.
- Empty state: "No hay pesajes de animales en corrales."

#### `AvgWeightByCategoryChart`

- Barras verticales: peso promedio (kg) por categoría, último valor de los últimos 90 días.
- Color por categoría.
- Subtítulo: "Pesos promedio de los últimos 90 días."
- Empty state si no hay pesajes recientes.

#### `LivestockHealthEventsChart`

- Barras stacked. Eje X: 12 meses. Eje Y: count de eventos. Series stacked por `health_type`: vacunación, desparasitación, tratamiento, revisión sanitaria.
- Tooltip: mes + count por tipo.
- Empty state.

#### `LivestockReproEventsChart`

- Mismo shape que health. Series: servicio, destete, inseminación, detección de celo.

#### `FeedlotOccupancyChart`

- Lista de corrales (no es un chart recharts; es una vertical card con barras horizontales una por corral). Cada barra: `${currentHeadcount} / ${capacity ?? '—'}` con fill `${pct}%` (verde <80%, amarillo 80–95%, rojo >95%).
- Corrales sin `capacity` se muestran sólo con el número, sin barra.
- Empty state si no hay corrales.

## Feature Gating

| Sub-tab | Gate | Comportamiento |
|---|---|---|
| Resumen | siempre visible | — |
| Agronómico | `useAuth().features.includes('agronomy')` | Si false: tab oculto |
| Ganadero | `useAuth().features.includes('livestock')` (plan `pro_plus+`) | Si false: tab oculto |

Si el usuario llega a `?overview=ganadero` sin la feature → redirect silencioso a `?overview=resumen` con `history.replaceState`.

Backend: cada endpoint nuevo usa el middleware `requireFeature('agronomy')` / `requireFeature('livestock')` (mismo patrón que el resto de dashboard endpoints).

## Error Handling

- Cada hook lazy maneja su propio `error` state; un fallo en el endpoint Agronómico no rompe Resumen.
- Empty states a nivel chart (descriptos arriba) — nunca pantalla blanca.
- Si el endpoint nuevo devuelve 403 (feature deshabilitada mid-sesión por admin), el view muestra "No tenés esta sección habilitada" con CTA a "Mi cuenta".

## Testing

- **Unit (vitest):** test del helper que computa Rentabilidad por lote (`groupBy` plotId, currency filter, exclusión de null) — input: arrays mock de breakdown, output esperado por lote.
- **Integration backend:** test rápido en `src/routes/auth.routes.ts` para los 2 endpoints nuevos: crear user + datos seed, llamar endpoint, validar shape de respuesta. Smoke (no exhaustivo).
- **No e2e:** los tests conversacionales existentes no aplican (es UI puro, no toca el pipeline AI).
- **Manual smoke:** abrir cada sub-tab en local con datos seed (`seed-dummy-data.ts`) y verificar que los charts no crashean y muestran datos plausibles.

## Migration / Rollout

- No DB migration needed (todos los datos ya existen en tablas actuales: `rainfall`, `domain_events`, `crop_scoutings`, `harvest_loads`, `livestock_groups`, `livestock_movements`, `corrals`).
- Endpoints nuevos son aditivos — no rompen clientes viejos.
- Frontend cambio es backward compatible: si el usuario tiene una pestaña vieja abierta antes del deploy, sigue funcionando hasta que recargue.

## Open Questions

Ninguna al cierre del brainstorm. Las tres ambigüedades planteadas (visualización de scouting, agregación de rendimiento, granularidad de curva de feedlot) fueron resueltas con el usuario:

- Scouting → overlay en `FieldMap` (variante nueva `ScoutingFieldMap`)
- Rendimiento por cultivo → promedio simple de kg/ha
- Curva de peso feedlot → una línea por grupo activo

## Files To Change

### Frontend (new)
- `frontend/src/components/overview/OverviewTabs.tsx`
- `frontend/src/components/overview/OverviewSummaryView.tsx`
- `frontend/src/components/overview/OverviewAgronomicView.tsx`
- `frontend/src/components/overview/OverviewLivestockView.tsx`
- `frontend/src/components/overview/charts/RentabilidadPorLoteChart.tsx`
- `frontend/src/components/overview/charts/RainfallYieldTrendChart.tsx`
- `frontend/src/components/overview/charts/ScoutingFieldMap.tsx`
- `frontend/src/components/overview/charts/YieldByCropChart.tsx`
- `frontend/src/components/overview/charts/HarvestQualityVsHumidityScatter.tsx`
- `frontend/src/components/overview/charts/LivestockStockByCategoryChart.tsx`
- `frontend/src/components/overview/charts/LivestockHeadcountTrendChart.tsx`
- `frontend/src/components/overview/charts/FeedlotWeightCurveChart.tsx`
- `frontend/src/components/overview/charts/AvgWeightByCategoryChart.tsx`
- `frontend/src/components/overview/charts/LivestockHealthEventsChart.tsx`
- `frontend/src/components/overview/charts/LivestockReproEventsChart.tsx`
- `frontend/src/components/overview/charts/FeedlotOccupancyChart.tsx`
- `frontend/src/hooks/useOverviewTab.ts`
- `frontend/src/hooks/useAgronomicAnalyticsData.ts`
- `frontend/src/hooks/useLivestockAnalyticsData.ts`

### Frontend (modified)
- `frontend/src/components/overview/OverviewPage.tsx` (becomes router/container)

### Backend (new endpoints)
- `src/routes/auth.routes.ts`: add `GET /analytics/agronomic` + `GET /analytics/livestock`

### Backend (no changes needed)
- `GET /analytics` (existing) — `monthlyTrend` keeps shipping in the JSON even though it's no longer rendered. Removing it is out of scope (could be a small follow-up).
