# Hacienda UX Hardening — Spec A

**Status:** Design draft · awaiting user review
**Owner:** Juan Pablo Mitriatti
**Date:** 2026-05-20
**Related:** Spec B (catálogos `user_taxonomies` para vacunas/razas/toros) — separate doc.

## Goal

Cerrar gaps de discoverability y data quality en el flujo de hacienda del bot. El usuario aprende qué puede hacer (no por documentación, sino por interacción), no pierde datos por defaults silenciosos, y tiene siguientes acciones obvias en cada confirmación.

## Scope (gaps cubiertos)

| # | Gap | Decisión |
|---|---|---|
| 0 | Onboarding no menciona hacienda | Agregar bloque al `ONBOARDING_FIRST_PLOT_MESSAGE` |
| 1 | No descubrimiento de feedlot/corral | Nudge informativo en la primera registración de animales |
| 2 | Verbos de encierre no infieren corral | Regla en el prompt del agente |
| 3 | "No encontré X" sin botón inline para crear | Botones Sí/No: crear-y-continuar o cancelar |
| 4 | Sanidad/repro/pesajes admiten ubicación vacía | Auto-resolver cuando único; preguntar con buttons cuando ambiguo |
| 5 | `animals_affected` opcional silenciosamente | Preguntar siempre con shortcuts `Todos (N)` y `Saltar` |
| 8 | Confirmaciones sin acciones siguientes | Botones post-confirmación en las 6 ops de hacienda |

**Out of scope (otros specs):**
- Gap 6: comando `mi rodeo` / treemap del rodeo (skipped por decisión del usuario)
- Gap 7: catálogos `user_taxonomies` (vacunas/razas/toros) → Spec B

## Sección 1 — Gap 0: Onboarding incluye hacienda

### Estado actual

`src/services/settings.service.js` define `ONBOARDING_FIRST_PLOT_MESSAGE`. Hoy lista: Gastos, Ingresos, Actividades, Lluvia/Clima, Reportes. Cero mención de hacienda.

### Cambio

Agregar un bloque al final del mensaje (antes del "Escribí *menú*..."):

```
🐄 *Hacienda*
"agregué 30 vacas Angus al lote A1"
"pesé los novillos a 380 kg promedio"
"vacuné contra aftosa"

💡 ¿Engorde a corral? Creá un feedlot con "nuevo feedlot en <campo>".
```

### Notas

- Sin feature-gate: el mensaje se muestra a TODOS los nuevos usuarios. Si el plan no tiene `livestock`, intentar las acciones les disparará el gate normal — pero el descubrimiento del feature es valor en sí mismo (señal para upsell).
- Cambio aislado en `settings.service.js`. Sin tocar lógica.

---

## Sección 2 — Gap 1: Nudge en primera registración de animales

### Estado actual

`livestock.handler.addLivestock` confirma con texto plano sin tips contextuales.

### Cambio

Después de `service.addAnimals(...)`, antes del return, query rápida:

```sql
SELECT COUNT(*)::int AS n FROM livestock_movements WHERE user_id = $1
```

Si `n === 1` (el primer movimiento) y el destino es un `plot` (no corral), añadir línea final a la confirmación:

```
💡 Si hacés engorde a corral, podés crear un feedlot con "nuevo feedlot en <campo>".
```

### Notas

- Solo el primer movimiento del usuario. Subsecuentes no.
- Query barata (índice ya existe por user_id).
- No se muestra si el primer movimiento ya fue a un corral (el usuario ya descubrió el feature).

---

## Sección 3 — Gap 2: Verbos de encierre → corral

### Estado actual

El agente solo detecta "lote X" vs "corral X" por keyword exacto. Verbos como "encerré" / "los puse a engordar" no inferencian ubicación de feedlot.

### Cambio

Agregar bloque al prompt builder, después de la sección "Hacienda" existente (línea ~745):

