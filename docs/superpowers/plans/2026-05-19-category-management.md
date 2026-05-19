# Category Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user catalog of expense/income categories that the bot suggests from on every save, asks the user on ambiguity (with quick buttons + "+ Otra"), and learns over time by usage_count.

**Architecture:** One new `user_categories` table (per-user, per-kind) + a thin service that handles `match/bootstrap/bump`. The AI tools `log_expense`/`log_income` get a `category_match` enum that turns the agent into a 3-way classifier (`exact|new|unknown`) — when `unknown`, the handler asks the user with button options. A new `Categorías` dashboard tab lets the user rename/delete/create. The existing regex parser fallback (`AGENT_ENABLED=false`) keeps using the legacy global EXPENSE_CATEGORIES map.

**Tech Stack:** PostgreSQL, Node 20 + TypeScript + Express, vitest for backend unit tests, React 19 + Tailwind + Vite for frontend. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-19-category-management-design.md`

---

## TDD note

- **Backend pure logic** (service `match/bootstrap/bump`) → vitest unit tests
- **Backend SQL endpoints** (CRUD) → curl smoke against local Docker
- **Backend handler flow** → covered by 1 new conversational eval scenario at the end
- **Frontend** → no test framework configured; verify via `tsc -b` + manual browser smoke

Every task ends with a commit.

---

## File structure

### NEW
- `src/migrations/090_user_categories.sql` — table + indexes
- `src/migrations/091_user_categories_backfill.sql` — one-shot backfill from existing expenses/incomes
- `src/domain/financial/category.repository.ts` — DB CRUD + match
- `src/domain/financial/category.service.ts` — bootstrap + match + bump + business rules
- `src/domain/financial/__tests__/category.service.test.ts` — unit tests
- `frontend/src/hooks/useCategories.ts` — fetch + CRUD client
- `frontend/src/components/CategoriesTab.tsx` — top-level dashboard tab

### MODIFIED
- `src/ai/tool-definitions.ts` — relax category enum + add `category_match` on log_expense + log_income
- `src/ai/user-context.service.ts` — include top-8 categories per kind in the user context
- `src/ai/agent-prompt-builder.ts` — emit "Categorías" section from context
- `src/domain/financial/financial.handler.ts` — wire `categoryService.match()` into the expense + income paths, handle button callbacks + new-name flow
- `src/domain/router.ts` — register `pick_category`, `create_category` commands
- `src/routes/auth.routes.ts` — `/categories` GET / POST / PATCH / DELETE endpoints
- `src/testing/scenarios/19-category-ambiguous.json` — eval scenario
- `frontend/src/pages/Dashboard.tsx` — `categories` view + import
- `frontend/src/components/layout/Sidebar.tsx` — entry
- `frontend/src/components/layout/BottomNav.tsx` — entry

---

## Phase 1 — Backend foundation

### Task 1: Migration — create `user_categories` table

**Files:**
- Create: `src/migrations/090_user_categories.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Per-user catalog of expense / income categories. Learned over time via
-- usage_count + last_used_at. The agent suggests from the top 8.
CREATE TABLE IF NOT EXISTS user_categories (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('expense', 'income')),
  name VARCHAR(60) NOT NULL,
  usage_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Case-insensitive uniqueness scoped to (user, kind). The WHERE clause lets
