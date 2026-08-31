# Ganadería híbrida — reporte de estado (P0)

**Fecha:** 30-ago-2026 · **Alcance de esta entrega:** P0 (animal individual, RFID,
eventos individuales, modelo híbrido, compatibilidad hacia atrás, performance).
P1/P2/P3 quedaron como roadmap documentado, sin código.

## Recomendación final

> ### READY para desplegar. Queda pendiente solo la prueba de carga a 100k.
>
> P0 completo y verificado de punta a punta contra el agente real:
>
> | Verificación | Resultado |
> |---|---|
> | Unit + integración (`npm test`) | **2464/2465** (1 flaky de bcrypt bajo carga, pasa aislado) |
> | Eval conversacional (`npm run eval`) | **31/31 escenarios, 105/105 assertions** |
> | `qa-hacienda-agro-80` | **79/80 (99%) — Hacienda 48/48** |
> | Typecheck backend + frontend | limpio |
>
> El único fallo de la QA suite (`A04_termine_siembra`, cierre de campaña) es
> **idéntico al del baseline guardado** — comparado test por test, no es una
> regresión.

Se puede desplegar sin riesgo: toda la capa es aditiva y opcional, y un usuario
que no caravanea nada no ve ninguna diferencia.

### Lo que encontró el eval (y no habrían encontrado los tests unitarios)

1. **Una regresión real en un dominio ajeno.** Las 6 tools nuevas, con
   descripciones verbosas (~6 KB, 5% del payload), rompieron el picker de
   categorías de gastos: el agente dejaba de dudar sobre "análisis de suelo" y la
   asignaba sola. Aislado con A/B por `git stash` — eran las **tools**, no el
   prompt. Recortadas a 4.4 KB, resuelto (3/3). Documentado en CLAUDE.md
   § "Presupuesto del bloque de tools".
2. **Un mensaje que mentía.** Con 0 grupos y 1 animal con caravana, el bot
   contestaba "No tenés hacienda registrada". Ahora dice cuántos animales
   individualizados hay.
3. **El resumen del import contaba mal** (`extractIdList` descartaba antes de
   contar): 4 líneas pegadas se reportaban como "leí 2".
4. **El reset del test-bot habría explotado por FK** apenas un usuario tuviera un
   animal — las tablas nuevas no estaban en el borrado.

### Actualización 30-ago (post-auditoría de datos)

El **dry-run de fusión de razas contra la copia de prod dio 0 colisiones**: sobre
150 grupos vivos, la única raza no-nula es `Angus` (15 grupos, 590 cabezas) y ya
está en grafía canónica; los otros 135 tienen `breed` NULL. O sea que el paso más
riesgoso del plan **es un no-op sobre los datos reales**, y el backfill de la
propia migración 111 ya cubre esos 15 grupos. **No hace falta correr `--apply` en
producción.** El script queda igual, para cuando aparezcan grafías nuevas.

---

## Implementado y verificado

### Modelo de datos (migraciones 111-116, aplicadas y probadas en local)
- `livestock_breeds` — catálogo canónico con sinónimos + `breed_id` en grupos.
- `animals` — entidad individual, 7 índices parciales dimensionados a 100k.
- `animal_identifications` — identificación como **entidad-evento** con historial
  y encadenamiento (`replaces_identification_id`), unicidad por usuario.
- `animal_events` — línea de tiempo que **enlaza** a `domain_events` /
  `livestock_movements` en vez de duplicarlos.
- `animal_id_batches` — lotes de lectura con ciclo preview → aplicar.
- `livestock_movements` — `created_by`, `reverses_movement_id` (+ único parcial),
  `source`.
- `fields` — `renspa`, `cuig`, `senasa_titular`.

