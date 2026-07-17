# Conversation Lock (modo conversacional pegajoso) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una vez que el agente responde una aclaración (sin ejecutar acción), los mensajes siguientes se mantienen con la IA (salteando el trivial bypass + regex) hasta encausar la situación.

**Architecture:** Un store liviano (`conversationLockStore`, `TypedPendingStore<{turns}>`) marca que hay una aclaración en curso. El pipeline, antes de clasificar, lee el lock y le pasa un `clarificationHint` a `classify()`; con el hint presente, `classify()` saltea el trivial bypass y fuerza el agente. El contador se actualiza en un único punto del pipeline: cada respuesta conversacional del agente hace enter/bump (y libera al tope de turnos); cada acción real resetea a 0 pero sigue en lock.

**Tech Stack:** TypeScript (ESM), vitest, PostgreSQL (`system_settings`, `pending_states`), FakeAgentService (harness de integración sin API de Anthropic).

## Global Constraints

- ESM modules (`import`/`export`), NO `require`.
- Todo texto de cara al usuario en español argentino.
- Pending simple nuevo = `TypedPendingStore`, NUNCA un `Map` suelto ni otra clase ad-hoc.
- Todo interceptor que consume/reruta/veta un mensaje DEBE loguearlo (`[CONV-LOCK] ...`).
- Kill switch `CONVERSATION_LOCK_ENABLED` default `true`; `CONVERSATION_LOCK_MAX_TURNS` default `5` (grupo `bot`).
- Los settings resuelven default desde `SETTING_DEFINITIONS` (`getSetting` cae al catálogo si no hay override en DB/env); igual el código usa `?? <default>` como belt-and-suspenders.
- Los tests de interacción entre capas del pipeline van en `pipeline.integration.test.ts` (requieren DB; se saltean sin ella).

---

### Task 1: Store del lock + settings + lógica pura del contador

**Files:**
- Create: `src/middleware/conversation-lock-store.ts`
- Modify: `src/services/settings.service.js` (agregar 2 entradas al grupo `bot` de `SETTING_DEFINITIONS`, después de la entrada `FLOW_HALFLIFE_WARNING_ENABLED`)
- Test: `src/middleware/__tests__/conversation-lock-store.test.ts`

**Interfaces:**
- Consumes: `TypedPendingStore` de `./typed-pending-store.js`; `getSettingBool`/`getSettingNumber` de `../services/settings.service.js`.
- Produces:
  - `export const conversationLockStore: TypedPendingStore<{ turns: number }>`
  - `export const CLARIFICATION_HINT: string` (empieza con `ACLARACIÓN EN CURSO`)
  - `export const LOCK_RELEASED_SUFFIX: string`
  - `export function evaluateLockBump(current: number, maxTurns: number): { turns: number; released: boolean }` (pura)
  - `export async function isConversationLockActive(phone: string): Promise<boolean>`
  - `export async function bumpConversationLock(phone: string): Promise<{ released: boolean; turns: number }>`
  - `export function resetConversationLock(phone: string): void`

- [ ] **Step 1: Write the failing test** (lógica pura del contador — sin DB ni settings)

Create `src/middleware/__tests__/conversation-lock-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateLockBump } from '../conversation-lock-store.js';

describe('evaluateLockBump', () => {
  it('entra al lock en el turno 1 sin liberar', () => {
    expect(evaluateLockBump(0, 5)).toEqual({ turns: 1, released: false });
  });

  it('sigue en lock por debajo del tope', () => {
    expect(evaluateLockBump(2, 5)).toEqual({ turns: 3, released: false });
  });

  it('libera al alcanzar el tope', () => {
    expect(evaluateLockBump(4, 5)).toEqual({ turns: 5, released: true });
  });

  it('respeta un tope configurable de 2', () => {
    expect(evaluateLockBump(1, 2)).toEqual({ turns: 2, released: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/middleware/__tests__/conversation-lock-store.test.ts`
