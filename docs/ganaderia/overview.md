# Ganadería — modelo híbrido Grupo + Animal individual

## Por qué existe esta capa

Hasta agosto de 2026 la hacienda de campo-bot era **exclusivamente agregada**: un
`livestock_group` es un balde `(ubicación × categoría × raza)` con un `count`, y
sanidad, reproducción y pesaje se registraban a nivel grupo. No existía ninguna
noción de animal individual — ni tablas, ni columnas, ni tools. El prompt del
agente incluso tenía una regla dura que respondía "el sistema lleva la hacienda
por grupos" ante cualquier pregunta por una caravana.

Eso dejó de alcanzar. La **Res. SENASA 530/2025** hizo obligatoria la
identificación individual electrónica de bovinos desde el 1-ene-2026. El
productor ya está obligado a manejar caravanas electrónicas; el sistema tenía que
poder representarlas. Ver [senasa.md](senasa.md) para la base normativa completa.

## El principio que ordena todo

> **El camino por grupos nunca depende del camino individual.**
> Un grupo con 0 animales individualizados se comporta EXACTAMENTE como antes de
> que esta capa existiera: mismas queries, mismas respuestas, mismos side-effects.
> Todo lo individual es aditivo y falla-suave.

No es una aspiración: es el criterio de aceptación. `AnimalService` **jamás toca
`livestock_groups.count`** — esa columna sigue siendo la proyección del ledger de
movimientos y su único dueño sigue siendo `LivestockRepository`. Lo único que la
capa nueva mantiene sobre los grupos es `individualized_count`, que es un dato
nuevo y no participa de ninguna decisión vieja.

La razón es de producto, no de arquitectura: la ventaja de campo-bot es que el
productor dicta "mové 50 vacas del Norte al Sur" y listo. Si individualizar se
volviera obligatorio para operar, el producto se convierte en el ERP ganadero que
la gente no quiere usar.

## Los tres estados válidos

```
Grupo de 100, 0 individualizados     → funciona igual que siempre
Grupo de 100, 60 individualizados    → parcial (NO es una inconsistencia)
Grupo de 100, 100 individualizados   → total
```