-- a soft-deleted name be re-created later.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_categories_active
  ON user_categories (user_id, kind, lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_categories_top
  ON user_categories (user_id, kind, usage_count DESC, last_used_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE user_categories IS 'Per-user catalog. Backfilled from expenses/incomes once in migration 091.';
```

- [ ] **Step 2: Apply the migration against local Docker**

```bash
docker compose up -d db && sleep 3
docker compose exec -T db psql -U campo -d campo_bot -f /dev/stdin < src/migrations/090_user_categories.sql
docker compose exec -T db psql -U campo -d campo_bot -c "\d user_categories"
```
Expected: schema printed with id/user_id/kind/name/usage_count/last_used_at/created_at/deleted_at + the 2 indexes.

- [ ] **Step 3: Commit**

```bash
git add src/migrations/090_user_categories.sql
git commit -m "feat(db): user_categories table for per-user expense/income catalog"
```

---

### Task 2: Repository

**Files:**
- Create: `src/domain/financial/category.repository.ts`

- [ ] **Step 1: Write the repository**

```typescript
import { pool } from '../../config/db.js';

export type CategoryKind = 'expense' | 'income';

export interface UserCategory {
  id: number;
  userId: number;
  kind: CategoryKind;
  name: string;
  usageCount: number;
  lastUsedAt: Date | null;
}

export class CategoryRepository {
  async listActive(userId: number, kind: CategoryKind): Promise<UserCategory[]> {
    const { rows } = await pool.query(
      `SELECT id, user_id, kind, name, usage_count, last_used_at
       FROM user_categories
       WHERE user_id = $1 AND kind = $2 AND deleted_at IS NULL
       ORDER BY usage_count DESC, last_used_at DESC NULLS LAST, lower(name)`,
      [userId, kind]
    );
    return rows.map(mapRow);
  }

  async topN(userId: number, kind: CategoryKind, n: number): Promise<UserCategory[]> {
    const { rows } = await pool.query(
      `SELECT id, user_id, kind, name, usage_count, last_used_at
       FROM user_categories
       WHERE user_id = $1 AND kind = $2 AND deleted_at IS NULL
       ORDER BY usage_count DESC, last_used_at DESC NULLS LAST, lower(name)
       LIMIT $3`,
      [userId, kind, n]
    );
    return rows.map(mapRow);
  }

  async findByName(userId: number, kind: CategoryKind, name: string): Promise<UserCategory | null> {
    const { rows } = await pool.query(
      `SELECT id, user_id, kind, name, usage_count, last_used_at
       FROM user_categories
       WHERE user_id = $1 AND kind = $2 AND lower(name) = lower($3) AND deleted_at IS NULL`,
      [userId, kind, name]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findById(userId: number, id: number): Promise<UserCategory | null> {
    const { rows } = await pool.query(
      `SELECT id, user_id, kind, name, usage_count, last_used_at
       FROM user_categories
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(userId: number, kind: CategoryKind, name: string): Promise<UserCategory> {
    const { rows } = await pool.query(
      `INSERT INTO user_categories (user_id, kind, name)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, kind, name, usage_count, last_used_at`,
      [userId, kind, name.trim()]
    );
    return mapRow(rows[0]);
  }

  async rename(userId: number, id: number, name: string): Promise<UserCategory | null> {
    const { rows } = await pool.query(
      `UPDATE user_categories SET name = $3
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, user_id, kind, name, usage_count, last_used_at`,
      [id, userId, name.trim()]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async softDelete(userId: number, id: number): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE user_categories SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId]
    );
    return (rowCount ?? 0) > 0;
  }

  async bump(id: number): Promise<void> {
    await pool.query(
      `UPDATE user_categories SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  /** Count how many non-deleted expenses or incomes reference this category by name. */
  async usageInTransactions(userId: number, kind: CategoryKind, name: string): Promise<number> {
    const table = kind === 'expense' ? 'expenses' : 'incomes';
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${table}
       WHERE user_id = $1 AND deleted_at IS NULL AND lower(category) = lower($2)`,
      [userId, name]
    );
    return rows[0].n;
  }

  async reassign(userId: number, kind: CategoryKind, fromName: string, toName: string): Promise<number> {
    const table = kind === 'expense' ? 'expenses' : 'incomes';
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET category = $4
       WHERE user_id = $1 AND deleted_at IS NULL AND lower(category) = lower($2)`,
      [userId, fromName, kind, toName]
    );
    return rowCount ?? 0;
  }
}

function mapRow(r: any): UserCategory {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    kind: r.kind,
    name: r.name,
    usageCount: Number(r.usage_count),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: no new errors in this file.

- [ ] **Step 3: Commit**

```bash
git add src/domain/financial/category.repository.ts
git commit -m "feat(financial): CategoryRepository CRUD + topN + bump"
```

---

### Task 3: Service + unit tests

**Files:**
- Create: `src/domain/financial/category.service.ts`
- Create: `src/domain/financial/__tests__/category.service.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CategoryService, MatchResult } from '../category.service.js';
import type { CategoryRepository, UserCategory } from '../category.repository.js';

function fakeCat(id: number, name: string, usage = 0): UserCategory {
  return { id, userId: 1, kind: 'expense', name, usageCount: usage, lastUsedAt: null };
}

describe('CategoryService.match', () => {
  let repo: CategoryRepository;
  let svc: CategoryService;

  beforeEach(() => {
    repo = {
      findByName: vi.fn(),
      create: vi.fn(),
      topN: vi.fn(),
      listActive: vi.fn(),
      bump: vi.fn(),
    } as unknown as CategoryRepository;
    svc = new CategoryService(repo);
  });

  it('returns matched category when input matches case-insensitively (intent=exact)', async () => {
    vi.mocked(repo.findByName).mockResolvedValue(fakeCat(7, 'Semillas', 3));
    const r = await svc.match(1, 'expense', 'semillas', 'exact');
    expect(r).toEqual<MatchResult>({ kind: 'matched', category: fakeCat(7, 'Semillas', 3) });
  });

  it('returns needs-confirmation when input has no match and intent=unknown', async () => {
    vi.mocked(repo.findByName).mockResolvedValue(null);
    vi.mocked(repo.topN).mockResolvedValue([fakeCat(1, 'Semillas'), fakeCat(2, 'Insumos')]);
    const r = await svc.match(1, 'expense', 'flete', 'unknown');
    expect(r.kind).toBe('needs-confirmation');
    if (r.kind === 'needs-confirmation') {
      expect(r.suggestions.map(c => c.name)).toEqual(['Semillas', 'Insumos']);
    }
  });

  it('creates a new category when intent=new and name is unique', async () => {
    vi.mocked(repo.findByName).mockResolvedValue(null);
    vi.mocked(repo.create).mockResolvedValue(fakeCat(99, 'Cosecha 2026'));
    const r = await svc.match(1, 'expense', 'Cosecha 2026', 'new');
    expect(r).toEqual<MatchResult>({ kind: 'matched', category: fakeCat(99, 'Cosecha 2026') });
  });

  it('treats intent=new but existing name as a match (does not create duplicate)', async () => {
    vi.mocked(repo.findByName).mockResolvedValue(fakeCat(7, 'Semillas', 3));
    const r = await svc.match(1, 'expense', 'semillas', 'new');
    expect(r).toEqual<MatchResult>({ kind: 'matched', category: fakeCat(7, 'Semillas', 3) });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('falls back to needs-confirmation when no category was provided at all', async () => {
    vi.mocked(repo.topN).mockResolvedValue([fakeCat(1, 'Semillas')]);
    const r = await svc.match(1, 'expense', null, 'unknown');
    expect(r.kind).toBe('needs-confirmation');
  });
});

describe('CategoryService.bootstrapDefaults', () => {
  let repo: CategoryRepository;
  let svc: CategoryService;

  beforeEach(() => {
    repo = {
      listActive: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation((u, k, name) => Promise.resolve(fakeCat(1, name))),
    } as unknown as CategoryRepository;
    svc = new CategoryService(repo);
  });

  it('seeds 9 expense defaults on first call when listActive is empty', async () => {
    await svc.bootstrapDefaults(1, 'expense');
    expect(repo.create).toHaveBeenCalledTimes(9);
    const inserted = vi.mocked(repo.create).mock.calls.map(([, , n]) => n);
    expect(inserted).toContain('Semillas');
    expect(inserted).toContain('Combustible');
    expect(inserted).toContain('Otros');
  });

  it('does nothing when the user already has categories', async () => {
    vi.mocked(repo.listActive).mockResolvedValue([fakeCat(1, 'Semillas')]);
    await svc.bootstrapDefaults(1, 'expense');
    expect(repo.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/financial/__tests__/category.service.test.ts`
Expected: FAIL — `CategoryService` module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import type { CategoryRepository, CategoryKind, UserCategory } from './category.repository.js';

export type MatchIntent = 'exact' | 'new' | 'unknown';

export type MatchResult =
  | { kind: 'matched'; category: UserCategory }
  | { kind: 'needs-confirmation'; suggestions: UserCategory[] };

const DEFAULT_EXPENSE_CATEGORIES = [
  'Semillas', 'Fertilizantes', 'Agroquímicos', 'Combustible',
  'Sueldos', 'Maquinaria', 'Servicios', 'Insumos', 'Otros',
];

const DEFAULT_INCOME_CATEGORIES = [
  'Venta de soja', 'Venta de maíz', 'Venta de trigo', 'Venta de girasol',
  'Venta de hacienda', 'Arrendamiento', 'Otros',
];

export const TOP_N_FOR_PROMPT = 8;
export const SUGGESTIONS_FOR_BUTTONS = 7; // leaves a slot for "+ Otra"

export class CategoryService {
  constructor(private readonly repo: CategoryRepository) {}

  /**
   * Match the user's raw category string against their catalog.
   * - intent='exact': caller is confident there's a match → look it up
   * - intent='new': caller wants to create → upsert (no duplicate)
   * - intent='unknown' or null name: return suggestions for confirmation
   */
  async match(userId: number, kind: CategoryKind, name: string | null, intent: MatchIntent): Promise<MatchResult> {
    const trimmed = (name ?? '').trim();
    if (trimmed) {
      const existing = await this.repo.findByName(userId, kind, trimmed);
      if (existing) {
        return { kind: 'matched', category: existing };
      }
      if (intent === 'new') {
        const created = await this.repo.create(userId, kind, trimmed);
        return { kind: 'matched', category: created };
      }
    }
    const suggestions = await this.repo.topN(userId, kind, SUGGESTIONS_FOR_BUTTONS);
    return { kind: 'needs-confirmation', suggestions };
  }

  /** Seed the user's catalog with sensible defaults if it is empty. */
  async bootstrapDefaults(userId: number, kind: CategoryKind): Promise<void> {
    const existing = await this.repo.listActive(userId, kind);
    if (existing.length > 0) return;
    const defaults = kind === 'expense' ? DEFAULT_EXPENSE_CATEGORIES : DEFAULT_INCOME_CATEGORIES;
    for (const name of defaults) {
      await this.repo.create(userId, kind, name);
    }
  }

  /** Mark a category as used: bump counter + timestamp. */
  async bump(categoryId: number): Promise<void> {
    await this.repo.bump(categoryId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/financial/__tests__/category.service.test.ts`
Expected: PASS — 7 tests passing.

- [ ] **Step 5: Run the full unit suite to confirm no regressions**

Run: `npm test`
Expected: previous total + 7. No failures.

- [ ] **Step 6: Commit**

```bash
git add src/domain/financial/category.service.ts src/domain/financial/__tests__/category.service.test.ts
git commit -m "feat(financial): CategoryService match/bootstrapDefaults/bump + unit tests"
```

---

## Phase 2 — Backend CRUD endpoints

### Task 4: `/categories` endpoints

**Files:**
- Modify: `src/routes/auth.routes.ts` — insert AFTER the `/analytics/livestock` block (around line 1900+)

- [ ] **Step 1: Add imports near the top of the file (after the existing `import { pool }` line)**

```typescript
import { CategoryRepository, type CategoryKind } from '../domain/financial/category.repository.js';
import { CategoryService } from '../domain/financial/category.service.js';
```

And add the service instance near the other `const xxxService = new ...` lines at the top:

```typescript
const categoryRepo = new CategoryRepository();
const categoryService = new CategoryService(categoryRepo);
```

- [ ] **Step 2: Add the CRUD block at the end of the file (just before the default export or last `export default router`)**

```typescript
// --- Categories ---

function parseKind(raw: unknown, res: Response): CategoryKind | null {
  if (raw === 'expense' || raw === 'income') return raw;
  res.status(400).json({ error: "kind query parameter must be 'expense' or 'income'" });
  return null;
}

router.get('/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.query.kind, res);
    if (!kind) return;
    const userId = req.auth!.userId;
    await categoryService.bootstrapDefaults(userId, kind);
    const list = await categoryRepo.listActive(userId, kind);
    res.json({
      categories: list.map(c => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        usageCount: c.usageCount,
        lastUsedAt: c.lastUsedAt,
      })),
    });
  } catch (err) { handleError(err, res); }
});

router.post('/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.body?.kind, res);
    if (!kind) return;
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 60) {
      res.status(400).json({ error: 'name is required and must be ≤ 60 chars' });
      return;
    }
    const userId = req.auth!.userId;
    const existing = await categoryRepo.findByName(userId, kind, name);
    if (existing) {
      res.status(409).json({ error: 'Ya existe una categoría con ese nombre', category: existing });
      return;
    }
    const created = await categoryRepo.create(userId, kind, name);
    res.status(201).json({ category: created });
  } catch (err) { handleError(err, res); }
});

router.patch('/categories/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 60) {
      res.status(400).json({ error: 'name is required and must be ≤ 60 chars' });
      return;
    }
    const userId = req.auth!.userId;
    const renamed = await categoryRepo.rename(userId, id, name);
    if (!renamed) { res.status(404).json({ error: 'category not found' }); return; }
    res.json({ category: renamed });
  } catch (err: any) {
    if (err?.code === '23505') { // unique violation
      res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
      return;
    }
    handleError(err, res);
  }
});

