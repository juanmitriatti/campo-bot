# QA Suite v2 — medidor de calidad del agente, grounded en prod y parametrizable

**Fecha:** 2026-05-29
**Estado:** Diseño aprobado (pendiente review del spec)
**Autor:** Claude + Juan Pablo

## 1. Motivación

El agente conversacional se percibe "tosco": se pierde, rutea mal y repregunta de más
(síntomas 2/3/4 del usuario: comprensión, contexto/memoria, repreguntas).

Antes de tocar el prompt o la arquitectura, corrimos un A/B Haiku 4.5 vs Sonnet 4.6
sobre 70 escenarios adversariales (mismo prompt, solo cambia el modelo):

| Métrica | Haiku | Sonnet | Δ |
|---|---|---|---|
| PASS estricto (combinado) | 71% | 73% | +2 pts |
| Eje contexto | 55% | 52% | −3 pts |
| Costo / 1k msgs | US$ 8.45 | US$ 27.71 | **3.3×** |

**Hallazgo 1:** subir de modelo con el prompt actual no mueve la aguja (1 test de 70) y
cuesta 3.3×. El cuello de botella es estructural (prompt/contexto), no el modelo.

**Hallazgo 2 (crítico para este spec):** al inspeccionar los "fallos", **3 de 4 en la
categoría contexto eran el bot funcionando bien** — falsos-FAIL por aserciones de
substring frágiles (ej: el test esperaba "observación" y el bot respondió
"🔍 Observación registrada" → contado como FAIL). Las suites actuales **subestiman** la
calidad real y su número absoluto es ruido; solo el delta entre configs es confiable.

**Conclusión:** cualquier cambio futuro (prompt lean, fix de contexto) se va a evaluar con
instrumentos rotos. Necesitamos una vara de medir confiable ANTES de seguir.

## 2. Objetivo

Una suite de QA que:
1. **Mide la calidad real** del agente con aserciones a prueba de wording.
2. Está **grounded en conversaciones reales de producción** (no en la imaginación del autor).
3. Es **parametrizable**: corre el mismo set contra distintos modelos/prompts y emite tabla
   comparativa (calidad por eje/dominio + costo). Doble como harness de A/B permanente.
4. Reporta por los **3 ejes** que le importan al usuario: comprensión/routing,
   contexto/memoria, repreguntas-de-más.

## 3. Filosofía de aserción (la pieza central)

El problema de las suites actuales: asertan sobre substrings del **texto de respuesta**.
El texto lo arma el handler y varía → falsos-FAIL.

**v2 aserta sobre el ESTADO RESULTANTE, no sobre el wording.** Tres familias:

- **DB (primaria):** consulta las tablas de dominio después de la conversación, user-scoped.
  - `dbExpense({amount, category, plotName, currency, n})`
  - `dbActivity({type, crop, plotName})`
  - `dbLivestockCount(category, n)` / `dbLivestockMovement(...)`
  - `dbRowCount(table, whereObj, expectedN)` — genérica
  - `dbNone({table, whereObj})` — aserción negativa (anti ghost-cattle, anti doble-registro)
  - El **routing** se verifica por outcome: una query no crea fila, un registro sí; la fila
    cae en la tabla correcta = ruteó bien. Equivalente y wording-immune.
- **Estructural (respuesta):** clasifica la respuesta sin depender de texto exacto.
  - `botAsked()` — la respuesta es una pregunta / quedó un pending en DB
    (`pending_activities` / `conversation_state`).
  - `botRegistered()` — hubo confirmación + fila creada, sin pending.
  - `botDidNotAsk()` — para el eje repreguntas: el bot resolvió directo cuando tenía info.
- **Negativa:** verificar que NO se creó lo que no correspondía.

Cada escenario declara su outcome esperado y **distingue "repregunta razonable"
(PASS si pregunta) de "perdió el hilo / ruteó mal / corrupción silenciosa" (FAIL).**

### Opcional: `_debug.commands` en el test-bot
El endpoint `/api/test-bot` hoy devuelve solo `{ messages }`. Las tool-calls del agente no
se exponen. Para aserciones de routing exactas donde el outcome de DB no alcance, se puede
agregar un campo `_debug: { commands: [...] }` (solo cuando un flag/header test-only está
presente). Bajo riesgo (endpoint de test). Se decide por escenario; no es la base.

## 4. Fuente de escenarios — por fases

### Fase 1 — Medidor real (grounded en prod) ⭐ máxima prioridad
Las fallas reales ya están en la DB de producción. Las minamos y convertimos en escenarios.