```
═══ VERBOS DE CONFINAMIENTO → CORRAL / FEEDLOT ═══

Cuando el usuario use verbos o sustantivos de confinamiento:
  - "encerrar / encerré / encierre / encierro"
  - "engordar / engorde / engordo"
  - "balanceado / ración / suplementación"
  - "alimentación intensiva / dieta"
  - "comedero / bebedero" (en contexto hacienda)

Interpretá que la ubicación NATURAL es un corral del feedlot, NO un lote a
campo. Si el usuario menciona el nombre del corral, usalo. Si NO lo menciona,
pedí el corral con respond_text — NO asumas lote ni feedlot por default.

Ejemplos:
  "encerré 20 novillos" sin más → respond_text: "¿En qué corral?"
  "los puse en el corral 1 a engordar" → add_livestock(corral="1")
  "engordamos terneros en corral Norte" → add_livestock(corral="Norte")

Contraejemplo:
  "los novillos están en el lote A1" → add_livestock(plot="A1") (mención
  explícita de lote prevalece sobre cualquier inferencia)
```

### Notas

- Solo regla de prompt (~25 líneas). Sin código.
- Mejora tasa de éxito en mensajes ambiguos.
- Lista de verbos cubre lo más común en AR; ampliable.

---

## Sección 4 — Gap 3: "No encontré X" con confirmación inline para crear

### Estado actual

```
Bot: "No encontré el corral 'Norte' en el feedlot 'Don Pedro'."
Bot: "No encontré el lote 'X'. Creá el lote primero con 'nuevo lote X'."
```

El usuario tiene que cancelar lo que hacía, tipear el comando de creación, y volver a intentar la operación original.

### Cambio

Cuando `livestock.handler` recibe error de "no encontré X" del resolver, interceptar y devolver buttons:

```
🔍 No encontré el corral *Norte*.
¿Querés que lo cree y registre los 20 novillos?

[Sí, crear y continuar]  [No, cancelar]
```

### Flow detallado

#### Caso corral inexistente

1. Usuario: "registrá 20 novillos en corral Norte"
2. Handler resuelve → `feedlotService.resolveCorral` tira "No encontré...".
3. Handler captura el error, examina si:
   - El usuario tiene **1 feedlot**: payload incluye `feedlotId`, mensaje pregunta crear el corral en ese feedlot.
   - El usuario tiene **0 feedlots**: payload pivota — primero pregunta "¿En qué campo creo el feedlot?", luego cascadea.
   - El usuario tiene **2+ feedlots**: pregunta "¿En cuál feedlot?" con buttons listando feedlots.
4. Pending state codificado en `payload` (base64url) con: cmd original + nombre del corral pedido + (opcional) feedlotId/fieldName.
5. Botón Sí dispara `lv_create_corral_continue_<payload>` → handler crea corral + retoma la operación original.
6. Botón No dispara `lv_create_cancel` → handler responde "Cancelado".

#### Caso lote inexistente

Mismo patrón pero `lv_create_plot_continue_<payload>`. Si el campo tampoco existe: cascada (crear campo + lote + retomar).

### Button callback IDs

```
lv_create_corral_continue_<payload>     # acepta crear corral + retomar
lv_create_plot_continue_<payload>       # acepta crear lote + retomar
lv_create_feedlot_continue_<payload>    # acepta crear feedlot + corral + retomar (caso 0 feedlots)
lv_create_field_continue_<payload>      # caso campo no existe (cascada completa)
lv_create_cancel                         # botón "No, cancelar"
```

### Pending state payload

Base64url-encoded JSON:
```typescript
{
  cmd: ParsedCommand,        // El comando original que se quería ejecutar
  missingType: 'corral' | 'plot' | 'feedlot' | 'field',
  missingName: string,
  feedlotId?: number,        // si ya está resuelto
  fieldName?: string,        // si ya está resuelto
}
```

### Notas

- Patrón mirrors lo que hicimos con `cat_pick_*` / `cat_new_*` para categorías.
- No es 100% recoverable: si el cmd original es complejo (transferLivestock con source+dest), el payload guarda todos los campos.
- Se reusa la infra de pending callbacks ya existente (interactive.router.ts + financial.handler como referencia).

---

## Sección 5 — Gap 4: Auto-resolver ubicación en sanidad/repro/pesajes