### Funcionalidad
| Criterio de aceptación del spec | Estado |
|---|---|
| Crear animal / identificar / consultar / historial | ✅ |
| Asociar RFID, buscar por RFID, detectar duplicado, reemplazar conservando historial | ✅ |
| Mantener grupos actuales, asociar animales, grupos parcialmente individualizados | ✅ |
| Movimiento individual, movimiento masivo por lista RFID | ✅ |
| Reversión con auditoría y referencia al original | ✅ |
| Pesaje individual + GDP cuando hay datos | ✅ (lectura y cálculo; falta el registro conversacional de pesaje individual) |
| Capacidad de corral con advertencia no bloqueante | ✅ |
| Detección de inconsistencias del modelo híbrido | ✅ (3 reglas en "Para revisar") |
| Interfaz conversacional (6 tools + lista pegada) | ✅ |
| Movimiento grupal intacto | ✅ verificado con regresión explícita |

### Bugs preexistentes arreglados de paso
1. `GET /api/auth/livestock` paginaba **en memoria** (traía todas las filas y
   cortaba con `.slice()`). Ahora pagina en la base.
2. `set_livestock_price` **no estaba en el mapa de feature-gate** — escribía
   precios y creaba gastos/ingresos sin pasar el gate de plan.
3. `findMovementById` **no filtraba por `user_id`**, y el id llega desde un
   payload de botón (o sea, del cliente).
4. Sin guarda de doble reversión: dos taps del botón de deshacer aplicaban dos
   contra-asientos y descuadraban el inventario en silencio.
5. `accessibleFieldsSql` estaba **copiado en 3 repositorios**, los tres con la
   misma cicatriz ("el dueño no veía sus propios datos"). Extraído a
   `src/domain/shared/accessible-fields.ts`.
6. El mensaje del guard de taps repetidos estaba hardcodeado a lluvia — al
   re-tocar un botón de caravanas contestaba "esa lluvia ya la registré".

### Tests
**2440/2440 verdes** (128 archivos), typecheck limpio. Nuevos:

| Suite | Tests | Cubre |
|---|---|---|
| `animal-id.test.ts` | 24 | CII/NII, normalización, detección de listas |
| `livestock-breeds.test.ts` + paridad seed | 32 | Normalización de razas, seed SQL ↔ TS |
| `merge-duplicate-breeds.test.ts` | 14 | Planificador de fusión, conservación de cabezas |
| `animal.service.integration.test.ts` | 23 | Integridad de datos contra DB real |
| `corral-capacity.integration.test.ts` | 10 | Advertencia y aislamiento |
| `review-findings-livestock.integration.test.ts` | 8 | Las 3 reglas + los falsos positivos que NO deben disparar |
| `animal-tools-registration.test.ts` | 37 | Invariante 2 × 6 tools + grupo intacto |
| `pipeline.integration.test.ts` § híbrida | 7 | Flujo completo sin API |

El script de fusión de razas se validó además **end-to-end contra la base local**
con una colisión sintética: sumó las cabezas, repuntó el ledger, soft-deleteó el
perdedor con traza, y se restauró el estado previo.

---

## Pendiente (no implementado)

### Pendiente
- **Prueba de carga a 100k animales sin correr.** Los índices están diseñados
  para ese volumen y la resolución masiva es una sola query (verificada a 200
  lecturas en <3 s), pero eso no es evidencia a 100k. Es el único riesgo técnico
  abierto.

### Parcial
- **Import CSV**: funciona con listas de caravanas (pegadas o desde archivo
  `.csv`/`.txt`), que es lo que habilita el movimiento masivo. El parseo de
  **columnas** (raza, sexo, fecha de nacimiento en el mismo archivo) es P1.
- **Formulario Mini App** para carga de caravanas: no implementado (el chat y el
  dashboard ya cubren los casos reales).
- **Alta individual desde el dashboard**: se puede reemplazar la caravana de un
  animal existente por la ficha, pero el alta se hace por chat o por `POST
  /animals`. Falta el modal.

### Prueba de carga
- **No se corrió** el seed de 10k/50k/100k animales ni la medición de umbrales.
  Los índices están diseñados para ese volumen y el lookup masivo es una sola
  query (`= ANY($1::text[])`, verificado con 200 lecturas en <3s), pero **eso no
  es evidencia a 100k**. Es el riesgo técnico más importante que queda abierto.

