# Livestock System (Hacienda)

Event-sourced cattle inventory tracking. Feature-gated to `pro_plus` and `enterprise` plans. Migration `053_livestock.sql`.

## Data Model

- **`livestock_groups`** — Per-location state projection. Keyed by `(plot_id, category, breed)` with unique constraint. `plot_id` OR `corral_id` (CHECK constraint `chk_location_exclusive`).
- **`livestock_movements`** — Immutable audit log. DB-level `chk_movement_endpoints` CHECK enforces valid source/dest config per movement type.

### Categories (9 enum)
`vaca`, `vaquillona`, `ternero`, `ternera`, `novillo`, `novillito`, `toro`, `torito`, `buey`. Service normalizes plurals/accents ("vacas" → "vaca", "vaquillas" → "vaquillona").

### Movement Types (7 enum)
`entrada` (new/purchase), `salida` (sale/exit), `transferencia` (plot-to-plot), `muerte` (death), `nacimiento` (birth), `recategorizacion` (same plot, different category), `ajuste` (absolute count correction)

## Code (`src/domain/livestock/`)

- **LivestockRepository** — `applySingleMovement()` uses `FOR UPDATE` row lock. `applyTransferMovement()` locks both groups in consistent UUID order to prevent deadlocks.
- **LivestockService** — Category normalization, location resolution via `resolveLocation()` (plots AND corrals, never auto-creates), find-or-create groups, auto-classifies same-location+different-category as `recategorizacion`.
- **LivestockHandler** — 8 commands, emoji responses, Argentine Spanish.

## AI Tools (8)

`add_livestock`, `remove_livestock`, `transfer_livestock`, `record_livestock_death`, `record_livestock_birth`, `adjust_livestock`, `list_livestock`, `livestock_history`

### Example Mappings
- "agregué 20 vacas al lote norte" → `add_livestock`
- "vendí 5 novillos del lote A1" → `remove_livestock`
- "mové 10 vacas del lote A al lote B" → `transfer_livestock`
- "pasé 15 terneros a novillos en el lote sur" → `transfer_livestock` (recategorizacion)
- "se murieron 2 terneros" → `record_livestock_death`
- "nacieron 8 terneros" → `record_livestock_birth`
- "en el lote A1 hay 50 vacas" → `adjust_livestock`
- "cuántos animales tengo" → `list_livestock`

## Dashboard & API

- **Hacienda tab**: `LivestockTab` with Grupos + Historial sub-tabs
- **Grupos**: paginated table, campo/lote/categoría filters, totals banner, Movimientos/Editar actions
- **Historial**: global movement timeline with 6 filters, pagination
- **API**: `GET /api/auth/livestock` (paginated groups), `GET /api/auth/livestock/movements` (global history), `GET /api/auth/livestock/:id/movements` (per-group), `GET /api/auth/livestock/filters`, `PATCH /api/auth/livestock/:id` (edit breed/weight/notes, count read-only)