### Estado actual

`livestock.handler.resolveEventLocation`:
- Si especifica corral → resuelve
- Si especifica plot → resuelve
- Si ninguno → devuelve `{ plotId: null, corralId: null, label: 'Sin ubicación' }` ✗

Evento se guarda sin ubicación. Reportes por lote/corral lo pierden.

### Cambio

Reemplazar `resolveEventLocation` con una nueva función `resolveEventLocationOrAsk` que:

```typescript
async resolveEventLocationOrAsk(cmd, userId, kind) {
  // 1. Si especifica corral/plot, usar el resolver actual (sin cambios).
  if (cmd.corralName || cmd.plotName) {
    return resolveEventLocation(cmd, userId);
  }

  // 2. Sin ubicación: intentar inferir del grupo único de hacienda.
  const category = cmd.category as string | null;
  const matching = await queryGroupsForUser(userId, {
    category,                  // null → all groups
  });

  if (matching.length === 0) {
    return { error: 'No tenés hacienda registrada. Primero agregá animales con "agregué N <categoría> al lote X".' };
  }

  if (matching.length === 1) {
    // Auto-resolver: único grupo coincide
    const g = matching[0];
    return {
      plotId: g.plot_id,
      corralId: g.corral_id,
      label: g.location_label,   // "Corral 1" o "Don Pedro > A1"
      autoResolved: true,        // marker para mostrar en confirmación
    };
  }

  // 3. Múltiples grupos: devolver needs-confirmation con buttons.
  return {
    needsLocationPick: true,
    options: matching.map(g => ({
      plotId: g.plot_id,
      corralId: g.corral_id,
      label: g.location_label,
      groupId: g.id,
    })),
  };
}
```

### Buttons cuando `needsLocationPick`

```
¿En qué ubicación lo registramos?
[Corral 1 (47 novillos)]  [Lote A1 (12 vacas)]  [Don Aurelio > B2 (33 terneros)]
```

(Máximo 7 buttons, sino lista numerada en texto.)

### Confirmación con autoResolved

Cuando se auto-resuelve, agregar un info chico al mensaje de confirmación:

```
💉 Evento sanitario registrado
   Tipo: Vacunación
   🦠 Aftosa
   🐄 47 novillos
   📍 Corral 1 (auto)         ← marker visible
   📅 hoy
```

### Button callback IDs

```
lv_pick_loc_health_<payload>_<plotId|null>_<corralId|null>   # health
lv_pick_loc_repro_<payload>_<plotId|null>_<corralId|null>    # repro
lv_pick_loc_weigh_<payload>_<plotId|null>_<corralId|null>    # weighing
lv_pick_loc_cancel
```

Payload encodes the original cmd.

### Notas

- Esta sección requiere agregar `category` como filtro opcional en `queryGroupsForUser`. Ya existe el query base, solo nuevo filtro.
- Aplica SOLO a los 3 eventos sin ubicación física obligatoria (health/repro/weighing). add/remove/transfer ya rechazan sin ubicación.
- El path de Gap 5 (animals_affected) corre DESPUÉS de Gap 4 — primero ubicación, luego conteo.

---

## Sección 6 — Gap 5: `animals_affected` siempre se pregunta

### Estado actual

Si el usuario omite `animals_affected` en `log_health_event`/`log_repro_event`/`log_weighing`, el evento se guarda con `animals_affected = null`. Reportes / dashboard pierden granularidad.

### Cambio

Después de resolver ubicación (Gap 4) y antes de guardar, si `animals_affected` es null/undefined:

1. Bot envía buttons:
```
¿A cuántos animales?
[Todos (47)]  [Saltar]
```

- `Todos (47)` solo aparece si la ubicación resuelta tiene EXACTAMENTE 1 grupo. El número es `group.count`.
- `Saltar` siempre aparece.
- El usuario también puede responder con texto: "12", "todos", "30 vacas", etc.

