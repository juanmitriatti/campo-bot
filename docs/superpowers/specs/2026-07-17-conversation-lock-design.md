# Conversation Lock (modo conversacional pegajoso) — Diseño

**Fecha:** 2026-07-17
**Estado:** Aprobado (pendiente de plan de implementación)

## Problema

Cuando el agente responde de forma conversacional (una aclaración vía `respond_text`, sin
ejecutar ninguna tool), el pipeline **solo devuelve el texto y loguea — no deja ningún
estado** (`src/services/message-pipeline.ts:1090-1094`). No existe un "lock conversacional".
Cada mensaje siguiente vuelve a entrar por todo el pipeline desde cero (trivial bypass →
agente), así que un follow-up ambiguo lo agarra el bypass trivial o el agente lo misrutea a
una consulta.

### Caso real reproducido

```
Usuario:  quiero registrar algo
Bot:      ¿Qué querés registrar? ¿Un gasto, un ingreso...?
Usuario:  quiero registrar algo
Bot:      ¿Qué querés registrar? ¿Un gasto...?          ← pregunta repetida
Usuario:  quiero registrar algo
Bot:      ¿Qué querés registrar? ¿Un gasto...?          ← repetida de nuevo
Usuario:  una coca cola
Bot:      Jaja, eso no entra... ¿Querés registrar un gasto, ingreso...?
Usuario:  como que no?
Bot:      📊 Movimientos — hacienda / Todo el historial   ← MISRUTEO
          • Compra hacienda: 40 terneros — $20.000.000
          ¿Más?
Usuario:  como que no?
Bot:      📊 Movimientos — hacienda ...                    ← misruteo otra vez
```

**Root cause:** `"como que no?"` disparó `financial_report(category:hacienda)` (por eso el
listado de movimientos). El `¿Más?` es el prompt de paginación de ese reporte, que
re-consumió el siguiente mensaje. La causa de fondo es la ausencia de un estado conversacional:
una vez que el bot entra en un diálogo de aclaración, no se garantiza que los follow-ups sigan
yendo al agente con el contexto correcto.

## Invariante deseado

> Una vez que la conversación entra a la IA (el agente pide una aclaración), los mensajes
> siguientes se mantienen con la IA hasta encausar la situación — no los agarra el bypass
> trivial ni se misrutean a consultas.

## Decisiones de diseño (acordadas)

- **Salida del lock:** por **tope de turnos**, configurable, default **5**.
- **Semántica del contador:** una acción real ejecutada dentro del lock **resetea el contador
  a 0 y sigue en lock** (hubo progreso). El cap de 5 salta solo tras 5 turnos SEGUIDOS sin
  resolver nada. Pegajoso y tolerante.
- **Escapes que mantienen su prioridad normal (ganan antes que el agente):**
  1. **Pendings activos / flows** — el lock NO pisa la escalera de pendings existente.
  2. **Prefijo `observación:`** — el hard-rule del STEP 1 sigue intocable.
- **Cancelar / menú NO son hard-escape:** los maneja el propio agente (consistente con
  "quedate en la IA"). El cap de turnos + los pendings ya funcionan como válvula.

## Arquitectura

### Estado nuevo: `conversationLockStore`

- `TypedPendingStore<{ turns: number }>`, keyed por `phone`.
  (Regla CLAUDE.md: pending simple nuevo = `TypedPendingStore`, NUNCA Map suelto.)
- TTL de backstop: **30 min** (limpia el lock si el usuario queda idle).
- Se hidrata al inicio de cada mensaje junto a los otros stores (pasa de 11 a 12 en
  `hydratePendingStores`).

### Settings nuevos (grupo `bot`)

- `CONVERSATION_LOCK_ENABLED` — kill switch. Arranca `true`, pero killable. Off → STEP 1.5
  es no-op y el pipeline queda idéntico al actual.
- `CONVERSATION_LOCK_MAX_TURNS` — default `5`.

### Flujo

1. **Rutear en lock** — nuevo **STEP 1.5** en `intent-classifier.classify()`, entre
   observación (STEP 1) y trivial bypass (STEP 2): si `CONVERSATION_LOCK_ENABLED` y el lock
   está activo → **salta el trivial bypass + regex** y fuerza el camino del agente,
   inyectando un `clarificationHint` (mismo mecanismo que `pendingHint`, zona no cacheada del
   user-prefix). `observación:` ya ganó antes; los pendings se resuelven en el pipeline ANTES
   de `classify`, así que no hay que tocarlos acá.
