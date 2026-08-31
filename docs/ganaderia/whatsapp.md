# Interfaz conversacional — grupo vs. animal individual

## La regla que protege al modelo por grupos

La pregunta que decide qué tool usar no es "¿habla de animales?" sino:

> **¿el usuario nombró animales CONCRETOS, o habló de una cantidad?**

| El usuario dice | Tool | Por qué |
|---|---|---|
| "mové 50 vacas del Norte al Sur" | `transfer_livestock` | Cantidad, sin identidad → **GRUPO**, como siempre |
| "cuántas vacas tengo" | `list_livestock` | Un total → GRUPO |
| "compré 20 novillos" | `add_livestock` | GRUPO |
| "vacuné 200 vacas" | `log_health_event` | GRUPO |
| "qué pasó con la caravana 123456789" | `query_animal` | UNA caravana concreta |
| "qué animales están en el lote Norte" | `list_animals` | Conjunto filtrado de identificados |
| "mové la 1234 y la 5678 al Sur" | `move_animals` | Caravanas concretas |
| "dar de alta el toro caravana X" | `register_animal` | Alta individual |
| "le puse caravana nueva a la 1234" | `identify_animal` | Reemplazo |
| "revertí el último movimiento" | `revert_livestock_movement` | — |

Dos desambiguaciones explícitas en el prompt:

- **Un número no es una caravana solo por ser un número.** "los 45 terneros" es
  una cantidad. Una caravana es un identificador largo (10 o 15 dígitos).
- **Ante la duda, GRUPO.** Es lo que el productor usa todos los días y no exige
  que haya caravaneado nada.

Esta última línea es la que impide que la capa individual canibalice al modelo por
grupos. Si el agente empezara a rutear "mové 50 vacas" por `move_animals`, se
pierde la simplicidad que es la ventaja del producto.

La regla vive en `src/ai/agent-prompt-builder.ts`, bloque **CRÍTICO GRUPO vs
ANIMAL INDIVIDUAL**. Reemplazó a la regla anterior, que mandaba a `respond_text`
toda pregunta por un animal puntual ("el sistema lleva la hacienda por grupos").

## Tools nuevas (6)

Cada una con sus 3 registros (invariante 2): schema en `tool-definitions.ts`,
entrada en `LIVESTOCK_COMMANDS` de `router.ts`, `case` en `animal.handler.ts` —
más el mapeo explícito en `agent-response-mapper.ts`. El test
`src/ai/__tests__/animal-tools-registration.test.ts` verifica los cuatro.

| Tool | Params principales |
|---|---|
| `register_animal` | `category`* , `rfid`, `visual_tag`, `sex`, `breed`, `birth_date`, `origin`, ubicación |
| `identify_animal` | `animal_ref`*, `new_rfid`, `new_visual_tag`, `reason` |
| `query_animal` | `animal_ref`*, `view` (`ficha` \| `timeline` \| `pesos`) |
| `list_animals` | `category`, `sex`, `status`, `identified`, ubicación, `top_n` |
| `move_animals` | `animal_refs[]`*, `dest_plot` / `dest_corral` / `dest_field` |
| `revert_livestock_movement` | `movement_id` (opcional), `reason` |

Se despachan desde el **mismo** `LIVESTOCK_COMMANDS` y con el **mismo** feature
gate `livestock`: para el router y el plan esto es hacienda, no un dominio nuevo.
`AnimalHandler` está en un archivo aparte solo porque `livestock.handler.ts` ya
tiene 2200+ líneas.

## Comandos que NO son tools del agente

`animal_batch_preview` lo emite el **interceptor determinístico** del pipeline,
nunca el modelo. `animal_batch_move` / `animal_batch_cancel` son taps de botón
resueltos por `interactive.router.ts`. Ninguno tiene schema, a propósito.

## Lista pegada de caravanas

El caso "escaneé estos 87 animales":

```
usuario pega 87 números
        ↓  STEP 1.5 del intent-classifier — ANTES del bypass trivial y de la IA
looksLikeIdList → animal_batch_preview        [RFID BATCH]
        ↓
resolución contra el padrón (una query, no 87)
        ↓
"Leí 90 identificadores y encontré 87 animales.
   • 82 en Lote Norte
   • 3 en Lote Sur
   • 2 sin ubicación conocida"
   [🔄 Moverlos]  [✖️ Descartar]
        ↓ tap
"📍 ¿A qué lote o corral los muevo?"   ← pending machine-readable
        ↓ "Sur"
"🔄 87 animales movidos"
```

Nunca llega al agente: 87 números queman tokens y Haiku mangla dígitos largos, y
con identificadores individuales un dígito cambiado apunta a otro animal. Ver
[rfid.md](rfid.md) § "La lista pegada nunca llega al agente".

## Preguntas y confirmaciones

Todo lo que el handler necesita preguntar sale por **pending machine-readable**
(`setPendingActivity` con `missing[]` + `askPrompt`) o por **botones** — nunca
texto suelto (invariante 5).

Un detalle que costó un bug: el destino de un movimiento llega por **dos**
caminos — desde el agente en `dest_plot`, y desde un pending en la clave genérica
`plot`/`plotName` que llena el slot-extractor. `AnimalHandler.resolveLocation`
acepta los dos. Leer solo `dest_*` hacía que la respuesta "Sur" al «¿a qué lote?»
se ignorara y el handler re-preguntara el mismo slot; lo detectó la escalera de
escalamiento (invariante 6), que antepuso "🤔 No encontré el lote «Sur»" en vez de
loopear en silencio.

## Reversión

`undoMovement` ya revertía por contra-asiento (nunca borra el histórico). Lo que
se agregó:

- `livestock_movements.reverses_movement_id` + índice único parcial → un
  movimiento se puede revertir **una sola vez**;
- rechazo explícito de revertir una reversa ("eso volvería al estado anterior");
- `created_by` — con campos compartidos el actor puede no ser el dueño;
- `findMovementById` ahora exige `user_id`: el id llega de un payload de botón, o
  sea del cliente, y sin el filtro un id ajeno devolvía el movimiento de otro.

Sin id explícito, `findLatestRevertibleMovement` toma el último que tiene sentido
revertir: ni una reversa, ni uno ya revertido, ni un `ajuste` (que no guarda el
valor previo).

## Capacidad de corral

Se advierte **después** de registrar y **nunca bloquea**:

```
⚠️ El corral Corral 1 queda con 590 animales y tiene capacidad
   configurada para 500 (90 de más).
```

El productor sabe cosas que el sistema no (encierre temporal, corral que se
amplió, animales que salen mañana). Bloquear una operación real porque un número
de configuración quedó viejo lo enseña a pelearse con la herramienta. Un corral
sin capacidad configurada nunca advierte: `NULL` significa "no me dijiste", no
"cero".