2. Si el usuario tapea `Todos (N)`: save con `animals_affected = N`.
3. Si tapea `Saltar`: save con `animals_affected = null` Y la confirmación final agrega un warning chico:
```
💉 Evento sanitario registrado
   ...
   ⚠️ Sin cantidad de animales — agregalo más tarde si lo necesitás.
```
4. Si tipea un número: validar (1 ≤ n ≤ 9999) y save.

### Button callback IDs

```
lv_animals_all_<payload>     # tap "Todos (N)" — count viene del payload
lv_animals_skip_<payload>    # tap "Saltar"
```

(Texto libre con número se parsea en el flujo normal — no necesita button id.)

### Pending state payload (Gap 4 + Gap 5)

El payload acumula contexto a través de los pasos:

```typescript
{
  cmd: ParsedCommand,             // original
  resolvedLocation: {              // post-Gap 4
    plotId: number | null,
    corralId: number | null,
    label: string,
  },
  knownGroupCount?: number,        // si resolvedLocation tiene 1 grupo único
  kind: 'health' | 'repro' | 'weighing',
}
```

### Notas

- La pregunta no se hace si `animals_affected` está presente.
- `knownGroupCount` permite mostrar `Todos (N)` correctamente.

---

## Sección 7 — Gap 8: Buttons post-confirmación

### Estado actual

Las confirmaciones de hacienda son texto plano. Comparar con expense que cierra con `📈 Resultado mes | 🧾 Cargar factura | ↩️ Borrar último`.

### Cambio

Cada operación de hacienda agrega 2-3 buttons al final del mensaje de confirmación.

### Diseño por operación

#### `add_livestock` confirmation

```
🐄 Hacienda actualizada
   Vacas Angus (nuevo grupo)
   ➕ 30 animales
   📊 Total: 30
   📍 Corral 1

[📊 Ver stock]   [⚖️ Pesar grupo]   [↩️ Borrar]
```

#### `remove_livestock` confirmation

```
🐄 Hacienda descontada
   Novillos
   ➖ 5 animales
   📊 Quedan: 42
   📍 Corral 1

[📊 Ver stock]   [↩️ Borrar]   [💰 Resumen mes]
```

(El botón "💰 Resumen mes" solo aparece si `is_sale === true`.)

#### `transfer_livestock` confirmation

```
🐄 Transferidos
   12 vacas
   📍 Lote A1 → Corral 1

[📊 Stock destino]   [⚖️ Pesar grupo]   [↩️ Borrar]
```

#### `log_weighing` confirmation

```
⚖️ Pesaje registrado
   🐄 47 novillos
   📊 Peso promedio: 380 kg
   📍 Corral 1

[📈 GDPV grupo]   [💉 Sanidad]   [↩️ Borrar]
```

#### `log_health_event` confirmation

```
💉 Evento sanitario registrado
   Tipo: Vacunación
   🦠 Aftosa
   🐄 47 novillos
   📍 Corral 1

[💉 Historial sanitario]   [➕ Otro evento]   [↩️ Borrar]
```

#### `log_repro_event` confirmation

```
🐂 Evento reproductivo registrado
   Tipo: Servicio
   🐂 Toro Angus carav. 1234
   🐄 35 vacas
   📍 Lote A1

[🐂 Historial repro]   [➕ Otro evento]   [↩️ Borrar]
```

### Handlers de los buttons

| Button ID | Acción |
|---|---|
| `lv_post_stock_<plotId>_<corralId>` | Ejecuta `list_livestock` con el filtro de location |
| `lv_post_weigh_<groupId>` | Devuelve un `respond_text` pidiendo el peso. Setea flow_state `awaiting_weight_for_group_<groupId>` |
| `lv_post_gdpv_<groupId>` | Ejecuta `query_weighings` para ese grupo |
| `lv_post_health_hist_<groupId>` | Ejecuta `query_health_events` filtrado por location del grupo |
| `lv_post_repro_hist_<groupId>` | Ejecuta `query_repro_events` filtrado por location del grupo |
| `lv_post_undo_movement_<movementId>` | Soft-undo del livestock_movement (reverse) |
| `lv_post_undo_event_<eventId>` | Soft-delete del domain_event |
| `lv_post_resumen_mes` | Ejecuta `financial_report` mes actual |
| `lv_post_new_event_<groupId>_<kind>` | "➕ Otro evento" → respond_text pidiendo qué evento |

