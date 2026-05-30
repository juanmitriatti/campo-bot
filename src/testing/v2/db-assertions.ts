import type { Assertion, AssertContext } from './types.js';

type FilterVal = string | number | null | undefined | { op: '>=' | '<=' | '>' | '<' | '='; value: number };

/** Build a parameterized WHERE clause from a partial filter, user-scoped, undefined keys skipped. */
export function buildWhere(
  filter: Record<string, FilterVal>,
  userId: number,
  opts: { includeDeleted?: boolean } = {},
): { clause: string; params: unknown[] } {
  const parts = ['user_id = $1'];
  const params: unknown[] = [userId];
  if (!opts.includeDeleted) parts.push('deleted_at IS NULL');
  for (const [col, val] of Object.entries(filter)) {
    if (val === undefined) continue;
    if (val !== null && typeof val === 'object') {
      params.push(val.value);
      parts.push(`${col} ${val.op} $${params.length}`);
    } else {
      params.push(val);
      parts.push(`${col} = $${params.length}`);
    }
  }
  return { clause: parts.join(' AND '), params };
}

async function countRows(ctx: AssertContext, table: string, filter: Record<string, FilterVal>, opts?: { includeDeleted?: boolean }): Promise<number> {
  const { clause, params } = buildWhere(filter, ctx.userId, opts);
  const rows = await ctx.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${clause}`, params);
  return Number(rows[0]?.n ?? 0);
}

/** Resolve a plot name to its id for the user (case-insensitive). Returns null if not found. */
async function plotIdByName(ctx: AssertContext, plotName: string): Promise<number | null> {
  const rows = await ctx.query(
    `SELECT p.id FROM plots p JOIN fields f ON f.id = p.field_id
     WHERE f.user_id = $1 AND p.deleted_at IS NULL AND lower(p.name) = lower($2) LIMIT 1`,
    [ctx.userId, plotName],
  );
  return rows.length ? Number(rows[0].id) : null;
}

/** Generic: assert exactly `n` rows match the filter in `table`. */
export function dbRowCount(table: string, filter: Record<string, FilterVal>, n: number, opts: { includeDeleted?: boolean } = {}): Assertion {
  return {
    label: `dbRowCount(${table}, ${JSON.stringify(filter)}) == ${n}`,
    run: async (ctx) => {
      const got = await countRows(ctx, table, filter, opts);
      return { ok: got === n, detail: `expected ${n}, got ${got}` };
    },
  };
}

/** Assert NO row matches (anti-corruption / anti-duplicate). */
export function dbNone(table: string, filter: Record<string, FilterVal>, opts: { includeDeleted?: boolean } = {}): Assertion {
  return {
    label: `dbNone(${table}, ${JSON.stringify(filter)})`,
    run: async (ctx) => {
      const got = await countRows(ctx, table, filter, opts);
      return { ok: got === 0, detail: `expected 0, got ${got}` };
    },
  };
}

export function dbExpense(spec: { amount?: number; category?: string; currency?: string; plotName?: string; n?: number }): Assertion {
  return {
    label: `dbExpense(${JSON.stringify(spec)})`,
    run: async (ctx) => {
      const filter: Record<string, FilterVal> = { amount: spec.amount, category: spec.category, currency: spec.currency };
      if (spec.plotName) {
        const pid = await plotIdByName(ctx, spec.plotName);
        if (pid === null) return { ok: false, detail: `plot "${spec.plotName}" not found` };
        filter.plot_id = pid;
      }
      const got = await countRows(ctx, 'expenses', filter);
      const want = spec.n ?? 1;
      return { ok: got === want, detail: `expected ${want} expense(s) matching, got ${got}` };
    },
  };
}

export function dbActivity(spec: { eventType: string; crop?: string; product?: string; plotName?: string; n?: number }): Assertion {
  return {
    label: `dbActivity(${JSON.stringify(spec)})`,
    run: async (ctx) => {
      const filter: Record<string, FilterVal> = { event_type: spec.eventType, crop: spec.crop, product: spec.product };
      if (spec.plotName) {
        const pid = await plotIdByName(ctx, spec.plotName);
        if (pid === null) return { ok: false, detail: `plot "${spec.plotName}" not found` };
        filter.plot_id = pid;
      }
      const got = await countRows(ctx, 'domain_events', filter);
      const want = spec.n ?? 1;
      return { ok: got === want, detail: `expected ${want} ${spec.eventType} event(s), got ${got}` };
    },
  };
}

export function dbLivestockCount(spec: { category: string; count: number }): Assertion {
  return {
    label: `dbLivestockCount(${spec.category}) total == ${spec.count}`,
    run: async (ctx) => {
      const rows = await ctx.query(
        `SELECT COALESCE(SUM(count),0)::int AS total FROM livestock_groups
         WHERE user_id = $1 AND deleted_at IS NULL AND category = $2`,
        [ctx.userId, spec.category],
      );
      const got = Number(rows[0]?.total ?? 0);
      return { ok: got === spec.count, detail: `expected ${spec.count} head, got ${got}` };
    },
  };
}