Expected: FAIL — `Failed to resolve import "../conversation-lock-store.js"` (el módulo no existe todavía).

- [ ] **Step 3: Create the store module**

Create `src/middleware/conversation-lock-store.ts`:

```ts
/**
 * conversation-lock-store — "modo conversacional pegajoso". Cuando el agente
 * responde una aclaración (respond_text, SIN ejecutar acción), el pipeline no
 * dejaba estado: cada follow-up ambiguo volvía a entrar por el trivial bypass y
 * a veces se misruteaba (visto live: "como que no?" → financial_report(hacienda)).
 *
 * Este store marca que hay una aclaración en curso. Mientras esté activo,
 * intent-classifier saltea el trivial bypass y manda el mensaje al agente con un
 * hint. Sale por tope de turnos (CONVERSATION_LOCK_MAX_TURNS, default 5): cada
 * respuesta conversacional suma un turno; una acción real resetea a 0 (sigue en
 * lock). TTL de 30 min como backstop (heredado de TypedPendingStore).
 *
 * Pending simple nuevo = TypedPendingStore (regla CLAUDE.md), NUNCA Map suelto.
 */
import { TypedPendingStore } from './typed-pending-store.js';
import { getSettingBool, getSettingNumber } from '../services/settings.service.js';

export const conversationLockStore = new TypedPendingStore<{ turns: number }>('conversation_lock');

/** Hint que viaja al agente por el carril del pendingHint (branch dedicado en
 *  agent.service). Empieza con "ACLARACIÓN EN CURSO" para su framing propio. */
export const CLARIFICATION_HINT =
  'ACLARACIÓN EN CURSO: ya le hiciste una pregunta al usuario en este hilo y todavía no la ' +
  'resolvió. NO repitas la misma pregunta verbatim. Avanzá hacia registrar la acción concreta ' +
  'con lo que te diga; si el mensaje no aporta nada útil, ofrecele escribir *menú* para ver las opciones.';

/** Se agrega a la respuesta conversacional cuando el lock se libera por tope de turnos. */
export const LOCK_RELEASED_SUFFIX = 'Si querés, escribí *menú* y te muestro todo lo que puedo registrar.';

/** Lógica pura del contador: dado el turno actual y el tope, devuelve el próximo
 *  turno y si se alcanzó el tope (lock liberado). */
export function evaluateLockBump(current: number, maxTurns: number): { turns: number; released: boolean } {
  const turns = current + 1;
  return { turns, released: turns >= maxTurns };
}

/** true si el lock está activo Y el kill switch está prendido. */
export async function isConversationLockActive(phone: string): Promise<boolean> {
  const enabled = (await getSettingBool('CONVERSATION_LOCK_ENABLED')) ?? true;
  if (!enabled) return false;
  return conversationLockStore.has(phone);
}

/**
 * El agente respondió conversacional (aclaración sin acción): ENTRAR o BUMP.
 * No-op si el kill switch está apagado. Devuelve { released } true si se alcanzó
 * el tope de turnos (lock liberado — el próximo mensaje vuelve al pipeline normal).
 */
export async function bumpConversationLock(phone: string): Promise<{ released: boolean; turns: number }> {
  const enabled = (await getSettingBool('CONVERSATION_LOCK_ENABLED')) ?? true;
  if (!enabled) return { released: false, turns: 0 };
  const maxTurns = (await getSettingNumber('CONVERSATION_LOCK_MAX_TURNS')) ?? 5;
  const existed = conversationLockStore.has(phone);
  const current = conversationLockStore.get(phone)?.turns ?? 0;
  const { turns, released } = evaluateLockBump(current, maxTurns);
  if (released) {
    conversationLockStore.clear(phone);
    console.log(`[CONV-LOCK] release (cap) phone=${phone} turns=${turns}`);
    return { released: true, turns };
  }
  conversationLockStore.set(phone, { turns });
  console.log(`[CONV-LOCK] ${existed ? 'continue' : 'enter'} phone=${phone} turns=${turns}`);
  return { released: false, turns };
}

/** Se ejecutó una acción real: reset a 0 pero sigue en lock (solo si estaba activo). */
export function resetConversationLock(phone: string): void {
  if (!conversationLockStore.has(phone)) return;
  conversationLockStore.set(phone, { turns: 0 });
  console.log(`[CONV-LOCK] reset (acción) phone=${phone}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/middleware/__tests__/conversation-lock-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add settings catalog entries**

