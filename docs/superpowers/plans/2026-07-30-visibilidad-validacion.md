# Plan: Visibilidad y Validación pre-lanzamiento

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preparar campo-bot para el piloto con 10-20 productores reales: guía orientada al productor, alertas proactivas reactivadas con opt-out por usuario, insights de tendencia en el resumen mensual, y runbook operativo del piloto.

**Architecture:** Tres frentes de código chico sobre infraestructura existente (el motor de alertas y el resumen mensual ya existen — se gatean y enriquecen, no se construyen) + dos entregables de documentación. Todo el código respeta los invariantes del CLAUDE.md: opt-out como comando trivial (parser + router + handler), intercepciones logueadas, kill switch admin para shipear dark.

**Tech Stack:** Node ESM + TypeScript/JS mixto, PostgreSQL (migraciones SQL numeradas), vitest, node-cron, Chrome headless para PDF.

## Global Constraints

- Todo texto de usuario en español argentino (voseo).
- ESM (`import`/`export`), nunca `require`.
- Migraciones: la última aplicada es `102_plan_yearly_price_seed.sql` → la nueva es `103_user_alerts_optout.sql` en `src/migrations/`. Se auto-aplican al arrancar la app.
- Invariante CLAUDE.md #1: toda capa que saltea/consume un mensaje o alerta LOGUEA (`[INTERCEPT]`).
- Invariante CLAUDE.md #2: comando trivial nuevo = regex en `src/utils/parser.js` + set en `src/domain/router.ts` + case en el handler (para triviales NO hace falta tool-definition).
- Baseline de tests local: 1753 pass + 16 env-dependent fails. Comparar contra ese baseline, no contra 100%.
- `PROACTIVE_ALERTS_ENABLED` arranca en `false` (ship dark) — se prende desde admin cuando arranque el piloto.
- NO tocar `landing/` (submódulo Lovable, no se edita a mano).
- Commits con `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Guía versión productor (PDF)

La guía actual (`docs/guia-funcionalidades.html`) mezcla audiencias: sirve como doc interno pero tiene un anexo con nombres de tools (`log_health_event`) que un productor no debe ver, y arranca por "qué es" en vez de "qué escribo".

**Files:**
- Create: `docs/guia-productor.html` (a partir de una copia de `docs/guia-funcionalidades.html`)
- Create: `docs/guia-productor-campo-bot.pdf` (generado)

**Interfaces:**
- Consumes: `docs/guia-funcionalidades.html` (existente)
- Produces: PDF listo para mandar por Telegram/mail a un productor del piloto (lo usa el runbook de Task 8)

- [ ] **Step 1: Copiar la base**

```bash
cp docs/guia-funcionalidades.html docs/guia-productor.html
```

- [ ] **Step 2: Aplicar estos cambios exactos a `docs/guia-productor.html`**

1. **Portada**: cambiar el `.sub` a `Guía rápida para el productor<br>Tu campo, por chat` y el `.meta` a `Julio 2026 · Telegram (WhatsApp próximamente)` (sacar "98 acciones disponibles" — es jerga interna).
2. **Eliminar el Anexo completo**: borrar desde `<h1 class="pb">Anexo: lista completa de acciones del asistente (98)</h1>` hasta el cierre de su `</table>` inclusive. Borrar también la línea del índice `<div>Anexo: lista completa de acciones</div>`.
3. **Eliminar la nota al pie** `<p class="footer-note">...tool-definitions.ts...</p>` y reemplazar por `<p class="footer-note">campo-bot · Guía para el productor · Julio 2026</p>`.
4. **Nueva sección "Tus primeros 5 minutos"** insertada ANTES de `<h1>1. Qué es campo-bot</h1>` (y agregar `<div>0. Tus primeros 5 minutos</div>` al inicio del índice):

```html
<h1>0. Tus primeros 5 minutos</h1>
<p>No hay que configurar nada. Abrí el chat y escribí (o mandá un audio con) cualquiera de estas frases, con tus datos:</p>
<div class="ej">
<b>1.</b> <em>"Tengo el campo La Esperanza en Pergamino con los lotes Norte de 50 has y Sur de 80"</em><br>
<b>2.</b> <em>"Gasté 500 mil en gasoil"</em><br>
<b>3.</b> <em>"Sembré soja en el lote Norte"</em><br>
<b>4.</b> <em>"Compré 40 vacas a 900 mil cada una"</em><br>
<b>5.</b> <em>"Llovieron 30mm ayer"</em><br>
<b>6.</b> <em>"¿Cuánto gasté este mes?"</em>
</div>
<p>Con eso ya tenés el campo armado y los primeros registros hechos. Si al bot le falta un dato, te lo pregunta él — no hace falta saber ningún comando. Y si escribís <em>"menú"</em> o <em>"ayuda"</em>, te muestra las opciones.</p>
```

5. **Sección 19 (Planes)**: en la tabla de planes, borrar la fila `Consultas con IA por día` (los límites diarios son detalle interno; el productor del piloto va con plan completo).

- [ ] **Step 3: Generar el PDF**

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="docs/guia-productor-campo-bot.pdf" \
  "file:///Users/juanpablomitriatti/Desktop/campo-bot/docs/guia-productor.html"
```

