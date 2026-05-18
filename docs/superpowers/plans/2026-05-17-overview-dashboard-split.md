# Overview Dashboard Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tendencia mensual chart with a new Rentabilidad por lote chart, and add three horizontal sub-tabs (Resumen / Agronómico / Ganadero) inside the dashboard's Overview tab — each tab feeding its own lazy analytics endpoint.

**Architecture:** `OverviewPage` becomes a thin router that reads `?overview=…` from the URL and dispatches to one of three view components (`OverviewSummaryView`, `OverviewAgronomicView`, `OverviewLivestockView`). Two new lazy analytics endpoints (`GET /api/auth/analytics/agronomic`, `GET /api/auth/analytics/livestock`) feed the new tabs. Tab visibility is gated by `useAuth().features`.

**Tech Stack:** React 19 + Vite + TypeScript, Recharts (already in deps), Leaflet (already in deps), Tailwind. Backend: Express + node-postgres + vitest.

**Spec:** `docs/superpowers/specs/2026-05-17-overview-dashboard-split-design.md`

---

## TDD note

The frontend (`frontend/package.json`) does **not** ship a test framework today. Adding one is out of scope. Instead, for frontend code we rely on:

1. **TypeScript check** — `cd frontend && npx tsc -b` after every change. Type errors halt the task.
2. **Manual browser smoke** — for any view/component change, the task lists what to click and what to look for.

For backend code, the project uses **vitest** (Node-side). For new endpoints that hit Postgres, we smoke-test against local Docker (`docker compose up -d`) with `curl`. For pure helper functions, we write vitest unit tests in the matching `__tests__/` directory.

Every task ends with a **commit** step.

---

## File structure

### NEW
- `frontend/src/hooks/useOverviewTab.ts` — URL-based sub-tab state
- `frontend/src/hooks/useAgronomicAnalyticsData.ts`
- `frontend/src/hooks/useLivestockAnalyticsData.ts`
- `frontend/src/components/overview/OverviewTabs.tsx`
- `frontend/src/components/overview/OverviewSummaryView.tsx`
- `frontend/src/components/overview/OverviewAgronomicView.tsx`
- `frontend/src/components/overview/OverviewLivestockView.tsx`
- `frontend/src/components/overview/charts/computeRentabilidadPorLote.ts` — pure helper (extracted to make it unit-testable in the future)
- `frontend/src/components/overview/charts/RentabilidadPorLoteChart.tsx`
- `frontend/src/components/overview/charts/RainfallYieldTrendChart.tsx`
- `frontend/src/components/overview/charts/ScoutingFieldMap.tsx`
- `frontend/src/components/overview/charts/YieldByCropChart.tsx`
- `frontend/src/components/overview/charts/HarvestQualityVsHumidityScatter.tsx`
- `frontend/src/components/overview/charts/LivestockStockByCategoryChart.tsx`
- `frontend/src/components/overview/charts/AvgWeightByCategoryChart.tsx`
- `frontend/src/components/overview/charts/FeedlotOccupancyChart.tsx`
- `frontend/src/components/overview/charts/LivestockHeadcountTrendChart.tsx`
- `frontend/src/components/overview/charts/FeedlotWeightCurveChart.tsx`
- `frontend/src/components/overview/charts/LivestockHealthEventsChart.tsx`
- `frontend/src/components/overview/charts/LivestockReproEventsChart.tsx`

### MODIFIED
- `frontend/src/components/overview/OverviewPage.tsx` (becomes router)
- `src/routes/auth.routes.ts` (add 2 endpoints)

---

## Phase 1 — Foundation

### Task 1: `useOverviewTab` hook

**Files:**
- Create: `frontend/src/hooks/useOverviewTab.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useState, useEffect, useCallback } from 'react';

export type OverviewTab = 'resumen' | 'agronomico' | 'ganadero';

const VALID_TABS: ReadonlyArray<OverviewTab> = ['resumen', 'agronomico', 'ganadero'];

function readTabFromUrl(): OverviewTab {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('overview');
  if (raw && (VALID_TABS as ReadonlyArray<string>).includes(raw)) {
    return raw as OverviewTab;
  }
  return 'resumen';
}

function writeTabToUrl(tab: OverviewTab) {
  const params = new URLSearchParams(window.location.search);
  if (tab === 'resumen') {
    params.delete('overview');
  } else {
    params.set('overview', tab);
  }
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? '?' + qs : ''}${window.location.hash}`;
  window.history.replaceState(null, '', next);
}