In `src/services/settings.service.js`, inside the `SETTING_DEFINITIONS` object, in the `bot` group block (right after the `FLOW_HALFLIFE_WARNING_ENABLED` entry, ~line 101), add:

```js
  CONVERSATION_LOCK_ENABLED: { default: 'true', type: 'boolean', group: 'bot', label: 'Modo conversacional pegajoso', description: 'Cuando el agente pide una aclaración (responde una pregunta sin registrar nada), los mensajes siguientes se mantienen con la IA (salteando el bypass trivial/regex) hasta encausar la conversación. Evita que un follow-up ambiguo ("como que no?") se misrutee a una consulta. Sale por tope de turnos (CONVERSATION_LOCK_MAX_TURNS); cada acción registrada resetea el contador. Kill switch: si se apaga, el pipeline queda idéntico al actual. Cambios aplican en ≤5 min (cache de settings).' },
  CONVERSATION_LOCK_MAX_TURNS: { default: '5', type: 'number', group: 'bot', label: 'Máx turnos del modo conversacional', description: 'Cuántas respuestas conversacionales seguidas SIN resolver nada tolera el modo pegajoso antes de soltar y ofrecer el menú. Cada acción registrada con éxito resetea el contador a 0. Default 5. Subir si los usuarios necesitan más idas y vueltas para explicarse; bajar si se sienten atrapados.' },
```

- [ ] **Step 6: Verify settings parse (no syntax break) and run the module test again**

Run: `node --input-type=module -e "import('./src/services/settings.service.js').then(m => m.getSetting('CONVERSATION_LOCK_MAX_TURNS')).then(v => console.log('default:', v))"`
Expected: prints `default: 5` (o el valor de DB si hay override; sin DB, `5` desde el catálogo).