- [ ] **Step 4: Verificar render**

Leer las páginas 1-3 del PDF generado y confirmar: portada nueva, sección "0. Tus primeros 5 minutos" presente, sin anexo al final (última sección = "20. Tu cuenta y tus datos").

- [ ] **Step 5: Commit**

```bash
git add docs/guia-productor.html docs/guia-productor-campo-bot.pdf docs/guia-funcionalidades.html docs/guia-funcionalidades-campo-bot.pdf
git commit -m "docs: guía versión productor (sin anexo interno, con sección primeros 5 minutos)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Nota: este commit también incorpora la guía interna generada antes si seguía sin commitear.)

---

### Task 2: Migración `alerts_enabled` por usuario

**Files:**
- Create: `src/migrations/103_user_alerts_optout.sql`

**Interfaces:**
- Produces: columna `user_settings.alerts_enabled BOOLEAN DEFAULT TRUE` — la leen Task 3 (gate) y Task 4 (comandos opt-out).

- [ ] **Step 1: Escribir la migración**

```sql
-- 103_user_alerts_optout.sql
-- Opt-out por usuario de alertas proactivas (clima, monitoreo, plagas, stock bajo, fenología).
-- Default TRUE: el usuario recibe alertas salvo que diga "no más alertas".
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN DEFAULT TRUE;
```

- [ ] **Step 2: Aplicarla en local**

```bash
docker compose up -d && sleep 8 && docker compose logs app --tail 15
```
Expected: log de migraciones muestra `103_user_alerts_optout.sql` aplicada (o `npx tsx src/scripts/run-migrations.ts` si la app ya corría).

- [ ] **Step 3: Verificar la columna**

```bash
/opt/homebrew/opt/libpq/bin/psql "postgresql://campo:campo@localhost:5433/campo_bot" -c "\d user_settings" | grep alerts_enabled
```
Expected: `alerts_enabled | boolean | ... | default true`

- [ ] **Step 4: Commit**

```bash
git add src/migrations/103_user_alerts_optout.sql
git commit -m "feat(alerts): migración 103 — opt-out de alertas proactivas por usuario

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Gate central de opt-out en alert.service

Los 6 tipos de alerta proactiva pasan todos por `sendAlertWithRetry` / `sendAlertWithRetryMultiChannel` con su `alertType`. Gateamos ahí (un solo lugar) en vez de tocar los 6 ticks. Los tipos NO proactivos (`monthly_summary`, `weekly_summary`, `flow_halflife`, `flow_timeout`, recordatorios) no se gatean.

**Files:**
- Modify: `src/services/alert.service.js` (funciones en líneas ~16 y ~85)
- Test: `src/services/alert-optout.test.js` (nuevo)

**Interfaces:**
- Consumes: `user_settings.alerts_enabled` (Task 2), `pool` de `../config/db.js` (ya importado en el archivo).
- Produces: `isProactiveAlertType(alertType: string): boolean` y `OPT_OUT_FOOTER` (exportados); ambas funciones send devuelven `{ sent: false, skipped: 'opt_out' }` cuando el usuario optó por no recibir.

- [ ] **Step 1: Escribir el test de la parte pura (falla primero)**