export function useOverviewTab(): [OverviewTab, (tab: OverviewTab) => void] {
  const [tab, setTabState] = useState<OverviewTab>(readTabFromUrl);

  // Keep state synced with browser back/forward navigation
  useEffect(() => {
    const onPop = () => setTabState(readTabFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const setTab = useCallback((next: OverviewTab) => {
    setTabState(next);
    writeTabToUrl(next);
  }, []);

  return [tab, setTab];
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS (no new errors)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useOverviewTab.ts
git commit -m "feat(overview): add useOverviewTab hook for URL-based sub-tab state"
```

---

### Task 2: `OverviewTabs` component

**Files:**
- Create: `frontend/src/components/overview/OverviewTabs.tsx`

- [ ] **Step 1: Create the component**

```tsx
import type { OverviewTab } from '../../hooks/useOverviewTab';

interface TabSpec {
  key: OverviewTab;
  label: string;
}

interface Props {
  active: OverviewTab;
  onChange: (tab: OverviewTab) => void;
  showAgronomic: boolean;
  showLivestock: boolean;
}

export default function OverviewTabs({ active, onChange, showAgronomic, showLivestock }: Props) {
  const tabs: TabSpec[] = [{ key: 'resumen', label: 'Resumen' }];
  if (showAgronomic) tabs.push({ key: 'agronomico', label: 'Agronómico' });
  if (showLivestock) tabs.push({ key: 'ganadero', label: 'Ganadero' });

  return (
    <div className="flex items-center gap-1 border-b border-gray-200">
      {tabs.map(t => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'px-3 py-2 text-sm font-medium transition-colors -mb-px',
              isActive
                ? 'border-b-2 border-campo-600 text-campo-700'
                : 'border-b-2 border-transparent text-gray-500 hover:text-gray-700',
            ].join(' ')}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/overview/OverviewTabs.tsx
git commit -m "feat(overview): add OverviewTabs horizontal sub-tab nav"
```

---

### Task 3: Extract current body into `OverviewSummaryView`

**Files:**
- Create: `frontend/src/components/overview/OverviewSummaryView.tsx`
- Modify: `frontend/src/components/overview/OverviewPage.tsx`

- [ ] **Step 1: Create `OverviewSummaryView.tsx` (copy of current OverviewPage body, no tabs nav yet)**

```tsx
import { Wallet, DollarSign, TrendingUp, TrendingDown, Sprout } from 'lucide-react';
import { useDashboardData } from '../../hooks/useDashboardData';
import { useAnalyticsData } from '../../hooks/useAnalyticsData';
import KpiCard from './KpiCard';
import MonthlyTrendChart from './MonthlyTrendChart';
import CategoryDonutChart from './CategoryDonutChart';
import RecentFeed from './RecentFeed';
import AlertsBanner from './AlertsBanner';
import FieldMap from './FieldMap';

interface Props {
  onRecentItemClick?: (type: 'expense' | 'income' | 'activity', id: number) => void;
}

export default function OverviewSummaryView({ onRecentItemClick }: Props) {
  const { data, loading: dashLoading, error: dashError, refresh: dashRefresh } = useDashboardData();
  const analytics = useAnalyticsData();

  if (dashLoading || analytics.loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (dashError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
        {dashError}
        <button onClick={dashRefresh} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  if (!data) return null;

  const expMap = data.expenses_month ?? { ARS: data.expenses_month_ars, USD: 0 };
  const expPrev = data.expenses_prev_month ?? { ARS: data.expenses_prev_month_ars, USD: 0 };
  const incMap = data.incomes_month ?? { ARS: data.incomes_month_ars, USD: 0 };
  const incPrev = data.incomes_prev_month ?? { ARS: data.incomes_prev_month_ars, USD: 0 };

  const expRows = analytics.data?.expenseBreakdown ?? [];
  const arsRows = expRows.filter(r => r.currency === 'ARS');
  const totalArs = arsRows.reduce((s, r) => s + r.total, 0);
  const generalArs = arsRows.filter(r => r.plotId == null).reduce((s, r) => s + r.total, 0);
  const pctGeneral = totalArs > 0 ? Math.round((generalArs / totalArs) * 100) : 0;

  const resultMap = {
    ARS: { current: incMap.ARS - expMap.ARS, prev: incPrev.ARS - expPrev.ARS },
    USD: { current: incMap.USD - expMap.USD, prev: incPrev.USD - expPrev.USD },
  };
  const resultPrimary = Math.abs(resultMap.USD.current) > Math.abs(resultMap.ARS.current) ? resultMap.USD.current : resultMap.ARS.current;
  const resultPositive = resultPrimary >= 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard
          label="Gastos del mes"
          currencies={{ ARS: { current: expMap.ARS, prev: expPrev.ARS }, USD: { current: expMap.USD, prev: expPrev.USD } }}
          tint="bg-red-50" Icon={Wallet} iconColor="text-red-500"
        />
        <KpiCard
          label="Ingresos del mes"
          currencies={{ ARS: { current: incMap.ARS, prev: incPrev.ARS }, USD: { current: incMap.USD, prev: incPrev.USD } }}
          tint="bg-green-50" Icon={DollarSign} iconColor="text-green-600"
        />
        <KpiCard
          label="Resultado" currencies={resultMap} mode="dual"
          tint={resultPositive ? 'bg-green-50' : 'bg-red-50'}
          Icon={resultPositive ? TrendingUp : TrendingDown}
          iconColor={resultPositive ? 'text-green-600' : 'text-red-500'}
        />
        <KpiCard label="Actividades" value={String(data.activities_month_count)} tint="bg-campo-50" Icon={Sprout} iconColor="text-campo-600" />
        <KpiCard label="Gastos sin lote" value={`${pctGeneral}%`} tint="bg-amber-50" Icon={Wallet} iconColor="text-amber-600" />
      </div>

      {analytics.data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <CategoryDonutChart title="Gastos por categoría (mes actual)" data={analytics.data.expenseBreakdown} emptyText="Sin gastos este mes" />
          <CategoryDonutChart title="Ingresos por categoría (mes actual)" data={analytics.data.incomeBreakdown} emptyText="Sin ingresos este mes" />
        </div>
      )}

      <FieldMap />

      {analytics.data && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-4">
            <RecentFeed items={data.recent_items} onItemClick={onRecentItemClick} />
          </div>
          <div className="lg:col-span-8">
            <MonthlyTrendChart data={analytics.data.monthlyTrend} />
          </div>
        </div>
      )}

      <AlertsBanner stockAlerts={data.stock_alerts_count} livestockTotal={data.livestock_total} />
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `OverviewPage.tsx` to become the router**

Replace the entire contents of `frontend/src/components/overview/OverviewPage.tsx` with:

```tsx
import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useOverviewTab } from '../../hooks/useOverviewTab';
import OverviewTabs from './OverviewTabs';
import OverviewSummaryView from './OverviewSummaryView';
import SubscriptionBanner from './SubscriptionBanner';
import EmailVerifyBanner from './EmailVerifyBanner';

interface OverviewPageProps {
  onGoToAccount?: () => void;
  onRecentItemClick?: (type: 'expense' | 'income' | 'activity', id: number) => void;
}

export default function OverviewPage({ onGoToAccount, onRecentItemClick }: OverviewPageProps = {}) {
  const { features } = useAuth();
  const [tab, setTab] = useOverviewTab();

  const showAgronomic = features.includes('agronomy');
  const showLivestock = features.includes('livestock');

  // If user lands on a tab they can't access, silently rewrite to Resumen
  useEffect(() => {
    if (tab === 'agronomico' && !showAgronomic) setTab('resumen');
    if (tab === 'ganadero' && !showLivestock) setTab('resumen');
  }, [tab, showAgronomic, showLivestock, setTab]);

  // Plain page reload — re-fetches whichever hooks the active view uses.
  const reload = () => window.location.reload();

  return (
    <div className="space-y-6">
      <EmailVerifyBanner />
      <SubscriptionBanner onGoToAccount={onGoToAccount ?? (() => {})} />

      <div className="flex items-center justify-between flex-wrap gap-2">
        <OverviewTabs active={tab} onChange={setTab} showAgronomic={showAgronomic} showLivestock={showLivestock} />
        <button
          onClick={reload}
          className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-800 border border-gray-200 bg-white rounded-md px-3 py-1.5 transition-colors hover:bg-gray-50"
          title="Recargar datos"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Actualizar
        </button>
      </div>

      {tab === 'resumen' && <OverviewSummaryView onRecentItemClick={onRecentItemClick} />}
      {tab === 'agronomico' && showAgronomic && <div className="text-sm text-gray-500 py-8 text-center">Dashboard agronómico — próximamente</div>}
      {tab === 'ganadero' && showLivestock && <div className="text-sm text-gray-500 py-8 text-center">Dashboard ganadero — próximamente</div>}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 4: Manual browser smoke**

```bash
cd frontend && npm run dev
```
- Login as a user with agronomy + livestock features.
- Open `/dashboard` → should see the same Resumen content as before, with a tab nav on top.
- Click "Agronómico" → URL becomes `?overview=agronomico` and you see the "próximamente" placeholder.
- Click "Ganadero" → same with placeholder.
- Click "Resumen" → query param removed, back to original content.
- Refresh the page while on `?overview=agronomico` → still shows the agronómico placeholder (URL persistence works).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/overview/OverviewSummaryView.tsx \
        frontend/src/components/overview/OverviewPage.tsx
git commit -m "feat(overview): split OverviewPage into router + SummaryView with 3 sub-tabs"
```

---

## Phase 2 — Rentabilidad por lote (replaces Tendencia mensual in Resumen)

### Task 4: Pure helper `computeRentabilidadPorLote`

**Files:**
- Create: `frontend/src/components/overview/charts/computeRentabilidadPorLote.ts`

- [ ] **Step 1: Create the helper**

```typescript
import type { BreakdownRow } from '../../../hooks/useAnalyticsData';

export interface PlotResult {
  plotId: number;
  label: string;
  expenses: number;
  incomes: number;
  resultado: number;
}

/**
 * Group expense + income rows by plot, filter to a single currency, and drop
 * rows without a plot (gastos generales). Output is sorted by absolute
 * resultado descending so the most-impactful lotes show first.
 */
export function computeRentabilidadPorLote(
  expenses: BreakdownRow[],
  incomes: BreakdownRow[],
  currency: string,
): PlotResult[] {
  const byPlot = new Map<number, PlotResult>();

  const upsert = (row: BreakdownRow, kind: 'expenses' | 'incomes') => {
    if (row.plotId == null) return;
    if (row.currency !== currency) return;
    const existing = byPlot.get(row.plotId);
    if (existing) {
      existing[kind] += row.total;
      existing.resultado = existing.incomes - existing.expenses;
    } else {
      const label = row.fieldName ? `${row.fieldName} — ${row.plotName ?? '—'}` : (row.plotName ?? '—');
      const next: PlotResult = {
        plotId: row.plotId,
        label,
        expenses: kind === 'expenses' ? row.total : 0,
        incomes: kind === 'incomes' ? row.total : 0,
        resultado: 0,
      };
      next.resultado = next.incomes - next.expenses;
      byPlot.set(row.plotId, next);
    }
  };

  for (const r of expenses) upsert(r, 'expenses');
  for (const r of incomes) upsert(r, 'incomes');

  return [...byPlot.values()].sort((a, b) => Math.abs(b.resultado) - Math.abs(a.resultado));
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/overview/charts/computeRentabilidadPorLote.ts
git commit -m "feat(overview): add computeRentabilidadPorLote helper"
```

---

### Task 5: `RentabilidadPorLoteChart` component

**Files:**
- Create: `frontend/src/components/overview/charts/RentabilidadPorLoteChart.tsx`

- [ ] **Step 1: Create the chart**

```tsx
import { useMemo, useState } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { BreakdownRow } from '../../../hooks/useAnalyticsData';
import { computeRentabilidadPorLote } from './computeRentabilidadPorLote';

interface Props {
  expenses: BreakdownRow[];
  incomes: BreakdownRow[];
}

function formatCompact(value: number, currency: string): string {
  const sym = currency === 'USD' ? 'USD ' : '$';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${sym}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${sym}${Math.round(abs / 1_000)}k`;
  return `${sign}${sym}${abs}`;
}

export default function RentabilidadPorLoteChart({ expenses, incomes }: Props) {
  const [currency, setCurrency] = useState<'ARS' | 'USD'>('ARS');

  const data = useMemo(
    () => computeRentabilidadPorLote(expenses, incomes, currency),
    [expenses, incomes, currency],
  );

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-start justify-between mb-1 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">Rentabilidad por lote</h3>
          <p className="text-xs text-gray-400">Gastos sin lote excluidos · mes actual</p>
        </div>
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
          {(['ARS', 'USD'] as const).map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setCurrency(c)}
              className={`px-3 py-1 text-xs font-medium transition-colors ${c === currency ? 'bg-campo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {data.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-12">Aún no hay gastos ni ingresos asignados a lotes este mes.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} angle={-15} textAnchor="end" height={50} />
            <YAxis tickFormatter={(v) => formatCompact(v, currency)} tick={{ fontSize: 11 }} width={60} />
            <Tooltip
              formatter={(v: number, name: string) => {
                const labelMap: Record<string, string> = { expenses: 'Gastos', incomes: 'Ingresos', resultado: 'Resultado' };
                return [formatCompact(v, currency), labelMap[name] ?? name];
              }}
              contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
            />
            <Legend formatter={(value: string) => ({ expenses: 'Gastos', incomes: 'Ingresos', resultado: 'Resultado' } as Record<string, string>)[value] ?? value} />
            <Bar dataKey="expenses" fill="#ef4444" radius={[4, 4, 0, 0]} />
            <Bar dataKey="incomes" fill="#22c55e" radius={[4, 4, 0, 0]} />
            <Line type="monotone" dataKey="resultado" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/overview/charts/RentabilidadPorLoteChart.tsx
git commit -m "feat(overview): add RentabilidadPorLoteChart component"
```

---

### Task 6: Wire `RentabilidadPorLoteChart` into `OverviewSummaryView`

**Files:**
- Modify: `frontend/src/components/overview/OverviewSummaryView.tsx`

- [ ] **Step 1: Replace `MonthlyTrendChart` with `RentabilidadPorLoteChart` in the bottom grid**

In `OverviewSummaryView.tsx`, replace the import line:
```typescript
import MonthlyTrendChart from './MonthlyTrendChart';
```
with:
```typescript
import RentabilidadPorLoteChart from './charts/RentabilidadPorLoteChart';
```

And replace the inner JSX for the bottom grid:
```tsx
{analytics.data && (
  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
    <div className="lg:col-span-4">
      <RecentFeed items={data.recent_items} onItemClick={onRecentItemClick} />
    </div>
    <div className="lg:col-span-8">
      <MonthlyTrendChart data={analytics.data.monthlyTrend} />
    </div>
  </div>
)}
```
with:
```tsx
{analytics.data && (
  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
    <div className="lg:col-span-4">
      <RecentFeed items={data.recent_items} onItemClick={onRecentItemClick} />
    </div>
    <div className="lg:col-span-8">
      <RentabilidadPorLoteChart
        expenses={analytics.data.expenseBreakdown}
        incomes={analytics.data.incomeBreakdown}
      />
    </div>
  </div>
)}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Manual browser smoke**

- Refresh `/dashboard` on Resumen tab.
- Confirm the bottom-right card now shows "Rentabilidad por lote" (no longer "Tendencia mensual").
- Confirm the ARS/USD toggle switches the data without errors.
- If you have lotes with expenses/incomes assigned this month, bars + line render. Otherwise the empty state message shows.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/overview/OverviewSummaryView.tsx
git commit -m "feat(overview): replace MonthlyTrend with RentabilidadPorLote in Resumen view"
```

---

## Phase 3 — Backend Agronomic endpoint

### Task 7: Implement `GET /api/auth/analytics/agronomic`

**Files:**
- Modify: `src/routes/auth.routes.ts` — add new handler immediately after the existing `/analytics` handler (around line 1517 — look for the line `} catch (err) { handleError(err, res); ... });` right after `incomeBreakdown` returns).

- [ ] **Step 1: Insert the new route**

Add this block right after the existing `router.get('/analytics', requireAuth, async (req, res) => { ... });` definition:

```typescript
router.get('/analytics/agronomic', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;

    // Last 12 months of rainfall, monthly total in mm
    const { rows: rainfallMonthly } = await pool.query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', NOW()) - interval '11 months',
           date_trunc('month', NOW()),
           '1 month'
         )::date AS month_start
       )
       SELECT
         to_char(m.month_start, 'YYYY-MM') AS month,
         to_char(m.month_start, 'Mon') AS label,
         COALESCE((
           SELECT SUM(r.millimeters)::numeric
           FROM rainfall r
           JOIN fields f ON f.id = r.field_id
           WHERE f.user_id = $1
             AND f.deleted_at IS NULL
             AND r.rainfall_date >= m.month_start
             AND r.rainfall_date < m.month_start + interval '1 month'
         ), 0) AS mm
       FROM months m
       ORDER BY m.month_start`,
      [userId]
    );

    // Last 12 months of harvest events — yield computed from quantity / area
    const { rows: harvestsMonthly } = await pool.query(
      `SELECT
         to_char(date_trunc('month', e.event_date), 'YYYY-MM') AS month,
         to_char(date_trunc('month', e.event_date), 'Mon')    AS label,
         e.crop,
         p.name AS plot_name,
         e.quantity::numeric AS total_kg,
         CASE WHEN p.area_hectares > 0 THEN (e.quantity / p.area_hectares)::numeric ELSE NULL END AS yield_kg_per_ha
       FROM domain_events e
       JOIN plots p ON p.id = e.plot_id
       WHERE e.user_id = $1
         AND e.event_type = 'harvest'
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
         AND e.quantity IS NOT NULL
       ORDER BY e.event_date`,
      [userId]
    );

    // Latest scouting per plot (joined with field for the map)
    const { rows: scoutingByPlot } = await pool.query(
      `SELECT DISTINCT ON (s.plot_id)
         s.plot_id,
         p.name AS plot_name,
         f.id AS field_id,
         f.name AS field_name,
         f.lat AS field_lat,
         f.lng AS field_lng,
         s.weed_coverage_pct,
         s.weed_species,
         s.pest_species,
         s.pest_severity_1_5,
         s.scouting_date
       FROM crop_scoutings s
       JOIN plots p ON p.id = s.plot_id
       JOIN fields f ON f.id = p.field_id
       WHERE s.user_id = $1
         AND s.deleted_at IS NULL
         AND f.deleted_at IS NULL
       ORDER BY s.plot_id, s.scouting_date DESC, s.id DESC`,
      [userId]
    );

    // Average kg/ha by crop, last 12 months
    const { rows: yieldByCrop } = await pool.query(
      `SELECT
         e.crop,
         AVG(e.quantity / NULLIF(p.area_hectares, 0))::numeric AS avg_kg_per_ha,
         COUNT(*)::int AS harvests
       FROM domain_events e
       JOIN plots p ON p.id = e.plot_id
       WHERE e.user_id = $1
         AND e.event_type = 'harvest'
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
         AND e.quantity IS NOT NULL
         AND p.area_hectares > 0
         AND e.crop IS NOT NULL
       GROUP BY e.crop
       ORDER BY avg_kg_per_ha DESC NULLS LAST`,
      [userId]
    );

    // Harvest loads with humidity AND quality_metrics, last 12 months
    const { rows: harvestQualityLoads } = await pool.query(
      `SELECT
         hl.id AS load_id,
         e.crop,
         hl.humidity_pct,
         hl.quality_metrics,
         p.name AS plot_name,
         e.event_date AS harvested_at
       FROM harvest_loads hl
       JOIN domain_events e ON e.id = hl.domain_event_id
       LEFT JOIN plots p ON p.id = e.plot_id
       WHERE e.user_id = $1
         AND e.event_type = 'harvest'
         AND hl.humidity_pct IS NOT NULL
         AND hl.quality_metrics IS NOT NULL
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
       ORDER BY e.event_date DESC`,
      [userId]
    );

    res.json({
      rainfallMonthly: rainfallMonthly.map(r => ({
        month: r.month,
        label: r.label,
        mm: Number(r.mm),
      })),
      harvestsMonthly: harvestsMonthly.map(r => ({
        month: r.month,
        label: r.label,
        crop: r.crop ?? null,
        plotName: r.plot_name ?? null,
        totalKg: r.total_kg !== null ? Number(r.total_kg) : null,
        yieldKgPerHa: r.yield_kg_per_ha !== null ? Number(r.yield_kg_per_ha) : null,
      })),
      scoutingByPlot: scoutingByPlot.map(r => ({
        plotId: r.plot_id,
        plotName: r.plot_name,
        fieldId: r.field_id,
        fieldName: r.field_name,
        fieldLat: r.field_lat !== null ? Number(r.field_lat) : null,
        fieldLng: r.field_lng !== null ? Number(r.field_lng) : null,
        weedCoveragePct: r.weed_coverage_pct !== null ? Number(r.weed_coverage_pct) : null,
        weedSpecies: r.weed_species ?? [],
        pestSpecies: r.pest_species ?? null,
        pestSeverity1to5: r.pest_severity_1_5 !== null ? Number(r.pest_severity_1_5) : null,
        scoutedAt: r.scouting_date,
      })),
      yieldByCrop: yieldByCrop.map(r => ({
        crop: r.crop,
        avgKgPerHa: r.avg_kg_per_ha !== null ? Number(r.avg_kg_per_ha) : null,
        harvests: Number(r.harvests),
      })),
      harvestQualityLoads: harvestQualityLoads.map(r => ({
        loadId: r.load_id,
        crop: r.crop ?? null,
        humidityPct: Number(r.humidity_pct),
        quality: r.quality_metrics ?? {},
        plotName: r.plot_name ?? null,
        harvestedAt: r.harvested_at,
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});
```

- [ ] **Step 2: Typecheck the backend**

Run: `npx tsc --noEmit -p .`
Expected: PASS

- [ ] **Step 3: Smoke-test the endpoint with curl**

```bash
docker compose up -d
# Wait ~6 seconds for the app to come up
sleep 6
# Login as a user with agronomy feature. Adjust credentials as needed.
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"testin@gmail.com","password":"tester123"}' | jq -r '.tokens.accessToken')
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/auth/analytics/agronomic | jq 'keys'
```
Expected output:
```
[
  "harvestQualityLoads",
  "harvestsMonthly",
  "rainfallMonthly",
  "scoutingByPlot",
  "yieldByCrop"
]
```

- [ ] **Step 4: Run unit tests to confirm no regressions**

Run: `npm test`
Expected: 1280 passing (the baseline)

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.routes.ts
git commit -m "feat(api): add GET /analytics/agronomic endpoint"
```

---

### Task 8: `useAgronomicAnalyticsData` hook

**Files:**
- Create: `frontend/src/hooks/useAgronomicAnalyticsData.ts`

- [ ] **Step 1: Create the hook + types**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';

export interface AgronomicRainfallMonth {
  month: string;
  label: string;
  mm: number;
}

export interface AgronomicHarvestMonth {
  month: string;
  label: string;
  crop: string | null;
  plotName: string | null;
  totalKg: number | null;
  yieldKgPerHa: number | null;
}

export interface ScoutingByPlot {
  plotId: number;
  plotName: string;
  fieldId: number;
  fieldName: string;
  fieldLat: number | null;
  fieldLng: number | null;
  weedCoveragePct: number | null;
  weedSpecies: string[];
  pestSpecies: string | null;
  pestSeverity1to5: number | null;
  scoutedAt: string;
}

export interface YieldByCropRow {
  crop: string;
  avgKgPerHa: number | null;
  harvests: number;
}

export interface HarvestQualityLoad {
  loadId: number;
  crop: string | null;
  humidityPct: number;
  quality: Record<string, number>;
  plotName: string | null;
  harvestedAt: string;
}

export interface AgronomicAnalyticsData {
  rainfallMonthly: AgronomicRainfallMonth[];
  harvestsMonthly: AgronomicHarvestMonth[];
  scoutingByPlot: ScoutingByPlot[];
  yieldByCrop: YieldByCropRow[];
  harvestQualityLoads: HarvestQualityLoad[];
}

export function useAgronomicAnalyticsData() {
  const [data, setData] = useState<AgronomicAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await apiRequest<AgronomicAnalyticsData>('/analytics/agronomic');
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar dashboard agronómico');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, error, refresh };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useAgronomicAnalyticsData.ts
git commit -m "feat(overview): add useAgronomicAnalyticsData hook"
```

---

## Phase 4 — Agronomic charts

### Task 9: `RainfallYieldTrendChart`

**Files:**
- Create: `frontend/src/components/overview/charts/RainfallYieldTrendChart.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useMemo } from 'react';
import { ComposedChart, Bar, Scatter, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { AgronomicRainfallMonth, AgronomicHarvestMonth } from '../../../hooks/useAgronomicAnalyticsData';

interface Props {
  rainfall: AgronomicRainfallMonth[];
  harvests: AgronomicHarvestMonth[];
}

const CROP_COLORS: Record<string, string> = {
  soja: '#ca8a04',
  maíz: '#f59e0b',
  trigo: '#84cc16',
  girasol: '#f97316',
  sorgo: '#a16207',
  cebada: '#a3a3a3',
  avena: '#737373',
};

function colorForCrop(crop: string | null): string {
  if (!crop) return '#6b7280';
  return CROP_COLORS[crop.toLowerCase()] ?? '#6b7280';
}

export default function RainfallYieldTrendChart({ rainfall, harvests }: Props) {
  // Merge by month: each row has mm + per-month scatter points (yield).
  const data = useMemo(() => {
    const map = new Map<string, { month: string; label: string; mm: number; yield_kg_per_ha?: number; crop?: string | null; plot?: string | null }>();
    for (const r of rainfall) {
      map.set(r.month, { month: r.month, label: r.label, mm: r.mm });
    }
    // We attach yields as separate Scatter series; for the merged chart we
    // emit one entry per harvest, keyed by month label, with the yield.
    const out: Array<{ month: string; label: string; mm: number; yield_kg_per_ha: number | null; crop: string | null; plot: string | null }> = [];
    for (const m of map.values()) {
      out.push({ ...m, yield_kg_per_ha: null, crop: null, plot: null });
    }
    for (const h of harvests) {
      if (h.yieldKgPerHa == null) continue;
      const baseline = map.get(h.month);
      if (!baseline) continue;
      out.push({
        month: h.month,
        label: h.label,
        mm: baseline.mm,
        yield_kg_per_ha: h.yieldKgPerHa,
        crop: h.crop,
        plot: h.plotName,
      });
    }
    return out.sort((a, b) => a.month.localeCompare(b.month));
  }, [rainfall, harvests]);

  const hasAnything = rainfall.some(r => r.mm > 0) || harvests.some(h => h.yieldKgPerHa != null);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Lluvias y rendimiento (12 meses)</h3>
      {!hasAnything ? (
        <p className="text-sm text-gray-400 text-center py-12">Aún no hay lluvias ni cosechas en los últimos 12 meses.</p>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={data} margin={{ top: 5, right: 30, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="left" orientation="left" tick={{ fontSize: 11 }} width={50} label={{ value: 'mm', angle: -90, position: 'insideLeft', fontSize: 11, fill: '#3b82f6' }} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} width={60} label={{ value: 'kg/ha', angle: 90, position: 'insideRight', fontSize: 11, fill: '#ca8a04' }} />
            <Tooltip
              contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
              formatter={(v: number, name: string, p: { payload?: { crop?: string | null; plot?: string | null } }) => {
                if (name === 'mm') return [`${v} mm`, 'Lluvia'];
                if (name === 'yield_kg_per_ha') {
                  const crop = p.payload?.crop ?? 'cultivo';
                  const plot = p.payload?.plot ?? '';
                  return [`${Math.round(v)} kg/ha`, `${plot} — ${crop}`];
                }
                return [v, name];
              }}
            />
            <Legend formatter={(value: string) => value === 'mm' ? 'Lluvia mensual' : 'Rinde por cosecha'} />
            <Bar yAxisId="left" dataKey="mm" fill="#3b82f6" name="mm" />
            <Scatter yAxisId="right" dataKey="yield_kg_per_ha" name="yield_kg_per_ha" fill="#ca8a04" shape="circle" />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// `colorForCrop` kept for future per-point coloring once recharts Scatter supports per-point fill via Cell.
void colorForCrop;
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/overview/charts/RainfallYieldTrendChart.tsx
git commit -m "feat(overview): add RainfallYieldTrendChart"
```

---

### Task 10: `ScoutingFieldMap`

**Files:**
- Create: `frontend/src/components/overview/charts/ScoutingFieldMap.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { ScoutingByPlot } from '../../../hooks/useAgronomicAnalyticsData';

interface Props {
  scoutings: ScoutingByPlot[];
}

interface FieldAgg {
  fieldId: number;
  fieldName: string;
  lat: number;
  lng: number;
  worstScore: number;        // 0..5
  plots: ScoutingByPlot[];
}

// 0-5 → color. Weed_coverage_pct is divided by 20 to map to 0..5 scale.
function scoutScore(s: ScoutingByPlot): number {
  const weed = s.weedCoveragePct != null ? Math.min(5, s.weedCoveragePct / 20) : 0;
  const pest = s.pestSeverity1to5 != null ? s.pestSeverity1to5 : 0;
  return Math.max(weed, pest);
}

function colorForScore(score: number): string {
  if (score < 1) return '#22c55e';
  if (score < 2) return '#84cc16';
  if (score < 3) return '#eab308';
  if (score < 4) return '#f97316';
  return '#dc2626';
}

export default function ScoutingFieldMap({ scoutings }: Props) {
  const byField = useMemo<FieldAgg[]>(() => {
    const map = new Map<number, FieldAgg>();
    for (const s of scoutings) {
      if (s.fieldLat == null || s.fieldLng == null) continue;
      const existing = map.get(s.fieldId);
      const score = scoutScore(s);
      if (existing) {
        existing.worstScore = Math.max(existing.worstScore, score);
        existing.plots.push(s);
      } else {
        map.set(s.fieldId, {
          fieldId: s.fieldId,
          fieldName: s.fieldName,
          lat: s.fieldLat,
          lng: s.fieldLng,
          worstScore: score,
          plots: [s],
        });
      }
    }
    return [...map.values()];
  }, [scoutings]);

  const center: LatLngExpression = byField.length > 0
    ? [
        byField.reduce((s, f) => s + f.lat, 0) / byField.length,
        byField.reduce((s, f) => s + f.lng, 0) / byField.length,
      ]
    : [-34, -64];

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="p-4 pb-2">
        <h3 className="text-sm font-semibold text-gray-700">Mapa de sanidad (último monitoreo)</h3>
        <p className="text-xs text-gray-400">Color = peor severidad entre todos los lotes del campo</p>
      </div>
      <div style={{ height: 360 }}>
        {byField.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">Aún no hay monitoreos cargados con campos georreferenciados.</p>
        ) : (
          <MapContainer center={center} zoom={8} style={{ height: '100%', width: '100%' }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {byField.map(f => (
              <CircleMarker
                key={f.fieldId}
                center={[f.lat, f.lng]}
                radius={12}
                pathOptions={{ color: colorForScore(f.worstScore), fillColor: colorForScore(f.worstScore), fillOpacity: 0.6 }}
              >
                <Popup>
                  <div className="text-xs">
                    <strong>{f.fieldName}</strong>
                    <ul className="mt-1 space-y-1">
                      {f.plots.map(p => (
                        <li key={p.plotId}>
                          <span className="font-medium">{p.plotName}</span> · {new Date(p.scoutedAt).toLocaleDateString('es-AR')}
                          <br />
                          {p.weedCoveragePct != null && <span>Malezas: {p.weedCoveragePct}% </span>}
                          {p.weedSpecies.length > 0 && <span>({p.weedSpecies.join(', ')}) </span>}
                          <br />
                          {p.pestSeverity1to5 != null && <span>Plagas: severidad {p.pestSeverity1to5}/5 </span>}
                          {p.pestSpecies && <span>({p.pestSpecies})</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/overview/charts/ScoutingFieldMap.tsx
git commit -m "feat(overview): add ScoutingFieldMap chart"
```

---

### Task 11: `YieldByCropChart`

**Files:**
- Create: `frontend/src/components/overview/charts/YieldByCropChart.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import type { YieldByCropRow } from '../../../hooks/useAgronomicAnalyticsData';

interface Props {
  data: YieldByCropRow[];
}

const CROP_COLORS: Record<string, string> = {
  soja: '#ca8a04',
  maíz: '#f59e0b',
  trigo: '#84cc16',
  girasol: '#f97316',
  sorgo: '#a16207',
  cebada: '#a3a3a3',
  avena: '#737373',
};

function colorForCrop(crop: string): string {
  return CROP_COLORS[crop.toLowerCase()] ?? '#6b7280';
}

export default function YieldByCropChart({ data }: Props) {
  const rows = data.filter(d => d.avgKgPerHa != null);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Rendimiento por cultivo (kg/ha promedio · 12 meses)</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-12">Aún no hay cosechas en los últimos 12 meses.</p>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={rows} layout="vertical" margin={{ top: 5, right: 30, left: 30, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(v)}`} />
            <YAxis type="category" dataKey="crop" tick={{ fontSize: 12 }} width={80} />
            <Tooltip
              formatter={(v: number, _name: string, p: { payload?: YieldByCropRow }) => [`${Math.round(v)} kg/ha`, p.payload ? `${p.payload.crop} (${p.payload.harvests} cosechas)` : '']}
              contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
            />
            <Bar dataKey="avgKgPerHa" radius={[0, 4, 4, 0]}>
              {rows.map(r => <Cell key={r.crop} fill={colorForCrop(r.crop)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/overview/charts/YieldByCropChart.tsx
git commit -m "feat(overview): add YieldByCropChart"
```

---

### Task 12: `HarvestQualityVsHumidityScatter`

**Files:**
- Create: `frontend/src/components/overview/charts/HarvestQualityVsHumidityScatter.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useMemo } from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Cell } from 'recharts';
import type { HarvestQualityLoad } from '../../../hooks/useAgronomicAnalyticsData';

interface Props {
  loads: HarvestQualityLoad[];
}

interface PreparedPoint {
  loadId: number;
  crop: string;
  humidity: number;
  quality: number;
  qualityField: string;
  plot: string | null;
  harvestedAt: string;
}

const CROP_COLORS: Record<string, string> = {
  soja: '#ca8a04',
  maíz: '#f59e0b',
  trigo: '#84cc16',
  girasol: '#f97316',
  sorgo: '#a16207',
  cebada: '#a3a3a3',
  avena: '#737373',
};

function colorForCrop(crop: string): string {
  return CROP_COLORS[crop.toLowerCase()] ?? '#6b7280';
}

// Pick the most informative quality metric per crop.
function extractQuality(crop: string | null, q: Record<string, number>): { value: number; field: string } | null {
  if (!q) return null;
  const tryFields = (() => {
    switch ((crop ?? '').toLowerCase()) {
      case 'soja': return ['oil_pct'];
      case 'girasol': return ['oil_pct'];
      case 'trigo': return ['protein_pct', 'gluten_pct', 'test_weight_kg_hl'];
      default: return Object.keys(q);
    }
  })();
  for (const f of tryFields) {
    if (typeof q[f] === 'number') return { value: q[f], field: f };
  }
  return null;
}

// AR commercial base humidity reference per crop.
const HUMIDITY_BASE: Record<string, number> = {
  soja: 13.5,
  trigo: 14,
  maíz: 14.5,
};

export default function HarvestQualityVsHumidityScatter({ loads }: Props) {
  const points = useMemo<PreparedPoint[]>(() => {
    const out: PreparedPoint[] = [];
    for (const l of loads) {
      if (!l.crop) continue;
      const q = extractQuality(l.crop, l.quality);
      if (!q) continue;
      out.push({
        loadId: l.loadId,
        crop: l.crop,
        humidity: l.humidityPct,
        quality: q.value,
        qualityField: q.field,
        plot: l.plotName,
        harvestedAt: l.harvestedAt,
      });
    }
    return out;
  }, [loads]);

  // Group points by crop so each scatter series can have its own color.
  const byCrop = useMemo(() => {
    const m = new Map<string, PreparedPoint[]>();
    for (const p of points) {
      const list = m.get(p.crop) ?? [];
      list.push(p);
      m.set(p.crop, list);
    }
    return [...m.entries()];
  }, [points]);

  // Reference lines for the crops we have data for.
  const referenceLines = useMemo(() => {
    const crops = new Set(points.map(p => p.crop.toLowerCase()));
    return Object.entries(HUMIDITY_BASE).filter(([c]) => crops.has(c));
  }, [points]);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">Calidad vs humedad de cosecha</h3>
      <p className="text-xs text-gray-400 mb-3">Una carga = un punto · línea punteada = humedad base AR</p>
      {points.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-12">No hay cargas con humedad y calidad cargadas.</p>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <ScatterChart margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis type="number" dataKey="humidity" name="Humedad" unit="%" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
            <YAxis type="number" dataKey="quality" name="Calidad" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
            <ZAxis range={[60, 60]} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
              formatter={(v: number, name: string) => {
                if (name === 'Humedad') return [`${v}%`, name];
                if (name === 'Calidad') return [`${v}`, name];
                return [v, name];
              }}
              labelFormatter={() => ''}
            />
            {referenceLines.map(([crop, base]) => (
              <ReferenceLine key={crop} x={base} stroke="#d1d5db" strokeDasharray="4 4" label={{ value: `${crop} base ${base}%`, fontSize: 10, position: 'top', fill: '#9ca3af' }} />
            ))}
            {byCrop.map(([crop, pts]) => (
              <Scatter key={crop} name={crop} data={pts}>
                {pts.map(p => <Cell key={p.loadId} fill={colorForCrop(crop)} />)}
              </Scatter>
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/overview/charts/HarvestQualityVsHumidityScatter.tsx
git commit -m "feat(overview): add HarvestQualityVsHumidityScatter"
```

---

### Task 13: Compose `OverviewAgronomicView`

**Files:**
- Create: `frontend/src/components/overview/OverviewAgronomicView.tsx`
- Modify: `frontend/src/components/overview/OverviewPage.tsx`

- [ ] **Step 1: Create the view**

```tsx
import { useAgronomicAnalyticsData } from '../../hooks/useAgronomicAnalyticsData';
import RainfallYieldTrendChart from './charts/RainfallYieldTrendChart';
import ScoutingFieldMap from './charts/ScoutingFieldMap';
import YieldByCropChart from './charts/YieldByCropChart';
import HarvestQualityVsHumidityScatter from './charts/HarvestQualityVsHumidityScatter';

export default function OverviewAgronomicView() {
  const { data, loading, error, refresh } = useAgronomicAnalyticsData();

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
        {error}
        <button onClick={refresh} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <RainfallYieldTrendChart rainfall={data.rainfallMonthly} harvests={data.harvestsMonthly} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8">
          <ScoutingFieldMap scoutings={data.scoutingByPlot} />
        </div>
        <div className="lg:col-span-4">
          <YieldByCropChart data={data.yieldByCrop} />
        </div>
      </div>

      <HarvestQualityVsHumidityScatter loads={data.harvestQualityLoads} />
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `OverviewPage`**

In `OverviewPage.tsx`, replace the line:
```tsx
import OverviewSummaryView from './OverviewSummaryView';
```
with:
```tsx
import OverviewSummaryView from './OverviewSummaryView';
import OverviewAgronomicView from './OverviewAgronomicView';
```

Then replace the line:
```tsx
{tab === 'agronomico' && showAgronomic && <div className="text-sm text-gray-500 py-8 text-center">Dashboard agronómico — próximamente</div>}
```
with:
```tsx
{tab === 'agronomico' && showAgronomic && <OverviewAgronomicView />}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 4: Manual browser smoke**

- Open `/dashboard?overview=agronomico`.
- Confirm: spinner → 4 charts render (Lluvias+rinde, Mapa sanidad, Rinde por cultivo, Calidad vs humedad).
- For accounts with little or no data, confirm each empty state shows its own message — no white screens.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/overview/OverviewAgronomicView.tsx \
        frontend/src/components/overview/OverviewPage.tsx
git commit -m "feat(overview): wire OverviewAgronomicView with 4 charts"
```

---

## Phase 5 — Backend Livestock endpoint

### Task 14: Implement `GET /api/auth/analytics/livestock`

**Files:**
- Modify: `src/routes/auth.routes.ts` — add right after the `/analytics/agronomic` handler.

- [ ] **Step 1: Insert the new route**

```typescript
router.get('/analytics/livestock', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;

    // Current stock summed by category
    const { rows: stockByCategory } = await pool.query(
      `SELECT category::text AS category, SUM(count)::int AS headcount
       FROM livestock_groups
       WHERE user_id = $1 AND deleted_at IS NULL
       GROUP BY category
       ORDER BY headcount DESC`,
      [userId]
    );

    // Monthly net movements per category, last 12 months. Convention:
    // entrada / nacimiento → +count to dest category
    // salida   / muerte    → -count from source category
    // For transfer / recategorizacion we use the dest category for the +,
    // and the source category for the -.
    const { rows: monthlyDelta } = await pool.query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', NOW()) - interval '11 months',
           date_trunc('month', NOW()),
           '1 month'
         )::date AS month_start
       ),
       moves AS (
         SELECT
           date_trunc('month', m.movement_date)::date AS month_start,
           CASE
             WHEN m.movement_type IN ('entrada','nacimiento') THEN (SELECT category::text FROM livestock_groups WHERE id = m.dest_group_id)
             WHEN m.movement_type IN ('salida','muerte') THEN (SELECT category::text FROM livestock_groups WHERE id = m.source_group_id)
             WHEN m.movement_type IN ('transferencia','recategorizacion','ajuste') THEN (SELECT category::text FROM livestock_groups WHERE id = COALESCE(m.dest_group_id, m.source_group_id))
           END AS category,
           CASE
             WHEN m.movement_type IN ('entrada','nacimiento','transferencia','recategorizacion','ajuste') THEN m.count
             ELSE -m.count
           END AS delta
         FROM livestock_movements m
         WHERE m.user_id = $1
           AND m.movement_date >= date_trunc('month', NOW()) - interval '11 months'
       )
       SELECT
         to_char(months.month_start, 'YYYY-MM') AS month,
         to_char(months.month_start, 'Mon') AS label,
         moves.category,
         COALESCE(SUM(moves.delta), 0)::int AS delta
       FROM months
       LEFT JOIN moves ON moves.month_start = months.month_start
       GROUP BY months.month_start, moves.category
       ORDER BY months.month_start, moves.category`,
      [userId]
    );

    // Per-group weight curve for groups currently in any corral, last 12 months
    const { rows: feedlotWeightCurve } = await pool.query(
      `SELECT
         g.id AS group_id,
         g.category::text AS category,
         g.breed,
         c.name AS corral_name,
         e.event_date,
         e.quantity::numeric AS avg_weight_kg
       FROM domain_events e
       JOIN corrals c ON c.id = e.corral_id
       JOIN livestock_groups g
         ON g.corral_id = c.id
        AND g.category::text = e.animal_category
        AND g.deleted_at IS NULL
       WHERE e.user_id = $1
         AND e.event_type = 'weighing'
         AND e.event_date >= NOW() - interval '12 months'
         AND e.quantity IS NOT NULL
       ORDER BY g.id, e.event_date`,
      [userId]
    );

    // Latest avg weight per category, only weighings from last 90 days
    const { rows: avgWeightByCategory } = await pool.query(
      `SELECT DISTINCT ON (e.animal_category)
         e.animal_category::text AS category,
         e.quantity::numeric AS avg_weight_kg,
         e.event_date AS last_weighed_at
       FROM domain_events e
       WHERE e.user_id = $1
         AND e.event_type = 'weighing'
         AND e.event_date >= CURRENT_DATE - interval '90 days'
         AND e.animal_category IS NOT NULL
         AND e.quantity IS NOT NULL
       ORDER BY e.animal_category, e.event_date DESC`,
      [userId]
    );

    // Health events by month + sub-type, last 12 months
    const { rows: healthEventsMonthly } = await pool.query(
      `SELECT
         to_char(date_trunc('month', e.event_date), 'YYYY-MM') AS month,
         to_char(date_trunc('month', e.event_date), 'Mon') AS label,
         e.product_type AS type,
         COUNT(*)::int AS n
       FROM domain_events e
       WHERE e.user_id = $1
         AND e.event_type = 'health_event'
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
       GROUP BY 1, 2, 3
       ORDER BY 1, 3`,
      [userId]
    );

    // Repro events by month + sub-type, last 12 months
    const { rows: reproEventsMonthly } = await pool.query(
      `SELECT
         to_char(date_trunc('month', e.event_date), 'YYYY-MM') AS month,
         to_char(date_trunc('month', e.event_date), 'Mon') AS label,
         e.product_type AS type,
         COUNT(*)::int AS n
       FROM domain_events e
       WHERE e.user_id = $1
         AND e.event_type = 'repro_event'
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
       GROUP BY 1, 2, 3
       ORDER BY 1, 3`,
      [userId]
    );

    // Feedlot occupancy per corral
    const { rows: feedlotOccupancy } = await pool.query(
      `SELECT
         c.id AS corral_id,
         c.name AS corral_name,
         c.capacity,
         COALESCE(SUM(g.count), 0)::int AS current_headcount
       FROM corrals c
       JOIN feedlots f ON f.id = c.feedlot_id
       LEFT JOIN livestock_groups g
         ON g.corral_id = c.id
        AND g.deleted_at IS NULL
       WHERE c.deleted_at IS NULL
         AND f.user_id = $1
         AND f.deleted_at IS NULL
       GROUP BY c.id, c.name, c.capacity
       ORDER BY c.name`,
      [userId]
    );

    // Stitch monthly deltas into the headcount trend (one row per month with byCategory map).
    // We don't reconstruct historic stock here — we expose the *deltas*, which is enough
    // for an area chart of monthly movement. (Computing historic stock would require
    // running totals back to time 0; not needed for the dashboard.)
    const trendMap = new Map<string, { month: string; label: string; byCategory: Record<string, number> }>();
    for (const r of monthlyDelta) {
      const key = r.month;
      const existing = trendMap.get(key) ?? { month: r.month, label: r.label, byCategory: {} };
      if (r.category) existing.byCategory[r.category] = (existing.byCategory[r.category] ?? 0) + Number(r.delta);
      trendMap.set(key, existing);
    }

    // Stitch monthly health/repro event counts into the same per-month-by-type shape.
    const eventsToMonthly = (rows: Array<{ month: string; label: string; type: string | null; n: number }>) => {
      const map = new Map<string, { month: string; label: string; byType: Record<string, number> }>();
      for (const r of rows) {
        const k = r.month;
        const ex = map.get(k) ?? { month: r.month, label: r.label, byType: {} };
        if (r.type) ex.byType[r.type] = (ex.byType[r.type] ?? 0) + Number(r.n);
        map.set(k, ex);
      }
      return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
    };

    // Group feedlot points into per-group time series
    const groupMap = new Map<string, { groupId: string; groupLabel: string; corralName: string; points: Array<{ date: string; avgWeightKg: number }> }>();
    for (const r of feedlotWeightCurve) {
      const id = String(r.group_id);
      const ex = groupMap.get(id) ?? {
        groupId: id,
        groupLabel: `${r.category}${r.breed ? ' ' + r.breed : ''}`,
        corralName: r.corral_name,
        points: [],
      };
      ex.points.push({ date: r.event_date, avgWeightKg: Number(r.avg_weight_kg) });
      groupMap.set(id, ex);
    }

    res.json({
      stockByCategory: stockByCategory.map(r => ({ category: r.category, headcount: Number(r.headcount) })),
      headcountTrendMonthly: [...trendMap.values()].sort((a, b) => a.month.localeCompare(b.month)),
      feedlotWeightCurve: [...groupMap.values()],
      avgWeightByCategory: avgWeightByCategory.map(r => ({
        category: r.category,
        avgWeightKg: Number(r.avg_weight_kg),
        lastWeighedAt: r.last_weighed_at,
      })),
      healthEventsMonthly: eventsToMonthly(healthEventsMonthly as Array<{ month: string; label: string; type: string | null; n: number }>),
      reproEventsMonthly: eventsToMonthly(reproEventsMonthly as Array<{ month: string; label: string; type: string | null; n: number }>),
      feedlotOccupancy: feedlotOccupancy.map(r => ({
        corralId: Number(r.corral_id),
        corralName: r.corral_name,
        capacity: r.capacity !== null ? Number(r.capacity) : null,
        currentHeadcount: Number(r.current_headcount),
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});
```

- [ ] **Step 2: Typecheck the backend**

Run: `npx tsc --noEmit -p .`
Expected: PASS

- [ ] **Step 3: Smoke-test the endpoint with curl**

```bash
docker compose up -d
sleep 6
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"testin@gmail.com","password":"tester123"}' | jq -r '.tokens.accessToken')
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/auth/analytics/livestock | jq 'keys'
```
Expected output:
```
[
  "avgWeightByCategory",
  "feedlotOccupancy",
  "feedlotWeightCurve",
  "headcountTrendMonthly",
  "healthEventsMonthly",
  "reproEventsMonthly",
  "stockByCategory"
]
```

If your test user does NOT have the livestock feature, expect 403 with `{"error":"Feature not available in your plan"}`. Upgrade them via `seed-dummy-data.ts` or admin panel.

- [ ] **Step 4: Run unit tests**

Run: `npm test`
Expected: 1280 passing

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.routes.ts
git commit -m "feat(api): add GET /analytics/livestock endpoint"
```

---

### Task 15: `useLivestockAnalyticsData` hook

**Files:**
- Create: `frontend/src/hooks/useLivestockAnalyticsData.ts`

- [ ] **Step 1: Create the hook + types**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';

export interface LivestockStockCategoryRow {
  category: string;
  headcount: number;
}

export interface LivestockHeadcountMonth {
  month: string;
  label: string;
  byCategory: Record<string, number>; // monthly net delta per category
}

export interface FeedlotWeightCurveGroup {
  groupId: string;
  groupLabel: string;
  corralName: string;
  points: Array<{ date: string; avgWeightKg: number }>;
}

export interface AvgWeightCategoryRow {
  category: string;
  avgWeightKg: number;
  lastWeighedAt: string;
}

export interface MonthlyEventsByType {
  month: string;
  label: string;
  byType: Record<string, number>;
}

export interface FeedlotOccupancyRow {
  corralId: number;
  corralName: string;
  capacity: number | null;
  currentHeadcount: number;
}

export interface LivestockAnalyticsData {
  stockByCategory: LivestockStockCategoryRow[];
  headcountTrendMonthly: LivestockHeadcountMonth[];
  feedlotWeightCurve: FeedlotWeightCurveGroup[];
  avgWeightByCategory: AvgWeightCategoryRow[];
  healthEventsMonthly: MonthlyEventsByType[];
  reproEventsMonthly: MonthlyEventsByType[];
  feedlotOccupancy: FeedlotOccupancyRow[];
}

export function useLivestockAnalyticsData() {
  const [data, setData] = useState<LivestockAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await apiRequest<LivestockAnalyticsData>('/analytics/livestock');
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar dashboard ganadero');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, error, refresh };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useLivestockAnalyticsData.ts
git commit -m "feat(overview): add useLivestockAnalyticsData hook"
```

---

## Phase 6 — Livestock charts

### Task 16: Three small Row-1 charts (Stock + AvgWeight + FeedlotOccupancy)

**Files:**
- Create: `frontend/src/components/overview/charts/LivestockStockByCategoryChart.tsx`
- Create: `frontend/src/components/overview/charts/AvgWeightByCategoryChart.tsx`
- Create: `frontend/src/components/overview/charts/FeedlotOccupancyChart.tsx`

- [ ] **Step 1: Create `LivestockStockByCategoryChart.tsx`**

```tsx
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import type { LivestockStockCategoryRow } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: LivestockStockCategoryRow[]; }

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

export default function LivestockStockByCategoryChart({ data }: Props) {
  const total = data.reduce((s, r) => s + r.headcount, 0);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Stock por categoría</h3>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-12">Aún no hay hacienda registrada.</p>
      ) : (
        <div className="h-56 relative">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2} dataKey="headcount" nameKey="category" stroke="#fff" strokeWidth={2}>
                {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v: number, n: string) => [`${v} cabezas`, n]} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-xs text-gray-500">Total</span>
            <span className="text-lg font-bold text-gray-800">{total}</span>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `AvgWeightByCategoryChart.tsx`**

```tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import type { AvgWeightCategoryRow } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: AvgWeightCategoryRow[]; }

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

export default function AvgWeightByCategoryChart({ data }: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">Peso promedio</h3>
      <p className="text-xs text-gray-400 mb-3">Último pesaje por categoría · 90 días</p>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-12">Sin pesajes recientes.</p>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="category" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={45} />
            <Tooltip formatter={(v: number) => [`${Math.round(v)} kg`, 'Peso promedio']} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Bar dataKey="avgWeightKg" radius={[4, 4, 0, 0]}>
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `FeedlotOccupancyChart.tsx`**

```tsx
import type { FeedlotOccupancyRow } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: FeedlotOccupancyRow[]; }

function occupancyColor(pct: number): string {
  if (pct >= 95) return 'bg-red-500';
  if (pct >= 80) return 'bg-amber-500';
  return 'bg-green-500';
}

export default function FeedlotOccupancyChart({ data }: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Ocupación de corrales</h3>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-12">Sin corrales.</p>
      ) : (
        <ul className="space-y-2 max-h-56 overflow-y-auto">
          {data.map(c => {
            const pct = c.capacity && c.capacity > 0
              ? Math.min(100, (c.currentHeadcount / c.capacity) * 100)
              : null;
            return (
              <li key={c.corralId} className="text-xs">
                <div className="flex justify-between mb-0.5">
                  <span className="font-medium text-gray-700 truncate">{c.corralName}</span>
                  <span className="text-gray-500">
                    {c.currentHeadcount}{c.capacity != null && ` / ${c.capacity}`}{pct != null && ` · ${Math.round(pct)}%`}
                  </span>
                </div>
                {pct != null && (
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full ${occupancyColor(pct)}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/overview/charts/LivestockStockByCategoryChart.tsx \
        frontend/src/components/overview/charts/AvgWeightByCategoryChart.tsx \
        frontend/src/components/overview/charts/FeedlotOccupancyChart.tsx
git commit -m "feat(overview): add livestock Row-1 charts (stock/avgWeight/feedlotOccupancy)"
```

---

### Task 17: `LivestockHeadcountTrendChart`

**Files:**
- Create: `frontend/src/components/overview/charts/LivestockHeadcountTrendChart.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { LivestockHeadcountMonth } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: LivestockHeadcountMonth[]; }

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

export default function LivestockHeadcountTrendChart({ data }: Props) {
  // Collect every category that appears in any month so the chart has a
  // stable set of series (gaps become 0).
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of data) for (const k of Object.keys(m.byCategory)) set.add(k);
    return [...set].sort();
  }, [data]);

  // Flatten into rechart-friendly rows: { label, [cat1]: n, [cat2]: n, ... }
  const rows = useMemo(() => {
    return data.map(m => {
      const out: Record<string, number | string> = { label: m.label };
      for (const c of categories) out[c] = m.byCategory[c] ?? 0;
      return out;
    });
  }, [data, categories]);

  const hasAnything = data.some(m => Object.values(m.byCategory).some(v => v !== 0));

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">Evolución de cabezas (delta mensual)</h3>
      <p className="text-xs text-gray-400 mb-3">Altas (+) y bajas (−) por categoría, 12 meses</p>
      {!hasAnything ? (
        <p className="text-sm text-gray-400 text-center py-12">Sin movimientos en los últimos 12 meses.</p>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={45} />
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend />
            {categories.map((c, i) => (
              <Area key={c} type="monotone" dataKey={c} stackId="1" stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.5} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/overview/charts/LivestockHeadcountTrendChart.tsx
git commit -m "feat(overview): add LivestockHeadcountTrendChart"
```

---

### Task 18: `FeedlotWeightCurveChart`

**Files:**
- Create: `frontend/src/components/overview/charts/FeedlotWeightCurveChart.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { FeedlotWeightCurveGroup } from '../../../hooks/useLivestockAnalyticsData';

interface Props { groups: FeedlotWeightCurveGroup[]; }

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

export default function FeedlotWeightCurveChart({ groups }: Props) {
  const [focus, setFocus] = useState<string>('__all__');

  const shown = useMemo(() => {
    if (focus === '__all__') return groups;
    return groups.filter(g => g.groupId === focus);
  }, [groups, focus]);

  // Build a unified date axis (union of all dates across visible groups)
  const rows = useMemo(() => {
    const dateSet = new Set<string>();
    for (const g of shown) for (const p of g.points) dateSet.add(p.date.slice(0, 10));
    const dates = [...dateSet].sort();
    return dates.map(d => {
      const row: Record<string, number | string> = { date: d, label: d.slice(5) };
      for (const g of shown) {
        const p = g.points.find(x => x.date.slice(0, 10) === d);
        if (p) row[g.groupId] = p.avgWeightKg;
      }
      return row;
    });
  }, [shown]);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-700">Curva de peso (grupos en corral)</h3>
        {groups.length > 1 && (
          <select
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:border-campo-500"
          >
            <option value="__all__">Todos los grupos</option>
            {groups.map(g => <option key={g.groupId} value={g.groupId}>{g.corralName} · {g.groupLabel}</option>)}
          </select>
        )}
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-12">No hay pesajes de animales en corrales.</p>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={50} tickFormatter={(v: number) => `${v} kg`} />
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend formatter={(value: string) => {
              const g = shown.find(x => x.groupId === value);
              return g ? `${g.corralName} · ${g.groupLabel}` : value;
            }} />
            {shown.map((g, i) => (
              <Line key={g.groupId} type="monotone" dataKey={g.groupId} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={{ r: 3 }} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/overview/charts/FeedlotWeightCurveChart.tsx
git commit -m "feat(overview): add FeedlotWeightCurveChart"
```

---

### Task 19: `LivestockHealthEventsChart` + `LivestockReproEventsChart` (same pattern)

**Files:**
- Create: `frontend/src/components/overview/charts/LivestockHealthEventsChart.tsx`
- Create: `frontend/src/components/overview/charts/LivestockReproEventsChart.tsx`

- [ ] **Step 1: Create `LivestockHealthEventsChart.tsx`**

```tsx
import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { MonthlyEventsByType } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: MonthlyEventsByType[]; }

const TYPE_COLORS: Record<string, string> = {
  vacunacion: '#3b82f6',
  desparasitacion: '#22c55e',
  tratamiento: '#f59e0b',
  revision_sanitaria: '#a855f7',
};

const TYPE_LABELS: Record<string, string> = {
  vacunacion: 'Vacunación',
  desparasitacion: 'Desparasitación',
  tratamiento: 'Tratamiento',
  revision_sanitaria: 'Revisión',
};

export default function LivestockHealthEventsChart({ data }: Props) {
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const m of data) for (const k of Object.keys(m.byType)) set.add(k);
    return [...set].sort();
  }, [data]);

  const rows = useMemo(() => data.map(m => {
    const out: Record<string, number | string> = { label: m.label };
    for (const t of types) out[t] = m.byType[t] ?? 0;
    return out;
  }), [data, types]);

  const hasAnything = data.some(m => Object.values(m.byType).some(v => v > 0));

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Sanidad — eventos mensuales</h3>
      {!hasAnything ? (
        <p className="text-sm text-gray-400 text-center py-12">Sin eventos sanitarios en 12 meses.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={35} />
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} formatter={(v: number, name: string) => [v, TYPE_LABELS[name] ?? name]} />
            <Legend formatter={(value: string) => TYPE_LABELS[value] ?? value} />
            {types.map(t => (
              <Bar key={t} dataKey={t} stackId="health" fill={TYPE_COLORS[t] ?? '#6b7280'} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `LivestockReproEventsChart.tsx`**

```tsx
import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { MonthlyEventsByType } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: MonthlyEventsByType[]; }

const TYPE_COLORS: Record<string, string> = {
  servicio: '#3b82f6',
  destete: '#22c55e',
  inseminacion: '#f59e0b',
  deteccion_celo: '#a855f7',
};

const TYPE_LABELS: Record<string, string> = {
  servicio: 'Servicio',
  destete: 'Destete',
  inseminacion: 'Inseminación',
  deteccion_celo: 'Detección celo',
};

export default function LivestockReproEventsChart({ data }: Props) {
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const m of data) for (const k of Object.keys(m.byType)) set.add(k);
    return [...set].sort();
  }, [data]);

  const rows = useMemo(() => data.map(m => {
    const out: Record<string, number | string> = { label: m.label };
    for (const t of types) out[t] = m.byType[t] ?? 0;
    return out;
  }), [data, types]);

  const hasAnything = data.some(m => Object.values(m.byType).some(v => v > 0));

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Reproducción — eventos mensuales</h3>
      {!hasAnything ? (
        <p className="text-sm text-gray-400 text-center py-12">Sin eventos reproductivos en 12 meses.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={35} />
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} formatter={(v: number, name: string) => [v, TYPE_LABELS[name] ?? name]} />
            <Legend formatter={(value: string) => TYPE_LABELS[value] ?? value} />
            {types.map(t => (
              <Bar key={t} dataKey={t} stackId="repro" fill={TYPE_COLORS[t] ?? '#6b7280'} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/overview/charts/LivestockHealthEventsChart.tsx \
        frontend/src/components/overview/charts/LivestockReproEventsChart.tsx
git commit -m "feat(overview): add Livestock health and repro monthly event charts"
```

---

### Task 20: Compose `OverviewLivestockView`

**Files:**
- Create: `frontend/src/components/overview/OverviewLivestockView.tsx`
- Modify: `frontend/src/components/overview/OverviewPage.tsx`

- [ ] **Step 1: Create the view**

```tsx
import { useLivestockAnalyticsData } from '../../hooks/useLivestockAnalyticsData';
import LivestockStockByCategoryChart from './charts/LivestockStockByCategoryChart';
import AvgWeightByCategoryChart from './charts/AvgWeightByCategoryChart';
import FeedlotOccupancyChart from './charts/FeedlotOccupancyChart';
import LivestockHeadcountTrendChart from './charts/LivestockHeadcountTrendChart';
import FeedlotWeightCurveChart from './charts/FeedlotWeightCurveChart';
import LivestockHealthEventsChart from './charts/LivestockHealthEventsChart';
import LivestockReproEventsChart from './charts/LivestockReproEventsChart';

export default function OverviewLivestockView() {
  const { data, loading, error, refresh } = useLivestockAnalyticsData();

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
        {error}
        <button onClick={refresh} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-4">
          <LivestockStockByCategoryChart data={data.stockByCategory} />
        </div>
        <div className="lg:col-span-4">
          <AvgWeightByCategoryChart data={data.avgWeightByCategory} />
        </div>
        <div className="lg:col-span-4">
          <FeedlotOccupancyChart data={data.feedlotOccupancy} />
        </div>
      </div>

      <LivestockHeadcountTrendChart data={data.headcountTrendMonthly} />

      <FeedlotWeightCurveChart groups={data.feedlotWeightCurve} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LivestockHealthEventsChart data={data.healthEventsMonthly} />
        <LivestockReproEventsChart data={data.reproEventsMonthly} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into `OverviewPage`**

In `OverviewPage.tsx`, add the import:
```tsx
import OverviewLivestockView from './OverviewLivestockView';
```

Replace:
```tsx
{tab === 'ganadero' && showLivestock && <div className="text-sm text-gray-500 py-8 text-center">Dashboard ganadero — próximamente</div>}
```
with:
```tsx
{tab === 'ganadero' && showLivestock && <OverviewLivestockView />}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 4: Manual browser smoke**

- Login as user with `livestock` feature.
- Open `/dashboard?overview=ganadero`.
- Confirm: spinner → 7 sections render. Empty states show where data is missing.
- Smoke each part: hover bars, change "Curva de peso" group selector if multiple groups.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/overview/OverviewLivestockView.tsx \
        frontend/src/components/overview/OverviewPage.tsx
git commit -m "feat(overview): wire OverviewLivestockView with 7 charts"
```

---

## Phase 7 — Final verification

### Task 21: Cross-tab smoke + regression check

**Files:** (none — verification only)

- [ ] **Step 1: Backend typecheck + tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: typecheck PASS, 1280 tests passing.

- [ ] **Step 2: Frontend typecheck + production build**

Run: `cd frontend && npx tsc -b && npm run build`
Expected: PASS, `frontend/dist/` produced.

- [ ] **Step 3: Browser end-to-end smoke**

```bash
docker compose up -d
sleep 6
cd frontend && npm run dev
```

Walk through every tab once with a test user that has agronomy + livestock features:

- `/dashboard` (Resumen)
  - All 5 KPI cards render
  - Both donuts render
  - FieldMap renders
  - Bottom-right: "Rentabilidad por lote" (not "Tendencia mensual")
  - ARS / USD toggle on Rentabilidad works
  - "Actualizar" button refreshes
- `/dashboard?overview=agronomico`
  - 4 charts (lluvias+rinde, mapa sanidad, rinde por cultivo, calidad vs humedad)
  - No console errors
- `/dashboard?overview=ganadero`
  - 7 sections (stock donut, peso prom, ocupación corrales, evolución cabezas, curva feedlot, sanidad, repro)
  - No console errors
- Login as user WITHOUT `livestock` feature
  - "Ganadero" tab is NOT visible
  - Pasting `?overview=ganadero` redirects silently to Resumen

- [ ] **Step 4: If everything passes, no commit needed** — verification only.

---

## Self-Review Notes

This plan was self-reviewed against the spec:

1. **Spec coverage:** every spec section has a task. Architecture (Task 3, 13, 20), Data Flow (Task 7, 14), Rentabilidad por lote (Tasks 4-6), Agronómico Tab (Tasks 9-13), Ganadero Tab (Tasks 16-20), Feature Gating (Task 3), Error Handling (covered inside each view component), Testing (Tasks 7, 14, 21).
2. **Placeholder scan:** no TBD / TODO / "implement later" anywhere. Each code step shows the full snippet.
3. **Type consistency:** hook return types (`AgronomicAnalyticsData`, `LivestockAnalyticsData`) are defined once, imported everywhere they're used. Chart component prop types reference the hook-exported interfaces directly. Sub-tab union type `OverviewTab` declared once in `useOverviewTab.ts`.
4. **Ambiguity:** `RainfallYieldTrendChart` uses Scatter for yield (per-load points share monthly X-axis); per-point coloring kept as a future enhancement noted in the file. `LivestockHeadcountTrendChart` is a **monthly delta** chart, not a running total — documented in the chart subtitle. Both noted explicitly.