2. **Actualizar el lock (en `message-pipeline.ts`, tras resolver el turno).** Un solo punto de
   actualización según el resultado del turno — evita doble conteo:
   - **Agente devolvió `_conversationalResponse`** (aclaración, sin acción): es a la vez la
     ENTRADA y el BUMP del lock.
     - Si el lock no estaba activo → `enter(phone)` (turns=1).
     - Si ya estaba activo → `bump(phone)` (turns++). Si `turns >= MAX` → `release(phone)` +
       agrega cierre suave ("Si querés, escribí *menú* y te muestro las opciones").
   - **Agente ejecutó acción real** (single o compound exitoso) → si el lock estaba activo,
     `reset(phone)` (turns=0); sigue en lock. Si no estaba activo, no hace nada.
   - **Un pending se resuelve** → `release(phone)` (progreso, la conversación se encausó por
     otro canal).
3. **Hint al agente** — `clarificationHint`: *"Seguís a mitad de una aclaración con el
   usuario; ya le preguntaste antes — NO repitas la misma pregunta verbatim, avanzá o ofrecé
   el menú."* Ataca directo el "¿Qué querés registrar?" ×3.

### Data flow (turno lockeado)

```
msg → hydrate stores → pending? no → observación? no
   → classify() STEP 1.5: lock activo → agente (con clarificationHint, con history)
   → agente: ¿ejecutó tool?
        sí → aplicar acción, lock.reset(turns=0)
        no (respond_text) → lock.bump(turns++); si turns≥5 → release + "escribí menú"
```

## Componentes tocados

| Archivo | Cambio |
|---|---|
| `src/middleware/conversation-lock-store.ts` *(nuevo)* | `TypedPendingStore<{turns}>` + helpers `enter/bump/reset/release/isActive`. ~40 LOC. |
| `src/middleware/pending-persistence.ts` | Agregar el store a `hydratePendingStores` (11 → 12). |
| `src/services/intent-classifier.ts` | STEP 1.5: si lock activo → skip trivial+regex, forzar agente con `clarificationHint`. |
| `src/ai/agent.service.ts` | Aceptar `clarificationHint` y meterlo en el user-prefix (igual que `pendingHint`). |
| `src/services/message-pipeline.ts` | Entrada al lock (`_conversationalResponse`); reset a 0 cuando se ejecuta acción/compound exitoso; release + cierre suave al llegar al cap; release cuando un pending se resuelve. |
| Settings seed | `CONVERSATION_LOCK_ENABLED` (true), `CONVERSATION_LOCK_MAX_TURNS` (5), grupo `bot`. |

## Manejo de errores / bordes

- **Kill switch off** → STEP 1.5 es no-op, pipeline idéntico a hoy.
- **Agente falla (timeout/error)** → no cuenta como turno resuelto ni rompe el lock; cae al
  fallback normal.
- **Observabilidad:** `[CONV-LOCK] enter turns=1` / `continue turns=N` / `reset (acción)` /
  `release (cap)` / `release (pending)`. (Principio CLAUDE.md: todo interceptor que consume o
  reruta un mensaje debe loguearlo.)

## Tradeoff aceptado

Con "reset a 0 y sigue en lock", un usuario que registra con éxito una acción tras otra queda
en modo agente de forma indefinida (cada mensaje pega al agente, salteando el bypass trivial de
saludos/confirmaciones). En la práctica es costo marginal (con `AGENT_ENABLED=true` casi todo
ya va al agente igual) y el TTL de 30 min lo limpia al quedar idle. Aceptado. Si en el futuro
molesta, cambiar la semántica a "acción exitosa libera el lock" es una línea.

## Testing

Regresión en `src/testing/integration/pipeline.integration.test.ts` con `FakeAgentService`
(sin API de Anthropic, determinístico):

1. Agente devuelve `respond_text` 5 veces → verifica que se saltea el trivial bypass en los
   turnos 2-5 y que libera + ofrece menú al 5º.
2. Agente `respond_text` → luego ejecuta un `log_expense` → verifica reset a 0 y que sigue
   lockeado.
3. Con un pending activo, el pending gana (no lo pisa el lock).
4. Kill switch off → comportamiento idéntico al actual.

## Fuera de alcance (YAGNI)

- Salida por TTL como criterio primario (el TTL es solo backstop de 30 min).
- Salida por cancelar/menú como hard-escape (lo maneja el agente).
- Detección semántica de "¿es una pregunta?" para decidir el entrar — se entra siempre que el
  agente produzca `_conversationalResponse`.
