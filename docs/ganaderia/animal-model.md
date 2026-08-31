# La entidad Animal

## Tabla `animals` (migración 112)

```sql
id                UUID PK
user_id           INT NOT NULL → users(id)
field_id          INT → fields(id)
plot_id           INT → plots(id)          -- exclusivo con corral_id
corral_id         INT → corrals(id)
group_id          UUID → livestock_groups(id)   -- NULL es legítimo
category          livestock_category NOT NULL   -- el MISMO enum que los grupos
sex               animal_sex NOT NULL           -- 'M' | 'H'
breed_id          INT → livestock_breeds(id)
breed_text        VARCHAR(80)                   -- lo que escribió el usuario
birth_date        DATE
status            animal_status NOT NULL DEFAULT 'activo'
origin            VARCHAR(20)   -- nacimiento | compra | importacion | alta_manual
entry_date        DATE NOT NULL DEFAULT CURRENT_DATE
exit_date         DATE
mother_animal_id  UUID → animals(id)
notes             TEXT
source            animal_source NOT NULL DEFAULT 'manual'
created_by        INT → users(id)
created_at / updated_at / deleted_at
CONSTRAINT chk_animal_location CHECK (plot_id IS NULL OR corral_id IS NULL)
```

### Decisiones que no son obvias

**`group_id` puede ser NULL.** Un animal individualizado puede no estar asignado a
ningún grupo: recién importado, o sin ubicación conocida. Forzar el grupo
obligaría a inventar uno en el momento del alta.

**Los dos campos de ubicación pueden ser NULL a la vez** — a diferencia de
`livestock_groups`, cuyo CHECK exige exactamente uno. Un animal importado por CSV
sin ubicación conocida es un caso real que hay que poder representar (y después
reportar). El CHECK solo impide que esté en un lote *y* en un corral al mismo
tiempo.

**Se reusa el enum `livestock_category`.** Ninguna categoría nueva, ningún
espejo. Un animal y un grupo hablan el mismo idioma, y la recategorización
individual usa los mismos valores que la grupal.

**No hay FK desde `livestock_groups` hacia `animals`.** La dependencia va en un
solo sentido. Si la capa individual falla, la agregada sigue en pie.

## Sexo derivado de la categoría

Las categorías del rodeo argentino **ya codifican el sexo**, así que pedírselo al
usuario sería redundante en el 100% de los casos:

| Categoría | Sexo |
|---|---|
| vaca, vaquillona, ternera | H |
| ternero, novillo, novillito, toro, torito, buey | M |

`CATEGORY_SEX` en `animal.types.ts`. Es un **default, no una verdad inmutable**:
`sex` es una columna explícita y se puede corregir (un "ternero" cargado que
resultó ser ternera).

## Estados

`activo` · `vendido` · `muerto` · `extraviado` · `transferido`

`TERMINAL_STATUSES = ['vendido', 'muerto', 'transferido']` — los tres significan
que el animal salió del rodeo. `AnimalService.moveAnimals` los rechaza:

```
{ moved: 84, skipped: [{ animalId, reason: 'está muerto' }, …] }
```

Se devuelven **aparte, no como falla de la operación entera**. Que 3 de 87
caravanas correspondan a animales ya vendidos no puede impedir mover los otros 84.

## `individualized_count`

Columna en `livestock_groups`. Es una desnormalización deliberada: contar 100k
filas de `animals` en cada listado de grupos no escala.

Se mantiene con un **RECOUNT** (`SELECT COUNT(*)`) dentro de la misma transacción
que el cambio de `group_id`/`status`, nunca con un `+1`: un incremento se pierde
ante cualquier camino que no lo llame, y el recount es correcto aunque alguien
escriba por afuera.

Nunca se asume correcto para una decisión. `AnimalService.reconcile(userId)`
recalcula todos los grupos y devuelve cuántos estaban desviados.

## Índices (dimensionados para 100.000 animales por usuario)

```sql
idx_animals_user_active   (user_id, status)          WHERE deleted_at IS NULL
idx_animals_group         (group_id)                 WHERE deleted_at IS NULL AND group_id IS NOT NULL
idx_animals_plot          (plot_id)                  WHERE deleted_at IS NULL AND status='activo' AND plot_id IS NOT NULL
idx_animals_corral        (corral_id)                WHERE …
idx_animals_user_cat_sex  (user_id, category, sex)   WHERE deleted_at IS NULL AND status='activo'
idx_animals_mother        (mother_animal_id)         WHERE mother_animal_id IS NOT NULL
idx_animals_keyset        (user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL
```