router.delete('/categories/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    const userId = req.auth!.userId;
    const cat = await categoryRepo.findById(userId, id);
    if (!cat) { res.status(404).json({ error: 'category not found' }); return; }

    const reassignToRaw = req.query.reassignTo;
    if (reassignToRaw) {
      const targetId = parseInt(String(reassignToRaw), 10);
      if (isNaN(targetId)) { res.status(400).json({ error: 'invalid reassignTo' }); return; }
      const target = await categoryRepo.findById(userId, targetId);
      if (!target || target.kind !== cat.kind) {
        res.status(400).json({ error: 'reassignTo must point to an existing category of the same kind' });
        return;
      }
      await categoryRepo.reassign(userId, cat.kind, cat.name, target.name);
    }
    await categoryRepo.softDelete(userId, id);
    res.json({ ok: true });
  } catch (err) { handleError(err, res); }
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: no new errors from your additions.

- [ ] **Step 4: Smoke test with curl**

```bash
docker compose up -d --build && sleep 8
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"testin@gmail.com","password":"tester123"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tokens']['accessToken'])")

# GET should return bootstrapped defaults
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/auth/categories?kind=expense" | python3 -m json.tool | head -25

# CREATE
NEW_ID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"expense","name":"Cosecha 2026"}' \
  http://localhost:3000/api/auth/categories | python3 -c "import sys,json; print(json.load(sys.stdin)['category']['id'])")
echo "Created id=$NEW_ID"

# DUPLICATE create should 409
curl -s -o /dev/null -w "duplicate status: %{http_code}\n" -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"expense","name":"cosecha 2026"}' \
  http://localhost:3000/api/auth/categories

# RENAME
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Cosecha gruesa 2026"}' \
  http://localhost:3000/api/auth/categories/$NEW_ID | python3 -m json.tool

# DELETE
curl -s -o /dev/null -w "delete status: %{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/auth/categories/$NEW_ID
```
Expected: GET returns 9 categories, CREATE returns 201, duplicate returns 409, PATCH returns 200, DELETE returns 200.

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.routes.ts
git commit -m "feat(api): /categories CRUD endpoints (list/create/rename/delete with reassign)"
```

---

## Phase 3 — AI tool + agent prompt

### Task 5: Tool definitions — `category_match` + relax enum

**Files:**
- Modify: `src/ai/tool-definitions.ts:23-43` and `:44-63`

- [ ] **Step 1: Update `log_expense`**

Replace lines 22-43 with:

```typescript
  {
    name: 'log_expense',
    description: 'Registrar gasto agrícola. Verbos: gasté, pagué, compré + monto.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Monto. lucas=miles, palos=millones, mil=x1000.' },
        category: { type: 'string', description: 'Categoría del gasto. Debería corresponder a una de las categorías existentes del usuario (te las pasamos en el contexto). Si no encontrás match exacto, OMITÍ este parámetro y el sistema le va a preguntar al usuario.' },
        category_match: {
          type: 'string',
          enum: ['exact', 'new'],
          description: "Decisión sobre la categoría: 'exact' si el texto del usuario coincide LITERALMENTE (case-insensitive) con una categoría del listado del usuario. 'new' SOLO si el usuario pidió explícitamente crear una nueva categoría con un nombre dado (ej. 'creá la categoría X'). Si ninguna de las dos aplica, OMITÍ este parámetro y también omití 'category' — el sistema le va a preguntar al usuario.",
        },
        description: { type: 'string', description: 'Descripción breve del gasto.' },
        currency: { type: 'string', enum: ['ARS', 'USD'], description: 'Moneda. Default ARS. "dólares/USD"→USD.' },
        expense_type: { type: 'string', enum: ['insumo', 'varios'], description: 'insumo=producto almacenable (Roundup,urea,semilla). varios=servicio/labranza (siembra directa,pulverización). Default: inferir de categoría.' },
        product: { type: 'string', description: 'Nombre del producto/insumo (Roundup, Urea, Gasoil). Solo si expense_type=insumo.' },
        quantity: QUANTITY_PROP,
        unit: UNIT_PROP,
        unit_price: { type: 'number', description: 'Precio por unidad. Usar cuando el usuario dice "a X c/u", "a X el kg/bolsa/lt". Ej: "50 bolsas de urea a 8000 c/u" → quantity=50, unit_price=8000, amount=400000.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: ['amount', 'description'],
    },
  },