```js
// src/services/alert-optout.test.js
import { describe, it, expect } from 'vitest';
import { isProactiveAlertType, OPT_OUT_FOOTER } from './alert.service.js';

describe('isProactiveAlertType', () => {
  it.each(['weather', 'monitoring_reminder', 'pest_escalation', 'missing_hectares', 'low_stock', 'phenology'])(
    'marca %s como proactiva', (t) => expect(isProactiveAlertType(t)).toBe(true)
  );
  it.each(['monthly_summary', 'weekly_summary', 'flow_halflife', 'flow_timeout', 'task_reminder'])(
    'NO marca %s como proactiva', (t) => expect(isProactiveAlertType(t)).toBe(false)
  );
});

describe('OPT_OUT_FOOTER', () => {
  it('menciona el comando de opt-out', () => {
    expect(OPT_OUT_FOOTER).toContain('no más alertas');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
npx vitest run src/services/alert-optout.test.js
```
Expected: FAIL — `isProactiveAlertType` no exportada.

- [ ] **Step 3: Implementar en `src/services/alert.service.js`**

Arriba del archivo (después de los imports existentes):

```js
// Tipos de alerta que el usuario puede apagar con "no más alertas".
// Los resúmenes (weekly/monthly), avisos de flow y recordatorios NO se gatean acá.
const PROACTIVE_ALERT_TYPES = new Set([
  'weather', 'monitoring_reminder', 'pest_escalation',
  'missing_hectares', 'low_stock', 'phenology',
]);

export const OPT_OUT_FOOTER = '\n\n_Para dejar de recibir estos avisos: «no más alertas»._';

export function isProactiveAlertType(alertType) {
  return PROACTIVE_ALERT_TYPES.has(alertType);
}

async function userAllowsProactiveAlerts(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(alerts_enabled, TRUE) AS ok FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  return rows.length === 0 ? true : rows[0].ok !== false;
}
```

Al comienzo de `sendAlertWithRetry` (antes del INSERT a `alert_history`) y de `sendAlertWithRetryMultiChannel` (mismo lugar), agregar el mismo bloque:

```js
if (isProactiveAlertType(alertType)) {
  if (!(await userAllowsProactiveAlerts(userId))) {
    console.log(`[alert.service] [INTERCEPT] alerta '${alertType}' salteada para user ${userId} (opt-out)`);
    return { sent: false, skipped: 'opt_out' };
  }
  message = message + OPT_OUT_FOOTER;
}
```

- [ ] **Step 4: Verificar que ningún call-site rompe con el nuevo return**

```bash
grep -n "result\.\w*" src/services/scheduler.js | grep -v "result.sent\|// " | head
```
Expected: los call-sites solo usan `result.sent` o loguean — nada accede a `result.alertId` de forma que rompa con `{ sent: false, skipped: 'opt_out' }`. Si algún sitio desestructura otra propiedad, agregarla como `undefined` es aceptable (solo se usa para logging).

- [ ] **Step 5: Correr el test y el suite del servicio**

```bash
npx vitest run src/services/alert-optout.test.js
npm test 2>&1 | tail -5
```
Expected: test nuevo PASS; total dentro del baseline (1753+16).

- [ ] **Step 6: Commit**