### Undo logic (importante)

Dos tipos de undo según operación:

**Para livestock_movement** (add/remove/transfer): patrón compensating-row (ledger inmutable):
- `entrada` → revertir = insertar `salida` con mismo count en el mismo grupo
- `salida` → revertir = insertar `entrada`
- `transferencia` → revertir = insertar `transferencia` con source ↔ dest invertidos
- El movimiento original NO se borra (es ledger inmutable). Solo se agrega el compensatorio.
- Implementación: nuevo método `livestockService.undoMovement(movementId)`.
- Validación previa: si la compensación dejaría el `count` del grupo en negativo (ej. ya saliste 30 vacas posteriores y querés deshacer una entrada vieja de 10), tirar error claro: "No se puede deshacer: actualmente hay X animales, restaría a Y".

**Para domain_event** (health/repro/weighing): soft-delete. Requiere migration:
```sql
-- src/migrations/NNN_domain_events_deleted_at.sql
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_domain_events_deleted_at ON domain_events(user_id, deleted_at) WHERE deleted_at IS NULL;
```

Luego: `UPDATE domain_events SET deleted_at = NOW() WHERE id = $1 AND user_id = $2`.

**Importante**: todas las queries existentes que leen `domain_events` deben agregarse `AND deleted_at IS NULL`. Auditar y actualizar:
- `agronomy.handler.ts` (getActivitiesInWindow + queries de actividades)
- `livestock.handler.ts` (queryLivestockEvents + livestockHistory)
- `analytics/agronomic` endpoint (harvestsMonthly + yieldByCrop queries)
- `analytics/livestock` endpoint (feedlotWeightCurve + healthEvents + reproEvents)
- Cualquier otro lector de `domain_events`

(Es la consecuencia de agregar soft-delete: hay que respetar el filtro en todos los lectores. ~15 queries auditadas en total.)

### Confirmación del undo

```
↩️ Operación deshecha.
   30 vacas Angus removidas del Corral 1.
```

### TTL del undo

Sin TTL en V1 (cualquier botón clickeado funciona). Si el usuario tap años después también deshace. Si genera problemas → TTL de 24h en V2.

### Notas

- El `↩️ Borrar` SOLO aparece si la operación se guardó hace menos de X tiempo? No — siempre disponible mientras el botón esté visible en el chat.
- El botón "➕ Otro evento" simplifica el caso "registré una vacuna y ahora la quiero registrar para otro grupo".

---

## Sección 8 — Cross-cutting: pending state, payloads, router

### Pending payloads

Todos los buttons de hacienda usan el patrón base64url(JSON) ya establecido por `cat_pick_*`/`cat_new_*`. Helpers nuevos en `livestock.handler.ts`:

```typescript
function encodeLivestockPayload(p: LivestockPendingPayload): string;
function decodeLivestockPayload(b64: string): LivestockPendingPayload;

type LivestockPendingPayload = {
  cmd: ParsedCommand,               // original tool call
  step: 'create_loc' | 'pick_loc' | 'animals' | 'post_action',
  resolvedLocation?: { plotId, corralId, label },
  missingType?: 'corral' | 'plot' | 'feedlot' | 'field',
  missingName?: string,
  knownGroupCount?: number,
}
```

### Interactive router

Agregar al `src/domain/interactive/interactive.router.ts`:

```typescript
// Gap 3 — create-and-continue
if (id.startsWith('lv_create_corral_continue_')) { ... }
if (id.startsWith('lv_create_plot_continue_')) { ... }
if (id.startsWith('lv_create_feedlot_continue_')) { ... }
if (id.startsWith('lv_create_field_continue_')) { ... }
if (id === 'lv_create_cancel') { ... }

// Gap 4 — pick location
if (id.startsWith('lv_pick_loc_health_')) { ... }
if (id.startsWith('lv_pick_loc_repro_')) { ... }
if (id.startsWith('lv_pick_loc_weigh_')) { ... }
if (id === 'lv_pick_loc_cancel') { ... }

// Gap 5 — animals_affected
if (id.startsWith('lv_animals_all_')) { ... }
if (id.startsWith('lv_animals_skip_')) { ... }

// Gap 8 — post-confirmation
if (id.startsWith('lv_post_stock_')) { ... }
if (id.startsWith('lv_post_weigh_')) { ... }
if (id.startsWith('lv_post_gdpv_')) { ... }
if (id.startsWith('lv_post_health_hist_')) { ... }
if (id.startsWith('lv_post_repro_hist_')) { ... }
if (id.startsWith('lv_post_undo_movement_')) { ... }
if (id.startsWith('lv_post_undo_event_')) { ... }
if (id.startsWith('lv_post_new_event_')) { ... }
if (id === 'lv_post_resumen_mes') { ... }
```

### Router commands

Agregar al `src/domain/router.ts` en `LIVESTOCK_COMMANDS`:

```typescript
'livestock_create_continue',
'livestock_create_cancel',
'livestock_pick_location',
'livestock_animals_all',
'livestock_animals_skip',
'livestock_post_action',
'livestock_undo_movement',
'livestock_undo_event',
```

(Cada uno con su `case` en el dispatch que llama al método correspondiente del handler.)

---

## Sección 9 — Files to change

### Backend (modify)
- `src/services/settings.service.js` — extender `ONBOARDING_FIRST_PLOT_MESSAGE` (Gap 0)
- `src/ai/agent-prompt-builder.ts` — regla de verbos de encierre (Gap 2)
- `src/domain/livestock/livestock.handler.ts` — `resolveEventLocationOrAsk`, primer-movement nudge, post-confirmation buttons, undo methods, create-and-continue handlers (Gaps 1, 3, 4, 5, 8)
- `src/domain/livestock/livestock.service.ts` — `undoMovement`, `findGroupsByCategory` (Gaps 4, 8)
- `src/domain/livestock/livestock.repository.ts` — soft-delete domain_event helper si no existe
- `src/domain/router.ts` — registrar nuevos commands
- `src/domain/interactive/interactive.router.ts` — registrar todos los `lv_*` parsers

### Backend (new)
- `src/migrations/NNN_domain_events_deleted_at.sql` — soft-delete column + index (para Gap 8 undo)

### Tests
- Unit test para `resolveEventLocationOrAsk` (Gap 4): único / múltiple / vacío
- Unit test para `livestockService.undoMovement` (Gap 8)
- Eval scenario: "vacuno sin ubicación con grupo único → auto-resuelve"
- Eval scenario: "vacuno sin animals_affected → tap Todos → save con N"

### No tocados
- Frontend (este spec es bot-only)

---

## Sección 10 — Open questions

1. **Undo lifetime**: ¿el botón `↩️ Borrar` sigue funcionando aunque hayan pasado horas o días? V1 = sí, sin TTL. ¿OK?
2. **Mass actions**: si el usuario tapea "➕ Otro evento" y el grupo tiene contexto, ¿auto-rellenamos location+category del último evento? Conservador en V1: no, pregunta de cero.
3. **Race conditions del undo**: si el grupo destino fue modificado por movimientos posteriores, ¿el undo puede dejar el conteo en negativo? Necesita validación previa (V1: si la reversa dejaría el count negativo, error claro).

---

## Estimado de implementación

| Sección | LOC aprox |
|---|---|
| Gap 0 (onboarding) | ~10 |
| Gap 1 (nudge) | ~15 |
| Gap 2 (regla prompt) | ~30 |
| Gap 3 (create-and-continue) | ~200 |
| Gap 4 (auto-resolver location) | ~120 |
| Gap 5 (animals_affected) | ~80 |
| Gap 8 (post-confirmation buttons + undo) | ~250 |
| Cross-cutting (router, interactive) | ~80 |
| Migration + audit `deleted_at IS NULL` filters | ~60 |
| Tests | ~120 |
| **Total** | **~960 LOC** |