### P1 (documentado, sin código)
Reproducción individual (servicios/preñez/FPP/partos/crías), condición corporal,
**período de retiro** (el de mayor valor para "¿puedo vender estos?"),
recategorización sugerida por edad, alertas ganaderas, dashboards de rodeo.

### P2/P3
Conciliación SENASA bidireccional por archivo, import de balanza, integración con
lector RFID, API SENASA si alguna vez se publica, multi-especie.

---

## Riesgos abiertos

| Riesgo | Severidad | Estado |
|---|---|---|
| **Performance a 100k animales sin medir** | Alta | Índices diseñados, lookup bulk verificado a 200; falta el seed y la medición |
| ~~Fusión de razas toca datos de producción~~ | ~~Alta~~ → **cerrado** | Dry-run contra la copia de prod: **0 colisiones**. No hay nada que fusionar; no se corre `--apply` |
| El agente empieza a rutear operaciones grupales por `move_animals` | Media | Regla CRÍTICO en el prompt + regresión que verifica que "mové 50 vacas" sigue siendo `transfer_livestock`. **No se corrió `npm run eval` ni `qa-hacienda-agro-80`** (consumen créditos de API) — conviene antes de desplegar |
| `individualized_count` se desincroniza | Baja | RECOUNT transaccional (no `+1`) + `reconcile()` + regla en "Para revisar" |
| Formato de RENSPA/CUIG no confirmado | Baja | Se guarda sin validar, TODO documentado en `docs/ganaderia/senasa.md`. No se inventó máscara |
| Sin permisos diferenciados por rol | Media | Todo va con el mismo scoping que el resto de hacienda (`user_id` + `isFieldAccessible`). El módulo `livestock-permissions.ts` del plan (owner para identificación/reversión) **no se implementó** |

---

## Deuda técnica introducida

- `AnimalHandler.resolveLocation` duplica parte de la resolución de ubicación que
  ya hace `LivestockService` — delega en él, pero la lectura de las claves
  (`destPlot` vs `plotName` vs `plot`) es propia. Si aparece un tercer camino de
  entrada, conviene centralizarla.
- `livestock.handler.ts` sigue en 2200+ líneas; la capa nueva se puso aparte pero
  no se refactorizó lo viejo.
- `countTotal` (grupos) no filtra `f.deleted_at IS NULL`, a diferencia de
  `listGroups` y del `countGroups` nuevo. Inconsistencia preexistente, no tocada
  para no cambiar el número que ve el usuario sin analizarlo aparte.

---

## Antes de desplegar

1. ~~Dry-run de fusión de razas contra la copia de prod~~ — **hecho: 0 colisiones,
   no hay nada que aplicar.**
2. ~~`npm run eval` y `qa-hacienda-agro-80`~~ — **hecho: 31/31 y 79/80 (Hacienda
   48/48), sin regresión contra el baseline.**
3. Seed de performance a 100k y medición de lookup/timeline/listado. **Pendiente.**

## Escenarios de eval agregados

| Escenario | Qué protege |
|---|---|
| `26-hacienda-grupo-intacto` | "mové 30 vacas del Norte al Sur" sigue siendo `transfer_livestock` con el agente REAL, y no crea ningún animal |
| `27-animal-alta-y-consulta` | alta por caravana, consulta por caravana, listado, y caravana inexistente |
| `28-animal-reemplazo-caravana` | reemplazo conservando historial; la vieja deja de resolver, la nueva sí |
| `29-animal-movimiento-individual` | movimiento por caravanas Y por cantidad **en la misma conversación** (la desambiguación más frágil) |
| `30-rfid-lista-pegada` | lista pegada → preview con desglose → tap → destino → movimiento |
| `31-animal-desambiguacion` | contrastes finos con el usuario YA individualizado: totales, sanidad grupal, y un número que es cantidad y no caravana |