```bash
git add src/services/alert.service.js src/services/alert-optout.test.js
git commit -m "feat(alerts): gate central de opt-out para alertas proactivas + footer de baja

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Comandos triviales «no más alertas» / «dame alertas»

Espeja exactamente el patrón de `disable_tips`/`enable_tips` (parser regex → `SYSTEM_COMMANDS` en router → case en system.handler). Costo cero de IA.

**Files:**
- Modify: `src/utils/parser.js` (junto al bloque de tips, ~línea 788)
- Modify: `src/domain/router.ts` (línea ~112, junto a `'disable_tips', 'enable_tips'`)
- Modify: `src/domain/system/system.handler.ts` (junto a los cases de tips, ~línea 393)
- Test: `src/utils/parser.test.js` (agregar casos al final del archivo)

**Interfaces:**
- Consumes: columna `alerts_enabled` (Task 2).
- Produces: comandos `disable_alerts` / `enable_alerts` ruteados por DomainRouter.

- [ ] **Step 1: Escribir los tests del parser (fallan primero)**

Agregar al final de `src/utils/parser.test.js`:

```js
describe('alerts opt-out triviales', () => {
  it.each([
    'no más alertas',
    'no me mandes más alertas',
    'no quiero más avisos',
    'apagá las alertas',
    'sacame los avisos',
  ])('"%s" → disable_alerts', (msg) => {
    const r = parseMessage(msg);
    expect(r?.command).toBe('disable_alerts');
  });

  it.each([
    'dame alertas de nuevo',
    'quiero las alertas',
    'activá los avisos',
  ])('"%s" → enable_alerts', (msg) => {
    const r = parseMessage(msg);
    expect(r?.command).toBe('enable_alerts');
  });

  it('no roba frases con contexto ("no más alertas de lluvia por ahora" sigue siendo trivial igual)', () => {
    expect(parseMessage('registrá 50mil de gasoil')?.command).not.toBe('disable_alerts');
  });
});
```

(Usar el mismo helper de parseo que usan los tests existentes de `disable_tips` en ese archivo — si el archivo usa otro nombre que `parseMessage`, copiar el patrón del describe de tips.)

- [ ] **Step 2: Correr y verificar que fallan**

```bash
npx vitest run src/utils/parser.test.js 2>&1 | tail -8
```
Expected: FAIL en los casos nuevos.

- [ ] **Step 3: Agregar los patterns en `src/utils/parser.js`**

Inmediatamente después del bloque `enable_tips` existente:

```js
  // --- Alertas proactivas: opt-out / opt-in por usuario ---
  {
    command: "disable_alerts",
    patterns: [
      /^no\s+(?:me\s+)?(?:des|mandes|quiero)\s+(?:m[aá]s\s+)?(?:alertas?|avisos?)\b/i,
      /^no\s+m[aá]s\s+(?:alertas?|avisos?)\s*\.?$/i,
      /^(?:sacame|quitame|apag[aá])\s+(?:las?\s+|los?\s+)?(?:alertas?|avisos?)\b/i,
    ],
  },
  {
    command: "enable_alerts",
    patterns: [
      /^(?:dame|quiero|activ[aá]|prend[eé])\s+(?:las?\s+|los?\s+)?(?:alertas?|avisos?)(?:\s+de\s+nuevo)?\s*\.?$/i,
    ],
  },
```

- [ ] **Step 4: Registrar en el router**

En `src/domain/router.ts` línea ~112, extender la lista de SYSTEM_COMMANDS:

```ts
  'disable_tips', 'enable_tips',
  'disable_alerts', 'enable_alerts',
```

- [ ] **Step 5: Agregar los cases al handler**

En `src/domain/system/system.handler.ts`, después del case `enable_tips`:

```ts
      case 'disable_alerts': {
        await pool.query(`UPDATE user_settings SET alerts_enabled = FALSE WHERE user_id = $1`, [userId]);
        return { messages: ['👍 Listo, no te mando más alertas (clima, monitoreo, stock).\n\n_Los resúmenes y tus recordatorios siguen llegando. Para reactivarlas: "dame alertas de nuevo"._'] };
      }

      case 'enable_alerts': {
        await pool.query(`UPDATE user_settings SET alerts_enabled = TRUE WHERE user_id = $1`, [userId]);
        return { messages: ['🔔 Alertas activadas — te aviso de clima, monitoreos pendientes y stock bajo.'] };
      }
```

- [ ] **Step 6: Correr tests**

```bash
npx vitest run src/utils/parser.test.js 2>&1 | tail -5
npm test 2>&1 | tail -5
```
Expected: parser tests PASS; total dentro del baseline.

- [ ] **Step 7: Commit**

```bash
git add src/utils/parser.js src/domain/router.ts src/domain/system/system.handler.ts src/utils/parser.test.js
git commit -m "feat(alerts): comandos triviales no-más-alertas / dame-alertas (opt-out por usuario)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Reactivar los ticks con kill switch admin

Descomenta los dos bloques cron y los gatea con `PROACTIVE_ALERTS_ENABLED` (default `false`) para que el deploy salga dark y se prenda desde `/admin → Settings` al arrancar el piloto — mismo patrón que `TIPS_ENABLED`.

**Files:**
- Modify: `src/services/scheduler.js` (líneas ~570 `weatherAlertTick`, ~844 `proactiveAlertsTick`, ~1160-1175 bloque comentado en `startScheduler`)
- Modify: `src/services/settings.service.js` (mapa de defaults)

**Interfaces:**
- Consumes: `getSettingBool` (ya importado en scheduler.js), setting nuevo `PROACTIVE_ALERTS_ENABLED`.
- Produces: alertas corriendo en cron, apagadas hasta flip en admin.

- [ ] **Step 1: Agregar el setting default**

En `src/services/settings.service.js`, en el mapa de defaults (mismo formato que las entradas vecinas — buscar `TIPS_ENABLED` y copiar su shape; si no está en este archivo, agregarla junto a las del grupo `bot`):