```

- [ ] **Step 2: Update `log_income` analogously (lines 44-63)**

Replace:

```typescript
  {
    name: 'log_income',
    description: 'Registrar ingreso. Verbos: vendí, cobré + monto.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Monto total.' },
        category: { type: 'string', description: 'Categoría del ingreso. Debería corresponder a una de las categorías existentes del usuario (te las pasamos en el contexto). Si no encontrás match exacto, OMITÍ este parámetro y el sistema le va a preguntar al usuario.' },
        category_match: {
          type: 'string',
          enum: ['exact', 'new'],
          description: "Decisión sobre la categoría del ingreso: 'exact' si el texto coincide LITERALMENTE con una existente. 'new' SOLO si el usuario pidió crear una nueva con un nombre dado. Si no, OMITÍ este parámetro y omití 'category' — el sistema le pregunta al usuario.",
        },
        description: { type: 'string', description: 'Descripción breve del ingreso.' },
        currency: { type: 'string', enum: ['ARS', 'USD'], description: 'Moneda. Default ARS.' },
        quantity: { type: 'number', description: 'Cantidad vendida (ej: 30 tn).' },
        unit: UNIT_PROP,
        unit_price: { type: 'number', description: 'Precio por unidad.' },
        field: FIELD_PROP,
        plot: PLOT_PROP,
        event_date: DATE_PROP,
      },
      required: ['amount', 'description'],
    },
  },
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: PASS. (The enum constraint was the only TS dependency on EXPENSE_CATEGORIES from this file — keep the import alone since it's still used downstream.)

- [ ] **Step 4: Run unit tests**

Run: `npm test`
Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/ai/tool-definitions.ts
git commit -m "feat(ai): relax category enum + add category_match decision parameter"
```

---

### Task 6: User context — top 8 categories per kind

**Files:**
- Modify: `src/ai/user-context.service.ts`

- [ ] **Step 1: Find the place where the user's fields/plots get loaded**

Run: `grep -n "fields\\|plots\\|getUserContext" src/ai/user-context.service.ts | head -20`. Identify the method (most likely `getUserContext(userId)` or similar) that already loads fields, plots, and other context. Read it once.

- [ ] **Step 2: Add a categories fetch in the same method**

Inside `getUserContext` (or whatever the entry method is), alongside the existing field/plot fetches, add:

```typescript
import { CategoryRepository } from '../domain/financial/category.repository.js';
import { CategoryService, TOP_N_FOR_PROMPT } from '../domain/financial/category.service.js';
```

And add inside the loading block:

```typescript
const _categoryRepo = new CategoryRepository();
const _categoryService = new CategoryService(_categoryRepo);
// Bootstrap on demand so new users always have a catalog ready.
await Promise.all([
  _categoryService.bootstrapDefaults(userId, 'expense'),
  _categoryService.bootstrapDefaults(userId, 'income'),
]);
const [expenseCategories, incomeCategories] = await Promise.all([
  _categoryRepo.topN(userId, 'expense', TOP_N_FOR_PROMPT),
  _categoryRepo.topN(userId, 'income', TOP_N_FOR_PROMPT),
]);
```

And extend the returned context shape so callers (the prompt builder) can read it:

```typescript
// inside the return:
return {
  // ...existing fields,
  expenseCategories: expenseCategories.map(c => c.name),
  incomeCategories: incomeCategories.map(c => c.name),
};
```

- [ ] **Step 3: Update the context type**

Find the TypeScript interface for the context (usually in the same file or `src/types/index.ts`). Add:

```typescript
expenseCategories: string[];
incomeCategories: string[];
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/user-context.service.ts src/types/index.ts
git commit -m "feat(ai): include top-8 user categories (expense/income) in agent context"
```

---

### Task 7: Agent prompt — emit "Categorías" section

**Files:**
- Modify: `src/ai/agent-prompt-builder.ts`

- [ ] **Step 1: Find where the user-message prefix is built**

Run: `grep -n "buildUserMessagePrefix\\|Cultivos\\|Categor" src/ai/agent-prompt-builder.ts`. There should be a function like `buildUserMessagePrefix(ctx)` that serializes the user context. Locate it.

- [ ] **Step 2: Add a Categorías block right after the existing context lines (fields/plots/crops)**

```typescript
if (ctx.expenseCategories?.length || ctx.incomeCategories?.length) {
  lines.push('Categorías:');
  if (ctx.expenseCategories?.length) {
    lines.push(`- Gastos: ${ctx.expenseCategories.join(', ')}`);
  }
  if (ctx.incomeCategories?.length) {
    lines.push(`- Ingresos: ${ctx.incomeCategories.join(', ')}`);
  }
}
```

(Use the same array/lines pattern that the existing builder uses — don't introduce a different style.)

- [ ] **Step 3: Add a disambiguation rule in `coreRules()` or its equivalent**

Find the rules section that already describes other disambiguations. Add a new rule block:

```
### Categorías de Gastos / Ingresos

- En cada `log_expense`/`log_income`, mirá las categorías del usuario (te las pasamos en el contexto).
- Si el texto del usuario coincide LITERALMENTE (case-insensitive) con una categoría existente → pasá `category` con esa cadena y `category_match='exact'`.
- Si el usuario pidió EXPLÍCITAMENTE crear una nueva (ej. "creá una categoría X y meté ahí...") → `category='X'` + `category_match='new'`.
- Si no hay match exacto Y el usuario no pidió crear → OMITÍ `category` y `category_match`. El sistema le va a preguntar.
- NUNCA inventes categorías propias. "venta de soja" no equivale a "Soja" a menos que "Soja" esté literalmente en el listado.
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/agent-prompt-builder.ts
git commit -m "feat(ai): emit Categorías block + agent rule for category_match"
```

---

## Phase 4 — Handler integration

### Task 8: `log_expense` and `log_income` use the service

**Files:**
- Modify: `src/domain/financial/financial.handler.ts` (around lines 580-700 for expense, search for income equivalent)

- [ ] **Step 1: Import + add a service instance at the top of the file**

```typescript
import { CategoryRepository } from './category.repository.js';
import { CategoryService } from './category.service.js';
```

And, inside the class (likely `FinancialHandler`), as a field:

```typescript
private readonly categoryService = new CategoryService(new CategoryRepository());
```

- [ ] **Step 2: In the expense path, BEFORE `this.service.saveExpense(...)`, resolve the category**

Find the spot at `financial.handler.ts:633`. Just before that line, insert:

```typescript
const rawCategory = (cmd.category as string | undefined) ?? data.category ?? null;
const intent = (cmd.category_match as 'exact' | 'new' | undefined) ?? 'unknown';
const matchRes = await this.categoryService.match(userId, 'expense', rawCategory, intent);

if (matchRes.kind === 'needs-confirmation') {
  // Defer save: store the pending expense in conversation_state with category=null.
  const payload = encodePendingExpensePayload({ data, fieldId, plotId });
  const buttons = matchRes.suggestions.map(c => ({ id: `cat_pick_exp_${payload}_${c.id}`, title: c.name }));
  buttons.push({ id: `cat_new_exp_${payload}`, title: '+ Otra' });
  return {
    messages: [],
    interactive: {
      type: 'buttons' as const,
      body: `¿En qué categoría va este gasto de $${Number(data.amount).toLocaleString('es-AR')}?`,
      buttons,
    },
  };
}

// matched → snap to canonical name + remember the id so we can bump it after save
data.category = matchRes.category.name;
const matchedCategoryId = matchRes.category.id;
```

After `const saved = await this.service.saveExpense(userId, data, fieldId, plotId);` add:

```typescript
this.categoryService.bump(matchedCategoryId).catch(() => {});
```

- [ ] **Step 3: Add the helper `encodePendingExpensePayload`** (top of the file)

```typescript
function encodePendingExpensePayload(p: { data: any; fieldId: number | null; plotId: number | null }): string {
  // base64url of compact JSON so we can stuff it into a callback id and round-trip.
  const json = JSON.stringify({
    a: p.data.amount,
    c: p.data.currency,
    d: p.data.description,
    f: p.fieldId,
    p: p.plotId,
    ed: p.data.expenseDate ?? null,
    et: p.data.expenseType ?? null,
    pr: p.data.product ?? null,
    q: p.data.quantity ?? null,
    u: p.data.unit ?? null,
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodePendingExpensePayload(b64: string): { data: any; fieldId: number | null; plotId: number | null } {
  const o = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  return {
    fieldId: o.f, plotId: o.p,
    data: {
      amount: o.a, currency: o.c, description: o.d,
      expenseDate: o.ed, expenseType: o.et, product: o.pr,
      quantity: o.q, unit: o.u,
    },
  };
}
```

(And the analogous `encodePendingIncomePayload` / `decodePendingIncomePayload` — narrower shape with just `a/c/d/f/p/q/u/up`.)

- [ ] **Step 4: Mirror Step 2 inside the income path**

Find the equivalent `this.service.saveIncome(...)` call and add the same match → confirmation → bump pattern with `kind='income'` and the `cat_pick_inc_*` / `cat_new_inc_*` callback ids.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/financial/financial.handler.ts
git commit -m "feat(financial): expense/income handlers route through CategoryService"
```

---

### Task 9: Button callbacks for `cat_pick_*` and `cat_new_*`

**Files:**
- Modify: `src/domain/financial/financial.handler.ts` — add 2 new handler methods
- Modify: `src/domain/router.ts` — register the new commands

- [ ] **Step 1: Add the two handlers inside `FinancialHandler`**

```typescript
async pickCategory(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  // cmd.kind: 'expense' | 'income'
  // cmd.payload: base64url-encoded pending data
  // cmd.categoryId: number
  const kind = cmd.kind as 'expense' | 'income';
  const categoryId = Number(cmd.categoryId);
  const category = await new CategoryRepository().findById(userId, categoryId);
  if (!category || category.kind !== kind) {
    return { messages: ['No encontré esa categoría. Probá registrar el gasto/ingreso de nuevo.'] };
  }

  if (kind === 'expense') {
    const { data, fieldId, plotId } = decodePendingExpensePayload(cmd.payload as string);
    data.category = category.name;
    const saved = await this.service.saveExpense(userId, data, fieldId, plotId);
    this.categoryService.bump(category.id).catch(() => {});
    void saved;
    const resFieldName = fieldId ? await this.lookupFieldName(userId, fieldId) : null;
    const resPlotName = plotId ? await this.lookupPlotName(userId, plotId) : null;
    return { messages: [await buildExpenseConfirmation(data, resFieldName, resPlotName)] };
  } else {
    const { data, fieldId, plotId } = decodePendingIncomePayload(cmd.payload as string);
    data.category = category.name;
    await this.service.saveIncome(userId, data, fieldId, plotId);
    this.categoryService.bump(category.id).catch(() => {});
    const resFieldName = fieldId ? await this.lookupFieldName(userId, fieldId) : null;
    const resPlotName = plotId ? await this.lookupPlotName(userId, plotId) : null;
    return { messages: [await buildIncomeConfirmation(data, resFieldName, resPlotName)] };
  }
}

async createCategoryInline(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  // cmd.kind, cmd.payload — same encoding. The flow stores the payload and prompts the user
  // for the new category name. Implemented in a 1-turn flow:
  const kind = cmd.kind as 'expense' | 'income';
  await updateConversationState(userId, {
    flow_state: 'awaiting_new_category_name',
    flow_data: { kind, payload: cmd.payload },
  } as any);
  return {
    messages: [`¿Cómo se llama la nueva categoría de ${kind === 'expense' ? 'gasto' : 'ingreso'}?`],
  };
}

// And the resumption (called by the flow engine when state=awaiting_new_category_name):
async resumeCreateCategory(userId: UserId, name: string, flowData: { kind: 'expense'|'income'; payload: string }): Promise<HandlerResponse> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) {
    return { messages: ['El nombre tiene que tener entre 1 y 60 caracteres. Probá de nuevo:'] };
  }
  const cat = await this.categoryService.match(userId, flowData.kind, trimmed, 'new');
  if (cat.kind !== 'matched') {
    return { messages: ['No pude crear la categoría. Probá de nuevo o cancelá.'] };
  }
  if (flowData.kind === 'expense') {
    const { data, fieldId, plotId } = decodePendingExpensePayload(flowData.payload);
    data.category = cat.category.name;
    await this.service.saveExpense(userId, data, fieldId, plotId);
    this.categoryService.bump(cat.category.id).catch(() => {});
    return { messages: [`✅ Categoría '${cat.category.name}' creada.\n${await buildExpenseConfirmation(data, null)}`] };
  } else {
    const { data, fieldId, plotId } = decodePendingIncomePayload(flowData.payload);
    data.category = cat.category.name;
    await this.service.saveIncome(userId, data, fieldId, plotId);
    this.categoryService.bump(cat.category.id).catch(() => {});
    return { messages: [`✅ Categoría '${cat.category.name}' creada.\n${await buildIncomeConfirmation(data, null)}`] };
  }
}

private async lookupFieldName(userId: UserId, fieldId: number): Promise<string | null> {
  const { rows } = await pool.query('SELECT name FROM fields WHERE id = $1 AND user_id = $2', [fieldId, userId]);
  return rows[0]?.name ?? null;
}

private async lookupPlotName(userId: UserId, plotId: number): Promise<string | null> {
  const { rows } = await pool.query(`SELECT p.name FROM plots p JOIN fields f ON f.id = p.field_id WHERE p.id = $1 AND f.user_id = $2`, [plotId, userId]);
  return rows[0]?.name ?? null;
}
```

(`pool` should already be imported elsewhere in the file. If not, add `import { pool } from '../../config/db.js';`.)

- [ ] **Step 2: Map button callback IDs to commands**

In the interactive router (search: `grep -rn "cat_pick\\|interactive callback\\|handleInteractive" src/`), there's a place where button `id` strings get parsed into commands. Add:

```typescript
if (id.startsWith('cat_pick_exp_')) {
  // id = `cat_pick_exp_${payload}_${categoryId}`
  const rest = id.slice('cat_pick_exp_'.length);
  const lastUnderscore = rest.lastIndexOf('_');
  return { type: 'pick_category', kind: 'expense', payload: rest.slice(0, lastUnderscore), categoryId: rest.slice(lastUnderscore + 1) };
}
if (id.startsWith('cat_pick_inc_')) {
  const rest = id.slice('cat_pick_inc_'.length);
  const lastUnderscore = rest.lastIndexOf('_');
  return { type: 'pick_category', kind: 'income', payload: rest.slice(0, lastUnderscore), categoryId: rest.slice(lastUnderscore + 1) };
}
if (id.startsWith('cat_new_exp_')) {
  return { type: 'create_category', kind: 'expense', payload: id.slice('cat_new_exp_'.length) };
}
if (id.startsWith('cat_new_inc_')) {
  return { type: 'create_category', kind: 'income', payload: id.slice('cat_new_inc_'.length) };
}
```

- [ ] **Step 3: Register `pick_category` and `create_category` in router**

In `src/domain/router.ts`, find the `FINANCIAL_COMMANDS` set (or equivalent) and add:

```typescript
const FINANCIAL_COMMANDS = new Set([
  // ... existing entries
  'pick_category',
  'create_category',
]);
```

And in the dispatch switch inside the financial branch:

```typescript
case 'pick_category': return financialHandler.pickCategory(cmd, userId);
case 'create_category': return financialHandler.createCategoryInline(cmd, userId);
```

- [ ] **Step 4: Hook the resumption in `conversation-engine.ts`**

Find the place that handles flow_state resumption (search: `awaiting_new_category_name`). Since this is a new state, we add it:

```typescript
if (state.flow_state === 'awaiting_new_category_name') {
  const flowData = state.flow_data as { kind: 'expense'|'income'; payload: string };
  await clearFlow(userId);
  return financialHandler.resumeCreateCategory(userId, message.text, flowData);
}
```

- [ ] **Step 5: Typecheck + tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/domain/financial/financial.handler.ts src/domain/router.ts src/middleware/conversation-engine.ts
git commit -m "feat(financial): handle cat_pick_* / cat_new_* callbacks + inline category create flow"
```

---

## Phase 5 — Backfill existing data

### Task 10: Migration — backfill from existing expenses/incomes

**Files:**
- Create: `src/migrations/091_user_categories_backfill.sql`

- [ ] **Step 1: Write the backfill**

```sql
-- One-shot backfill: convert each user's free-text categories on expenses + incomes
-- into rows in user_categories. INITCAP normalizes casing; the ON CONFLICT keeps
-- the migration idempotent (safe to re-run after the initial deploy).

INSERT INTO user_categories (user_id, kind, name, usage_count, last_used_at, created_at)
SELECT
  e.user_id,
  'expense' AS kind,
  INITCAP(TRIM(e.category)) AS name,
  COUNT(*) AS usage_count,
  MAX(e.created_at) AS last_used_at,
  MIN(e.created_at) AS created_at
FROM expenses e
WHERE e.category IS NOT NULL
  AND TRIM(e.category) <> ''
  AND e.deleted_at IS NULL
GROUP BY e.user_id, INITCAP(TRIM(e.category))
ON CONFLICT DO NOTHING;

INSERT INTO user_categories (user_id, kind, name, usage_count, last_used_at, created_at)
SELECT
  i.user_id,
  'income' AS kind,
  INITCAP(TRIM(i.category)) AS name,
  COUNT(*) AS usage_count,
  MAX(i.created_at) AS last_used_at,
  MIN(i.created_at) AS created_at
FROM incomes i
WHERE i.category IS NOT NULL
  AND TRIM(i.category) <> ''
  AND i.deleted_at IS NULL
GROUP BY i.user_id, INITCAP(TRIM(i.category))
ON CONFLICT DO NOTHING;
```

- [ ] **Step 2: Run it against local Docker + spot-check**

```bash
docker compose exec -T db psql -U campo -d campo_bot -f /dev/stdin < src/migrations/091_user_categories_backfill.sql
docker compose exec -T db psql -U campo -d campo_bot -c "
  SELECT u.email, c.kind, COUNT(*) AS n_categories, SUM(c.usage_count) AS total_uses
  FROM user_categories c JOIN users u ON u.id = c.user_id
  GROUP BY u.email, c.kind ORDER BY u.email, c.kind;
"
```
Expected: existing users have rows in `user_categories` covering their current categories, usage_count matches what they had.

- [ ] **Step 3: Commit**

```bash
git add src/migrations/091_user_categories_backfill.sql
git commit -m "feat(db): backfill user_categories from existing expenses/incomes (idempotent)"
```

---

## Phase 6 — Frontend dashboard tab

### Task 11: `useCategories` hook

**Files:**
- Create: `frontend/src/hooks/useCategories.ts`

- [ ] **Step 1: Write the hook**

```typescript
import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api/client';

export type CategoryKind = 'expense' | 'income';

export interface Category {
  id: number;
  kind: CategoryKind;
  name: string;
  usageCount: number;
  lastUsedAt: string | null;
}

interface ListResponse { categories: Category[]; }

export function useCategories(kind: CategoryKind) {
  const [data, setData] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiRequest<ListResponse>(`/categories?kind=${kind}`);
      setData(r.categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar categorías');
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (name: string) => {
    await apiRequest('/categories', { method: 'POST', body: { kind, name } });
    await refresh();
  }, [kind, refresh]);

  const rename = useCallback(async (id: number, name: string) => {
    await apiRequest(`/categories/${id}`, { method: 'PATCH', body: { name } });
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: number, reassignTo?: number) => {
    const qs = reassignTo ? `?reassignTo=${reassignTo}` : '';
    await apiRequest(`/categories/${id}${qs}`, { method: 'DELETE' });
    await refresh();
  }, [refresh]);

  return { data, loading, error, refresh, create, rename, remove };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useCategories.ts
git commit -m "feat(frontend): useCategories hook"
```

---

### Task 12: `CategoriesTab` UI

**Files:**
- Create: `frontend/src/components/CategoriesTab.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useCategories, type CategoryKind } from '../hooks/useCategories';

const KIND_LABELS: Record<CategoryKind, string> = { expense: 'Gastos', income: 'Ingresos' };

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-AR');
}

function CategoriesTable({ kind }: { kind: CategoryKind }) {
  const { data, loading, error, create, rename, remove } = useCategories(kind);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  if (loading) return <p className="text-sm text-gray-500 dark:text-gray-300 p-4">Cargando…</p>;
  if (error) return <p className="text-sm text-red-700 dark:text-red-300 p-4">{error}</p>;

  const onCreate = async () => {
    try { await create(newName); setNewName(''); setShowCreate(false); setFeedback(null); }
    catch (e) { setFeedback(e instanceof Error ? e.message : 'Error'); }
  };

  const onRename = async (id: number) => {
    try { await rename(id, editingName); setEditingId(null); setFeedback(null); }
    catch (e) { setFeedback(e instanceof Error ? e.message : 'Error'); }
  };

  const onDelete = async (id: number, usageInTx: number) => {
    if (usageInTx > 0) {
      const confirmed = window.confirm(`Esta categoría se usó en ${usageInTx} movimientos. ¿Eliminar igual? Los registros existentes conservan el nombre.`);
      if (!confirmed) return;
    }
    try { await remove(id); }
    catch (e) { setFeedback(e instanceof Error ? e.message : 'Error'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{KIND_LABELS[kind]}</h3>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 text-xs text-white bg-campo-600 hover:bg-campo-700 rounded-md px-3 py-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Nueva categoría
        </button>
      </div>

      {feedback && <p className="text-xs text-red-700 dark:text-red-300">{feedback}</p>}

      {showCreate && (
        <div className="flex gap-2 items-center bg-gray-50 dark:bg-gray-900 p-3 rounded-md">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Nombre de la categoría"
            className="flex-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5"
            autoFocus
          />
          <button onClick={onCreate} disabled={!newName.trim()} className="text-xs bg-campo-600 text-white rounded-md px-3 py-1.5 disabled:opacity-50">Crear</button>
          <button onClick={() => { setShowCreate(false); setNewName(''); }} className="text-xs text-gray-600 dark:text-gray-300">Cancelar</button>
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500 dark:text-gray-300 text-left border-b border-gray-200 dark:border-gray-700">
          <tr>
            <th className="py-2">Categoría</th>
            <th className="py-2 text-right">Usos</th>
            <th className="py-2">Último uso</th>
            <th className="py-2 text-right">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {data.map(c => (
            <tr key={c.id} className="border-b border-gray-100 dark:border-gray-800">
              <td className="py-2">
                {editingId === c.id ? (
                  <input
                    value={editingName}
                    onChange={e => setEditingName(e.target.value)}
                    className="text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1"
                    autoFocus
                  />
                ) : (
                  <span className="text-gray-800 dark:text-gray-100">{c.name}</span>
                )}
              </td>
              <td className="py-2 text-right text-gray-600 dark:text-gray-300">{c.usageCount}</td>
              <td className="py-2 text-gray-500 dark:text-gray-300">{fmtDate(c.lastUsedAt)}</td>
              <td className="py-2 text-right">
                {editingId === c.id ? (
                  <>
                    <button onClick={() => onRename(c.id)} className="text-xs text-campo-700 dark:text-campo-400 mr-2">Guardar</button>
                    <button onClick={() => setEditingId(null)} className="text-xs text-gray-500 dark:text-gray-300">Cancelar</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { setEditingId(c.id); setEditingName(c.name); }} className="text-gray-500 hover:text-gray-700 dark:text-gray-300 dark:hover:text-white mr-3" title="Renombrar">
                      <Pencil className="w-4 h-4 inline" />
                    </button>
                    <button onClick={() => onDelete(c.id, c.usageCount)} className="text-gray-500 hover:text-red-600 dark:text-gray-300 dark:hover:text-red-400" title="Eliminar">
                      <Trash2 className="w-4 h-4 inline" />
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {data.length === 0 && (
            <tr><td colSpan={4} className="py-6 text-center text-gray-400 dark:text-gray-300">Sin categorías</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function CategoriesTab() {
  const [kind, setKind] = useState<CategoryKind>('expense');
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 space-y-4">
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {(['expense', 'income'] as const).map(k => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`px-3 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
              kind === k
                ? 'border-campo-600 text-campo-700 dark:text-campo-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-300 dark:hover:text-white'
            }`}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <CategoriesTable kind={kind} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/CategoriesTab.tsx
git commit -m "feat(frontend): CategoriesTab — list/create/rename/delete per kind"
```

---

### Task 13: Wire `CategoriesTab` into the Dashboard + nav

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`
- Modify: `frontend/src/components/layout/Sidebar.tsx`
- Modify: `frontend/src/components/layout/BottomNav.tsx`

- [ ] **Step 1: Add `'categories'` to `DashboardView`** (in `Sidebar.tsx`)

Find the union type and add `'categories'`:

```typescript
export type DashboardView = 'overview' | 'expenses' | 'incomes' | 'activities' | 'observations' | 'scoutings' | 'reports' | 'harvests' | 'stock' | 'livestock' | 'documents' | 'account' | 'categories';
```

- [ ] **Step 2: Add the menu entry in `Sidebar.tsx`**

In the sidebar's items array (search for `'documents'` to find the right place), add an entry — probably right after `documents`:

```tsx
{ view: 'categories', label: 'Categorías', icon: Tag, requires: null },
```

(Import `Tag` from `lucide-react` if not already.)

- [ ] **Step 3: Same in `BottomNav.tsx`** (parallel additions for mobile nav).

- [ ] **Step 4: Wire the renderer in `Dashboard.tsx`**

Add the import near the other table imports:

```typescript
import CategoriesTab from '../components/CategoriesTab';
```

Add the case in `renderContent()`:

```tsx
case 'categories':
  return <CategoriesTab />;
```

Update the `viewFeatureMap`:

```typescript
const viewFeatureMap: Record<DashboardView, string | null> = {
  // ... existing
  categories: null, // available to all plans
};
```

- [ ] **Step 5: Typecheck + production build**

```bash
cd frontend && npx tsc -b && npm run build
```
Expected: PASS, `dist/` produced.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Dashboard.tsx frontend/src/components/layout/Sidebar.tsx frontend/src/components/layout/BottomNav.tsx
git commit -m "feat(frontend): wire CategoriesTab into Dashboard + Sidebar + BottomNav"
```

---

## Phase 7 — Verify

### Task 14: Eval scenario + final smoke

**Files:**
- Create: `src/testing/scenarios/19-category-ambiguous.json`

- [ ] **Step 1: Write the scenario**

```json
{
  "name": "category ambiguous prompts buttons + new category inline",
  "setup": ["seed_fields"],
  "steps": [
    {
      "send": "gasté 200k en gasoil hoy",
      "assert": {
        "interactiveType": "buttons",
        "responseContains": ["categoría", "200"]
      }
    },
    {
      "tap": "cat_pick_exp_<auto>_<Combustible>",
      "assert": {
        "responseContains": ["Gasto guardado", "Combustible"],
        "dbHasExpense": { "amount": 200000, "category": "Combustible" }
      }
    },
    {
      "send": "compré flete por 80k",
      "assert": { "interactiveType": "buttons" }
    },
    {
      "tap": "cat_new_exp_<auto>",
      "assert": { "responseContains": ["¿Cómo se llama"] }
    },
    {
      "send": "Flete",
      "assert": {
        "responseContains": ["Categoría 'Flete' creada", "80"],
        "dbHasExpense": { "amount": 80000, "category": "Flete" },
        "dbHasCategory": { "kind": "expense", "name": "Flete" }
      }
    }
  ]
}
```

(The `<auto>` placeholders represent dynamic values; the test runner will need to resolve them — adjust the runner if necessary, or split into two scenarios that don't require dynamic callback ids.)

- [ ] **Step 2: Add `dbHasCategory` assertion in `src/testing/assertions.ts`**

```typescript
export async function dbHasCategory(query: { kind: string; name: string }, ctx: TestContext): Promise<boolean> {
  const r = await ctx.queryDb<{ n: number }>(`
    SELECT COUNT(*)::int AS n FROM user_categories
    WHERE user_id = ${ctx.userId} AND kind = $1 AND lower(name) = lower($2) AND deleted_at IS NULL
  `, [query.kind, query.name]);
  return (r[0]?.n ?? 0) > 0;
}
```

And wire it into the dispatch in `assertions.ts` (find the existing `dbHasExpense` switch).

- [ ] **Step 3: Run eval**

```bash
docker compose up -d --build && sleep 8
npm run eval -- --scenario 19-category-ambiguous
```
Expected: PASS.

- [ ] **Step 4: Full smoke**

```bash
# Backend tests
npm test
# Frontend prod build
cd frontend && npx tsc -b && npm run build
# Quick curl: ensure /categories endpoint still works
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"testin@gmail.com","password":"tester123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['tokens']['accessToken'])")
curl -s -H "Authorization: Bearer $TOKEN" 'http://localhost:3000/api/auth/categories?kind=expense' | python3 -m json.tool | head -10
```
Expected: all green, no regressions.

- [ ] **Step 5: Commit + push (only if everything passes)**

```bash
git add src/testing/scenarios/19-category-ambiguous.json src/testing/assertions.ts
git commit -m "test(eval): scenario 19 — category ambiguous + inline new category"
```

---

## Self-Review

Walked the spec section-by-section:

1. **Spec: per-user table** → Task 1 ✓
2. **Spec: bootstrap defaults** → Task 3 (service has `bootstrapDefaults`) + Task 6 (called from user-context-service on every load) ✓
3. **Spec: agent prompt change** → Task 7 ✓
4. **Spec: tool schema changes (`category_match`)** → Task 5 ✓
5. **Spec: handler with match→confirm→bump** → Task 8 ✓
6. **Spec: button callbacks (`cat_pick_*` / `cat_new_*`)** → Task 9 ✓
7. **Spec: dashboard tab** → Tasks 11 + 12 + 13 ✓
8. **Spec: CRUD endpoints** → Task 4 ✓
9. **Spec: migration of existing data** → Task 10 ✓
10. **Spec: eval scenario** → Task 14 ✓
11. **Spec: same-kind reassign on delete** → Task 4 endpoint handles it; UI uses `window.confirm` shortcut (no "reassign to" picker — flagged below as a follow-up)

**Placeholder scan:** no TBD/TODO/"add error handling" present. The `<auto>` placeholders in Task 14's scenario are intentional and called out.

**Type consistency:** `CategoryKind`, `UserCategory`, `MatchIntent`, `MatchResult` all defined once and reused. `categoryService.match()` signature is consistent across handler, service tests, and prompt.

**Known follow-up (NOT in this plan):**
- The CategoriesTab delete UX currently uses `window.confirm()` for the "in use" case. A proper "reassign to X" picker modal is a nice-to-have but adds ~80 LOC. The backend already supports `reassignTo`; the UI just doesn't surface it yet.