Run: `npx vitest run src/middleware/__tests__/conversation-lock-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/middleware/conversation-lock-store.ts src/middleware/__tests__/conversation-lock-store.test.ts src/services/settings.service.js
git commit -m "feat(conversation-lock): store + settings + counter logic

TypedPendingStore<{turns}> + helpers enter/bump/reset + kill switch
CONVERSATION_LOCK_ENABLED (default true) y CONVERSATION_LOCK_MAX_TURNS
(default 5). Lógica pura del contador con test unitario.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wiring end-to-end (classify STEP 1.5 + agent hint + pipeline) + tests de integración

**Files:**
- Modify: `src/services/intent-classifier.ts` (opts type ~223-228; trivial bypass guard ~335-364; agent hint routing ~583)
- Modify: `src/ai/agent.service.ts` (branch de framing del hint ~175-179)
- Modify: `src/services/message-pipeline.ts` (hydration ~180; pre-classify lock read ~1082; conversational branch ~1090-1094; reset después de la branch ~1095)
- Test: `src/testing/integration/__tests__/pipeline.integration.test.ts` (agregar un `describe` nuevo)

**Interfaces:**
- Consumes de Task 1: `conversationLockStore`, `isConversationLockActive`, `bumpConversationLock`, `resetConversationLock`, `CLARIFICATION_HINT`, `LOCK_RELEASED_SUFFIX`.
- Produces: `classify()` opts gana `clarificationHint?: string | null`. Comportamiento observable: mientras el lock está activo, un mensaje trivial ("hola") va al agente con `pendingHint` que incluye `ACLARACIÓN EN CURSO`.

- [ ] **Step 1: Write the failing integration tests**

In `src/testing/integration/__tests__/pipeline.integration.test.ts`, add these imports at the top (junto a los imports existentes del harness):

```ts
import { conversationLockStore } from '../../../middleware/conversation-lock-store.js';
```

Then add a new `describe` block (al final del archivo, antes del cierre):

```ts
describe('conversation lock (modo pegajoso)', () => {
  it('mantiene la conversación en la IA y libera al tope de turnos', async () => {
    const h = await createPipelineHarness('convlock-cap');
    try {
      // 5 respuestas conversacionales programadas (una por turno lockeado)
      for (let i = 0; i < 5; i++) h.fakeAgent.enqueue([], '¿Qué querés registrar? ¿un gasto, una actividad...?');

      // turno 1: mensaje ambiguo → agente conversacional → ENTRA al lock
      await h.send('quiero registrar algo');
      expect(h.fakeAgent.calls.length).toBe(1);

      // turno 2: 'hola' es TRIVIAL, pero el lock lo manda al agente con hint
      await h.send('hola');
      expect(h.fakeAgent.calls.length).toBe(2);
      expect(h.fakeAgent.calls[1].pendingHint).toContain('ACLARACIÓN EN CURSO');

      // turnos 3 y 4: siguen en lock (cada 'hola' va al agente)
      await h.send('hola');
      await h.send('hola');
      expect(h.fakeAgent.calls.length).toBe(4);

      // turno 5: alcanza el tope (default 5) → libera + ofrece menú
      const items = await h.send('hola');
      expect(h.fakeAgent.calls.length).toBe(5);
      expect(h.allText(items)).toContain('menú');

      // lock liberado: el próximo 'hola' lo maneja el trivial bypass (NO al agente)
      await h.send('hola');
      expect(h.fakeAgent.calls.length).toBe(5); // no creció
      expect(conversationLockStore.has(h.phone)).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it('una acción real resetea el contador pero sigue en lock', async () => {
    const h = await createPipelineHarness('convlock-reset');
    try {
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Esperanza') RETURNING id`, [h.userId]);
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Norte')`, [f[0].id]);

      // turno 1: conversacional → entra al lock (turns=1)
      h.fakeAgent.enqueue([], '¿Qué querés registrar?');
      await h.send('quiero registrar algo');
      expect(conversationLockStore.get(h.phone)?.turns).toBe(1);

      // turno 2: acción real (gasto) → reset a 0, SIGUE en lock
      h.fakeAgent.enqueue([{ toolName: 'log_expense', toolInput: { amount: 5000, category: 'Combustible', description: 'gasoil' } }]);
      await h.send('gasté 5000 en gasoil');
      expect(conversationLockStore.get(h.phone)?.turns).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  it('un pending activo se resuelve antes que el lock', async () => {
    const h = await createPipelineHarness('convlock-pending');
    try {
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Esperanza') RETURNING id`, [h.userId]);
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Norte')`, [f[0].id]);

      // entrar al lock
      h.fakeAgent.enqueue([], '¿Qué querés registrar?');
      await h.send('quiero registrar algo');

      // sow_crop SIN cultivo → deja un pending machine-readable (missing: crop)
      h.fakeAgent.enqueue([{ toolName: 'sow_crop', toolInput: { plot: 'Norte' } }]);
      await h.send('sembré en el lote Norte');

      // responder el pending: 'soja' lo consume el pending-processor ANTES de classify
      const callsBefore = h.fakeAgent.calls.length;
      await h.send('soja');
      expect(h.fakeAgent.calls.length).toBe(callsBefore); // el agente NO fue llamado
      const crops = await h.q(
        `SELECT crop FROM plot_crops pc JOIN plots p ON p.id = pc.plot_id JOIN fields fi ON fi.id = p.field_id WHERE fi.user_id = $1`,
        [h.userId],
      );
      expect(crops.map(c => c.crop)).toContain('soja');
    } finally {
      await h.cleanup();
    }
  });

  it('con el kill switch apagado, no hay lock (comportamiento actual)', async () => {
    const { setSetting } = await import('../../../services/settings.service.js');
    const h = await createPipelineHarness('convlock-off');
    await setSetting('CONVERSATION_LOCK_ENABLED', 'false');
    try {
      h.fakeAgent.enqueue([], '¿Qué querés registrar?');
      await h.send('quiero registrar algo'); // conversacional, pero SIN activar lock
      const before = h.fakeAgent.calls.length;
      await h.send('hola'); // trivial bypass normal → NO va al agente
      expect(h.fakeAgent.calls.length).toBe(before);
      expect(conversationLockStore.has(h.phone)).toBe(false);
    } finally {
      await setSetting('CONVERSATION_LOCK_ENABLED', 'true');
      await h.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose up -d db` (si no está corriendo) then `npx vitest run src/testing/integration/__tests__/pipeline.integration.test.ts -t "conversation lock"`
Expected: FAIL — el test del cap falla en `expect(h.fakeAgent.calls.length).toBe(2)` (recibe 1: sin el lock, 'hola' lo agarra el trivial bypass y el agente no se llama). Si no hay DB, los tests se saltean (skip) — levantar la DB primero.

- [ ] **Step 3: Add `clarificationHint` to the classify opts type**

In `src/services/intent-classifier.ts`, modify the `opts` type (~223-228):

```ts
    opts?: {
      /** askPrompt del pending activo (si hay). Se inyecta en el prefix del
       *  agente para que sepa que hay una pregunta abierta sin responder y no
       *  conflacione el mensaje nuevo con la respuesta esperada. */
      pendingHint?: string | null;
      /** Modo conversacional pegajoso activo: fuerza el camino del agente
       *  (saltea el trivial bypass) y viaja al agente como hint de aclaración. */
      clarificationHint?: string | null;
    },
```

- [ ] **Step 4: Skip the trivial bypass when the lock is active**

In `src/services/intent-classifier.ts`, at the trivial bypass block (~335), change the guard. Replace:

```ts
    const trivialCmd = this.classifyTrivial(cleaned, preprocessed);
    if (trivialCmd) {
```

with:

```ts
    const forceAgentByLock = !!opts?.clarificationHint;
    const trivialCmd = this.classifyTrivial(cleaned, preprocessed);
    if (trivialCmd && forceAgentByLock) {
      console.log(`[CONV-LOCK] skip trivial bypass (lock) cmd=${(trivialCmd.intent as { data?: { command?: string } }).data?.command ?? '?'} text="${text.slice(0, 60)}"`);
    }
    if (trivialCmd && !forceAgentByLock) {
```

(El bloque existente `return trivialCmd;` queda dentro del `if (trivialCmd && !forceAgentByLock)`; con el lock activo cae a STEP 2.5/2.6 → agente.)

- [ ] **Step 5: Route the clarification hint to the agent**

In `src/services/intent-classifier.ts`, at the agent call (~583), replace:

```ts
        const agentResult = await this.agentService.extract(agentInputText, preprocessed, userId, settings, opts?.pendingHint ?? null);
```

with:

```ts
        const agentResult = await this.agentService.extract(agentInputText, preprocessed, userId, settings, opts?.pendingHint ?? opts?.clarificationHint ?? null);
```

(El `pendingHint` de un pending/escalamiento real gana; el `clarificationHint` solo llena el hueco cuando no hay pending — que es exactamente el caso del lock, porque los pendings se resuelven antes de `classify` en el pipeline.)

- [ ] **Step 6: Give the clarification hint its own framing in agent.service**

In `src/ai/agent.service.ts`, replace the `pendingLine` block (~175-179):

```ts
      const pendingLine = pendingHint
        ? (pendingHint.startsWith('RESCATE DE PENDING')
          ? `[${pendingHint}]\n`
          : `[Hay una pregunta pendiente al usuario sin responder: "${pendingHint.slice(0, 150)}". Si este mensaje NO la responde, procesalo como acción nueva.]\n`)
        : '';
```

with:

```ts
      const pendingLine = pendingHint
        ? (pendingHint.startsWith('RESCATE DE PENDING') || pendingHint.startsWith('ACLARACIÓN EN CURSO')
          ? `[${pendingHint}]\n`
          : `[Hay una pregunta pendiente al usuario sin responder: "${pendingHint.slice(0, 150)}". Si este mensaje NO la responde, procesalo como acción nueva.]\n`)
        : '';
```

(El hint de aclaración viaja VERBATIM, sin el truncado de 150 chars ni el framing de "pregunta pendiente" — mismo trato que el RESCATE.)

- [ ] **Step 7: Register the lock store in hydratePendingStores**

In `src/services/message-pipeline.ts`, add the import (junto a los otros imports de middleware, cerca del top):

```ts
import {
  conversationLockStore,
  isConversationLockActive,
  bumpConversationLock,
  resetConversationLock,
  CLARIFICATION_HINT,
  LOCK_RELEASED_SUFFIX,
} from '../middleware/conversation-lock-store.js';
```

Then in `hydratePendingStores` (~180), add to the `Promise.all` array (después de `deferredFirstActionStore.hydrate(phone),`):

```ts
    conversationLockStore.hydrate(phone),
```

- [ ] **Step 8: Wire the lock into the pipeline (read before classify, update after)**

In `src/services/message-pipeline.ts`, at the classify call (~1082), replace:

```ts
  const parseResult: ParseResult = await intentClassifier.classify(text, userId, settings, {
    pendingHint: escalationHint ?? pendingActStore.get(phone)?.askPrompt ?? null,
  });
```

with:

```ts
  const lockActive = await isConversationLockActive(phone);
  const parseResult: ParseResult = await intentClassifier.classify(text, userId, settings, {
    pendingHint: escalationHint ?? pendingActStore.get(phone)?.askPrompt ?? null,
    clarificationHint: lockActive ? CLARIFICATION_HINT : null,
  });
```

Then replace the conversational-response branch (~1090-1094):

```ts
  // Handle conversational response from Agent
  if ((parseResult as any)._conversationalResponse) {
    const convResponse = (parseResult as any)._conversationalResponse as string;
    conversationLogger.log(userId, phone, text, convResponse, 'conversational', null, null, null, true, Date.now() - startTime, false, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
    return [{ type: 'text', text: convResponse }];
  }
```

with:

```ts
  // Handle conversational response from Agent. El agente respondió una aclaración
  // sin ejecutar acción → entrar/bump el lock conversacional (modo pegajoso). Al
  // tope de turnos, libera y ofrece el menú para no atrapar al usuario.
  if ((parseResult as any)._conversationalResponse) {
    let convResponse = (parseResult as any)._conversationalResponse as string;
    const { released } = await bumpConversationLock(phone);
    if (released) convResponse += `\n\n${LOCK_RELEASED_SUFFIX}`;
    conversationLogger.log(userId, phone, text, convResponse, 'conversational', null, null, null, true, Date.now() - startTime, false, confidence, toolCallsData, agentMode, ctx.channel).catch(() => {});
    return [{ type: 'text', text: convResponse }];
  }

  // Llegamos acá → el turno NO fue conversacional: hubo una acción/comando real.
  // Si veníamos en lock, reseteamos el contador (progreso) y seguimos en lock.
  resetConversationLock(phone);
```

- [ ] **Step 9: Run the integration tests to verify they pass**

Run: `npx vitest run src/testing/integration/__tests__/pipeline.integration.test.ts -t "conversation lock"`
Expected: PASS (4 tests).

- [ ] **Step 10: Run the full integration suite + typecheck to catch regressions**

Run: `npx vitest run src/testing/integration/__tests__/pipeline.integration.test.ts`
Expected: todos PASS (los previos + los 4 nuevos).

Run: `npx tsc --noEmit`
Expected: sin errores nuevos de tipos.

- [ ] **Step 11: Commit**

```bash
git add src/services/intent-classifier.ts src/ai/agent.service.ts src/services/message-pipeline.ts src/testing/integration/__tests__/pipeline.integration.test.ts
git commit -m "feat(conversation-lock): wiring en pipeline + classify + agent hint

STEP 1.5 en classify saltea el trivial bypass con el lock activo y manda
el mensaje al agente con clarificationHint. El pipeline lee el lock antes
de clasificar, hace enter/bump en cada respuesta conversacional (libera +
ofrece menú al tope) y resetea a 0 con cada acción real. Regresiones en
pipeline.integration.test.ts (cap, reset, pending gana, kill switch off).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Verificación final (baseline de tests + eval opcional)

**Files:** ninguno (solo verificación).

- [ ] **Step 1: Run the unit test baseline**

Run: `npm test`
Expected: baseline local de 1753 passing + 16 env-dependent fails (los mismos de siempre) + los 4 nuevos unit tests del store. Ningún fail NUEVO fuera de los 16 conocidos.

- [ ] **Step 2: (Opcional, si hay Docker + créditos) Run el eval conversacional**

Run: `docker compose up -d && npm run eval`
Expected: 24/25 (el 1 fail conocido es no-determinismo LLM en proximidad de precios). El lock no debería cambiar el resultado del eval (ningún escenario depende de aclaraciones repetidas). Si baja, investigar antes de mergear.

- [ ] **Step 3: Confirmar la observabilidad manualmente (revisión de logs)**

Buscar en la salida de tests/eval las líneas `[CONV-LOCK] enter/continue/reset/release/skip trivial bypass`. Confirmar que aparecen en los turnos esperados. (Principio CLAUDE.md: todo interceptor logea su intercepción.)

---

## Self-Review

**Spec coverage:**
- Estado nuevo `conversationLockStore` (TypedPendingStore) → Task 1 ✓
- Settings `CONVERSATION_LOCK_ENABLED` / `CONVERSATION_LOCK_MAX_TURNS` (grupo bot) → Task 1 ✓
- STEP 1.5 en classify (skip trivial bypass, force agente con hint) → Task 2 Steps 3-5 ✓
- Hint al agente con framing propio (sin truncado) → Task 2 Step 6 ✓
- Entrada/bump/cap-release en el pipeline → Task 2 Step 8 ✓
- Reset a 0 con acción real (sigue en lock) → Task 2 Step 8 ✓
- Escapes: pendings activos (resueltos antes de classify) + observación (STEP 1 intocado) → Task 2 Step 1 test "pending gana"; observación no se toca ✓
- Hydration (11 → 12 stores) → Task 2 Step 7 ✓
- Kill switch off = comportamiento actual → Task 2 Step 1 test "kill switch" ✓
- Observabilidad `[CONV-LOCK]` → Task 1 (helpers) + Task 2 Step 4 (skip) + Task 3 Step 3 ✓
- Testing (cap, reset, pending gana, kill switch off) → Task 2 Step 1 ✓

**Simplificación vs spec (documentada):** el spec mencionaba "un pending que se resuelve → release(phone)". Se DESCARTA como acción explícita: mientras hay un pending activo, la branch de pendings del pipeline corre ANTES de `classify`, así que el lock (STEP 1.5) nunca se ejecuta ese turno — es inofensivo que el lock siga activo con turns=0. El TTL de 30 min y el cap lo limpian. Menos acoplamiento, mismo comportamiento observable. (El test "pending gana" cubre el caso.)

**Placeholder scan:** sin TBD/TODO; todo step tiene código o comando concreto. ✓

**Type consistency:** `evaluateLockBump(current, maxTurns)` mismo nombre/firma en Task 1 (definición + test) y consumido dentro de `bumpConversationLock`. `clarificationHint` mismo nombre en el opts type (Task 2 Step 3) y en su uso (Steps 4-5) y en el pipeline (Step 8). `CLARIFICATION_HINT` empieza con `ACLARACIÓN EN CURSO`, matcheado por el branch de agent.service (Step 6) y aserido en los tests (Step 1). ✓
