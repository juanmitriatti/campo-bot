# Category Management — Gastos / Ingresos

**Status:** Design draft · awaiting user sign-off before plan
**Owner:** Juan Pablo Mitriatti
**Date:** 2026-05-19

## Goal

Curated, learnable category catalog **per user** for expenses and incomes. Bot suggests from the user's existing categories on every log; user can create a new one inline; categories that go unused can be deleted; a dashboard tab lets the user manage them.

No regex pipeline involved — all matching happens against the catalog by exact (case-insensitive) string equality. Smart-but-bounded.

## Scope

### In scope
- DB table `user_categories` (per user, per kind)
- Bootstrap default categories on first usage
- Bot flow: exact-match auto-assign + ask-user-on-ambiguity (buttons + "+ Otra" option)
- Tool `log_expense` / `log_income` gain a `category_match` parameter
- Migration: deduplicate + normalize existing free-text categories per user
- Dashboard tab "Categorías" with rename + delete + manual create

### Out of scope (now)
- Embedding-based fuzzy matching ("Sementes" ≈ "Semillas")
- Cross-user / global category catalog
- Hierarchical (parent → child) categories
- Auto-categorization without asking (the user explicitly opted out — see Decision #3)

## Decisions (confirmed with user)

1. **Set propio por kind**: `expense` and `income` have separate catalogs. "Soja" as an income category is independent from "Soja" as an expense category (in practice the former is much more common).
2. **Delete allowed**: the user can soft-delete any category that has zero non-deleted expenses/incomes pointing to it. If it's in use, the UI offers to either (a) keep it as historical-only (default), or (b) reassign current rows to another category (advanced).
3. **No asumas — siempre preguntá** unless the user's input matches an existing category exactly (case-insensitive). "Venta de soja" could belong to "Venta", "Soja", "Cosecha 2026", or something else — the bot must NOT guess.
4. **Top 8 categories in agent prompt context** — ordered by `usage_count DESC, last_used_at DESC`. Trimmed by category-name length so the prompt stays compact.
5. **Dashboard management tab** included in this scope.

## DB schema

```sql
-- Migration NNN_user_categories.sql
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

-- Case-insensitive uniqueness per (user, kind). NULL-safe partial index lets
-- the same name be re-created after a soft delete.
CREATE UNIQUE INDEX uq_user_categories_active
  ON user_categories (user_id, kind, lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX idx_user_categories_user_kind_usage
  ON user_categories (user_id, kind, usage_count DESC, last_used_at DESC)
  WHERE deleted_at IS NULL;
```

## Bootstrap defaults

When the user has zero categories for a given `kind`, seed on first use:

- **Expense**: `Insumos, Semillas, Fertilizantes, Agroquímicos, Combustible, Sueldos, Maquinaria, Servicios, Otros`
- **Income**: `Venta de soja, Venta de maíz, Venta de trigo, Venta de girasol, Venta de hacienda, Arrendamiento, Otros`

Seeded with `usage_count = 0` so they sort to the bottom once the user starts using real ones. The agronomic flavor is intentional.

## Agent prompt change

`buildUserMessagePrefix()` (which already injects user context like fields/plots) gains a "Categorías" section:

```
Categorías:
- Gastos: Semillas, Insumos, Fertilizantes, Sueldos, Combustible, Maquinaria, Agroquímicos, Otros
- Ingresos: Venta de soja, Venta de maíz, Venta de trigo, Otros
```

The top 8 per kind, ordered by `usage_count DESC, last_used_at DESC`. ~80 tokens worst case.

## Tool schema changes

Tools `log_expense` and `log_income` gain ONE optional parameter:

```typescript
category_match: {
  type: 'string',
  enum: ['exact', 'new', 'unknown'],
  description: `Decisión sobre la categoría:
- 'exact' si el texto del usuario matchea EXACTAMENTE una categoría existente (case-insensitive). Pasá la categoría en 'category'.
- 'new' si el usuario indicó claramente que quiere crear una nueva (ej. "anótalo como 'Riego'"). Pasá el nombre en 'category'.
- 'unknown' o omití el param si el texto del usuario no coincide con ninguna categoría existente y no pidió crear una nueva. En ese caso NO pongas 'category' — el sistema le va a preguntar.`
}
```

The agent's job is reduced to a 3-way classifier, NOT to invent categories. Existing `category` param stays.

## Handler behavior

### `log_expense` / `log_income` (in `financial.handler.ts`)

After parsing the command, before saving:

1. Resolve `categoryService.match(userId, kind, cmd.category, cmd.category_match)`:
   - If `category_match === 'exact'` AND the (case-insensitive) name exists → use the existing category id + name (canonical casing from DB)
   - If `category_match === 'new'` → INSERT into `user_categories` + return the new id
   - Otherwise (unknown / no match) → return `{ needsConfirmation: true, suggestions: top8 }`
2. If `needsConfirmation` → handler saves the expense/income as **pending** in conversation_state and replies with buttons:
   ```
   ¿Qué categoría?
   [Semillas] [Insumos] [Fertilizantes] [Sueldos] [Combustible]
   [Maquinaria] [Agroquímicos] [+ Otra]
   ```
   Callback format: `cat_pick_<exp|inc>_<expense_id>_<category_id>` and `cat_new_<exp|inc>_<expense_id>` for "Otra".
3. On button click:
   - If existing → bump `usage_count`, set `category` on expense/income, reply confirmation
   - If "+ Otra" → ask for the new name in text (single-step flow), then create + assign + bump + reply

### `categoryService.bump(userId, kind, categoryId)`
Single SQL statement: `UPDATE user_categories SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = $1`. Called every successful expense/income save.

## Dashboard tab "Categorías"

New top-level tab below Documentos, gated by features (no gate — available to all plans).

### Layout
- Page tabs: `Gastos | Ingresos`
- Each tab shows a table:

| Categoría | Usos | Último uso | Acciones |
|---|---|---|---|
| Semillas | 47 | hace 2 días | ✏️ Renombrar · 🗑️ Eliminar |
| Insumos | 31 | hace 5 días | ✏️ Renombrar · 🗑️ Eliminar |
| ... | | | |

- Botón **"+ Crear categoría"** abre un modal mínimo (input + guardar)
- **Rename**: inline edit. Backend validates against the unique index.
- **Delete**:
  - If `usage_count = 0` and no `expenses`/`incomes` reference it → soft delete directly
  - If in use → modal: "Esta categoría se usó en X gastos. ¿Reasignar a otra categoría existente o mantenerla solo como histórica?"
    - "Mantener histórica": soft delete the category but leave expenses pointing to the old name (denormalized; current schema stores `category` as string on expenses, so this works)
    - "Reasignar a [X]": UPDATE expenses SET category = newName WHERE category = oldName AND user_id = me

### Backend endpoints (under `/api/auth`)
- `GET /categories?kind=expense|income` — list
- `POST /categories` — create
- `PATCH /categories/:id` — rename
- `DELETE /categories/:id?reassignTo=N` — soft delete (optionally with reassign)
- All require `requireAuth`. No feature gate.

## Migration

One-time backfill via migration:

```sql
-- For each user, GROUP existing categories with INITCAP normalization + count
INSERT INTO user_categories (user_id, kind, name, usage_count, last_used_at, created_at)
SELECT
  e.user_id,
  'expense',
  INITCAP(TRIM(e.category)),
  COUNT(*) AS usage_count,
  MAX(e.created_at) AS last_used_at,
  MIN(e.created_at) AS created_at
FROM expenses e
WHERE e.category IS NOT NULL
  AND TRIM(e.category) <> ''
  AND e.deleted_at IS NULL
GROUP BY e.user_id, INITCAP(TRIM(e.category))
ON CONFLICT DO NOTHING;

-- Same for incomes.
```

After the migration:
- The denormalized `expenses.category` / `incomes.category` columns stay as-is (no FK change). Reads still work.
- New writes funnel through the agent + handler that look up by name.
- Casing normalizes naturally (INITCAP). "semillas" + "Semillas" + "SEMILLAS" all collapse to "Semillas".

**No data loss** because we soft-touch only — we add to the new table without modifying existing rows.

## Frontend additions

- New view `categories` in `Dashboard.tsx`
- New component `CategoriesTab.tsx` with sub-tabs Gastos/Ingresos
- New hook `useCategories(kind)` — fetches `GET /categories?kind=...`
- Sidebar + BottomNav entry "Categorías"

## Bot flow examples

### Caso 1: match exacto
Usuario: "gasté 50k en semillas"
Agente: `log_expense(amount=50000, currency=ARS, category="semillas", category_match="exact")`
Bot: "✅ Gasto registrado · Semillas · $50.000" *(canonical casing returned)*

### Caso 2: ambiguo
Usuario: "compré gasoil por 200k"
Agente: `log_expense(amount=200000, currency=ARS, category_match="unknown")` (no `category`)
Bot:
```
✅ Gasto cargado: $200.000

¿En qué categoría va?
[Combustible] [Insumos] [Maquinaria] [Sueldos] [Semillas]
[Fertilizantes] [Agroquímicos] [+ Otra]
```
Usuario: tap "Combustible"
Bot: "✅ Gasto guardado · Combustible · $200.000"

### Caso 3: usuario quiere una nueva
Usuario (en el menú anterior): tap "+ Otra"
Bot: "¿Cómo se llama la nueva categoría?"
Usuario: "Diesel premium"
Bot: "✅ Categoría 'Diesel premium' creada · Gasto guardado · $200.000"

### Caso 4: agente detecta intención de crear
Usuario: "creá una categoría llamada Cosecha 2026 y poneme ahí los 800k que pagué del flete"
Agente: `log_expense(amount=800000, currency=ARS, category="Cosecha 2026", category_match="new")`
Bot: "✅ Categoría 'Cosecha 2026' creada · Gasto guardado · $800.000"

## Files to add / modify

### Backend (new)
- `src/migrations/NNN_user_categories.sql`
- `src/domain/financial/category.service.ts`
- `src/domain/financial/category.repository.ts`
- `src/routes/auth.routes.ts` — add `/categories` CRUD endpoints

### Backend (modify)
- `src/ai/tool-definitions.ts` — add `category_match` enum to `log_expense` + `log_income`
- `src/ai/agent-prompt-builder.ts` — inject `user-context.service.ts` block already, just need new section
- `src/ai/user-context.service.ts` — fetch + cache top 8 categories per kind
- `src/domain/financial/financial.handler.ts` — wire `categoryService.match()` + handle button callback for `cat_pick_*` / `cat_new_*`
- `src/services/expenses.js` — bump `usage_count` after successful insert (small helper call)
- `src/domain/router.ts` — add the 2 new commands `pick_category` and `create_category` (callback handlers)

### Frontend (new)
- `frontend/src/components/CategoriesTab.tsx`
- `frontend/src/hooks/useCategories.ts`
- `frontend/src/components/categories/CategoryRenameModal.tsx` (or inline edit)
- `frontend/src/components/categories/CategoryDeleteModal.tsx` (reassign UX)

### Frontend (modify)
- `frontend/src/pages/Dashboard.tsx` — add `'categories'` view + entry
- `frontend/src/components/layout/Sidebar.tsx` — entry
- `frontend/src/components/layout/BottomNav.tsx` — entry

### Tests
- Unit: `categoryService.match()` — exact / new / unknown branches
- Eval scenario: "ambiguous category prompts buttons" (new conversational eval scenario)

## Open Questions

None — the 5 questions above have been answered by the user.

## Estimate

~400-500 LOC across ~15 files. Less than a day of careful work. The key win is that the regex parser path is unchanged — this is purely additive on the AI-agent + handler side + a small CRUD UI.
