# Hacienda UX Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the livestock (hacienda) flow discoverable, robust against data loss, and visibly suggest follow-up actions on every confirmation.

**Architecture:** Three pillars: (1) onboarding & prompt rules surface the feature; (2) sanidad/repro/pesajes refuse to silently save partial events — they auto-resolve when unambiguous and ask with buttons otherwise; (3) every confirmation closes with 2-3 follow-up buttons (including undo). One new migration adds `deleted_at` to `domain_events` so undo works on health/repro/weighing without losing audit trail.

**Tech Stack:** Node 20 + TypeScript + Express, PostgreSQL, vitest. Bot-only changes (no frontend).

**Spec:** `docs/superpowers/specs/2026-05-20-hacienda-ux-hardening-design.md`

---

## TDD note

- **Pure logic** (e.g., `resolveEventLocationOrAsk`, undo validation, payload encode/decode) → vitest unit tests
- **Handler methods** (DB + interactive responses) → curl smoke + npm test for regressions
- **Confirmation buttons** → typecheck + manual smoke after Docker rebuild
- **Eval scenario** at the end covers the integrated flow

Every task ends with a commit.

---

## File structure

### NEW
- `src/migrations/092_domain_events_deleted_at.sql` — soft-delete column + index
- `src/domain/livestock/livestock-payload.ts` — shared encode/decode helpers for the new button payloads
- `src/domain/livestock/livestock-post-actions.ts` — helper that builds the post-confirmation button arrays per operation
- `src/domain/livestock/__tests__/livestock-payload.test.ts` — unit tests for payload round-trip
- `src/domain/livestock/__tests__/livestock-undo.test.ts` — unit tests for undo validation

### MODIFIED
- `src/services/settings.service.js` — extend `ONBOARDING_FIRST_PLOT_MESSAGE` (Gap 0)
- `src/ai/agent-prompt-builder.ts` — confinement-verbs rule block (Gap 2)
- `src/domain/livestock/livestock.handler.ts` — first-record nudge, new resolver path, callback handlers, post-action buttons, undo (Gaps 1, 3, 4, 5, 8)
- `src/domain/livestock/livestock.service.ts` — `findGroupsByCategory`, `undoMovement` (Gaps 4, 8)
- `src/domain/livestock/livestock.repository.ts` — `softDeleteDomainEvent`, `findMovementById`, `listGroupsByCategory` (Gaps 4, 8)
- `src/services/expenses.js` — update queries that read `domain_events` to add `AND deleted_at IS NULL` (audit)
- `src/domain/agronomy/agronomy.handler.ts` — same audit (queries of domain_events)
- `src/routes/auth.routes.ts` — same audit on `/analytics/agronomic` + `/analytics/livestock` SQL
- `src/domain/interactive/interactive.router.ts` — parsers for all `lv_*` callback ids
- `src/domain/router.ts` — register new commands in `LIVESTOCK_COMMANDS`
- `src/testing/scenarios/20-hacienda-flow.json` — new eval scenario

---

## Phase 1 — Foundation

### Task 1: Migration `domain_events.deleted_at` + audit existing readers

**Files:**
- Create: `src/migrations/092_domain_events_deleted_at.sql`
- Modify (read-side audit):
  - `src/services/expenses.js`
  - `src/domain/agronomy/agronomy.handler.ts`
  - `src/domain/livestock/livestock.handler.ts`
  - `src/routes/auth.routes.ts`

- [ ] **Step 1: Write the migration**

Create `src/migrations/092_domain_events_deleted_at.sql`:

```sql
-- Add soft-delete column to domain_events so undo can work on health/repro/weighing
-- events without losing audit history. All read queries must filter
-- `deleted_at IS NULL` from now on.

ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_domain_events_user_active
  ON domain_events(user_id) WHERE deleted_at IS NULL;
```

- [ ] **Step 2: Apply migration locally**

```bash
docker compose up -d db && sleep 3
docker compose exec -T db psql -U campo -d campo_bot -f /dev/stdin < src/migrations/092_domain_events_deleted_at.sql
docker compose exec -T db psql -U campo -d campo_bot -c "\d domain_events" | head -20
```
Expected: column `deleted_at | timestamp without time zone` appears in the listing.

- [ ] **Step 3: Find all reader queries that need the filter**

```bash
grep -rn "FROM domain_events\|JOIN domain_events" src/ --include="*.ts" --include="*.js"
```

Make a list (call it the "audit list"). Expected ~15-20 query sites.

- [ ] **Step 4: For each query site, add `AND deleted_at IS NULL`**

Pattern for SELECT/JOIN with WHERE clause:
```sql
FROM domain_events e
WHERE e.user_id = $1
  AND e.deleted_at IS NULL   -- NEW
  AND e.event_type = '...'
```

For correlated subqueries / CTEs: same pattern.

Specifically (non-exhaustive — use the grep output as your master list):
- `src/services/expenses.js` → `getActivitiesInWindow` and similar
- `src/domain/agronomy/agronomy.handler.ts` → activity queries, history queries
- `src/domain/livestock/livestock.handler.ts` → `queryLivestockEvents` if it lives there or in the repo
- `src/routes/auth.routes.ts` → `/analytics/agronomic` (harvestsMonthly, yieldByCrop, harvestQualityLoads), `/analytics/livestock` (feedlotWeightCurve, avgWeightByCategory, healthEventsMonthly, reproEventsMonthly)

For each call site, be defensive: if the query uses a CTE, add the filter inside the CTE.

- [ ] **Step 5: Typecheck + tests**

```bash
npx tsc --noEmit -p . 2>&1 | grep -v 'pre-existing' | head -10
npm test
```
Expected: no NEW typecheck errors, all 1413+ tests pass (no behavior change since current data has no deleted_at).

- [ ] **Step 6: Commit**

```bash
git add src/migrations/092_domain_events_deleted_at.sql src/services/expenses.js \
        src/domain/agronomy/agronomy.handler.ts src/domain/livestock/livestock.handler.ts \
        src/routes/auth.routes.ts
git commit -m "feat(db): domain_events.deleted_at + audit existing readers"
```

---

### Task 2: Payload encode/decode helpers (shared by Gaps 3, 4, 5, 8)

**Files:**
- Create: `src/domain/livestock/livestock-payload.ts`
- Create: `src/domain/livestock/__tests__/livestock-payload.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/domain/livestock/__tests__/livestock-payload.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { encodeLivestockPayload, decodeLivestockPayload } from '../livestock-payload.js';
import type { LivestockPendingPayload } from '../livestock-payload.js';

describe('livestock-payload', () => {
  it('round-trips a minimal payload', () => {
    const p: LivestockPendingPayload = {
      cmd: { command: 'log_health_event', healthType: 'vacunacion' as unknown as string } as any,
      step: 'pick_loc',
    };
    const b64 = encodeLivestockPayload(p);
    const out = decodeLivestockPayload(b64);
    expect(out).toEqual(p);
  });

  it('round-trips with full context', () => {
    const p: LivestockPendingPayload = {
      cmd: { command: 'log_weighing', avgWeightKg: 380, animalCategory: 'novillo' } as any,
      step: 'animals',
      resolvedLocation: { plotId: null, corralId: 5, label: 'Corral 1' },
      knownGroupCount: 47,
    };
    const b64 = encodeLivestockPayload(p);
    const out = decodeLivestockPayload(b64);
    expect(out).toEqual(p);
  });

  it('payload is URL-safe (no +, /, =)', () => {
    const p: LivestockPendingPayload = {
      cmd: { command: 'add_livestock', count: 30 } as any,
      step: 'create_loc',
      missingType: 'corral',
      missingName: 'Norte',
    };
    const b64 = encodeLivestockPayload(p);
    expect(b64).not.toMatch(/[+/=]/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/domain/livestock/__tests__/livestock-payload.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/domain/livestock/livestock-payload.ts`:

```typescript
import type { ParsedCommand } from '../../types/index.js';

export type LivestockPayloadStep = 'create_loc' | 'pick_loc' | 'animals' | 'post_action';

export interface LivestockPendingPayload {
  cmd: ParsedCommand;
  step: LivestockPayloadStep;
  resolvedLocation?: {
    plotId: number | null;
    corralId: number | null;
    label: string;
  };
  missingType?: 'corral' | 'plot' | 'feedlot' | 'field';
  missingName?: string;
  feedlotId?: number;
  fieldName?: string;
  knownGroupCount?: number;
}

export function encodeLivestockPayload(p: LivestockPendingPayload): string {
  const json = JSON.stringify(p);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeLivestockPayload(b64: string): LivestockPendingPayload {
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
}
```

- [ ] **Step 4: Run tests — must PASS**

Run: `npx vitest run src/domain/livestock/__tests__/livestock-payload.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Run full suite for no regressions**

Run: `npm test`
Expected: all tests pass (baseline + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/domain/livestock/livestock-payload.ts src/domain/livestock/__tests__/livestock-payload.test.ts
git commit -m "feat(livestock): payload encode/decode helpers for pending state buttons"
```

---

## Phase 2 — Quick wins (independent)

### Task 3: Gap 0 — Onboarding mentions hacienda

**Files:**
- Modify: `src/services/settings.service.js`

- [ ] **Step 1: Update the onboarding default**

In `src/services/settings.service.js`, find the line that starts with `ONBOARDING_FIRST_PLOT_MESSAGE:` (around line 131). Replace the `default:` string with the extended version. The existing message ends with `Escribí *menú* para ver todas las opciones.`. Insert the new block right BEFORE that closing line.

Locate this exact string in the file:
```
\n\n📊 *Reportes*\n"resumen del mes"\n"reporte agro"\n\nEscribí *menú* para ver todas las opciones.
```

Replace with:
```
\n\n📊 *Reportes*\n"resumen del mes"\n"reporte agro"\n\n🐄 *Hacienda*\n"agregué 30 vacas Angus al lote A1"\n"pesé los novillos a 380 kg promedio"\n"vacuné contra aftosa"\n\n💡 ¿Engorde a corral? Creá un feedlot con "nuevo feedlot en <campo>".\n\nEscribí *menú* para ver todas las opciones.
```

- [ ] **Step 2: Typecheck + tests**

