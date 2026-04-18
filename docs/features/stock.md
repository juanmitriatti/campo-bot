# Stock System (Inventario)

Feature-gated to `pro_plus` and `enterprise` plans.

## Data Model

`warehouses` (per-field) → `stock_items` (product, quantity, unit, min_stock, grade, humidity) → `stock_movements` (entrada/salida/ajuste with links to expenses and activities)

**Expense types**: `expenses.expense_type` differentiates `'varios'` (services/labranzas) from `'insumo'` (storable products like agroquimicos, fertilizantes, semillas, combustible). Agent auto-detects type from product name/category.

Migrations: 044 (expense types), 045 (warehouses/stock_items/stock_movements), 046 (stock_deduction_status), 047 (grain: grade/humidity)

## Code (`src/domain/stock/`)

- **StockRepository** — Atomic movements with `FOR UPDATE` row lock
- **StockService** — Auto-resolve warehouse/field, fuzzy product search, unit validation, grain stock
- **StockHandler** — 9 chat commands; `check_stock` shows expanded detail ≤15 items, compact above
- **StockPurchaseService** — Expense → stock entry suggestion + grain entry
- **StockDeductionService** — Activity → stock deduction
- **StockAlertService** — Low stock alerts daily at 8AM

## AI Tools (8)

`create_warehouse`, `list_warehouses`, `add_stock`, `remove_stock`, `adjust_stock`, `check_stock`, `stock_history`, `set_min_stock`

## Interactive Flows (buttons on WhatsApp + Telegram)

- Expense (insumo) → "cargar al stock?" (`stock_entry_yes/no`)
- Activity (spraying/fertilization) → "descontar del stock?" (`stock_deduct_yes/no`)
- Harvest → "cargar grano al silo?" (`stock_grain_yes/no`)
- Grain sale → "descontar del stock?" (`stock_grain_sale_yes/no`)

## Alerts

Daily 8AM low stock check via `lowStockAlertTick()` in scheduler. Multi-channel delivery with 24h dedup.

## Dashboard & API

- Stock tab: `StockTable`, `StockMovementHistory` modal, `StockEditModal`
- Expense table shows type badge + product column + type filter
- Endpoints: `GET /api/auth/stock`, `GET /api/auth/stock/:id/movements`, `GET /api/auth/stock/filters`, `PATCH /api/auth/stock/:id`