La individualización parcial es un estado **normal y esperado**, no un error. Lo
único que se reporta como inconsistencia es el **exceso**: un grupo que declara
100 cabezas y tiene 103 animales individuales asociados es aritmética imposible.
Ver [§ Consistencia](#consistencia).

## Estructura

```
Campo (fields + RENSPA / CUIG / titular sanitario)
 └── Lote (plots) │ Corral (corrals)
      └── Grupo (livestock_groups)      ← count agregado, INTACTO
           ├── categoría · raza (→ breed_id canónico)
           ├── count                    (proyección del ledger, como siempre)
           ├── individualized_count     (contador transaccional, dato nuevo)
           └── animals[] (0..N)         ← capa individual, OPCIONAL
                └── Animal
                     ├── animal_identifications[]  ← RFID/caravana como entidad-evento
                     └── animal_events[]           ← línea de tiempo
                          └── enlaza a domain_events / livestock_movements existentes
```

## Documentos

| Archivo | Qué cubre |
|---|---|
| [animal-model.md](animal-model.md) | La entidad Animal, estados, sexo derivado, consistencia con el grupo |
| [rfid.md](rfid.md) | Identificación como entidad-evento, formato CII, reemplazo de caravana, lotes de lectura |
| [senasa.md](senasa.md) | Base normativa con fuentes, qué se integra y qué explícitamente no |
| [whatsapp.md](whatsapp.md) | Tools nuevas, reglas de desambiguación grupo-vs-individual, lista pegada |

## Qué NO está implementado todavía

Honestidad sobre el alcance: esta entrega es **P0**. Quedan fuera, documentados
como roadmap y sin código:

- **Reproducción individual** (servicios/diagnósticos/preñez/fecha probable de
  parto/partos/crías por animal). Hoy la reproducción sigue siendo grupal en
  `domain_events`. El modelo de `animal_events` YA tiene los tipos
  (`servicio`, `inseminacion`, `diagnostico_prenez`, `parto`, `destete`) para que
  agregarlo no requiera migración.
- **Condición corporal** — el tipo de evento existe (`condicion_corporal`), la
  escala configurable y las consultas no.
- **Período de retiro** — nada implementado. Es P1 y es el que más valor tiene
  para "¿puedo vender estos animales?".
- **Recategorización sugerida por edad**, alertas ganaderas, dashboards de rodeo,
  import de balanza, conciliación SENASA bidireccional.
- **Import CSV con columnas completas** (raza, sexo, fecha de nacimiento): hoy el
  importador toma las caravanas y las resuelve contra el padrón, que es lo que
  habilita el movimiento masivo. El parseo de columnas es P1.

## Dashboard y API

La capa individual se opera por chat **y** por el dashboard, y las dos se ven lo
mismo: son la misma base.

Pestaña **Hacienda** → sub-tabs `Animales` e `Importar` (junto a `Grupos`, que
sigue primero por ser el modelo principal). `AnimalsPanel` lista con filtros y
búsqueda por caravana; `AnimalDetailDrawer` muestra ficha, historial COMPLETO de
caravanas (incluidas las retiradas), línea de tiempo y evolución de peso con GDP;
`AnimalImportPanel` hace preview → confirmar → aplicar. La tabla de `Grupos` suma
un "🏷️ N con caravana" que solo aparece cuando el grupo tiene algo individualizado.

```
GET    /api/auth/animals                      ?page&limit&status&category&sex&field_id&plot_id&corral_id&identified
GET    /api/auth/animals/lookup?ref=…          resolver una caravana
GET    /api/auth/animals/consistency           discrepancias del modelo híbrido
GET    /api/auth/animals/breeds                catálogo canónico
GET    /api/auth/animals/:id                   ficha + identificaciones + pesos
GET    /api/auth/animals/:id/timeline          keyset (?limit&before_date&before_id)
POST   /api/auth/animals                       alta individual (409 si la caravana ya está vigente)
POST   /api/auth/animals/:id/identifications   asignar / reemplazar caravana
POST   /api/auth/animals/import                preview de una lista o CSV — NO aplica nada
POST   /api/auth/animals/batches/:id/apply     aplicar (409 si ya se aplicó)
```

Todas con `requireAuth` + `requireFeature('livestock')`, y todo scopeado por
`user_id` **en la query**: los ids llegan del cliente y no se confía en ellos.

### El puente con el bot

Cuando el usuario carga animales por el dashboard, el agente tiene que
reconocerlos **en el mismo turno**. Dos piezas:

1. Las rutas que escriben llaman a `invalidateUserContext` — el contexto del
   agente cachea 60s, y sin esto lo recién cargado no existe para el bot hasta
   que expire.
2. `UserContext.individualizedAnimals` viaja al prompt como
   `animales con caravana:N`, **solo si es > 0**. Sin esa señal el agente no
   distingue "no encuentro esa caravana" de "este usuario no usa caravanas"; con
   ella sabe que puede usar `query_animal`/`list_animals`. En el caso mayoritario
   (solo grupos) el dato se omite y no gasta tokens.

Regresión del puente completo en `pipeline.integration.test.ts` § "lo cargado por
el DASHBOARD es visible para el bot en el mismo turno".

## Consistencia

`livestock-consistency` no es un servicio aparte: las discrepancias se publican
como reglas del registro `RULES` de `src/services/review-findings.service.ts`, que
ya alimenta el panel "Para revisar" del Resumen. Tres reglas nuevas:

| Regla | Severidad | Cuándo dispara |
|---|---|---|
| `livestock_group_vs_individuals` | warn | Más animales individuales que el `count` declarado del grupo |
| `corral_overcapacity` | info | Un corral con capacidad configurada que la superó |
| `animal_event_after_exit` | warn | Un animal vendido/muerto al que se le siguió **trabajando** (pesaje, movimiento, sanidad) |

La tercera excluye a propósito los eventos de contabilidad propia del animal
(`identificacion`, `ingreso`, `nacimiento`): dar de alta un animal hoy y fechar su
venta en mayo es carga retroactiva legítima, y reportarla dispararía en el uso
normal. Cada regla que explota loguea `[REVIEW]` y devuelve `[]` — nunca rompe el
Resumen.

`individualized_count` es una **desnormalización deliberada** (contar 100k filas
en cada listado de grupos no escala). Se mantiene con un RECOUNT dentro de la
misma transacción que el cambio — no un `+1`, porque un incremento se pierde ante
cualquier camino que no lo llame. `AnimalService.reconcile(userId)` recalcula
todo y devuelve cuántos estaban desviados.

## Archivos

| Archivo | Responsabilidad |
|---|---|
| `src/domain/livestock/animal.types.ts` | Tipos, `CATEGORY_SEX`, etiquetas |
| `src/domain/livestock/animal.repository.ts` | SQL bulk-first; lookup por RFID; timeline keyset |
| `src/domain/livestock/animal.service.ts` | Alta, re-identificación, movimiento, GDP, consistencia |
| `src/domain/livestock/animal-batch.service.ts` | `AnimalIdentificationSource`: preview → confirmar → aplicar |
| `src/domain/livestock/animal.handler.ts` | Los 9 comandos conversacionales |
| `src/domain/livestock/corral-capacity.service.ts` | Advertencia de sobrecapacidad (nunca bloqueo) |
| `src/utils/animal-id.ts` | **Fuente única** de validación/normalización de CII/NII/caravana |
| `src/utils/livestock-breeds.ts` | **Fuente única** de normalización de razas |
| `src/domain/shared/accessible-fields.ts` | **Fuente única** del subquery de campos accesibles |

Migraciones: `111` (razas) · `112` (animals + batches) · `113` (identificaciones)
· `114` (eventos) · `115` (auditoría + reversión) · `116` (RENSPA/CUIG).