```js
  PROACTIVE_ALERTS_ENABLED: { default: false, type: 'boolean', group: 'bot', label: 'Alertas proactivas', description: 'Kill switch de alertas proactivas (clima diario, recordatorio de monitoreo, escalamiento de plagas, hectáreas faltantes, stock bajo, fenología). Cada usuario puede además optar por no recibirlas con "no más alertas".' },
```

- [ ] **Step 2: Gatear ambos ticks**

En `src/services/scheduler.js`, primera línea del `try` de `weatherAlertTick()` (línea ~571):

```js
    if (await getSettingBool('PROACTIVE_ALERTS_ENABLED') !== true) return;
```

Y lo mismo como primera línea del `try` de `proactiveAlertsTick()` (línea ~845).

- [ ] **Step 3: Descomentar los bloques cron**

En `startScheduler()` (~línea 1160), reemplazar el bloque comentado `── ALERTAS DESACTIVADAS ──` completo por:

```js
  // Alertas proactivas — gateadas por PROACTIVE_ALERTS_ENABLED (admin, default false)
  // + opt-out por usuario (user_settings.alerts_enabled, comando "no más alertas").
  // Daily weather alerts — every minute (checks global_settings.daily_weather_hour HH:MM match)
  cron.schedule("* * * * *", () => {
    weatherAlertTick();
  });

  // Proactive alerts (monitoreo/plagas/hectáreas/stock/fenología) — every hour at :00 (checks hour === 8 internally)
  cron.schedule("0 * * * *", () => {
    proactiveAlertsTick();
  });
```

- [ ] **Step 4: Verificar en local que quedan dark por default**

```bash
docker compose restart app && sleep 8 && docker compose logs app --since 1m | grep -i "weather-alert\|proactive" ; echo "exit: $?"
```
Expected: sin líneas `[weather-alert] Running` ni `[proactive-alerts] Running` (el gate corta antes; puede no haber output — exit 1 del grep es el resultado esperado).

- [ ] **Step 5: Smoke del flip (opcional local)**

```bash
/opt/homebrew/opt/libpq/bin/psql "postgresql://campo:campo@localhost:5433/campo_bot" -c \
  "INSERT INTO system_settings (key, value) VALUES ('PROACTIVE_ALERTS_ENABLED','true') ON CONFLICT (key) DO UPDATE SET value='true';"
```
(El tick de clima chequea el HH:MM configurado y el proactivo `hour === 8`, así que no va a disparar mensajes fuera de hora — alcanza con ver que el proceso no loguea errores en el minuto siguiente. Revertir a `false` al terminar.)

- [ ] **Step 6: Correr suite y commitear**

```bash
npm test 2>&1 | tail -5
git add src/services/scheduler.js src/services/settings.service.js
git commit -m "feat(alerts): reactivar ticks de alertas con kill switch PROACTIVE_ALERTS_ENABLED (dark por default)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Módulo puro de insights de tendencia

El resumen mensual ya muestra totales con % vs mes anterior y top categorías. Lo que falta: **movers por categoría** ("Gasoil subió 18%"). Lógica pura en archivo nuevo, testeada sin DB.

**Files:**
- Create: `src/services/monthly-insights.js`
- Test: `src/services/monthly-insights.test.js`

**Interfaces:**
- Consumes: nada (funciones puras).
- Produces: `computeCategoryMovers(current, previous, opts?)` y `formatMoversLines(movers, formatCurrency)` — las consume Task 7. Shapes: entrada `Array<{category: string, total: number}>`; salida movers `Array<{category, pct: number|null, now: number, before: number}>` (pct `null` = categoría nueva).

- [ ] **Step 1: Escribir los tests (fallan primero)**

```js
// src/services/monthly-insights.test.js
import { describe, it, expect } from 'vitest';
import { computeCategoryMovers, formatMoversLines } from './monthly-insights.js';

const fmt = (n) => `$${Math.round(n).toLocaleString('es-AR')}`;