Todos parciales para no crecer con bajas ni borrados. El keyset existe porque
`OFFSET` profundo sobre 100k filas no sirve.

## `animal_events` — la línea de tiempo

**Decisión central: NO se duplica `domain_events`.**

Sanidad, reproducción y pesaje ya viven en `domain_events` con `animal_category` +
`animals_affected` (migración 074). Un evento grupal ("vacuné 50 vacas contra
aftosa") **sigue siendo UNA sola fila ahí**. Los animales que participaron son N
filas en `animal_events` que **enlazan** a esa fila por `domain_event_id`. Lo
mismo con `livestock_movements`.

Consecuencias buscadas:

- toda query agregada existente sigue funcionando sin tocar una línea;
- no hay dos verdades sobre el mismo hecho;
- un pesaje grupal de 40 animales = 1 `domain_event` (la sesión) + 40
  `animal_events` con el peso de cada uno. El promedio del grupo y el peso
  individual salen del mismo hecho, no de dos registros que pueden divergir.

El payload es genérico a propósito (`numeric_value` / `text_value` / `unit` /
`from_ref` / `to_ref` / `related_animal_id`): agregar un tipo de evento no debe
requerir una migración. El CHECK impide que una fila enlace a un `domain_event` y
a un `livestock_movement` a la vez; los dos NULL significa evento puramente
individual (identificación, condición corporal, cambio de estado).

Índice de timeline: `(animal_id, event_date DESC, id DESC) WHERE deleted_at IS
NULL`. El `id` desempata — dos eventos del mismo día necesitan un orden estable o
la paginación repite o saltea.

## Ganancia diaria de peso

`AnimalService.getWeightGain` calcula GDP **por tramo**, sobre los días reales
transcurridos. No asume periodicidad uniforme:

```
01/06 → 410 kg  ┐ 30 días, +28 kg → 0,933 kg/día
01/07 → 438 kg  ┤ 31 días, +27 kg → 0,871 kg/día
01/08 → 465 kg  ┘ GDP global: 55 kg / 61 días = 0,902 kg/día
```

Con un solo pesaje devuelve `overallGdpKgDay: null` — **no inventa una ganancia**.
Dos pesajes el mismo día se descartan: no hay división por cero y, además, no
significan nada como ganancia.

## Razas

`breed` era texto libre **y parte del índice único** `(plot_id, category, breed)`,
así que "Angus" / "angus" / "Aberdeen Angus" creaban tres grupos distintos en el
mismo lote — corrupción de inventario ya presente en los datos, no un riesgo
futuro.

- `src/utils/livestock-breeds.ts` es la **fuente única** de normalización.
- `livestock_breeds` (migración 111) es el catálogo canónico, con sinónimos.
  Incluye salidas estructuradas para raza no declarada: `cruza`, `desconocida`,
  `otra`.
- Un test de paridad amarra el seed SQL con `BREED_CATALOG` en TS.
- `normalizeBreed` devuelve `null` cuando no reconoce — **deliberado**: no se
  fuerza a "Otra" en silencio, el llamador tiene contexto para decidir.

La **fusión de grupos ya partidos** vive en
`src/scripts/merge-duplicate-breeds.ts`, NO en la migración: cambia `count`
(existencias reales) y repunta el ledger de movimientos, y eso no puede pasar solo
al arrancar el proceso.

```bash
npx tsx src/scripts/merge-duplicate-breeds.ts             # DRY-RUN (default)
npx tsx src/scripts/merge-duplicate-breeds.ts --user 42   # acotado
npx tsx src/scripts/merge-duplicate-breeds.ts --apply     # aplica
```

El dry-run imprime exactamente qué se fusionaría. El ledger histórico **se
repunta, nunca se borra**: los movimientos de los grupos absorbidos pasan a
apuntar al sobreviviente. No se emite un movimiento de `ajuste` — no hubo cambio
de existencias reales, solo dejaron de estar partidas en dos filas.
