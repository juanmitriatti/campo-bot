# Livestock System (Hacienda)

Event-sourced cattle inventory tracking with health, reproduction, and weighing event logging. Feature-gated to `pro_plus` and `enterprise` plans. Migrations: `053_livestock.sql` (base), `074_domain_events_livestock_columns.sql` (health/repro/weighing).

> **Desde Ago 2026 el modelo es HÍBRIDO: grupo + animal individual con caravana/RFID.**
> Este documento describe la capa por GRUPOS, que sigue siendo la principal y no
> cambió. La capa individual — opcional y aditiva — está en
> **[docs/ganaderia/](../ganaderia/overview.md)** (migraciones 111-116).
> Invariante 16: un grupo con 0 animales individualizados se comporta exactamente
> como antes de que esa capa existiera.

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
- **LivestockHandler** — 14 commands (8 inventory + 6 health/repro/weighing), emoji responses, Argentine Spanish.

## AI Tools (14)

### Inventory (8)
`add_livestock`, `remove_livestock`, `transfer_livestock`, `record_livestock_death`, `record_livestock_birth`, `adjust_livestock`, `list_livestock`, `livestock_history`

### Health / Reproduction / Weighing (6)
`log_health_event`, `query_health_events`, `log_repro_event`, `query_repro_events`, `log_weighing`, `query_weighings`

### Example Mappings
- "agregué 20 vacas al lote norte" → `add_livestock`
- "vendí 5 novillos del lote A1" → `remove_livestock`
- "mové 10 vacas del lote A al lote B" → `transfer_livestock`
- "pasé 15 terneros a novillos en el lote sur" → `transfer_livestock` (recategorizacion)
- "se murieron 2 terneros" → `record_livestock_death`
- "nacieron 8 terneros" → `record_livestock_birth`
- "en el lote A1 hay 50 vacas" → `adjust_livestock`
- "cuántos animales tengo" → `list_livestock`

## Sanidad Animal (Health Events)

Health events are stored in `domain_events` (not `livestock_movements`) with `animal_category` and `animals_affected` columns (migration 074).

### Health Types
- `vacunacion` — Vaccination (aftosa, brucelosis, carbunclo, etc.)
- `desparasitacion` — Deworming (ivermectina, doramectina, etc.)
- `tratamiento` — Veterinary treatment (antibiotics, topical treatments)
- `revision_sanitaria` — Health inspection/checkup

### Key Fields
- `health_type` (required) — One of the 4 types above
- `disease_or_vaccine` — Name of vaccine, disease, or drug applied
- `category` — Animal category (vaca, novillo, ternero, etc.)
- `animals_affected` — Number of animals treated
- `dose_quantity` / `dose_unit` — Dosage applied (optional)
- `veterinarian` — Vet name (optional)

### Example Mappings
- "vacuné 200 vacas contra aftosa" → `log_health_event(health_type=vacunacion, disease_or_vaccine=aftosa, category=vaca, animals_affected=200)`
- "desparasité los novillos con ivermectina" → `log_health_event(health_type=desparasitacion, disease_or_vaccine=ivermectina, category=novillo)`
- "historial sanitario del lote norte" → `query_health_events(plot=norte)`

## Reproducción (Reproductive Events)

Reproductive events also use `domain_events` table with the same `animal_category` and `animals_affected` columns.

### Repro Types
- `servicio` — Bull service / natural mating (echar el toro, entore)
- `destete` — Weaning (NOT the same as removing livestock; calves stay in inventory)
- `inseminacion` — Artificial insemination (IA, IATF)
- `deteccion_celo` — Heat detection

### Key Fields
- `repro_type` (required) — One of the 4 types above
- `category` — Animal category
- `animals_affected` — Number of animals involved
- `sire_info` — Bull/sire details (name, breed, ear tag number)
- `method` — Insemination method (IA, IATF, monta natural)

### Example Mappings
- "eché el toro Angus a 50 vacas" → `log_repro_event(repro_type=servicio, category=vaca, animals_affected=50, sire_info=Angus)`
- "desteté 30 terneros" → `log_repro_event(repro_type=destete, category=ternero, animals_affected=30)`
- "inseminé 80 vaquillonas por IATF" → `log_repro_event(repro_type=inseminacion, category=vaquillona, animals_affected=80, method=IATF)`
- "cuándo se echó el toro" → `query_repro_events(repro_type=servicio)`

## Pesaje (Weighing Events)

Weighing events use `domain_events` with weight stored as average per animal. Supports GDPV (ganancia diaria de peso vivo) calculation from consecutive weighings.

### Key Fields
- `avg_weight_kg` (required) — Average weight per animal in kg (NEVER total weight)
- `animals_weighed` — Number of animals weighed
- `category` — Animal category

### Example Mappings
- "pesé los novillos, 380 kg promedio" → `log_weighing(category=novillo, avg_weight_kg=380)`
- "pesamos 100 novillos a 420 kg" → `log_weighing(category=novillo, avg_weight_kg=420, animals_weighed=100)`
- "evolución de peso de los novillos" → `query_weighings(category=novillo)`
- "GDPV del lote norte" → `query_weighings(plot=norte)`

## Dashboard & API

- **Hacienda tab**: `LivestockTab` with Grupos + Historial sub-tabs
- **Grupos**: paginated table, campo/lote/categoría filters, totals banner, Movimientos/Editar actions
- **Historial**: global movement timeline with 6 filters, pagination
- **API**: `GET /api/auth/livestock` (paginated groups), `GET /api/auth/livestock/movements` (global history), `GET /api/auth/livestock/:id/movements` (per-group), `GET /api/auth/livestock/filters`, `PATCH /api/auth/livestock/:id` (edit breed/weight/notes, count read-only)