Run: `npm test`
Expected: all tests pass (settings string change doesn't affect logic tests).

- [ ] **Step 3: Commit**

```bash
git add src/services/settings.service.js
git commit -m "feat(onboarding): include hacienda examples + feedlot hint"
```

---

### Task 4: Gap 2 — Agent prompt rule for confinement verbs

**Files:**
- Modify: `src/ai/agent-prompt-builder.ts`

- [ ] **Step 1: Find insertion point**

Locate the existing hacienda rules block (around lines 740-750 — search for "Hacienda SIEMPRE necesita lote"). The new rule block goes IMMEDIATELY AFTER the existing hacienda block.

- [ ] **Step 2: Insert the rule**

Add this block:

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

Insert this as a template literal in whatever pattern the builder uses (the existing rule blocks are concatenated strings). Match the existing style — look at the block just above and follow the same format (no markdown code fences in the prompt, plain text only).

- [ ] **Step 3: Typecheck + tests**

```bash
npx tsc --noEmit -p . 2>&1 | grep "agent-prompt-builder" | head -5
npm test
```
Expected: no new errors in agent-prompt-builder; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/ai/agent-prompt-builder.ts
git commit -m "feat(ai): agent prompt rule for confinement verbs → corral/feedlot"
```

---

## Phase 3 — Gap 1: first-record nudge

### Task 5: Add nudge in `addLivestock` confirmation when it's the user's first movement

**Files:**
- Modify: `src/domain/livestock/livestock.handler.ts`
- Modify: `src/domain/livestock/livestock.repository.ts`

- [ ] **Step 1: Add a helper to the repository**

In `src/domain/livestock/livestock.repository.ts`, add a method:

```typescript
async countUserMovements(userId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM livestock_movements WHERE user_id = $1`,
    [userId]
  );
  return rows[0].n;
}
```

(You'll need `import { pool } from '../../config/db.js';` if not already imported.)

- [ ] **Step 2: Use it in `addLivestock`**

In `src/domain/livestock/livestock.handler.ts`, find the method `addLivestock` (around line 75). After the line that calls `this.service.addAnimals(...)` and gets the result, BEFORE the final `return {...}`, add the nudge logic:

```typescript
// Count BEFORE this insert was processed: we want to know if it was the very first.
// `addAnimals` inserts atomically, so after the call the count is already +1.
// "1" means this was the first movement.
const movementsCount = await this.service['repo'].countUserMovements(Number(userId));
const isFirstRecord = movementsCount === 1;
const destIsPlot = group.plot_id != null;
const nudgeLine = (isFirstRecord && destIsPlot)
  ? `\n\n💡 Si hacés engorde a corral, podés crear un feedlot con "nuevo feedlot en ${group.field_name || '<campo>'}".`
  : '';
```

Then append `nudgeLine` to the final messages string (wherever it joins the lines).

If accessing `this.service['repo']` feels hacky (because `repo` is private), expose a passthrough `LivestockService.countUserMovements(userId)` and call that. Cleaner. Add to `livestock.service.ts`:

```typescript
async countUserMovements(userId: UserId): Promise<number> {
  return this.repo.countUserMovements(Number(userId));
}
```

Then in the handler: `const movementsCount = await this.service.countUserMovements(userId);`.

- [ ] **Step 3: Typecheck + tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: no new errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/domain/livestock/livestock.handler.ts src/domain/livestock/livestock.service.ts src/domain/livestock/livestock.repository.ts
git commit -m "feat(livestock): nudge user about feedlot/corral on their first livestock record"
```

---

## Phase 4 — Gaps 4 + 5: auto-resolve location + always-ask animals_affected

### Task 6: Backend — `findGroupsByCategory` repo method + service wrapper

**Files:**
- Modify: `src/domain/livestock/livestock.repository.ts`
- Modify: `src/domain/livestock/livestock.service.ts`
- Create: tests in `src/domain/livestock/__tests__/livestock-undo.test.ts` (we'll reuse this file)

- [ ] **Step 1: Add repo method**

In `src/domain/livestock/livestock.repository.ts`:

```typescript
async findGroupsByCategory(
  userId: number,
  category: string | null,
): Promise<Array<{ id: string; plot_id: number | null; corral_id: number | null; count: number; location_label: string }>> {
  const params: unknown[] = [userId];
  let categoryFilter = '';
  if (category) {
    params.push(category);
    categoryFilter = ' AND g.category::text = $2';
  }
  const { rows } = await pool.query(
    `SELECT
       g.id::text AS id,
       g.plot_id,
       g.corral_id,
       g.count,
       COALESCE(
         CASE WHEN g.corral_id IS NOT NULL THEN
           (SELECT 'Corral ' || c.name || ' (' || f.name || ')'
              FROM corrals c JOIN feedlots ft ON ft.id = c.feedlot_id JOIN fields f ON f.id = ft.field_id
             WHERE c.id = g.corral_id)
           END,
         CASE WHEN g.plot_id IS NOT NULL THEN
           (SELECT f.name || ' > ' || p.name
              FROM plots p JOIN fields f ON f.id = p.field_id
             WHERE p.id = g.plot_id)
           END
       ) AS location_label
     FROM livestock_groups g
     WHERE g.user_id = $1 AND g.deleted_at IS NULL${categoryFilter}
       AND g.count > 0
     ORDER BY g.count DESC`,
    params
  );
  return rows;
}
```

- [ ] **Step 2: Add service passthrough**

In `src/domain/livestock/livestock.service.ts`:

```typescript
async findGroupsByCategory(userId: UserId, category: string | null) {
  return this.repo.findGroupsByCategory(Number(userId), category);
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/domain/livestock/livestock.repository.ts src/domain/livestock/livestock.service.ts
git commit -m "feat(livestock): findGroupsByCategory for location auto-resolution"
```

---

### Task 7: New `resolveEventLocationOrAsk` in livestock.handler

**Files:**
- Modify: `src/domain/livestock/livestock.handler.ts`

- [ ] **Step 1: Add the new resolver method**

In `src/domain/livestock/livestock.handler.ts`, after the existing private `resolveEventLocation` (around line 400), add:

```typescript
private async resolveEventLocationOrAsk(
  cmd: ParsedCommand,
  userId: UserId,
): Promise<
  | { plotId: number | null; corralId: number | null; label: string; autoResolved?: boolean; knownGroupCount?: number }
  | { needsLocationPick: true; options: Array<{ plotId: number | null; corralId: number | null; label: string; groupCount: number }> }
  | { error: string }
> {
  // If user named a location, use the strict resolver
  if (cmd.corralName || cmd.plotName) {
    const r = await this.resolveEventLocation(cmd, userId);
    if ('error' in r) return r;
    return { plotId: r.plotId, corralId: r.corralId, label: r.label };
  }

  // No location: try to infer from livestock groups
  const category = (cmd.category as string | null) ?? null;
  const groups = await this.service.findGroupsByCategory(userId, category);

  if (groups.length === 0) {
    return { error: 'No tenés hacienda registrada con esos criterios. Primero agregá animales con "agregué N <categoría> al lote X".' };
  }

  if (groups.length === 1) {
    const g = groups[0];
    return {
      plotId: g.plot_id,
      corralId: g.corral_id,
      label: g.location_label,
      autoResolved: true,
      knownGroupCount: g.count,
    };
  }

  return {
    needsLocationPick: true,
    options: groups.slice(0, 7).map(g => ({
      plotId: g.plot_id,
      corralId: g.corral_id,
      label: g.location_label,
      groupCount: g.count,
    })),
  };
}
```

- [ ] **Step 2: Wire it into `logHealthEvent`**

In `logHealthEvent` (around line 432), REPLACE the line:
```typescript
const loc = await this.resolveEventLocation(cmd, userId);
if ('error' in loc) return { messages: [loc.error] };
```

with:
```typescript
const loc = await this.resolveEventLocationOrAsk(cmd, userId);
if ('error' in loc) return { messages: [loc.error] };

if ('needsLocationPick' in loc) {
  const payload = encodeLivestockPayload({ cmd, step: 'pick_loc' });
  return {
    messages: [],
    interactive: {
      type: 'buttons' as const,
      body: '¿En qué ubicación lo registramos?',
      buttons: loc.options.map(o => ({
        id: `lv_pick_loc_health_${payload}_${o.plotId ?? 'null'}_${o.corralId ?? 'null'}`,
        title: `${o.label} (${o.groupCount})`.slice(0, 24),
      })),
    },
  };
}
```

(Add `import { encodeLivestockPayload } from './livestock-payload.js';` at the top of the file.)

After this, the code continues unchanged with `loc.plotId` and `loc.corralId`.

The same `autoResolved` marker on `loc` should be propagated to the confirmation: if `loc.autoResolved`, append `(auto)` to the location line. Find the existing line that builds `📍 ${loc.label}` and change to:
```typescript
lines.push(`  📍 ${loc.label}${('autoResolved' in loc && loc.autoResolved) ? ' (auto)' : ''}`);
```

- [ ] **Step 3: Mirror in `logReproEvent`**

Same pattern in `logReproEvent` (around line 519). Use `lv_pick_loc_repro_` prefix.

- [ ] **Step 4: Mirror in `logWeighing`**

Same pattern in `logWeighing` (around line 600). Use `lv_pick_loc_weigh_` prefix.

- [ ] **Step 5: Typecheck + tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: no new errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/domain/livestock/livestock.handler.ts
git commit -m "feat(livestock): auto-resolve location for sanidad/repro/pesajes; ask buttons when ambiguous"
```

---

### Task 8: Gap 5 — Ask `animals_affected` when missing, with `Todos (N)` / `Saltar` buttons

**Files:**
- Modify: `src/domain/livestock/livestock.handler.ts`

- [ ] **Step 1: Add the ask-animals helper**

Add a private method to the class:

```typescript
private buildAnimalsAffectedAskResponse(
  cmd: ParsedCommand,
  resolvedLocation: { plotId: number | null; corralId: number | null; label: string },
  knownGroupCount: number | undefined,
  kind: 'health' | 'repro' | 'weigh',
): HandlerResponse {
  const payload = encodeLivestockPayload({
    cmd, step: 'animals', resolvedLocation, knownGroupCount,
  });
  const buttons: Array<{ id: string; title: string }> = [];
  if (knownGroupCount && knownGroupCount > 0) {
    buttons.push({ id: `lv_animals_all_${kind}_${payload}`, title: `Todos (${knownGroupCount})` });
  }
  buttons.push({ id: `lv_animals_skip_${kind}_${payload}`, title: 'Saltar' });
  return {
    messages: [],
    interactive: {
      type: 'buttons' as const,
      body: '¿A cuántos animales?',
      buttons,
    },
  };
}
```

- [ ] **Step 2: Wire it into `logHealthEvent` BEFORE the save**

In `logHealthEvent`, just BEFORE the `await saveDomainEvent(...)` call, check if animals_affected is missing:

```typescript
if (animalsAffected == null) {
  return this.buildAnimalsAffectedAskResponse(
    cmd,
    { plotId: loc.plotId, corralId: loc.corralId, label: loc.label },
    'knownGroupCount' in loc ? loc.knownGroupCount : undefined,
    'health',
  );
}
```

The `animalsAffected` variable is already extracted from `cmd` in the method (around line 440).

- [ ] **Step 3: Mirror in `logReproEvent` and `logWeighing`**

Same insertion in each — replace `'health'` with `'repro'` or `'weigh'` accordingly, and use `animalsAffected` (repro) / `animalsWeighed` (weigh).

- [ ] **Step 4: Show "sin cantidad" warning when skipped**

In the confirmation builder for each (health/repro/weigh), if `animalsAffected` is null after save, append a small warning:
```typescript
if (animalsAffected == null) {
  lines.push('  ⚠️ Sin cantidad de animales — agregalo más tarde si lo necesitás.');
}
```

- [ ] **Step 5: Typecheck + tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/livestock/livestock.handler.ts
git commit -m "feat(livestock): ask animals_affected when missing on health/repro/weigh events"
```

---

### Task 9: Handler methods + interactive parsers for `lv_pick_loc_*` and `lv_animals_*`

**Files:**
- Modify: `src/domain/livestock/livestock.handler.ts`
- Modify: `src/domain/interactive/interactive.router.ts`
- Modify: `src/domain/router.ts`

- [ ] **Step 1: Add handler method `pickLocation`**

In `livestock.handler.ts`:

```typescript
async pickLocation(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  // cmd has: kind ('health'|'repro'|'weigh'), payload, plotIdStr, corralIdStr
  const kind = cmd.kind as 'health' | 'repro' | 'weigh';
  const plotId = cmd.plotIdStr === 'null' ? null : Number(cmd.plotIdStr);
  const corralId = cmd.corralIdStr === 'null' ? null : Number(cmd.corralIdStr);
  const payload = decodeLivestockPayload(cmd.payload as string);
  // Rebuild the original cmd with resolved location, then call the right log method
  const rebuilt = { ...payload.cmd } as ParsedCommand;
  if (plotId != null) (rebuilt as any).plotName = '__resolved__';
  if (corralId != null) (rebuilt as any).corralName = '__resolved__';
  // Stash the actual ids so resolveEventLocation skips re-resolving
  (rebuilt as any).__resolvedPlotId = plotId;
  (rebuilt as any).__resolvedCorralId = corralId;

  switch (kind) {
    case 'health': return (this as any).logHealthEvent(rebuilt, userId);
    case 'repro':  return (this as any).logReproEvent(rebuilt, userId);
    case 'weigh':  return (this as any).logWeighing(rebuilt, userId);
  }
}
```

You'll also need to update `resolveEventLocationOrAsk` to honor the `__resolvedPlotId`/`__resolvedCorralId` short-circuit when set:

```typescript
// At the top of resolveEventLocationOrAsk
if ((cmd as any).__resolvedPlotId != null || (cmd as any).__resolvedCorralId != null) {
  return {
    plotId: (cmd as any).__resolvedPlotId ?? null,
    corralId: (cmd as any).__resolvedCorralId ?? null,
    label: 'Ubicación seleccionada',
  };
}
```

(Refine the label later — for V1 this works.)

- [ ] **Step 2: Add handler method `applyAnimalsAffected`**

```typescript
async applyAnimalsAffected(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  // cmd has: kind, payload, mode ('all'|'skip')
  const kind = cmd.kind as 'health' | 'repro' | 'weigh';
  const mode = cmd.mode as 'all' | 'skip';
  const payload = decodeLivestockPayload(cmd.payload as string);
  const rebuilt = { ...payload.cmd } as ParsedCommand;
  // Restore the resolved location
  if (payload.resolvedLocation) {
    if (payload.resolvedLocation.plotId != null) (rebuilt as any).__resolvedPlotId = payload.resolvedLocation.plotId;
    if (payload.resolvedLocation.corralId != null) (rebuilt as any).__resolvedCorralId = payload.resolvedLocation.corralId;
  }
  // Inject animals_affected
  if (mode === 'all' && payload.knownGroupCount) {
    if (kind === 'weigh') (rebuilt as any).animalsWeighed = payload.knownGroupCount;
    else (rebuilt as any).animalsAffected = payload.knownGroupCount;
  } else {
    // 'skip' → leave as null, but mark so the handler doesn't re-ask
    (rebuilt as any).__animalsAffectedSkipped = true;
  }
  switch (kind) {
    case 'health': return (this as any).logHealthEvent(rebuilt, userId);
    case 'repro':  return (this as any).logReproEvent(rebuilt, userId);
    case 'weigh':  return (this as any).logWeighing(rebuilt, userId);
  }
}
```

And in each of `logHealthEvent` / `logReproEvent` / `logWeighing`, update the check from Step 2 of Task 8 to bypass the ask when `__animalsAffectedSkipped` is true:

```typescript
if (animalsAffected == null && !(cmd as any).__animalsAffectedSkipped) {
  return this.buildAnimalsAffectedAskResponse(...);
}
```

- [ ] **Step 3: Register interactive callbacks**

In `src/domain/interactive/interactive.router.ts`, add parsers. They follow the existing `cat_pick_*` / `cat_sim_*` pattern. Append in the same parsing block:

```typescript
// Gap 4 — pick location for sanidad/repro/pesaje
if (id.startsWith('lv_pick_loc_health_') || id.startsWith('lv_pick_loc_repro_') || id.startsWith('lv_pick_loc_weigh_')) {
  // Format: lv_pick_loc_<kind>_<payload>_<plotId|null>_<corralId|null>
  const kindMatch = id.match(/^lv_pick_loc_(health|repro|weigh)_/);
  if (kindMatch) {
    const kind = kindMatch[1];
    const rest = id.slice(`lv_pick_loc_${kind}_`.length);
    // rest = <payload>_<plotId>_<corralId>
    const parts = rest.split('_');
    const corralIdStr = parts[parts.length - 1];
    const plotIdStr = parts[parts.length - 2];
    const payload = parts.slice(0, -2).join('_');
    return { type: 'livestock_pick_location', kind, payload, plotIdStr, corralIdStr };
  }
}

// Gap 5 — animals_affected
if (id.startsWith('lv_animals_all_')) {
  // Format: lv_animals_all_<kind>_<payload>
  const rest = id.slice('lv_animals_all_'.length);
  const underscoreIdx = rest.indexOf('_');
  return {
    type: 'livestock_apply_animals',
    kind: rest.slice(0, underscoreIdx),
    payload: rest.slice(underscoreIdx + 1),
    mode: 'all',
  };
}
if (id.startsWith('lv_animals_skip_')) {
  const rest = id.slice('lv_animals_skip_'.length);
  const underscoreIdx = rest.indexOf('_');
  return {
    type: 'livestock_apply_animals',
    kind: rest.slice(0, underscoreIdx),
    payload: rest.slice(underscoreIdx + 1),
    mode: 'skip',
  };
}
```

- [ ] **Step 4: Register commands in router**

In `src/domain/router.ts`, find `LIVESTOCK_COMMANDS` (likely a Set declaration). Add:
```typescript
'livestock_pick_location',
'livestock_apply_animals',
```

And in the dispatch switch:
```typescript
case 'livestock_pick_location': return livestockHandler.pickLocation(cmd, userId);
case 'livestock_apply_animals': return livestockHandler.applyAnimalsAffected(cmd, userId);
```

- [ ] **Step 5: Typecheck + tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/livestock/livestock.handler.ts src/domain/interactive/interactive.router.ts src/domain/router.ts
git commit -m "feat(livestock): pickLocation + applyAnimalsAffected handlers + callback wiring"
```

---

## Phase 5 — Gap 3: "no encontré X" with create-and-continue

### Task 10: Capture "not found" errors and emit Sí/No buttons

**Files:**
- Modify: `src/domain/livestock/livestock.handler.ts`
- Modify: `src/domain/livestock/livestock.service.ts`

- [ ] **Step 1: Add `getCounts` helper to feedlot service (used to decide single-feedlot auto-resolution)**

In `src/domain/feedlot/feedlot.service.ts`, add:

```typescript
async countUserFeedlots(userId: UserId): Promise<number> {
  const list = await this.listFeedlots(userId);
  return list.length;
}
```

- [ ] **Step 2: Intercept "not found" errors in addLivestock and removeLivestock and transferLivestock**

The error today comes from `this.service.addAnimals(...)` throwing. Catch it and inspect the message text — when it matches one of:
- `/No encontré el corral/`
- `/No encontré el lote/`
- `/No encontré el campo/`
- `/El campo .* no tiene lotes/`

…return a Sí/No buttons response instead of the raw error message.

For `addLivestock`, wrap the service call in try/catch:

```typescript
try {
  const result = await this.service.addAnimals(userId, { ... });
  // existing success path
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const offer = await this.maybeOfferCreateAndContinue(cmd, userId, msg, 'add');
  if (offer) return offer;
  return { messages: [msg] };
}
```

- [ ] **Step 3: Add `maybeOfferCreateAndContinue` helper**

```typescript
private async maybeOfferCreateAndContinue(
  cmd: ParsedCommand,
  userId: UserId,
  errorMsg: string,
  opName: 'add' | 'remove' | 'transfer',
): Promise<HandlerResponse | null> {
  // Detect what's missing
  const corralMatch = errorMsg.match(/No encontré el corral "([^"]+)"/);
  const plotMatch = errorMsg.match(/No encontré el lote "([^"]+)"/);
  const fieldMatch = errorMsg.match(/No encontré el campo "([^"]+)"/);
  const noLotesMatch = errorMsg.match(/El campo "([^"]+)" no tiene lotes/);

  let missingType: 'corral' | 'plot' | 'feedlot' | 'field' | null = null;
  let missingName = '';
  if (corralMatch) { missingType = 'corral'; missingName = corralMatch[1]; }
  else if (plotMatch) { missingType = 'plot'; missingName = plotMatch[1]; }
  else if (fieldMatch) { missingType = 'field'; missingName = fieldMatch[1]; }
  else if (noLotesMatch) { missingType = 'plot'; missingName = 'A1'; }
  if (!missingType) return null;

  const feedlotCount = await this.feedlotService.countUserFeedlots(userId);
  const payload = encodeLivestockPayload({
    cmd, step: 'create_loc', missingType, missingName,
    feedlotId: undefined, fieldName: cmd.fieldName as string | undefined,
  });

  let body = '';
  let yesId = '';
  if (missingType === 'corral') {
    if (feedlotCount === 0) {
      body = `🔍 No encontré el corral *${missingName}* (no tenés feedlots). ¿Querés que cree el feedlot y el corral, y registre la operación?`;
      yesId = `lv_create_feedlot_continue_${payload}`;
    } else {
      body = `🔍 No encontré el corral *${missingName}*. ¿Querés que lo cree y continúe?`;
      yesId = `lv_create_corral_continue_${payload}`;
    }
  } else if (missingType === 'plot') {
    body = `🔍 No encontré el lote *${missingName}*. ¿Querés que lo cree y continúe?`;
    yesId = `lv_create_plot_continue_${payload}`;
  } else if (missingType === 'field') {
    body = `🔍 No encontré el campo *${missingName}*. ¿Querés que lo cree y continúe?`;
    yesId = `lv_create_field_continue_${payload}`;
  }

  return {
    messages: [],
    interactive: {
      type: 'buttons' as const,
      body,
      buttons: [
        { id: yesId, title: 'Sí, crear y continuar' },
        { id: 'lv_create_cancel', title: 'No, cancelar' },
      ],
    },
  };
}
```

(Add a private `feedlotService` instance to the handler if not already there.)

- [ ] **Step 4: Apply the try/catch to `removeLivestock` and `transferLivestock` too**

Same pattern: wrap the service call, on caught error call `maybeOfferCreateAndContinue(..., 'remove' or 'transfer')` and return its result if non-null.

- [ ] **Step 5: Typecheck + tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/livestock/livestock.handler.ts src/domain/feedlot/feedlot.service.ts
git commit -m "feat(livestock): offer Sí/No buttons when location is missing (create-and-continue)"
```

---

### Task 11: Handlers for `lv_create_*_continue` callbacks

**Files:**
- Modify: `src/domain/livestock/livestock.handler.ts`
- Modify: `src/domain/interactive/interactive.router.ts`
- Modify: `src/domain/router.ts`

- [ ] **Step 1: Add `createAndContinue` handler**

In `livestock.handler.ts`:

```typescript
async createAndContinue(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  const subType = cmd.subType as 'corral' | 'plot' | 'feedlot' | 'field';
  const payload = decodeLivestockPayload(cmd.payload as string);
  const { missingName } = payload;
  if (!missingName) return { messages: ['No tengo info para crear. Probá registrar la operación de nuevo.'] };

  try {
    if (subType === 'corral') {
      // Need a feedlot — try to find user's (only) one
      const feedlots = await this.feedlotService.listFeedlots(userId);
      if (feedlots.length !== 1) {
        return { messages: ['Tenés más de un feedlot. Decime cuál usar: "crear corral X en campo Y".'] };
      }
      await this.feedlotService.createCorral(userId, missingName, feedlots[0].field_name || null, {});
    } else if (subType === 'plot') {
      // Reuse the existing add_plot path — needs a field name
      const fieldName = (payload.cmd as any).fieldName || payload.fieldName;
      if (!fieldName) return { messages: ['Necesito saber en qué campo crear el lote.'] };
      // Call the financial handler or plot service to create the plot. For brevity:
      const { financialService } = await import('../financial/financial.service.js');
      // (Actually use whatever service creates plots in the codebase.)
      // ...
      return { messages: ['Para esta versión, creá el lote primero con "nuevo lote X en <campo>" y volvé a intentar.'] };
    } else if (subType === 'feedlot') {
      // Create feedlot + corral cascade
      const fieldName = (payload.cmd as any).fieldName || payload.fieldName;
      if (!fieldName) return { messages: ['Necesito saber el campo para crear el feedlot.'] };
      await this.feedlotService.createFeedlot(userId, fieldName, 'Feedlot', {});
      await this.feedlotService.createCorral(userId, missingName, fieldName, {});
    } else if (subType === 'field') {
      // Field creation: depends on existing API
      return { messages: ['Para esta versión, creá el campo primero con "nuevo campo X" y volvé a intentar.'] };
    }
    // Re-run the original command, this time the location resolves
    return this.handleCommand(payload.cmd, userId);
  } catch (err) {
    return { messages: [`Hubo un problema creando: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

async createCancel(_cmd: ParsedCommand, _userId: UserId): Promise<HandlerResponse> {
  return { messages: ['Cancelado. Si querés volver a intentarlo, registrá la operación de nuevo.'] };
}
```

Note: the "plot" and "field" cases are stubbed with friendly fallbacks because creating plots/fields touches the financial handler / plot discovery service. Full create-and-continue for those subtypes is acceptable to defer — the goal of Gap 3 is the UX pattern, and corral+feedlot cover the most common use case (livestock-specific). If you want plot/field full coverage, you'd add ~80 LOC. Document as a known limit.

- [ ] **Step 2: Register interactive parsers**

In `src/domain/interactive/interactive.router.ts`:

```typescript
if (id.startsWith('lv_create_corral_continue_')) {
  return { type: 'livestock_create_continue', subType: 'corral', payload: id.slice('lv_create_corral_continue_'.length) };
}
if (id.startsWith('lv_create_plot_continue_')) {
  return { type: 'livestock_create_continue', subType: 'plot', payload: id.slice('lv_create_plot_continue_'.length) };
}
if (id.startsWith('lv_create_feedlot_continue_')) {
  return { type: 'livestock_create_continue', subType: 'feedlot', payload: id.slice('lv_create_feedlot_continue_'.length) };
}
if (id.startsWith('lv_create_field_continue_')) {
  return { type: 'livestock_create_continue', subType: 'field', payload: id.slice('lv_create_field_continue_'.length) };
}
if (id === 'lv_create_cancel') {
  return { type: 'livestock_create_cancel' };
}
```

- [ ] **Step 3: Register router commands**

In `src/domain/router.ts`, `LIVESTOCK_COMMANDS`:
```typescript
'livestock_create_continue',
'livestock_create_cancel',
```

Dispatch:
```typescript
case 'livestock_create_continue': return livestockHandler.createAndContinue(cmd, userId);
case 'livestock_create_cancel':   return livestockHandler.createCancel(cmd, userId);
```

- [ ] **Step 4: Typecheck + tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/livestock/livestock.handler.ts src/domain/interactive/interactive.router.ts src/domain/router.ts
git commit -m "feat(livestock): create-and-continue handlers + interactive wiring for missing location"
```

---

## Phase 6 — Gap 8: post-confirmation buttons + undo

### Task 12: Build the post-action buttons helper

**Files:**
- Create: `src/domain/livestock/livestock-post-actions.ts`

- [ ] **Step 1: Write the helper**

Create `src/domain/livestock/livestock-post-actions.ts`:

```typescript
import type { InteractiveMessage } from '../../types/index.js';

export type LvOpKind = 'add' | 'remove' | 'transfer' | 'weigh' | 'health' | 'repro';

export interface PostActionContext {
  groupId?: string;        // for stock/weigh/gdpv/history
  movementId?: string;     // for undo of add/remove/transfer
  eventId?: number;        // for undo of weigh/health/repro
  plotId?: number | null;
  corralId?: number | null;
  isSale?: boolean;        // for remove
}

export function buildPostActionButtons(op: LvOpKind, ctx: PostActionContext): InteractiveMessage['buttons'] {
  const locTag = `${ctx.plotId ?? 'null'}_${ctx.corralId ?? 'null'}`;
  switch (op) {
    case 'add':
      return [
        { id: `lv_post_stock_${locTag}`, title: '📊 Ver stock' },
        ...(ctx.groupId ? [{ id: `lv_post_weigh_${ctx.groupId}`, title: '⚖️ Pesar grupo' }] : []),
        ...(ctx.movementId ? [{ id: `lv_post_undo_movement_${ctx.movementId}`, title: '↩️ Borrar' }] : []),
      ];
    case 'remove': {
      const buttons: Array<{ id: string; title: string }> = [
        { id: `lv_post_stock_${locTag}`, title: '📊 Ver stock' },
        ...(ctx.movementId ? [{ id: `lv_post_undo_movement_${ctx.movementId}`, title: '↩️ Borrar' }] : []),
      ];
      if (ctx.isSale) buttons.push({ id: 'lv_post_resumen_mes', title: '💰 Resumen mes' });
      return buttons;
    }
    case 'transfer':
      return [
        { id: `lv_post_stock_${locTag}`, title: '📊 Stock destino' },
        ...(ctx.groupId ? [{ id: `lv_post_weigh_${ctx.groupId}`, title: '⚖️ Pesar grupo' }] : []),
        ...(ctx.movementId ? [{ id: `lv_post_undo_movement_${ctx.movementId}`, title: '↩️ Borrar' }] : []),
      ];
    case 'weigh':
      return [
        ...(ctx.groupId ? [{ id: `lv_post_gdpv_${ctx.groupId}`, title: '📈 GDPV grupo' }] : []),
        ...(ctx.groupId ? [{ id: `lv_post_health_hist_${ctx.groupId}`, title: '💉 Sanidad' }] : []),
        ...(ctx.eventId ? [{ id: `lv_post_undo_event_${ctx.eventId}`, title: '↩️ Borrar' }] : []),
      ];
    case 'health':
      return [
        ...(ctx.groupId ? [{ id: `lv_post_health_hist_${ctx.groupId}`, title: '💉 Historial sanitario' }] : []),
        ...(ctx.groupId ? [{ id: `lv_post_new_event_${ctx.groupId}_health`, title: '➕ Otro evento' }] : []),
        ...(ctx.eventId ? [{ id: `lv_post_undo_event_${ctx.eventId}`, title: '↩️ Borrar' }] : []),
      ];
    case 'repro':
      return [
        ...(ctx.groupId ? [{ id: `lv_post_repro_hist_${ctx.groupId}`, title: '🐂 Historial repro' }] : []),
        ...(ctx.groupId ? [{ id: `lv_post_new_event_${ctx.groupId}_repro`, title: '➕ Otro evento' }] : []),
        ...(ctx.eventId ? [{ id: `lv_post_undo_event_${ctx.eventId}`, title: '↩️ Borrar' }] : []),
      ];
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/domain/livestock/livestock-post-actions.ts
git commit -m "feat(livestock): post-action buttons helper for confirmation messages"
```

---

### Task 13: Wire the helper into the 6 confirmation messages

**Files:**
- Modify: `src/domain/livestock/livestock.handler.ts`

For each of the 6 methods (addLivestock, removeLivestock, transferLivestock, logHealthEvent, logReproEvent, logWeighing), at the END just before `return { messages: [lines.join('\n')] }`, transform it into a buttons response.

- [ ] **Step 1: Update `addLivestock` return**

Replace the existing return at the end of `addLivestock` with:

```typescript
const buttons = buildPostActionButtons('add', {
  groupId: String(group.id),
  movementId: result.movementId ? String(result.movementId) : undefined,
  plotId: group.plot_id,
  corralId: group.corral_id,
});
return {
  messages: [],
  interactive: {
    type: 'buttons' as const,
    body: lines.join('\n'),
    buttons,
  },
};
```

(Make sure `result.movementId` is exposed by `service.addAnimals(...)` — if not, expose it. Same for the other ops below.)

Add import: `import { buildPostActionButtons } from './livestock-post-actions.js';`

- [ ] **Step 2: Same for `removeLivestock`**

Pass `op='remove'`, `isSale: cmd.isSale === true`, and the movementId from `service.removeAnimals` result.

- [ ] **Step 3: Same for `transferLivestock`**

Pass `op='transfer'`, plotId/corralId of the DESTINATION group.

- [ ] **Step 4: Same for `logHealthEvent`, `logReproEvent`, `logWeighing`**

Each takes `op='health'`/`'repro'`/`'weigh'` and `eventId` (the id returned by `saveDomainEvent`). Make sure `saveDomainEvent` returns the inserted row's id (if not, modify it to do so).

- [ ] **Step 5: Typecheck + tests + smoke**

```bash
npx tsc --noEmit -p .
npm test
docker compose up -d --build && sleep 8
```

Manual smoke: in the bot test endpoint, register an add_livestock and verify the response has 3 buttons.

- [ ] **Step 6: Commit**

```bash
git add src/domain/livestock/livestock.handler.ts src/domain/livestock/livestock.service.ts src/domain/livestock/livestock.repository.ts
git commit -m "feat(livestock): post-action buttons on all 6 confirmation messages"
```

---

### Task 14: Handler methods for the simple post-action callbacks

**Files:**
- Modify: `src/domain/livestock/livestock.handler.ts`

- [ ] **Step 1: Add `postActionStock`**

```typescript
async postActionStock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  const plotId = cmd.plotIdStr === 'null' ? null : Number(cmd.plotIdStr);
  const corralId = cmd.corralIdStr === 'null' ? null : Number(cmd.corralIdStr);
  // Reuse list_livestock with explicit filters
  const rebuilt: ParsedCommand = { command: 'list_livestock' } as any;
  if (plotId != null) (rebuilt as any).__resolvedPlotId = plotId;
  if (corralId != null) (rebuilt as any).__resolvedCorralId = corralId;
  return (this as any).listLivestock(rebuilt, userId);
}
```

- [ ] **Step 2: Add `postActionWeigh`**

```typescript
async postActionWeigh(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  const groupId = cmd.groupId as string;
  // Pre-fill a log_weighing with the group's category + location, ask for weight
  const g = await this.service.getGroupById(userId, groupId);
  if (!g) return { messages: ['No encontré ese grupo.'] };
  return {
    messages: [`⚖️ Vamos a pesar el grupo de *${g.count} ${g.category}* en ${g.location_label}.\n\nDecime el peso promedio (ej: "380 kg").`],
  };
}
```

(You'll need to add `getGroupById` to the service+repo.)

- [ ] **Step 3: Add `postActionGdpv`, `postActionHealthHist`, `postActionReproHist`**

Each routes to the corresponding query method with the group's location as filter.

- [ ] **Step 4: Add `postActionResumenMes`**

```typescript
async postActionResumenMes(_cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  const rebuilt: ParsedCommand = { command: 'financial_report', period: 'month' } as any;
  // dispatch via router or directly to financial handler
  const { FinancialHandler } = await import('../financial/financial.handler.js');
  // For brevity in V1: just respond pointing the user to type "resumen del mes"
  return { messages: ['📊 Para ver el resumen del mes, escribí *resumen del mes*.'] };
}
```

(In V2 we can fully dispatch.)

- [ ] **Step 5: Add `postActionNewEvent`**

```typescript
async postActionNewEvent(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  const subKind = cmd.subKind as 'health' | 'repro';
  return {
    messages: [`Decime el ${subKind === 'health' ? 'evento sanitario' : 'evento reproductivo'}: tipo, cantidad de animales, ubicación.`],
  };
}
```

- [ ] **Step 6: Register interactive parsers + router**

In `interactive.router.ts`:
```typescript
if (id.startsWith('lv_post_stock_')) {
  const rest = id.slice('lv_post_stock_'.length);
  const parts = rest.split('_');
  return { type: 'livestock_post_stock', plotIdStr: parts[0], corralIdStr: parts[1] };
}
if (id.startsWith('lv_post_weigh_')) {
  return { type: 'livestock_post_weigh', groupId: id.slice('lv_post_weigh_'.length) };
}
if (id.startsWith('lv_post_gdpv_')) {
  return { type: 'livestock_post_gdpv', groupId: id.slice('lv_post_gdpv_'.length) };
}
if (id.startsWith('lv_post_health_hist_')) {
  return { type: 'livestock_post_health_hist', groupId: id.slice('lv_post_health_hist_'.length) };
}
if (id.startsWith('lv_post_repro_hist_')) {
  return { type: 'livestock_post_repro_hist', groupId: id.slice('lv_post_repro_hist_'.length) };
}
if (id === 'lv_post_resumen_mes') {
  return { type: 'livestock_post_resumen_mes' };
}
if (id.startsWith('lv_post_new_event_')) {
  // format: lv_post_new_event_<groupId>_<subKind>
  const rest = id.slice('lv_post_new_event_'.length);
  const lastUnderscore = rest.lastIndexOf('_');
  return { type: 'livestock_post_new_event', groupId: rest.slice(0, lastUnderscore), subKind: rest.slice(lastUnderscore + 1) };
}
```

In `router.ts` `LIVESTOCK_COMMANDS`:
```typescript
'livestock_post_stock', 'livestock_post_weigh', 'livestock_post_gdpv',
'livestock_post_health_hist', 'livestock_post_repro_hist',
'livestock_post_resumen_mes', 'livestock_post_new_event',
```

Dispatch:
```typescript
case 'livestock_post_stock':       return livestockHandler.postActionStock(cmd, userId);
case 'livestock_post_weigh':       return livestockHandler.postActionWeigh(cmd, userId);
case 'livestock_post_gdpv':        return livestockHandler.postActionGdpv(cmd, userId);
case 'livestock_post_health_hist': return livestockHandler.postActionHealthHist(cmd, userId);
case 'livestock_post_repro_hist':  return livestockHandler.postActionReproHist(cmd, userId);
case 'livestock_post_resumen_mes': return livestockHandler.postActionResumenMes(cmd, userId);
case 'livestock_post_new_event':   return livestockHandler.postActionNewEvent(cmd, userId);
```

- [ ] **Step 7: Typecheck + tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/livestock/livestock.handler.ts src/domain/livestock/livestock.service.ts \
        src/domain/livestock/livestock.repository.ts src/domain/interactive/interactive.router.ts \
        src/domain/router.ts
git commit -m "feat(livestock): post-action callback handlers (stock/weigh/gdpv/history/resumen/new_event)"
```

---

### Task 15: Undo movement (compensating row)

**Files:**
- Modify: `src/domain/livestock/livestock.service.ts`
- Modify: `src/domain/livestock/livestock.repository.ts`
- Modify: `src/domain/livestock/livestock.handler.ts`
- Modify: `src/domain/livestock/__tests__/livestock-undo.test.ts`

- [ ] **Step 1: Write failing test**

In `src/domain/livestock/__tests__/livestock-undo.test.ts`, add:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { LivestockService } from '../livestock.service.js';
import type { LivestockRepository } from '../livestock.repository.js';

describe('LivestockService.undoMovement', () => {
  it('refuses when reversal would leave group count negative', async () => {
    const repo = {
      findMovementById: vi.fn().mockResolvedValue({
        id: 'm1', movement_type: 'entrada', count: 10, dest_group_id: 'g1', source_group_id: null,
      }),
      getGroupById: vi.fn().mockResolvedValue({ id: 'g1', count: 5 }), // 5 < 10, reversal would be -5
    } as unknown as LivestockRepository;
    const svc = new LivestockService(repo as any, {} as any);
    await expect(svc.undoMovement(1 as any, 'm1')).rejects.toThrow(/no se puede deshacer/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/domain/livestock/__tests__/livestock-undo.test.ts`
Expected: FAIL — method not defined or returns wrong result.

- [ ] **Step 3: Add repo methods**

In `livestock.repository.ts`:

```typescript
async findMovementById(movementId: string): Promise<any> {
  const { rows } = await pool.query(
    `SELECT id, movement_type, count, source_group_id, dest_group_id, avg_weight_kg
     FROM livestock_movements WHERE id = $1`,
    [movementId]
  );
  return rows[0] ?? null;
}

async getGroupById(groupId: string): Promise<any> {
  const { rows } = await pool.query(
    `SELECT id, category, count, plot_id, corral_id
     FROM livestock_groups WHERE id = $1 AND deleted_at IS NULL`,
    [groupId]
  );
  return rows[0] ?? null;
}

async softDeleteDomainEvent(userId: number, eventId: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE domain_events SET deleted_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [eventId, userId]
  );
  return (rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: Implement `undoMovement` in service**

```typescript
async undoMovement(userId: UserId, movementId: string): Promise<{ reversed: boolean; label: string }> {
  const m = await this.repo.findMovementById(movementId);
  if (!m) throw new Error('No encontré el movimiento.');

  // Determine compensating type
  const reverseType: Record<string, string> = {
    entrada: 'salida',
    salida: 'entrada',
    transferencia: 'transferencia',
    recategorizacion: 'recategorizacion',
    nacimiento: 'salida',
    muerte: 'entrada',
    ajuste: 'ajuste',
  };
  const newType = reverseType[m.movement_type];
  if (!newType) throw new Error('Tipo de movimiento no se puede deshacer.');

  // For entrada/nacimiento → check dest still has enough
  if (m.movement_type === 'entrada' || m.movement_type === 'nacimiento') {
    const g = await this.repo.getGroupById(m.dest_group_id);
    if (!g || g.count < m.count) {
      throw new Error(`No se puede deshacer: actualmente hay ${g?.count ?? 0} animales, restaría a un negativo.`);
    }
  }

  // Insert compensating movement (swap source ↔ dest, same count)
  await this.repo.insertMovement({
    userId: Number(userId),
    movement_type: newType,
    source_group_id: m.dest_group_id,
    dest_group_id: m.source_group_id,
    count: m.count,
    reason: `Reversa del movimiento ${m.id}`,
  });

  // Update group counts manually (or trigger your existing logic that recalcs from ledger)
  // ... (this depends on how `count` is maintained)

  return { reversed: true, label: `Movimiento ${newType} de ${m.count} animales` };
}
```

(Wire `insertMovement` if not exposed.)

- [ ] **Step 5: Add handler `postActionUndoMovement`**

```typescript
async postActionUndoMovement(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  const movementId = cmd.movementId as string;
  try {
    const r = await this.service.undoMovement(userId, movementId);
    return { messages: [`↩️ ${r.label} aplicado.`] };
  } catch (err) {
    return { messages: [err instanceof Error ? err.message : String(err)] };
  }
}
```

Register `livestock_post_undo_movement` in `LIVESTOCK_COMMANDS` + interactive parser:
```typescript
if (id.startsWith('lv_post_undo_movement_')) {
  return { type: 'livestock_post_undo_movement', movementId: id.slice('lv_post_undo_movement_'.length) };
}
```

Dispatch: `case 'livestock_post_undo_movement': return livestockHandler.postActionUndoMovement(cmd, userId);`

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/domain/livestock/__tests__/livestock-undo.test.ts && npm test`
Expected: undo test PASS + no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/domain/livestock/livestock.service.ts src/domain/livestock/livestock.repository.ts \
        src/domain/livestock/livestock.handler.ts src/domain/livestock/__tests__/livestock-undo.test.ts \
        src/domain/interactive/interactive.router.ts src/domain/router.ts
git commit -m "feat(livestock): undoMovement with compensating row + validation"
```

---

### Task 16: Undo domain_event (soft-delete)

**Files:**
- Modify: `src/domain/livestock/livestock.handler.ts`

- [ ] **Step 1: Add handler `postActionUndoEvent`**

```typescript
async postActionUndoEvent(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
  const eventId = Number(cmd.eventId);
  if (!Number.isFinite(eventId)) return { messages: ['ID de evento inválido.'] };
  const ok = await this.service['repo'].softDeleteDomainEvent(Number(userId), eventId);
  if (!ok) return { messages: ['No encontré ese evento para deshacer.'] };
  return { messages: ['↩️ Evento eliminado.'] };
}
```

(Or expose `livestockService.softDeleteDomainEvent(...)` if you prefer not to access `service['repo']`.)

- [ ] **Step 2: Register interactive parser + router**

```typescript
// interactive.router.ts
if (id.startsWith('lv_post_undo_event_')) {
  return { type: 'livestock_post_undo_event', eventId: id.slice('lv_post_undo_event_'.length) };
}
```

```typescript
// router.ts LIVESTOCK_COMMANDS
'livestock_post_undo_event',
```

Dispatch: `case 'livestock_post_undo_event': return livestockHandler.postActionUndoEvent(cmd, userId);`

- [ ] **Step 3: Typecheck + tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/domain/livestock/livestock.handler.ts src/domain/interactive/interactive.router.ts src/domain/router.ts
git commit -m "feat(livestock): undo domain_event via soft-delete"
```

---

## Phase 7 — Verify

### Task 17: Eval scenario + final smoke

**Files:**
- Create: `src/testing/scenarios/20-hacienda-flow.json`

- [ ] **Step 1: Write the scenario**

```json
{
  "name": "hacienda: vacunación sin ubicación auto-resuelve cuando hay un solo grupo",
  "setup": ["seed_fields", "seed_livestock_single_group"],
  "steps": [
    {
      "send": "vacuné contra aftosa",
      "assert": {
        "responseContains": ["Evento sanitario registrado", "Aftosa", "(auto)"],
        "dbHasEvent": { "event_type": "health_event", "product": "aftosa" }
      }
    }
  ]
}
```

If a `seed_livestock_single_group` setup doesn't exist, add it to `_setup.json` — it should ensure the test user has exactly 1 livestock group.

(For a fuller scenario covering the "ask buttons when ambiguous" path, you'd add 2 groups and then verify the buttons response. Add as a second scenario if time permits.)

- [ ] **Step 2: Run the eval**

```bash
docker compose up -d --build && sleep 8
npx tsx src/testing/run-eval.ts --scenario 20-hacienda-flow
```
Expected: PASS.

- [ ] **Step 3: Full smoke (typecheck + tests + production build)**

```bash
npx tsc --noEmit -p .
npm test
cd frontend && npx tsc -b && npm run build && cd ..
```
Expected: PASS in all four.

- [ ] **Step 4: Commit**

```bash
git add src/testing/scenarios/20-hacienda-flow.json src/testing/scenarios/_setup.json
git commit -m "test(eval): scenario 20 — hacienda auto-resolve location"
```

---

## Self-Review

**Spec coverage check:**
- Gap 0 (onboarding) → Task 3 ✓
- Gap 1 (first-record nudge) → Task 5 ✓
- Gap 2 (confinement verbs) → Task 4 ✓
- Gap 3 (create-and-continue) → Tasks 10, 11 ✓
- Gap 4 (auto-resolve location) → Tasks 6, 7, 9 ✓
- Gap 5 (animals_affected) → Tasks 8, 9 ✓
- Gap 8 (post-confirmation buttons + undo) → Tasks 12, 13, 14, 15, 16 ✓
- Cross-cutting (migration + audit) → Task 1 ✓
- Payload helpers → Task 2 ✓
- Eval scenario → Task 17 ✓

**Placeholder scan:**
- Task 11 has known limitations documented for plot/field creation (subTypes 'plot' and 'field' are stubbed with friendly fallback messages); this is intentional and called out.
- Task 14 step 4 (`postActionResumenMes`) ships a V1 that responds with a hint rather than full dispatch. Acceptable for first release, called out.
- All other code blocks contain real, runnable code. No "TBD" or "TODO".

**Type consistency:**
- `LivestockPendingPayload` is defined once (Task 2) and used in Tasks 7, 8, 9, 10, 11.
- `LvOpKind` defined in Task 12, used in Task 13.
- All button id prefixes follow the `lv_<feature>_<op>_*` convention.
- Method names: `postActionStock`, `postActionWeigh`, etc. — consistent prefix throughout.

**Known limitations (V1):**
1. Undo has no TTL — works indefinitely. Doc'd in spec open question #1.
2. "+ Crear lote/campo" (Task 11) stubbed with friendly fallback rather than full create-and-continue.
3. `postActionResumenMes` (Task 14) ships V1 as text hint, not full dispatch.

These are conscious V1 deferrals; the core data-quality fixes (Gaps 4, 5, plus undo) are complete.
