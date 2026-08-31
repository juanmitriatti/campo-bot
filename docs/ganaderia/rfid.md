# RFID / caravanas — identificación como entidad-evento

## Por qué NO es una columna `rfid`

La decisión más importante del modelo: la identificación es una **tabla con
historial**, no un string en `animals`.

La Res. SENASA 841/2025 Art. 11 regula el reemplazo del *binomio* (dispositivo
electrónico + tarjeta visual, Art. 7):

- pierde solo la tarjeta → puede o no reemplazarla, sigue trazable;
- pierde el componente electrónico → **debe** sustituir el binomio, sigue trazable;
- pierde el binomio completo → **el animal pierde su condición de trazable**.

Y el Art. 11(d) exige que la identificación nueva **referencie el número
anterior**. Una caravana cambia durante la vida del animal, y ese encadenamiento
*es* la trazabilidad. Una columna lo pisaría en cada reemplazo — justo el dato que
el organismo pide conservar.

## Formato del identificador

`src/utils/animal-id.ts` es la **fuente única**. Estructura del CII (Código de
Identificación Individual), Res. 530/2025 Art. 15:

```
032          01           0000000001
país         especie      NII (Número Individual Nacional)
ISO-3166     01=bovino    10 dígitos
─────────────────────────────────────
             15 dígitos en total
```

Referencias a ISO-11784 / ISO-11785 / ISO-24631; el código almacenado en el
dispositivo es binario natural de 64 bits.

### Qué acepta el parser

| Entrada | Resultado |
|---|---|
| 15 dígitos, `032` + `01` | `rfid`, CII completo, sin observaciones |
| 15 dígitos, otro país | `rfid`, CII completo + warning "origen extranjero" — es válido bajo ISO-11784, solo no es argentino |
| 15 dígitos, otra especie | `rfid`, CII completo + warning de especie |
| **10 dígitos** | `rfid`, NII suelto — **lectura legítima**: la caravana tipo cinta en machos muestra solo el NII (Art. 11) |
| Otro largo numérico | `caravana_visual` + warning |
| No numérico | `caravana_visual` + warning |
| Vacío | `interno` + warning |

**El sistema registra, no bloquea.** `parseAnimalId` nunca tira: un identificador
con formato inesperado se guarda con el tipo que el parser dedujo y queda
marcado como revisable. Un productor con el celular en el corral y barro en las
manos no puede quedar trabado porque tipeó 14 dígitos.

### Normalización

`normalizeAnimalId` colapsa las tres formas en que se escribe el mismo número:

```
"032 01 0001234567"  ┐
"032-01-0001234567"  ├→  "032010001234567"
"032010001234567"    ┘
```

El lookup usa `value_normalized`, y `resolveIdentifiers` busca además el NII
suelto y el CII reconstruido, porque el mismo animal pudo cargarse en cualquiera
de las dos formas.

## Unicidad: por usuario, no global

```sql
CREATE UNIQUE INDEX uq_animal_ident_current
  ON animal_identifications (user_id, id_type, value_normalized)
  WHERE is_current AND removed_date IS NULL;
```

Un CII es nacionalmente único, pero **un animal cambia de dueño legítimamente** y
ambos productores tendrán ese número en su historia. Una unicidad global rompería
la compra-venta. El duplicado entre usuarios se detecta como observación de
conciliación, nunca como constraint que bloquee un alta.

La unicidad aplica solo a lo **vigente**: retirar una caravana libera el número
para reasignarlo a otro animal, que es exactamente lo que pasa cuando se reusa
una caravana física.

## Reemplazo

`AnimalService.replaceIdentification` en una transacción:

1. valida que el número nuevo no esté vigente en OTRO animal;
2. retira la vigente (`is_current = false`, `removed_date`, `removal_reason`) —
   **nunca la borra**;
3. inserta la nueva con `replaces_identification_id` apuntando a la anterior;
4. deja un `animal_event` de tipo `reidentificacion` con `from_ref`/`to_ref`.

Después del reemplazo, el número viejo ya no resuelve en el lookup pero sigue
entero en el historial del animal.

## Lotes de lectura — `AnimalIdentificationSource`

Los cuatro orígenes producen lo mismo (un array de strings crudos) y confluyen en
`AnimalBatchService`. Agregar un lector RFID mañana es agregar un `source`, no un
camino nuevo.

```
lista pegada por chat ┐
import CSV            ├→ string[] → resolveBatch → animal_id_batches → preview → aplicar
formulario Mini App   │
alta manual           ┘
```

### La resolución cierra sus números

```
matched + unknown + duplicates + invalid = rawCount
```

Las cuatro categorías son disjuntas y suman el total leído. El productor tiene que
poder cuadrar "leí 90, encontré 87" sin adivinar dónde fueron los otros 3. El
resumen desglosa además por ubicación:

```
🔎 Leí 90 identificadores y encontré 87 animales.
  • 82 en Lote Norte
  • 3 en Lote Sur
  • 2 sin ubicación conocida
  • 2 sin registrar en tu rodeo
  • 1 repetido en la lectura
```

### Preview → confirmar → aplicar

Nunca se ejecuta una operación masiva sin que el productor haya visto el
desglose. El preview responde con **botones**, no con una pregunta suelta
(invariante 5).

### Idempotencia

Aplicar dos veces movería los mismos animales dos veces. Dos guardas:

1. `ONE_SHOT_PREFIXES` incluye `animal_batch_move_` — corta el segundo tap antes
   de procesar y contesta "esa lectura ya la apliqué";
2. la transición `previewed → applied` es un `UPDATE ... WHERE status =
   'previewed'` dentro de la misma transacción que el movimiento. Si el UPDATE no
   reclama ninguna fila, no se mueve nada.

Es el bug de lluvia acumulada de Ago 2026 en su versión ganadera: los dedups de
canal cubren el reintento del MISMO update, no dos entregas con ids distintos
(doble toque, solape de deploy).

## La lista pegada nunca llega al agente

`STEP 1.5` de `intent-classifier.ts`, antes del bypass trivial y antes de la IA:

```ts
if (looksLikeIdList(cleaned)) { … command: 'animal_batch_preview' … }
```

87 números en un prompt queman tokens, y Haiku mangla dígitos largos —
transpone, trunca, "resume" la lista. Con identificadores individuales, un dígito
cambiado apunta a **otro animal**. La detección es determinística y la resolución
contra el padrón es SQL puro.

`looksLikeIdList` pide al menos 5 líneas y que ≥80% parezcan identificadores
(≥8 caracteres alfanuméricos, mayoría dígitos). Los umbrales existen para no
robarle mensajes normales al agente: una lista de cantidades cortas
(`20\n15\n30\n45\n12\n8`) no dispara, y lenguaje natural con números tampoco.
Loguea `[RFID BATCH]` siempre (invariante 1).