describe('computeCategoryMovers', () => {
  it('detecta suba relevante', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Gasoil', total: 590000 }],
      [{ category: 'Gasoil', total: 500000 }],
    );
    expect(movers).toHaveLength(1);
    expect(movers[0]).toMatchObject({ category: 'Gasoil', pct: 18 });
  });

  it('detecta baja relevante', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Semillas', total: 400000 }],
      [{ category: 'Semillas', total: 800000 }],
    );
    expect(movers[0].pct).toBe(-50);
  });

  it('filtra variaciones chicas (< minPct)', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Gasoil', total: 505000 }],
      [{ category: 'Gasoil', total: 500000 }],
    );
    expect(movers).toHaveLength(0);
  });

  it('filtra montos chicos (< minAmountArs) aunque el % sea grande', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Varios', total: 3000 }],
      [{ category: 'Varios', total: 1000 }],
    );
    expect(movers).toHaveLength(0);
  });

  it('marca categoría nueva con pct null', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Arrendamiento', total: 2000000 }],
      [],
    );
    expect(movers[0]).toMatchObject({ category: 'Arrendamiento', pct: null });
  });

  it('devuelve como mucho `top` movers, ordenados por |pct| desc', () => {
    const movers = computeCategoryMovers(
      [
        { category: 'A', total: 200000 }, { category: 'B', total: 300000 },
        { category: 'C', total: 400000 }, { category: 'D', total: 500000 },
      ],
      [
        { category: 'A', total: 100000 }, { category: 'B', total: 200000 },
        { category: 'C', total: 300000 }, { category: 'D', total: 400000 },
      ],
      { top: 2 },
    );
    expect(movers).toHaveLength(2);
    expect(movers[0].category).toBe('A'); // +100% es el mayor |pct|
  });
});