- **Mining (`mine-prod-logs.ts`):** `SELECT` **read-only** sobre `conversation_logs` y
  `ai_fallback_logs` de la DB de Railway. Heurísticas de "conversación sospechosa"
  (reusar las del admin auto-flag): respuesta vacía / "no entendí" / "no encontré" /
  "me faltan" / "no pude" / "fallback" / processing_time alto / confidence baja, +
  detección de repreguntas en cadena y de contradicciones turno-a-turno.
- **Anonimización:** los mensajes reales se trabajan localmente; se quitan PII evidentes
  (teléfonos, emails, nombres propios cuando no son agronómicos). No se escribe nada en prod.
- **Curación → escenarios:** cada conversación sospechosa se revisa, se le define el outcome
  correcto esperado y se codifica como escenario con aserciones por DB.
- Salida: ~20-25 escenarios reales etiquetados por eje + dominio.

### Fase 2 — Cobertura amplia (escenarios escritos)
Completar dominios con poco/nada de tráfico real (estilo productor argentino) hasta llegar a
**~45 escenarios** cubriendo gastos, ingresos, hacienda, agro, stock, queries, clima +
profundidad en los 3 ejes. Reusa el mismo formato y aserciones de Fase 1.

### Fase 3 — Paths WA/TG (diferida)
Ejercitar los controllers de WhatsApp/Telegram (no solo test-bot) para cazar el **drift de
controllers** (CLAUDE.md documenta features "currently test-bot.controller; WA + TG port
pending" → pasar en test-bot ≠ pasar en WhatsApp). Solo si el mining muestra que importa o
antes de un launch público.

## 5. Componentes (en `src/testing/v2/`)

- `assertions.ts` — librería DB + estructural + negativa (§3).
- `scenarios/` — escenarios declarativos:
  ```ts
  { id, source: 'prod'|'written', domains: string[], axes: ('contexto'|'comprension'|'repreguntas')[],
    seed?: SeedSpec, turns: ({send: string} | {tap: string})[], assert: Assertion[] }
  ```
- `runner.ts` — `--model <id> [--max-tokens N]`: setea modelo en DB, reinicia app (limpia
  cache de settings), por escenario hace reset + seed determinista (enterprise plan), corre
  los turns, ejecuta aserciones, captura pass/fail + tokens (`ai_usage` por ventana).
  Escribe `results-<model>.json`.
- `compare.ts` — `--compare <modelA> <modelB>`: corre ambos y emite tabla por eje + dominio +
  costo (reusa la lógica de `scripts/ab-analyze.ts` ya escrita).
- `mine-prod-logs.ts` — Fase 1 (read-only sobre prod, anonimiza, propone candidatos).

## 6. Principios de diseño

- **Aislamiento:** reset + seed determinista por escenario. Sin `Date.now()`/random en
  aserciones; fechas relativas vía el normalizer existente (`relative-dates.ts`).
- **Reusa lo existente:** `TestBotClient`, mecanismo flip+restart ya validado
  (`scripts/ab-model-compare.sh`), `ab-analyze.ts`, heurísticas de auto-flag del admin.
- **Un escenario = un propósito** verificable de forma independiente.
- **El delta es la verdad, no el absoluto:** la suite reporta números absolutos pero el uso
  primario es comparar configs (modelo/prompt) sobre el mismo set.

## 7. Costuras de fidelidad (documentadas explícitamente)

La suite corre el pipeline real (mismo `IntentClassifier`/`AgentService`/handlers/DB/prompt/
modelo) → ~90% del camino crítico es idéntico a prod. NO cubre, y se asume conscientemente:
1. **Solo texto** — sin audio/Whisper (errores de transcripción no testeados).
2. **Render por canal** — payloads de botones WA (listas) vs TG (inline) normalizados.
3. **Drift de controllers** — test-bot puede estar adelante de WA/TG (→ Fase 3).
4. **Escala/concurrencia** — secuencial, 1 usuario, seed chico; prod tiene cientos de
   lotes, mensajes interleaved, timeouts bajo carga.

## 8. No-objetivos (YAGNI)

- **LLM-judge** (un modelo califica la respuesta): descartado — agrega costo y
  no-determinismo, justo lo que queremos medir.
- WA/TG en Fase 1 (diferido a Fase 3).
- Audio/transcripción.
- Reemplazar las suites existentes: v2 convive; no se borran las viejas.

## 9. Criterios de éxito

1. Re-evaluar los falsos-FAIL detectados (test 17 observación, etc.) → v2 los marca PASS.
2. La suite corre parametrizada (`--model`) y reproduce el A/B Haiku/Sonnet sin el ruido de
   substrings, con desglose por eje y costo.
3. ≥20 escenarios provienen de conversaciones reales de prod (Fase 1).
4. Cobertura amplia: ~45 escenarios sobre todos los dominios al cerrar Fase 2.
5. Un cambio futuro (prompt lean / fix de contexto) se puede medir como delta confiable.
