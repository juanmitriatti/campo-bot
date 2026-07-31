/**
 * Insights de tendencia para el resumen mensual: qué categorías de gasto
 * se movieron de forma relevante vs el mes anterior. Lógica pura, sin DB.
 * Umbrales configurables desde admin (MONTHLY_INSIGHTS_MIN_PCT) — el caller
 * los pasa por `opts`.
 */

export function computeCategoryMovers(current, previous, opts = {}) {
  const { minPct = 15, minAmountArs = 50000, top = 3 } = opts;
  const prevMap = new Map((previous ?? []).map((c) => [c.category, Number(c.total)]));
  const movers = [];

  for (const c of current ?? []) {
    const now = Number(c.total);
    const before = prevMap.get(c.category) ?? 0;

    if (before <= 0) {
      // Categoría nueva este mes: solo relevante si el monto es significativo
      if (now >= minAmountArs * 4) movers.push({ category: c.category, pct: null, now, before: 0 });
      continue;
    }

    const pct = Math.round(((now - before) / before) * 100);
    if (Math.abs(pct) >= minPct && Math.max(now, before) >= minAmountArs) {
      movers.push({ category: c.category, pct, now, before });
    }
  }

  movers.sort((a, b) => Math.abs(b.pct ?? Infinity) - Math.abs(a.pct ?? Infinity));
  return movers.slice(0, top);
}

export function formatMoversLines(movers, formatCurrency) {
  if (!movers?.length) return '';
  let out = `\n\n📈 *Tendencias:*`;
  for (const m of movers) {
    if (m.pct === null) {
      out += `\n• ${m.category}: nuevo este mes (${formatCurrency(m.now)})`;
    } else {
      out += `\n• ${m.category}: ${m.pct >= 0 ? 'subió' : 'bajó'} ${Math.abs(m.pct)}% (${formatCurrency(m.before)} → ${formatCurrency(m.now)})`;
    }
  }
  return out;
}
