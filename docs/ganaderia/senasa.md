# SENASA — base normativa, qué se integra y qué no

> **Regla de este documento:** toda afirmación regulatoria lleva fuente, fecha y
> URL. Lo que no se pudo confirmar en fuente oficial primaria está marcado como
> **no confirmado** y NO se implementó como validación. Inventar una máscara y
> rechazar el dato real de un productor es peor que no validar.

## Fuentes

| Norma | Fecha | URL | Qué fija | Qué afecta en el código |
|---|---|---|---|---|
| Res. SENASA **530/2025** | BO 21-jul-2025 | https://www.boletinoficial.gob.ar/detalleAviso/primera/328620/20250721 | Art. 15: estructura del CII (15 díg. = `032` + especie + NII de 10). Art. 15(d)/8: ISO-11784 / 11785 / 24631, 64 bits. Art. 11: la caravana cinta en machos muestra solo el NII. Art. 2: obligatorio desde 1-ene-2026 | `src/utils/animal-id.ts` (parser y validador) |
| Res. SENASA **841/2025** | BO 3-nov-2025 | https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-841-2025-419696/texto | Art. 7: define el *binomio* (botón-botón RFID + tarjeta / bolo ruminal + tarjeta / transpondedor inyectable + tarjeta). Art. 11: reemplazo por pérdida; 11(d) exige referenciar el número anterior. Art. 8: declaración en **10 días hábiles** | Tabla `animal_identifications` (historial + `replaces_identification_id` + `senasa_declared_at`) |
| Trazabilidad individual electrónica | consultado 30-ago-2026 | https://www.argentina.gob.ar/trazabilidad-individual-electronica-bovina-bubalina-y-cervidos | Micrositio general del régimen | Contexto |
| RENSPA | consultado 30-ago-2026 | https://www.argentina.gob.ar/senasa/micrositios/renspa | Describe el **trámite**, no el formato del número | Ver "no confirmado" abajo |

## Cómo se declara (y por qué no hay API)

La Res. 841/2025 Art. 8 fija tres modalidades para declarar la colocación de
dispositivos:

1. presencial en la oficina local, con la planilla impresa;
2. **autogestión en SIGSA** (Sistema Integrado de Gestión de Sanidad Animal);
3. la app oficial **SIGBIOTraza**.

Se revisaron el micrositio DT-e y la página de Servicios en Línea de SENASA: **no
existe API pública documentada** de SIGSA/SIGBIOTraza para integración de
terceros. Por eso:

> **No se implementó ninguna integración directa, y no se inventó ningún
> endpoint.** La estrategia es trazabilidad interna + exportación/importación de
> archivos + conciliación.

`animal_identifications.senasa_declared_at` registra cuándo se declaró cada
identificación, con un índice parcial sobre lo no declarado — que es lo que
permite avisar qué queda pendiente dentro de los 10 días hábiles.

El diseño queda **desacoplado**: cuando exista una API, se agrega un adaptador sin
tocar el dominio. La exportación de la planilla y la importación del padrón para
conciliar son **P1** — todavía no implementadas.

## No confirmado

**El formato exacto de RENSPA y de CUIG no se pudo confirmar en fuente oficial
primaria.** El micrositio RENSPA documenta el trámite y los datos que se declaran,
no la máscara del número. Consecuencia en el código (migración `116`):

```sql
ALTER TABLE fields ADD COLUMN IF NOT EXISTS renspa VARCHAR(24);
ALTER TABLE fields ADD COLUMN IF NOT EXISTS cuig VARCHAR(12);
ALTER TABLE fields ADD COLUMN IF NOT EXISTS senasa_titular VARCHAR(120);
```

Se guardan como texto, con largo holgado y **sin validador estricto**.

**TODO abierto:** confirmar la máscara de RENSPA y CUIG contra el manual de
usuario de SENASA o la mesa de ayuda de SIGSA antes de agregar validación. Hasta
entonces, no rechazar ningún valor por formato.

En contraste, el CII **sí** se valida: su estructura está en el texto del Art. 15
de la Res. 530/2025, citado arriba.

## Qué NO hace el sistema

- No emite ni gestiona DT-e.
- No consulta el padrón de SENASA.
- No decide si un animal puede moverse o venderse: es una herramienta de
  **registro, trazabilidad y alerta**, no una autoridad sanitaria.
- No implementa período de retiro todavía (P1) — cuando se implemente, será un
  aviso, nunca un bloqueo.