describe('formatMoversLines', () => {
  it('devuelve string vacío sin movers', () => {
    expect(formatMoversLines([], fmt)).toBe('');
  });

  it('formatea suba, baja y nuevo', () => {
    const out = formatMoversLines([
      { category: 'Gasoil', pct: 18, now: 590000, before: 500000 },
      { category: 'Semillas', pct: -50, now: 400000, before: 800000 },
      { category: 'Arrendamiento', pct: null, now: 2000000, before: 0 },
    ], fmt);
    expect(out).toContain('Tendencias');
    expect(out).toContain('Gasoil: subió 18%');
    expect(out).toContain('Semillas: bajó 50%');
    expect(out).toContain('Arrendamiento: nuevo este mes');
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
npx vitest run src/services/monthly-insights.test.js
```
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `src/services/monthly-insights.js`**

```js
/**
 * Insights de tendencia para el resumen mensual: qué categorías de gasto
 * se movieron de forma relevante vs el mes anterior. Lógica pura, sin DB.
 */

export function computeCategoryMovers(current, previous, opts = {}) {
  const { minPct = 15, minAmountArs = 50000, top = 3 } = opts;
  const prevMap = new Map((previous ?? []).map((c) => [c.category, Number(c.total)]));
  const movers = [];

  for (const c of current ?? []) {
    const now = Number(c.total);
    const before = prevMap.get(c.category) ?? 0;

    if (before <= 0) {
      // Categoría nueva este mes: solo relevante si el monto es significativo
      if (now >= minAmountArs * 4) movers.push({ category: c.category, pct: null, now, before: 0 });
      continue;
    }

    const pct = Math.round(((now - before) / before) * 100);
    if (Math.abs(pct) >= minPct && Math.max(now, before) >= minAmountArs) {
      movers.push({ category: c.category, pct, now, before });
    }
  }

  movers.sort((a, b) => Math.abs(b.pct ?? Infinity) - Math.abs(a.pct ?? Infinity));
  return movers.slice(0, top);
}

export function formatMoversLines(movers, formatCurrency) {
  if (!movers?.length) return '';
  let out = `\n\n📈 *Tendencias:*`;
  for (const m of movers) {
    if (m.pct === null) {
      out += `\n• ${m.category}: nuevo este mes (${formatCurrency(m.now)})`;
    } else {
      out += `\n• ${m.category}: ${m.pct >= 0 ? 'subió' : 'bajó'} ${Math.abs(m.pct)}% (${formatCurrency(m.before)} → ${formatCurrency(m.now)})`;
    }
  }
  return out;
}
```

Nota sobre el test de "categoría nueva": usa total 2.000.000 ≥ `50000 * 4`, pasa. El test de "montos chicos" usa 3.000 < 50.000, filtrado. Consistente.

- [ ] **Step 4: Correr y verificar que pasa**

```bash
npx vitest run src/services/monthly-insights.test.js
```
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/monthly-insights.js src/services/monthly-insights.test.js
git commit -m "feat(summary): módulo puro de movers por categoría para el resumen mensual

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Cablear insights al resumen mensual

**Files:**
- Modify: `src/services/scheduler.js` — función `buildMonthlyReport` (~línea 1029)

**Interfaces:**
- Consumes: `computeCategoryMovers` + `formatMoversLines` (Task 6); `getMonthTopCategories(userId, offset)` de `./expenses.js` (ya importada y usada en la misma función con offset 1); `formatCurrency` (ya usada en la función).
- Produces: bloque "📈 Tendencias" en el mensaje del resumen mensual.

- [ ] **Step 1: Agregar el import**

Junto a los imports de `./expenses.js` al tope de `scheduler.js`:

```js
import { computeCategoryMovers, formatMoversLines } from "./monthly-insights.js";
```

- [ ] **Step 2: Traer las categorías del mes anterior**

En el `Promise.all` de `buildMonthlyReport`, agregar `getMonthTopCategories(userId, 2)` al final del array y `prevTopCats` al final de la destructuración:

```js
  const [expense, prevExpense, income, prevIncome, topCats, rainfall, prevRainfall, actCount, prevTopCats] = await Promise.all([
    getMonthExpenses(userId, 1),
    getMonthExpenses(userId, 2),
    getMonthIncomes(userId, 1),
    getMonthIncomes(userId, 2),
    getMonthTopCategories(userId, 1),
    getMonthRainfall(userId, 1),
    getMonthRainfall(userId, 2),
    getMonthActivitiesCount(userId, 1),
    getMonthTopCategories(userId, 2),
  ]);
```

- [ ] **Step 3: Anexar el bloque de tendencias**

Después del bloque `if (topCats.length > 0) { ... }` existente:

```js
  const movers = computeCategoryMovers(topCats, prevTopCats);
  msg += formatMoversLines(movers, formatCurrency);
```

(Limitación conocida y aceptada para v1: `getMonthTopCategories` devuelve el top-N de cada mes, así que una categoría fuera del top de un mes puede no comparar — suficiente para el piloto.)

- [ ] **Step 4: Verificación manual con datos reales**

```bash
node -e "
import('./src/services/monthly-insights.js').then(({ computeCategoryMovers, formatMoversLines }) => {
  const fmt = (n) => '\$' + Math.round(n).toLocaleString('es-AR');
  const out = formatMoversLines(computeCategoryMovers(
    [{ category: 'Gasoil', total: 590000 }, { category: 'Semillas', total: 400000 }],
    [{ category: 'Gasoil', total: 500000 }, { category: 'Semillas', total: 800000 }],
  ), fmt);
  console.log(out);
});"
```
Expected: bloque `📈 *Tendencias:*` con "Gasoil: subió 18%" y "Semillas: bajó 50%".

- [ ] **Step 5: Suite completa y commit**

```bash
npm test 2>&1 | tail -5
git add src/services/scheduler.js
git commit -m "feat(summary): tendencias por categoría en el resumen mensual

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Runbook del piloto (10-20 productores)

Documento operativo: qué hacer antes, durante y después del piloto. No es código — es el guion que convierte "lanzar" en pasos chequeables.

**Files:**
- Create: `docs/piloto-runbook.md`

**Interfaces:**
- Consumes: `docs/guia-productor-campo-bot.pdf` (Task 1); las alertas gateadas (Tasks 2-5).
- Produces: runbook referenciable; sus queries SQL se corren contra prod cada semana.

- [ ] **Step 1: Escribir `docs/piloto-runbook.md`**

````markdown
# Runbook — Piloto con productores reales

Objetivo: 10-20 productores reales usando campo-bot 4 semanas, para decidir con datos
qué construir después (recomendaciones agronómicas / inteligencia financiera / otra cosa).

## Antes de invitar a nadie (bloqueantes)

- [ ] **Sentry activo**: setear `SENTRY_DSN` en Railway (el SDK ya está integrado).
      Verificar: forzar un error y verlo llegar al proyecto de Sentry.
- [ ] **Casilla de soporte real**: reemplazar `SUPPORT_CONTACT` (hoy apunta a duvips.com
      temporal) en admin → Settings → system.
- [ ] **Flip de alertas**: admin → Settings → bot → `PROACTIVE_ALERTS_ENABLED = true`.
- [ ] **Guía lista**: `docs/guia-productor-campo-bot.pdf` generada y revisada.
- [ ] Deploy verde: `curl https://campo-bot-production.up.railway.app/api/health`.

## Selección e invitación

- Perfil: productor mixto o agrícola de zona núcleo, que use WhatsApp/Telegram a diario.
  Ideal 3-4 conocidos directos (feedback brutal) + el resto por referidos.
- Canal: Telegram (WhatsApp todavía no está en prod).
- Mensaje de invitación (adaptar):

> Hola [nombre]! Estoy lanzando campo-bot, un asistente para llevar el campo por chat:
> le escribís "gasté 500 mil en gasoil" o "sembré soja en el lote norte" y él registra
> todo y te arma los números. Te doy acceso completo gratis por ser de los primeros —
> lo único que pido es que lo uses de verdad 2-3 semanas y me digas qué le falta.
> Te paso la guía en PDF y el link para arrancar: [PUBLIC_URL/register]

- Alta: registro en la web → vincular Telegram desde "Mi cuenta" (deep-link) → primer
  mensaje sugerido: que carguen su campo con la frase de la guía ("Tengo el campo X en...").

## Ritual semanal (20-30 min, lunes)

1. **Logs sospechosos**: `/admin → AI Training → Logs → filtro "⚠️ Sospechosas"` →
   marcar OK/Mal en bulk → "Promover" los casos que merezcan training example.
2. **Actividad** (psql prod):
   ```sql
   SELECT u.id, u.name, count(cl.id) AS msgs_7d, max(cl.created_at)::date AS ultimo
     FROM users u LEFT JOIN conversation_logs cl
       ON cl.user_id = u.id AND cl.created_at > now() - interval '7 days'
    WHERE u.deleted_at IS NULL AND u.phone_number NOT LIKE 'testbot%'
    GROUP BY u.id, u.name ORDER BY msgs_7d DESC;
   ```
3. **Silencios**: usuario del piloto con 0 mensajes en 7 días → mensaje personal
   ("¿te trabó algo?") — en piloto, el churn es feedback, no ruido.
4. **Errores**: bandeja de Sentry + `railway logs --deployment | grep -i "error\|INTERCEPT"`.
5. **Opt-outs de alertas**:
   ```sql
   SELECT count(*) FROM user_settings WHERE alerts_enabled = FALSE;
   ```
   Si más del 30% de los activos apagó las alertas en la semana 1, revisar frecuencia/tono
   antes de seguir sumando gente.

## Métricas de éxito (evaluar en semana 4)

| Métrica | Verde | Amarillo | Rojo |
|---|---|---|---|
| Activación (cargó campo + 1 registro en día 1) | ≥ 70% | 40-70% | < 40% |
| Retención semana 2 (≥ 1 mensaje) | ≥ 50% | 30-50% | < 30% |
| Dominios usados por usuario activo | ≥ 3 | 2 | 1 |
| Usuarios que pedirían una feature concreta | ≥ 5 | 2-4 | 0-1 |

## Decisión post-piloto

- **Verde** → abrir registro público + retomar backlog priorizado por lo que pidieron
  (candidatos ya identificados: recomendaciones agronómicas asistidas, inteligencia
  financiera de tendencias — ver análisis de feedback Jul 2026).
- **Amarillo** → segunda cohorte con los fixes de fricción encontrados; no abrir público.
- **Rojo** → entrevistas 1:1 con los que abandonaron antes de escribir una línea más de código.

## Registro de feedback

Cada pedido/queja de un productor → issue en GitHub con label `piloto` + quién lo pidió.
La prioridad post-piloto se decide contando quiénes pidieron qué, no por intuición.
````

- [ ] **Step 2: Commit**

```bash
git add docs/piloto-runbook.md
git commit -m "docs: runbook operativo del piloto con productores reales

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Orden de ejecución y dependencias

```
Task 1 (guía) ──────────────────────────┐
Task 2 (migración) → Task 3 (gate) → Task 4 (comandos) → Task 5 (reactivar ticks)
Task 6 (insights puros) → Task 7 (cableado resumen)     ├→ Task 8 (runbook) → push + deploy
                                                         ┘
```

- Tasks 1, 2-5 y 6-7 son independientes entre sí (paralelizables). Task 8 va última porque referencia los entregables.
- Push a main al final (un solo deploy); el deploy sale **dark** (`PROACTIVE_ALERTS_ENABLED=false`) — el flip es un paso del runbook, no del deploy.
- Post-deploy: correr `npm run eval` NO es necesario (no se tocó pipeline AI, prompt, tools ni handlers de parsing — solo parser trivial, scheduler y alert service); sí correr `npm test` completo antes del push.
