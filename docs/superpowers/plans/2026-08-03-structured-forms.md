# Formularios estructurados siembra/cosecha — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formulario de pantalla única (Telegram Mini App hoy, WhatsApp Flows preparado dark) para cargar siembras y cosechas de forma consistente, complementando el chat.

**Architecture:** Sesiones token-based en DB (`form_sessions`, patrón `map_tokens`) + `FormDefinition` como fuente única (render React, validación server-side, Flow JSON futuro). El submit entra por `DomainRouter.routeCommand` con lock por usuario — sin IA. El botón se ofrece vía side effect `offerForm` (invariante 9) y comando trivial `formulario`.

**Tech Stack:** Node ESM + TypeScript (tsx), Express, PostgreSQL, vitest (mocks, sin supertest), React + Tailwind (frontend in-repo), Telegram Bot API (`web_app` buttons).

**Spec:** `docs/superpowers/specs/2026-08-03-structured-forms-design.md`

## Global Constraints

- ESM (`import`/`export`), todo texto de usuario en español argentino.
- Invariantes P0 de CLAUDE.md aplican; en particular: 1 (todo drop/veto loguea — acá prefijo `[FORM]`), 2 (comando nuevo = registros en parser/router/handler), 5 (preguntas solo como pending o botones), 7 (bulkMode nunca bloquea → `offerForm` se suprime en compound), 9 (side effects solo vía `applySideEffects`), 12 (sin fechas futuras), 13 (cultivo nunca inferido — el form lo pide explícito), 15 (no tocar `clearAllUserPendingState`; acá se limpia UN pending puntual con `pendingActStore.clear`).
- Próxima migración: **`105_form_sessions.sql`** (la última aplicada es `104_user_settings_backfill.sql`).
- Baseline de tests local: 1753 pass + 16 env-dependent fails — comparar contra eso, no perseguir los 16.
- Token: `crypto.randomBytes(16).toString('hex')` (128 bits), TTL 30 min, un solo uso.
- `phone` interno por canal: telegram = `tg_<chatId>`, testbot = `testbot_<userId>`, whatsapp = número. `channel_id` telegram = chatId pelado (sin `tg_`).
- Los tests unit usan vitest + `vi.mock` de `../config/db.js` (patrón `src/domain/__tests__/router.test.ts`). No existe supertest.
- Commits frecuentes, mensajes en español estilo repo (`feat(forms): ...`), coautoría `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Migración `form_sessions` + `FormSessionService`

**Files:**
- Create: `src/migrations/105_form_sessions.sql`
- Create: `src/services/form-session.service.ts`
- Test: `src/services/__tests__/form-session.service.test.ts`

**Interfaces:**
- Consumes: `pool` de `src/config/db.js`.
- Produces: `formSessionService` singleton con:
  - `create(opts: { userId: number; action: 'sow_crop'|'harvest_crop'; prefill: Record<string, unknown>; channel: string; channelId: string; phone: string; hadPending: boolean }): Promise<string>` (retorna token)
  - `validate(token: string): Promise<FormSessionRow | null>` (null si usado/vencido/inexistente)
  - `markUsed(token: string): Promise<void>`
  - `interface FormSessionRow { token: string; user_id: number; action: 'sow_crop'|'harvest_crop'; prefill: Record<string, unknown>; channel: string; channel_id: string; phone: string; had_pending: boolean; used_at: string | null; expires_at: string }`

- [ ] **Step 1: Escribir la migración**

```sql
-- 105_form_sessions.sql
-- Sesiones de formularios estructurados (Telegram Mini App / WhatsApp Flows).
-- Token-based igual que map_tokens: corta vida, un solo uso, atado al usuario.
-- phone = clave interna de canal (tg_<chatId> / testbot_<id> / número WA) para
-- lock por usuario y stores de pendings al momento del submit.
CREATE TABLE IF NOT EXISTS form_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  prefill JSONB NOT NULL DEFAULT '{}'::jsonb,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  had_pending BOOLEAN NOT NULL DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_form_sessions_user ON form_sessions(user_id);

-- Variedad de siembra: la carga el formulario (el chat podrá sumarla a futuro).
ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS variety TEXT;
```

- [ ] **Step 2: Escribir el test que falla**

```typescript
// src/services/__tests__/form-session.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../../config/db.js', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

const { formSessionService } = await import('../form-session.service.js');

describe('FormSessionService', () => {
  beforeEach(() => queryMock.mockReset());

  it('create inserta con token hex de 32 chars y expiración', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const token = await formSessionService.create({
      userId: 1, action: 'sow_crop', prefill: { plotName: 'Norte' },
      channel: 'telegram', channelId: '123', phone: 'tg_123', hadPending: true,
    });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO form_sessions');
    expect(params[0]).toBe(token);
    expect(params[1]).toBe(1);
    expect(params[2]).toBe('sow_crop');
    expect(JSON.parse(params[3])).toEqual({ plotName: 'Norte' });
    expect(params[7]).toBe(true); // had_pending
  });

  it('validate devuelve null si no hay fila viva', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await formSessionService.validate('deadbeef')).toBeNull();
    expect(queryMock.mock.calls[0][0]).toContain('used_at IS NULL');
    expect(queryMock.mock.calls[0][0]).toContain('expires_at > NOW()');
  });

  it('validate devuelve la fila viva', async () => {
    const row = { token: 't', user_id: 1, action: 'harvest_crop' };
    queryMock.mockResolvedValue({ rows: [row] });
    expect(await formSessionService.validate('t')).toEqual(row);
  });

  it('markUsed setea used_at', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await formSessionService.markUsed('t');
    expect(queryMock.mock.calls[0][0]).toContain('SET used_at = NOW()');
  });
});
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `npx vitest run src/services/__tests__/form-session.service.test.ts`
Expected: FAIL (Cannot find module '../form-session.service.js')

- [ ] **Step 4: Implementar el servicio**

```typescript
// src/services/form-session.service.ts
import crypto from 'crypto';
import { pool } from '../config/db.js';

const TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 min, igual que map_tokens

export interface FormSessionRow {
  token: string;
  user_id: number;
  action: 'sow_crop' | 'harvest_crop';
  prefill: Record<string, unknown>;
  channel: string;
  channel_id: string;
  phone: string;
  had_pending: boolean;
  used_at: string | null;
  expires_at: string;
}

export class FormSessionService {
  async create(opts: {
    userId: number;
    action: 'sow_crop' | 'harvest_crop';
    prefill: Record<string, unknown>;
    channel: string;
    channelId: string;
    phone: string;
    hadPending: boolean;
  }): Promise<string> {
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);
    await pool.query(
      `INSERT INTO form_sessions (token, user_id, action, prefill, channel, channel_id, phone, had_pending, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
      [token, opts.userId, opts.action, JSON.stringify(opts.prefill),
       opts.channel, opts.channelId, opts.phone, opts.hadPending, expiresAt],
    );
    console.log(`[FORM] created action=${opts.action} user=${opts.userId} channel=${opts.channel} hadPending=${opts.hadPending}`);
    return token;
  }

  async validate(token: string): Promise<FormSessionRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM form_sessions WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [token],
    );
    return (rows[0] as FormSessionRow) ?? null;
  }

  async markUsed(token: string): Promise<void> {
    await pool.query(`UPDATE form_sessions SET used_at = NOW() WHERE token = $1`, [token]);
  }
}

export const formSessionService = new FormSessionService();
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `npx vitest run src/services/__tests__/form-session.service.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/migrations/105_form_sessions.sql src/services/form-session.service.ts src/services/__tests__/form-session.service.test.ts
git commit -m "feat(forms): migración form_sessions + FormSessionService token-based"
```

---

### Task 2: `FormDefinition` — fuente única de verdad + validación

**Files:**
- Create: `src/forms/form-definitions.ts`
- Modify: `src/utils/crops.ts` (exportar `KNOWN_CROPS`)
- Test: `src/forms/__tests__/form-definitions.test.ts`

**Interfaces:**
- Consumes: nada (módulo puro).
- Produces:
  - `interface FormField { key: string; label: string; type: 'select'|'date'|'number'|'text'|'group'; required: boolean; optionsSource?: 'plots'|'crops'; allowOther?: boolean; min?: number; max?: number; noFuture?: boolean; fields?: FormField[]; maxItems?: number; help?: string }`
  - `interface FormDefinition { action: 'sow_crop'|'harvest_crop'; title: string; fields: FormField[] }`
  - `FORM_DEFINITIONS: Record<'sow_crop'|'harvest_crop', FormDefinition>`
  - `validateFormPayload(def: FormDefinition, payload: Record<string, unknown>, todayISO: string): { ok: true; data: Record<string, unknown> } | { ok: false; errors: string[] }`
  - `KNOWN_CROPS: string[]` exportado desde `src/utils/crops.ts`

- [ ] **Step 1: Exportar `KNOWN_CROPS` en `src/utils/crops.ts`**

En `src/utils/crops.ts` la constante `KNOWN_CROPS` (líneas 11-28) hoy es privada. Cambiar:

```typescript
const KNOWN_CROPS = [
```

por:

```typescript
export const KNOWN_CROPS = [
```

- [ ] **Step 2: Escribir los tests que fallan**

```typescript
// src/forms/__tests__/form-definitions.test.ts
import { describe, it, expect } from 'vitest';
import { FORM_DEFINITIONS, validateFormPayload } from '../form-definitions.js';

const TODAY = '2026-08-03';

describe('FORM_DEFINITIONS', () => {
  it('siembra: plot_id y crop y event_date obligatorios; hectares y variety no', () => {
    const def = FORM_DEFINITIONS.sow_crop;
    const req = def.fields.filter(f => f.required).map(f => f.key);
    expect(req).toEqual(['plot_id', 'crop', 'event_date']);
    const opt = def.fields.filter(f => !f.required).map(f => f.key);
    expect(opt).toEqual(['hectares', 'variety']);
  });

  it('cosecha: incluye grupo repetible loads con driver_name y weight_kg obligatorios', () => {
    const loads = FORM_DEFINITIONS.harvest_crop.fields.find(f => f.key === 'loads');
    expect(loads?.type).toBe('group');
    const req = loads!.fields!.filter(f => f.required).map(f => f.key);
    expect(req).toEqual(['driver_name', 'weight_kg']);
  });
});

describe('validateFormPayload — siembra', () => {
  const def = FORM_DEFINITIONS.sow_crop;

  it('acepta payload completo y normaliza tipos', () => {
    const r = validateFormPayload(def, {
      plot_id: 7, crop: 'soja', event_date: '2026-08-01', hectares: 50, variety: 'DM 4670',
    }, TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.hectares).toBe(50);
  });

  it('rechaza sin cultivo', () => {
    const r = validateFormPayload(def, { plot_id: 7, event_date: TODAY }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('Cultivo');
  });

  it('rechaza fecha futura (plan futuro ≠ registro)', () => {
    const r = validateFormPayload(def, { plot_id: 7, crop: 'soja', event_date: '2026-08-04' }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('futura');
  });

  it('rechaza hectáreas <= 0', () => {
    const r = validateFormPayload(def, { plot_id: 7, crop: 'soja', event_date: TODAY, hectares: 0 }, TODAY);
    expect(r.ok).toBe(false);
  });
});

describe('validateFormPayload — cosecha', () => {
  const def = FORM_DEFINITIONS.harvest_crop;

  it('acepta solo con lote y fecha (sin rinde ni cargas)', () => {
    const r = validateFormPayload(def, { plot_id: 7, event_date: TODAY }, TODAY);
    expect(r.ok).toBe(true);
  });

  it('rechaza yield_kg y yield_kg_per_ha juntos (excluyentes)', () => {
    const r = validateFormPayload(def, {
      plot_id: 7, event_date: TODAY, yield_kg: 100000, yield_kg_per_ha: 3200,
    }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('rinde');
  });

  it('rechaza humedad fuera de 0-50', () => {
    const r = validateFormPayload(def, { plot_id: 7, event_date: TODAY, humidity_pct: 80 }, TODAY);
    expect(r.ok).toBe(false);
  });

  it('valida cargas: chofer y peso obligatorios por ítem', () => {
    const r = validateFormPayload(def, {
      plot_id: 7, event_date: TODAY,
      loads: [{ driver_name: 'Juan', weight_kg: 28500 }, { driver_name: '', weight_kg: 100 }],
    }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('Carga 2');
  });

  it('acepta cargas válidas con opcionales', () => {
    const r = validateFormPayload(def, {
      plot_id: 7, event_date: TODAY,
      loads: [{ driver_name: 'Juan', weight_kg: 28500, destinatario: 'Cargill', humidity_pct: 14 }],
    }, TODAY);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Correr y verificar que falla**

Run: `npx vitest run src/forms/__tests__/form-definitions.test.ts`
Expected: FAIL (Cannot find module '../form-definitions.js')

- [ ] **Step 4: Implementar `form-definitions.ts`**

```typescript
// src/forms/form-definitions.ts
// Fuente ÚNICA de verdad de los formularios estructurados: de acá salen el
// render del form React (GET /api/forms/:token), la validación server-side
// del submit y, a futuro, el Flow JSON de WhatsApp. Nunca duplicar esto.

export interface FormField {
  key: string;
  label: string;
  type: 'select' | 'date' | 'number' | 'text' | 'group';
  required: boolean;
  optionsSource?: 'plots' | 'crops';
  allowOther?: boolean;
  min?: number;
  max?: number;
  noFuture?: boolean;
  fields?: FormField[];
  maxItems?: number;
  help?: string;
}

export interface FormDefinition {
  action: 'sow_crop' | 'harvest_crop';
  title: string;
  fields: FormField[];
}

export const FORM_DEFINITIONS: Record<'sow_crop' | 'harvest_crop', FormDefinition> = {
  sow_crop: {
    action: 'sow_crop',
    title: '🌱 Registrar siembra',
    fields: [
      { key: 'plot_id', label: 'Lote', type: 'select', required: true, optionsSource: 'plots' },
      { key: 'crop', label: 'Cultivo', type: 'select', required: true, optionsSource: 'crops', allowOther: true },
      { key: 'event_date', label: 'Fecha', type: 'date', required: true, noFuture: true },
      { key: 'hectares', label: 'Hectáreas sembradas', type: 'number', required: false, min: 0.01, help: 'Solo si sembraste una parte del lote' },
      { key: 'variety', label: 'Variedad', type: 'text', required: false, help: 'Ej: DM 4670' },
    ],
  },
  harvest_crop: {
    action: 'harvest_crop',
    title: '🌾 Registrar cosecha',
    fields: [
      { key: 'plot_id', label: 'Lote', type: 'select', required: true, optionsSource: 'plots' },
      { key: 'event_date', label: 'Fecha', type: 'date', required: true, noFuture: true },
      { key: 'yield_kg_per_ha', label: 'Rinde (kg/ha)', type: 'number', required: false, min: 1 },
      { key: 'yield_kg', label: 'Rinde total (kg)', type: 'number', required: false, min: 1 },
      { key: 'humidity_pct', label: 'Humedad (%)', type: 'number', required: false, min: 0, max: 50 },
      {
        key: 'loads', label: 'Cargas por camión', type: 'group', required: false, maxItems: 20,
        fields: [
          { key: 'driver_name', label: 'Chofer', type: 'text', required: true },
          { key: 'weight_kg', label: 'Peso (kg)', type: 'number', required: true, min: 1 },
          { key: 'destinatario', label: 'Destinatario', type: 'text', required: false },
          { key: 'humidity_pct', label: 'Humedad (%)', type: 'number', required: false, min: 0, max: 50 },
        ],
      },
    ],
  },
};

type ValidationResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; errors: string[] };

function validateScalar(f: FormField, raw: unknown, errors: string[], label?: string): unknown {
  const name = label ?? f.label;
  const empty = raw === undefined || raw === null || raw === '';
  if (empty) {
    if (f.required) errors.push(`${name} es obligatorio.`);
    return undefined;
  }
  if (f.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) { errors.push(`${name} debe ser un número.`); return undefined; }
    if (f.min !== undefined && n < f.min) { errors.push(`${name} debe ser mayor a ${f.min <= 0.01 ? 0 : f.min - 1}.`); return undefined; }
    if (f.max !== undefined && n > f.max) { errors.push(`${name} debe ser como máximo ${f.max}.`); return undefined; }
    return n;
  }
  if (f.type === 'text' || f.type === 'select') {
    const s = String(raw).trim();
    if (!s) { if (f.required) errors.push(`${name} es obligatorio.`); return undefined; }
    return s;
  }
  return raw;
}

export function validateFormPayload(
  def: FormDefinition,
  payload: Record<string, unknown>,
  todayISO: string,
): ValidationResult {
  const errors: string[] = [];
  const data: Record<string, unknown> = {};

  for (const f of def.fields) {
    const raw = payload[f.key];
    if (f.type === 'date') {
      const empty = raw === undefined || raw === null || raw === '';
      if (empty) { if (f.required) errors.push(`${f.label} es obligatoria.`); continue; }
      const s = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) { errors.push(`${f.label} inválida.`); continue; }
      if (f.noFuture && s > todayISO) { errors.push(`${f.label} no puede ser futura.`); continue; }
      data[f.key] = s;
    } else if (f.type === 'group') {
      if (raw === undefined || raw === null) continue;
      if (!Array.isArray(raw)) { errors.push(`${f.label} inválidas.`); continue; }
      if (f.maxItems && raw.length > f.maxItems) { errors.push(`${f.label}: máximo ${f.maxItems}.`); continue; }
      const items: Record<string, unknown>[] = [];
      raw.forEach((item, i) => {
        const out: Record<string, unknown> = {};
        for (const sub of f.fields ?? []) {
          const v = validateScalar(sub, (item as Record<string, unknown>)[sub.key], errors, `Carga ${i + 1}: ${sub.label.toLowerCase()}`);
          if (v !== undefined) out[sub.key] = v;
        }
        items.push(out);
      });
      if (items.length > 0) data[f.key] = items;
    } else {
      const v = validateScalar(f, raw, errors);
      if (v !== undefined) data[f.key] = v;
    }
  }

  // Regla cruzada de cosecha: rinde por ha y total son excluyentes.
  if (def.action === 'harvest_crop' && data.yield_kg !== undefined && data.yield_kg_per_ha !== undefined) {
    errors.push('Cargá el rinde por hectárea O el total, no los dos.');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, data };
}
```

- [ ] **Step 5: Correr los tests de la task y el archivo de crops**

Run: `npx vitest run src/forms/__tests__/form-definitions.test.ts src/utils/crops.test.ts`
Expected: PASS los nuevos; los tests existentes de crops (si los hay) siguen verdes.

- [ ] **Step 6: Commit**

```bash
git add src/forms/form-definitions.ts src/forms/__tests__/form-definitions.test.ts src/utils/crops.ts
git commit -m "feat(forms): FormDefinition única para siembra/cosecha + validación server-side"
```

---

### Task 3: Botones `web_app` en Telegram

**Files:**
- Modify: `src/services/message-pipeline.ts` (interface `InteractiveButton`, ~línea 290)
- Modify: `src/services/telegram.ts` (función `sendTelegramButtons`, líneas 56-98)
- Modify: `src/services/whatsapp.js` (función `sendInteractiveButtons`, líneas 132-161)
- Test: `src/services/__tests__/telegram-webapp-buttons.test.ts`

**Interfaces:**
- Consumes: `InteractiveButton { id: string; title: string }` existente.
- Produces: `InteractiveButton` gana campo opcional `webAppUrl?: string`. En Telegram renderiza `{ text, web_app: { url } }`; en WhatsApp el botón con `webAppUrl` se omite con log `[FORM] skip web_app button (whatsapp v1)`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/services/__tests__/telegram-webapp-buttons.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();

describe('sendTelegramButtons con webAppUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mapea webAppUrl a web_app y el resto a callback_data', async () => {
    const { sendTelegramButtons } = await import('../telegram.js');
    await sendTelegramButtons(123, 'Elegí', [
      { id: 'a', title: 'Normal' },
      { id: 'b', title: '📝 Formulario', webAppUrl: 'https://x.test/form/tok' },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reply_markup.inline_keyboard[0][0]).toEqual({ text: 'Normal', callback_data: 'a' });
    expect(body.reply_markup.inline_keyboard[1][0]).toEqual({
      text: '📝 Formulario', web_app: { url: 'https://x.test/form/tok' },
    });
  });
});
```

Nota: si `telegram.ts` no lee `TELEGRAM_BOT_TOKEN` de env sino de settings, seguir el patrón de mock del test existente de telegram si lo hay; si no lo hay, mockear el módulo de settings igual que hacen otros tests del repo.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/services/__tests__/telegram-webapp-buttons.test.ts`
Expected: FAIL (el segundo botón sale con `callback_data: 'b'`)

- [ ] **Step 3: Implementar**

En `src/services/message-pipeline.ts`, interface `InteractiveButton`:

```typescript
export interface InteractiveButton {
  id: string;       // callback ID
  title: string;    // max 20 chars
  webAppUrl?: string; // si está: Telegram lo abre como Mini App (web_app), no callback
}
```

En `src/services/telegram.ts`, dentro de `sendTelegramButtons`, reemplazar:

```typescript
const inline_keyboard = buttons.map(b => [{ text: b.title, callback_data: b.id }]);
```

por:

```typescript
const inline_keyboard = buttons.map(b => [
  (b as { webAppUrl?: string }).webAppUrl
    ? { text: b.title, web_app: { url: (b as { webAppUrl?: string }).webAppUrl } }
    : { text: b.title, callback_data: b.id },
]);
```

(Si el parámetro `buttons` está tipado inline como `Array<{ id: string; title: string }>`, ampliarlo a `Array<{ id: string; title: string; webAppUrl?: string }>` y quitar los casts.)

En `src/services/whatsapp.js`, al inicio del map de botones de `sendInteractiveButtons`, filtrar:

```javascript
const renderable = buttons.filter((b) => {
  if (b.webAppUrl) {
    console.log('[FORM] skip web_app button (whatsapp v1):', b.title);
    return false;
  }
  return true;
});
```

y usar `renderable` en lugar de `buttons` en el armado del payload.

- [ ] **Step 4: Correr y verificar que pasa + suite de servicios**

Run: `npx vitest run src/services/__tests__/telegram-webapp-buttons.test.ts && npm test`
Expected: PASS el nuevo; `npm test` contra baseline (1753 + 16 env-dependent).

- [ ] **Step 5: Commit**

```bash
git add src/services/message-pipeline.ts src/services/telegram.ts src/services/whatsapp.js src/services/__tests__/telegram-webapp-buttons.test.ts
git commit -m "feat(forms): botones web_app (Mini App) en Telegram; skip logueado en WhatsApp"
```

---

### Task 4: Side effect `offerForm` + hook en pipeline + supresión en bulkMode

**Files:**
- Create: `src/forms/form-offer.ts`
- Modify: `src/services/message-pipeline.ts` (tipo `HandlerResponse.sideEffects` + call sites de conversión respuesta→items)
- Modify: `src/domain/compound-executor.ts` (interceptor bulkMode, líneas ~292-332)
- Test: `src/forms/__tests__/form-offer.test.ts`

**Interfaces:**
- Consumes: `formSessionService` (Task 1), `InteractiveButton.webAppUrl` (Task 3), `getSetting` de `src/services/settings.service.js`, `ChannelContext`.
- Produces:
  - Key nueva en `HandlerResponse['sideEffects']`: `offerForm?: { action: 'sow_crop'|'harvest_crop'; prefill: Record<string, unknown> }`
  - `appendFormOffer(items: BotResponseItem[], response: HandlerResponse, ctx: ChannelContext): Promise<void>` — si hay `offerForm`, crea la sesión y pushea el item con botón web_app. Exportada desde `src/forms/form-offer.ts`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/forms/__tests__/form-offer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn().mockResolvedValue('tok123');
vi.mock('../../services/form-session.service.js', () => ({
  formSessionService: { create: (...a: unknown[]) => createMock(...a) },
}));
const getSettingMock = vi.fn();
vi.mock('../../services/settings.service.js', () => ({
  getSetting: (...a: unknown[]) => getSettingMock(...a),
}));

const { appendFormOffer } = await import('../form-offer.js');

const ctx = {
  channel: 'telegram', phone: 'tg_555', userId: 9,
  user: {}, settings: {}, startTime: 0,
} as never;

describe('appendFormOffer', () => {
  beforeEach(() => { createMock.mockClear(); getSettingMock.mockReset(); });

  it('sin offerForm no hace nada', async () => {
    const items: unknown[] = [];
    await appendFormOffer(items as never, { messages: [] } as never, ctx);
    expect(items).toHaveLength(0);
  });

  it('con offerForm crea sesión y agrega botón web_app', async () => {
    getSettingMock.mockResolvedValue('https://campo.test');
    const items: unknown[] = [];
    const response = {
      messages: ['🌱 ¿Qué cultivo sembraste?'],
      sideEffects: {
        offerForm: { action: 'sow_crop', prefill: { plotName: 'Norte' } },
        setPendingActivity: { command: 'sow_crop', data: {}, missing: ['crop'] },
      },
    };
    await appendFormOffer(items as never, response as never, ctx);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 9, action: 'sow_crop', channel: 'telegram',
      channelId: '555', phone: 'tg_555', hadPending: true,
    }));
    expect(items).toHaveLength(1);
    const item = items[0] as { interactive: { buttons: Array<{ webAppUrl?: string }> } };
    expect(item.interactive.buttons[0].webAppUrl).toBe('https://campo.test/form/tok123');
  });

  it('sin PUBLIC_URL no ofrece y loguea', async () => {
    getSettingMock.mockResolvedValue(null);
    const items: unknown[] = [];
    await appendFormOffer(items as never, {
      messages: [], sideEffects: { offerForm: { action: 'sow_crop', prefill: {} } },
    } as never, ctx);
    expect(items).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('en whatsapp no ofrece (v1)', async () => {
    getSettingMock.mockResolvedValue('https://campo.test');
    const items: unknown[] = [];
    await appendFormOffer(items as never, {
      messages: [], sideEffects: { offerForm: { action: 'sow_crop', prefill: {} } },
    } as never, { ...(ctx as object), channel: 'whatsapp', phone: '549341...' } as never);
    expect(items).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/forms/__tests__/form-offer.test.ts`
Expected: FAIL (Cannot find module '../form-offer.js')

- [ ] **Step 3: Implementar `form-offer.ts`**

```typescript
// src/forms/form-offer.ts
import { formSessionService } from '../services/form-session.service.js';
import { getSetting } from '../services/settings.service.js';
import type { BotResponseItem, ChannelContext, HandlerResponse } from '../services/message-pipeline.js';

const ACTION_LABEL: Record<string, string> = {
  sow_crop: 'la siembra',
  harvest_crop: 'la cosecha',
};

/** channel_id "crudo" por canal: telegram guarda tg_<chatId> en phone. */
function rawChannelId(ctx: ChannelContext): string {
  if (ctx.channel === 'telegram') return ctx.phone.replace(/^tg_/, '');
  return ctx.phone;
}

export async function appendFormOffer(
  items: BotResponseItem[],
  response: HandlerResponse,
  ctx: ChannelContext,
): Promise<void> {
  const offer = response.sideEffects?.offerForm;
  if (!offer) return;
  if (ctx.channel === 'whatsapp') {
    console.log('[FORM] skip offer (whatsapp v1)');
    return;
  }
  const publicUrl = ((await getSetting('PUBLIC_URL')) as string) || '';
  if (!publicUrl) {
    console.log('[FORM] skip offer: PUBLIC_URL vacío');
    return;
  }
  const token = await formSessionService.create({
    userId: Number(ctx.userId),
    action: offer.action,
    prefill: offer.prefill ?? {},
    channel: ctx.channel,
    channelId: rawChannelId(ctx),
    phone: ctx.phone,
    hadPending: !!response.sideEffects?.setPendingActivity,
  });
  const url = `${publicUrl.replace(/\/$/, '')}/form/${token}`;
  items.push({
    type: 'interactive',
    interactive: {
      type: 'buttons',
      body: `📝 Si preferís, cargá ${ACTION_LABEL[offer.action] ?? 'los datos'} con un formulario:`,
      buttons: [{ id: `form_open_${token}`, title: '📝 Abrir formulario', webAppUrl: url }],
    },
  });
}
```

- [ ] **Step 4: Declarar la key y enchufar los call sites**

1. En `src/services/message-pipeline.ts`, en el tipo `HandlerResponse['sideEffects']`, agregar:

```typescript
offerForm?: { action: 'sow_crop' | 'harvest_crop'; prefill: Record<string, unknown> };
```

2. Buscar en `message-pipeline.ts` los call sites donde el resultado de `domainRouter.routeCommand(...)` se convierte a `BotResponseItem[]` (buscar `routeCommand` — el principal está cerca de la línea 1175: `const items: BotResponseItem[] = result.messages.map(...)`). En cada uno de esos call sites (path de texto Y path de `handleInteractiveReply`), inmediatamente después del `applySideEffects(...)` correspondiente, agregar:

```typescript
await appendFormOffer(items, result, ctx);
```

con `import { appendFormOffer } from '../forms/form-offer.js';` arriba. Si en algún call site la variable no se llama `result`/`items`, adaptar los nombres pero mantener la semántica: SIEMPRE después de `applySideEffects`, ANTES de despachar los items.

3. En `src/domain/compound-executor.ts`, en el interceptor bulkMode (bloque `if (bulkMode && response.sideEffects)`, líneas ~292-332), dentro del objeto `sideEffects` reescrito, agregar el strip:

```typescript
offerForm: undefined,          // invariante 7: en compound nunca se ofrecen formularios
```

y en el `console.log` del interceptor existente dejar constancia si venía un offerForm (`[INTERCEPT] offerForm suprimido en bulkMode`) — invariante 1.

- [ ] **Step 5: Correr y verificar que pasa**

Run: `npx vitest run src/forms/__tests__/form-offer.test.ts && npm test`
Expected: PASS nuevo + baseline intacto.

- [ ] **Step 6: Commit**

```bash
git add src/forms/form-offer.ts src/forms/__tests__/form-offer.test.ts src/services/message-pipeline.ts src/domain/compound-executor.ts
git commit -m "feat(forms): side effect offerForm + botón Mini App en pipeline; suprimido en bulkMode"
```

---

### Task 5: Handlers sow/harvest emiten `offerForm` + variedad en siembra

**Files:**
- Modify: `src/domain/agronomy/agronomy.handler.ts` (cases `sow_crop` ~2089-2186 y `harvest_crop` ~2188-2540)
- Modify: `src/services/expenses.js` (función `createPlotCrop`)
- Test: `src/domain/agronomy/__tests__/agronomy-offer-form.test.ts` (o sumar al archivo de tests existente del handler si ya hay uno — buscar `agronomy.handler` bajo `__tests__` y seguir su patrón de mocks)

**Interfaces:**
- Consumes: key `offerForm` (Task 4).
- Produces:
  - `sow_crop` con crop placeholder → `sideEffects` incluye ADEMÁS `offerForm: { action: 'sow_crop', prefill: { plotName: cmd.plotName ?? null, fieldName: cmd.fieldName ?? null, eventDate: cmd.eventDate ?? null, hectares: cmd.hectares ?? null } }`
  - Ídem `harvest_crop` placeholder → `offerForm: { action: 'harvest_crop', prefill: { plotName: ..., fieldName: ..., eventDate: ... } }`
  - `createPlotCrop(plotId, crop, seasonYear, seasonType, eventDate, sowedHectares, variety = null)` — 7º parámetro opcional, persiste `plot_crops.variety`.
  - `sow_crop` lee `cmd.variety` (string|null); si está, lo pasa a `createPlotCrop` y agrega línea `🧬 Variedad: <X>` a la confirmación.

- [ ] **Step 1: Escribir el test que falla**

Seguir el patrón de mocks del test existente más cercano al handler de agronomía (buscar con `ls src/domain/agronomy/__tests__/ 2>/dev/null || grep -rln "agronomyHandler\|AgronomyHandler" src --include="*.test.ts"`). El test debe cubrir:

```typescript
// src/domain/agronomy/__tests__/agronomy-offer-form.test.ts (esqueleto de asserts;
// el arnés de mocks copia el del test existente del handler)
import { describe, it, expect } from 'vitest';

describe('sow_crop sin cultivo → offerForm', () => {
  it('el pending por crop faltante viene acompañado de offerForm con prefill', async () => {
    // arrange: handler con mocks, cmd = { command: 'sow_crop', crop: null,
    //          plotName: 'Norte', fieldName: null, eventDate: '2026-08-01' }
    // act: response = await handler.handleCommand(cmd, userId, user, settings)
    // assert:
    // expect(response.sideEffects?.setPendingActivity?.missing).toEqual(['crop']);
    // expect(response.sideEffects?.offerForm).toEqual({
    //   action: 'sow_crop',
    //   prefill: { plotName: 'Norte', fieldName: null, eventDate: '2026-08-01', hectares: null },
    // });
  });
});
```

(Escribir los asserts REALES con el arnés del repo; el comentario de arriba define el contrato exacto que deben verificar. Hacer lo mismo para `harvest_crop`.)

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/domain/agronomy/__tests__/agronomy-offer-form.test.ts`
Expected: FAIL (`offerForm` undefined)

- [ ] **Step 3: Implementar en el handler**

En `agronomy.handler.ts`, case `sow_crop`, el return del placeholder de crop hoy es:

```typescript
return {
  messages: ['🌱 ¿Qué cultivo sembraste? (ej: soja, maíz, trigo, girasol)'],
  sideEffects: {
    setPendingActivity: {
      command: 'sow_crop',
      data: { ...cmd, _needs: 'crop' },
      missing: ['crop'],
      askPrompt: '🌱 ¿Qué cultivo sembraste? (ej: soja, maíz, trigo, girasol)',
    },
  },
};
```

agregarle la key hermana:

```typescript
    offerForm: {
      action: 'sow_crop',
      prefill: {
        plotName: (cmd.plotName as string) ?? null,
        fieldName: (cmd.fieldName as string) ?? null,
        eventDate: (cmd.eventDate as string) ?? null,
        hectares: (cmd.hectares as number) ?? null,
      },
    },
```

Ídem en el placeholder de `harvest_crop` (sin `hectares`). El interceptor de compound ya la suprime (Task 4).

- [ ] **Step 4: Variedad**

1. En `src/services/expenses.js`, `createPlotCrop`: agregar 7º parámetro `variety = null` y sumar la columna al INSERT de `plot_crops` (`variety`) con su placeholder. Ningún caller existente cambia (parámetro opcional).
2. En el case `sow_crop`, donde se llama `createPlotCrop(...)`, pasar `cmd.variety ?? null` como 7º argumento, y si `cmd.variety` es truthy agregar a los messages de confirmación la línea:

```typescript
`🧬 Variedad: ${cmd.variety}`
```

- [ ] **Step 5: Correr y verificar que pasa**

Run: `npx vitest run src/domain/agronomy/__tests__/agronomy-offer-form.test.ts && npm test`
Expected: PASS + baseline intacto.

- [ ] **Step 6: Commit**

```bash
git add src/domain/agronomy/agronomy.handler.ts src/services/expenses.js src/domain/agronomy/__tests__/agronomy-offer-form.test.ts
git commit -m "feat(forms): sow/harvest ofrecen formulario al faltar cultivo; variedad en siembra"
```

---

### Task 6: Comando trivial `formulario` + callbacks del picker

**Files:**
- Modify: `src/utils/parser.js` (array de patrones de comandos, ~línea 738 donde está `menu`)
- Modify: `src/services/intent-classifier.ts` (`TRIVIAL_COMMANDS`, líneas 61-94)
- Modify: `src/domain/router.ts` (set de comandos que contiene `'menu'`)
- Modify: `src/domain/billing/feature-gate.ts` (`commandToFeature`, líneas 71-201)
- Modify: el handler de sistema que atiende `menu` (seguir el switch donde vive `menu` — `src/domain/system/…`)
- Modify: `src/domain/interactive/interactive.router.ts` (mapeo de callbacks)
- Test: `src/utils/parser.test.js` (casos nuevos) + test del handler

**Interfaces:**
- Consumes: key `offerForm` (Task 4).
- Produces:
  - Comando `open_form` (trivial): "formulario" / "formulario siembra" / "formulario de cosecha" → SIEMPRE responde el picker de 2 botones (v1: un tap extra aunque haya nombrado la acción; documentado).
  - Comandos `open_form_sow` / `open_form_harvest` (solo vía callback): responden `{ messages: ['📝 Abrí el formulario con el botón:'], sideEffects: { offerForm: { action, prefill: {} } } }`.
  - Callbacks `form_open_sow` → `open_form_sow`, `form_open_harvest` → `open_form_harvest`.

- [ ] **Step 1: Test del parser que falla**

En `src/utils/parser.test.js`, siguiendo el estilo de los tests de comandos existentes, agregar:

```javascript
describe('open_form (comando trivial)', () => {
  it.each(['formulario', 'formulario siembra', 'formulario de cosecha', 'Formulario'])(
    'parsea "%s" como open_form', (text) => {
      const cmd = parseCommand(text);
      expect(cmd?.command).toBe('open_form');
    });

  it('NO roba frases con formulario en el medio', () => {
    expect(parseCommand('me llegó el formulario de AFIP hoy')).toBeNull();
  });
});
```

(Si `parseCommand` no se exporta con ese nombre, usar el mismo import que usan los tests de `menu` en ese archivo.)

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/utils/parser.test.js`
Expected: FAIL en los casos nuevos.

- [ ] **Step 3: Implementar los 5 registros**

1. `src/utils/parser.js`, junto a la entrada de `menu` (línea ~738), agregar (regex ANCLADO, como `pizarra`):

```javascript
{ command: "open_form", patterns: [/^formulario(\s+(de\s+)?(la\s+)?(siembra|cosecha))?$/] },
```

2. `src/services/intent-classifier.ts`: agregar `'open_form'` a `TRIVIAL_COMMANDS`.
3. `src/domain/router.ts`: agregar `'open_form', 'open_form_sow', 'open_form_harvest'` al set que contiene `'menu'` (los `*_COMMANDS` de sistema).
4. `src/domain/billing/feature-gate.ts`, `commandToFeature`: agregar

```typescript
open_form: 'agronomy',
open_form_sow: 'agronomy',
open_form_harvest: 'agronomy',
```

5. En el handler de sistema (el switch que atiende `menu`), agregar los tres cases:

```typescript
case 'open_form':
  return {
    messages: [],
    interactive: {
      type: 'buttons',
      body: '📝 ¿Qué querés cargar con formulario?',
      buttons: [
        { id: 'form_open_sow', title: '🌱 Siembra' },
        { id: 'form_open_harvest', title: '🌾 Cosecha' },
      ],
    },
  };
case 'open_form_sow':
  return {
    messages: [],
    sideEffects: { offerForm: { action: 'sow_crop', prefill: {} } },
  };
case 'open_form_harvest':
  return {
    messages: [],
    sideEffects: { offerForm: { action: 'harvest_crop', prefill: {} } },
  };
```

6. `src/domain/interactive/interactive.router.ts`: mapear los callbacks `form_open_sow` y `form_open_harvest` a los comandos `open_form_sow` / `open_form_harvest`, siguiendo el patrón de mapeos existente en ese archivo. IMPORTANTE: el path de `handleInteractiveReply` debe pasar por el hook `appendFormOffer` (Task 4 paso 4.2 lo cubre — verificar acá que el botón realmente sale al tocar el picker).

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run src/utils/parser.test.js && npm test`
Expected: PASS + baseline intacto.

- [ ] **Step 5: Commit**

```bash
git add src/utils/parser.js src/services/intent-classifier.ts src/domain/router.ts src/domain/billing/feature-gate.ts src/domain/system src/domain/interactive/interactive.router.ts src/utils/parser.test.js
git commit -m "feat(forms): comando trivial 'formulario' + picker siembra/cosecha (registro triple, invariante 2)"
```

---

### Task 7: `FormSubmitService` — del payload al handler

**Files:**
- Create: `src/forms/form-submit.service.ts`
- Test: `src/forms/__tests__/form-submit.service.test.ts`

**Interfaces:**
- Consumes: `formSessionService` (T1), `FORM_DEFINITIONS`/`validateFormPayload` (T2), `pool`, y de `src/services/message-pipeline.ts`: `domainRouter`, `userRepository`, `pendingActStore`, `hydratePendingStores`, `applySideEffects`. De `src/middleware/user-lock.ts`: `withUserLock`. Senders: `sendTelegramMessage`/`sendTelegramButtons` (telegram.js... ver paso 3), `sendMessage` de whatsapp.js. `getActiveCrop` de `src/services/expenses.js`. `getTodayISO` de `src/utils/date.ts`.
- Produces:
  - `submitForm(token: string, payload: Record<string, unknown>): Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }>`
  - Reglas de resultado: `status` 404 = token inválido/vencido, 409 = ya resuelto por chat, 422 = validación o handler rechazó, 200 = registrado.

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
// src/forms/__tests__/form-submit.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionValidate = vi.fn();
const sessionMarkUsed = vi.fn();
vi.mock('../../services/form-session.service.js', () => ({
  formSessionService: {
    validate: (...a: unknown[]) => sessionValidate(...a),
    markUsed: (...a: unknown[]) => sessionMarkUsed(...a),
  },
}));

const queryMock = vi.fn();
vi.mock('../../config/db.js', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
}));

const routeCommand = vi.fn();
const pendingGet = vi.fn();
const pendingClear = vi.fn();
vi.mock('../../services/message-pipeline.js', () => ({
  domainRouter: { routeCommand: (...a: unknown[]) => routeCommand(...a) },
  userRepository: { getSettings: vi.fn().mockResolvedValue({}) },
  pendingActStore: { get: (...a: unknown[]) => pendingGet(...a), clear: (...a: unknown[]) => pendingClear(...a) },
  hydratePendingStores: vi.fn().mockResolvedValue(undefined),
  applySideEffects: vi.fn().mockReturnValue({}),
}));
vi.mock('../../middleware/user-lock.js', () => ({
  withUserLock: (_k: string, fn: () => Promise<unknown>) => fn(),
}));
const sendTg = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/telegram.js', () => ({
  sendTelegramMessage: (...a: unknown[]) => sendTg(...a),
  sendTelegramButtons: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/whatsapp.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));
const getActiveCropMock = vi.fn();
vi.mock('../../services/expenses.js', () => ({
  getActiveCrop: (...a: unknown[]) => getActiveCropMock(...a),
}));

const { submitForm } = await import('../form-submit.service.js');

const SESSION = {
  token: 'tok', user_id: 9, action: 'sow_crop', prefill: {},
  channel: 'telegram', channel_id: '555', phone: 'tg_555',
  had_pending: false, used_at: null, expires_at: '',
};

function mockUserRow() {
  // 1ª query: SELECT users; 2ª: SELECT lote del usuario
  queryMock
    .mockResolvedValueOnce({ rows: [{ id: 9, name: 'Juan' }] })
    .mockResolvedValueOnce({ rows: [{ id: 7, name: 'Norte', field_name: 'La Esperanza' }] });
}

describe('submitForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionValidate.mockResolvedValue({ ...SESSION });
  });

  it('404 con token muerto', async () => {
    sessionValidate.mockResolvedValue(null);
    const r = await submitForm('x', {});
    expect(r).toEqual({ ok: false, status: 404, error: expect.stringContaining('venció') });
  });

  it('409 si había pending y ya no está (se resolvió por chat)', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, had_pending: true });
    pendingGet.mockReturnValue(undefined);
    mockUserRow();
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(sessionMarkUsed).toHaveBeenCalledWith('tok'); // se cierra el token
    expect(routeCommand).not.toHaveBeenCalled();
  });

  it('422 con payload inválido', async () => {
    mockUserRow();
    const r = await submitForm('tok', { plot_id: 7, event_date: '2026-08-01' }); // sin crop
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it('422 si el lote no es del usuario', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })
      .mockResolvedValueOnce({ rows: [] }); // lote no encontrado
    const r = await submitForm('tok', { plot_id: 99, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it('happy path siembra: rutea, confirma al chat, consume token y limpia pending', async () => {
    mockUserRow();
    pendingGet.mockReturnValue({ command: 'sow_crop', data: {} });
    routeCommand.mockResolvedValue({ messages: ['🌱 Siembra registrada'] });
    const r = await submitForm('tok', {
      plot_id: 7, crop: 'soja', event_date: '2026-08-01', hectares: 50, variety: 'DM 4670',
    });
    expect(r).toEqual({ ok: true, message: '🌱 Siembra registrada' });
    const cmd = routeCommand.mock.calls[0][0] as Record<string, unknown>;
    expect(cmd.command).toBe('sow_crop');
    expect(cmd.crop).toBe('soja');
    expect(cmd.plotName).toBe('Norte');
    expect(cmd.fieldName).toBe('La Esperanza');
    expect(cmd.eventDate).toBe('2026-08-01');
    expect(cmd.hectares).toBe(50);
    expect(cmd.variety).toBe('DM 4670');
    expect(sendTg).toHaveBeenCalledWith('555', '🌱 Siembra registrada');
    expect(sessionMarkUsed).toHaveBeenCalledWith('tok');
    expect(pendingClear).toHaveBeenCalledWith('tg_555');
  });

  it('cosecha toma el crop del cultivo activo y mapea loads', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'harvest_crop' });
    mockUserRow();
    getActiveCropMock.mockResolvedValue({ crop: 'maíz' });
    pendingGet.mockReturnValue(undefined);
    routeCommand.mockResolvedValue({ messages: ['🌾 Cosecha registrada'] });
    const r = await submitForm('tok', {
      plot_id: 7, event_date: '2026-08-01', humidity_pct: 14,
      loads: [{ driver_name: 'Juan', weight_kg: 28500, destinatario: 'Cargill' }],
    });
    expect(r.ok).toBe(true);
    const cmd = routeCommand.mock.calls[0][0] as Record<string, unknown>;
    expect(cmd.command).toBe('harvest_crop');
    expect(cmd.crop).toBe('maíz');
    expect(cmd.loads).toEqual([{ driver_name: 'Juan', weight_kg: 28500, destinatario: 'Cargill' }]);
  });

  it('cosecha sin cultivo activo → 422', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'harvest_crop' });
    mockUserRow();
    getActiveCropMock.mockResolvedValue(null);
    const r = await submitForm('tok', { plot_id: 7, event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cultivo activo');
  });

  it('handler que pide pending → 422 sin consumir token', async () => {
    mockUserRow();
    routeCommand.mockResolvedValue({
      messages: ['¿En qué lote?'],
      sideEffects: { setPendingActivity: { command: 'sow_crop', data: {}, missing: ['plot'] } },
    });
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    expect(sessionMarkUsed).not.toHaveBeenCalled();
  });

  it('mensaje de error del handler (❌) → 422 sin consumir token', async () => {
    mockUserRow();
    routeCommand.mockResolvedValue({ messages: ['❌ No encontré el lote'] });
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('No encontré');
    expect(sessionMarkUsed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/forms/__tests__/form-submit.service.test.ts`
Expected: FAIL (módulo inexistente)

- [ ] **Step 3: Implementar `form-submit.service.ts`**

```typescript
// src/forms/form-submit.service.ts
// Submit de un formulario estructurado: valida contra la FormDefinition,
// serializa con el lock del usuario y entra por DomainRouter.routeCommand
// (mismo handler que el chat — cero IA). Token de un solo uso = idempotencia.
import { pool } from '../config/db.js';
import { formSessionService, type FormSessionRow } from '../services/form-session.service.js';
import { FORM_DEFINITIONS, validateFormPayload } from './form-definitions.js';
import {
  domainRouter, userRepository, pendingActStore,
  hydratePendingStores, applySideEffects,
} from '../services/message-pipeline.js';
import { withUserLock } from '../middleware/user-lock.js';
import { sendTelegramMessage } from '../services/telegram.js';
import { sendMessage as sendWhatsAppText } from '../services/whatsapp.js';
import { getActiveCrop } from '../services/expenses.js';
import { getTodayISO } from '../utils/date.js';

type SubmitResult =
  | { ok: true; message: string }
  | { ok: false; status: number; error: string };

async function loadUserPlot(userId: number, plotId: number): Promise<{ id: number; name: string; field_name: string } | null> {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, f.name AS field_name
       FROM plots p JOIN fields f ON f.id = p.field_id
      WHERE p.id = $1 AND f.user_id = $2 AND p.deleted_at IS NULL AND f.deleted_at IS NULL`,
    [plotId, userId],
  );
  return rows[0] ?? null;
}

async function sendToChat(session: FormSessionRow, text: string): Promise<void> {
  try {
    if (session.channel === 'telegram') await sendTelegramMessage(session.channel_id, text);
    else if (session.channel === 'whatsapp') await sendWhatsAppText(session.channel_id, text);
    // testbot: sin push — el resultado viaja en la respuesta HTTP del form
  } catch (err) {
    console.error('[FORM] fallo el envío de confirmación al chat:', err);
  }
}

export async function submitForm(token: string, payload: Record<string, unknown>): Promise<SubmitResult> {
  const session = await formSessionService.validate(token);
  if (!session) {
    console.log('[FORM] rejected: token inválido/vencido');
    return { ok: false, status: 404, error: 'Este formulario venció. Pedime otro en el chat con «formulario siembra» o «formulario cosecha».' };
  }

  const def = FORM_DEFINITIONS[session.action];
  const validated = validateFormPayload(def, payload, getTodayISO());
  if (!validated.ok) {
    console.log(`[FORM] rejected: validación (${validated.errors.length} errores)`);
    return { ok: false, status: 422, error: validated.errors.join('\n') };
  }
  const data = validated.data;

  const { rows: userRows } = await pool.query(
    'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [session.user_id],
  );
  const user = userRows[0];
  if (!user) return { ok: false, status: 404, error: 'Usuario no encontrado.' };

  const plot = await loadUserPlot(session.user_id, Number(data.plot_id));
  if (!plot) {
    console.log('[FORM] rejected: lote ajeno o inexistente');
    return { ok: false, status: 422, error: 'El lote elegido ya no existe. Cerrá y pedí el formulario de nuevo.' };
  }

  return withUserLock(session.phone, async (): Promise<SubmitResult> => {
    await hydratePendingStores(session.phone);

    // Caso borde del spec: había un pending al ofrecer el form y ya no está →
    // se resolvió por chat. No duplicar; cerrar el token.
    const pending = pendingActStore.get(session.phone);
    if (session.had_pending && !pending) {
      console.log('[FORM] rejected: pending ya resuelto por chat');
      await formSessionService.markUsed(token);
      return { ok: false, status: 409, error: '⚠️ Esto ya se registró por el chat. No lo dupliqué.' };
    }

    let crop: string | null = (data.crop as string) ?? null;
    if (session.action === 'harvest_crop') {
      const active = await getActiveCrop(plot.id);
      if (!active) {
        console.log('[FORM] rejected: lote sin cultivo activo');
        return { ok: false, status: 422, error: 'Ese lote no tiene cultivo activo para cosechar.' };
      }
      crop = (active as { crop: string }).crop;
    }

    const base = {
      crop,
      plotName: plot.name,
      fieldName: plot.field_name,
      eventDate: data.event_date as string,
      originalText: `[formulario] ${session.action === 'sow_crop' ? 'siembra' : 'cosecha'} ${crop ?? ''} en ${plot.name}`.trim(),
    };
    const cmd = session.action === 'sow_crop'
      ? { command: 'sow_crop', ...base, hectares: (data.hectares as number) ?? null, variety: (data.variety as string) ?? null }
      : {
          command: 'harvest_crop', ...base,
          yieldKg: (data.yield_kg as number) ?? null,
          yieldKgPerHa: (data.yield_kg_per_ha as number) ?? null,
          humidity_pct: (data.humidity_pct as number) ?? null,
          loads: (data.loads as Array<Record<string, unknown>>) ?? null,
        };

    const settings = await userRepository.getSettings(session.user_id as never);
    const response = await domainRouter.routeCommand(cmd as never, session.user_id as never, user, settings);

    const blocking = !!(response?.sideEffects?.setPendingActivity || response?.sideEffects?.startFlow);
    const firstMsg = response?.messages?.[0] ?? '';
    if (!response || blocking || !firstMsg || firstMsg.startsWith('❌')) {
      console.log('[FORM] rejected: handler no confirmó', { blocking, firstMsg: firstMsg.slice(0, 60) });
      return { ok: false, status: 422, error: firstMsg || 'No se pudo registrar. Probá de nuevo o cargalo por el chat.' };
    }

    // Éxito: side effects legítimos (ej. botones de cierre de campaña tras
    // cosecha) se aplican por la vía canónica (invariante 9).
    applySideEffects(response.sideEffects, session.phone);
    const fullText = response.messages.join('\n\n');
    await sendToChat(session, fullText);
    await formSessionService.markUsed(token);

    if (pending && pending.command === session.action && !pending.nextInQueue?.length) {
      pendingActStore.clear(session.phone);
      console.log('[FORM] pending consumido por submit');
    }
    console.log(`[FORM] submitted action=${session.action} user=${session.user_id}`);
    return { ok: true, message: fullText };
  });
}
```

Nota de implementación: si `pendingActStore.get` en realidad se llama distinto (p. ej. es un `TypedPendingStore` con otra API), usar la API real del singleton exportado por `message-pipeline.ts` — el test moquea `get`/`clear`; ajustar mock e implementación juntos. Si `response.interactive` viene presente en éxito (botones de cierre de campaña), NO tratarlo como error; v1 no reenvía esos botones al chat (el usuario puede cerrar campaña por chat) — dejar log `[FORM] interactive de éxito no reenviado (v1)`.

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run src/forms/__tests__/form-submit.service.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/forms/form-submit.service.ts src/forms/__tests__/form-submit.service.test.ts
git commit -m "feat(forms): FormSubmitService — validación, lock, routeCommand y confirmación al chat"
```

---

### Task 8: Rutas `GET/POST /api/forms/:token` + serving de `/form/:token`

**Files:**
- Create: `src/routes/forms.routes.ts`
- Modify: `src/app.ts` (montar `/api/forms` junto a `/api/map` línea ~72; servir `/form/:token` antes del catch-all)
- Test: `src/routes/__tests__/forms.routes.test.ts`

**Interfaces:**
- Consumes: `formSessionService` (T1), `FORM_DEFINITIONS` (T2), `submitForm` (T7), `KNOWN_CROPS` (T2), `getUserFields`/`getPlotsByField`/`getAllActiveCrops` de `src/services/expenses.js`.
- Produces:
  - `GET /api/forms/:token` → `{ action, title, fields, prefill, options: { plots: Array<{ id, name, fieldName, activeCrop: string|null }>, crops: string[] } }` — para `harvest_crop`, `plots` ya viene filtrado a lotes con cultivo activo.
  - `POST /api/forms/:token` body = payload plano del form → `{ ok: true, message }` o `{ error }` con status 404/409/422.

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
// src/routes/__tests__/forms.routes.test.ts
// Sin supertest (no existe en el repo): se testean los handlers de la ruta
// invocándolos con req/res mockeados, patrón de tests de servicios del repo.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionValidate = vi.fn();
vi.mock('../../services/form-session.service.js', () => ({
  formSessionService: { validate: (...a: unknown[]) => sessionValidate(...a) },
}));
const submitMock = vi.fn();
vi.mock('../../forms/form-submit.service.js', () => ({
  submitForm: (...a: unknown[]) => submitMock(...a),
}));
const getUserFieldsMock = vi.fn();
const getPlotsByFieldMock = vi.fn();
const getAllActiveCropsMock = vi.fn();
vi.mock('../../services/expenses.js', () => ({
  getUserFields: (...a: unknown[]) => getUserFieldsMock(...a),
  getPlotsByField: (...a: unknown[]) => getPlotsByFieldMock(...a),
  getAllActiveCrops: (...a: unknown[]) => getAllActiveCropsMock(...a),
}));

const { formsGetHandler, formsPostHandler } = await import('../forms.routes.js');

function mockRes() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe('GET /api/forms/:token', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404 con token muerto', async () => {
    sessionValidate.mockResolvedValue(null);
    const res = mockRes();
    await formsGetHandler({ params: { token: 'x' } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('devuelve definición + opciones; cosecha filtra lotes sin cultivo activo', async () => {
    sessionValidate.mockResolvedValue({
      token: 't', user_id: 9, action: 'harvest_crop', prefill: {},
    });
    getUserFieldsMock.mockResolvedValue([{ id: 1, name: 'La Esperanza' }]);
    getPlotsByFieldMock.mockResolvedValue([
      { id: 7, name: 'Norte' }, { id: 8, name: 'Sur' },
    ]);
    getAllActiveCropsMock.mockResolvedValue([{ plot_id: 7, crop: 'maíz' }]);
    const res = mockRes();
    await formsGetHandler({ params: { token: 't' } } as never, res as never);
    const body = res.json.mock.calls[0][0];
    expect(body.action).toBe('harvest_crop');
    expect(body.options.plots).toEqual([
      { id: 7, name: 'Norte', fieldName: 'La Esperanza', activeCrop: 'maíz' },
    ]); // Sur (sin cultivo) filtrado
    expect(body.options.crops).toContain('soja');
  });
});

describe('POST /api/forms/:token', () => {
  it('propaga status y error del servicio', async () => {
    submitMock.mockResolvedValue({ ok: false, status: 422, error: 'Cultivo es obligatorio.' });
    const res = mockRes();
    await formsPostHandler({ params: { token: 't' }, body: {} } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cultivo es obligatorio.' });
  });

  it('200 con message en éxito', async () => {
    submitMock.mockResolvedValue({ ok: true, message: '🌱 Listo' });
    const res = mockRes();
    await formsPostHandler({ params: { token: 't' }, body: { crop: 'soja' } } as never, res as never);
    expect(res.json).toHaveBeenCalledWith({ ok: true, message: '🌱 Listo' });
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/routes/__tests__/forms.routes.test.ts`
Expected: FAIL (módulo inexistente)

- [ ] **Step 3: Implementar `forms.routes.ts`**

```typescript
// src/routes/forms.routes.ts
// Público a propósito: el token de form_sessions ES la autenticación
// (corta vida, un solo uso, atado al usuario) — mismo modelo que /api/map/:token.
import { Router, type Request, type Response } from 'express';
import { formSessionService } from '../services/form-session.service.js';
import { FORM_DEFINITIONS } from '../forms/form-definitions.js';
import { submitForm } from '../forms/form-submit.service.js';
import { KNOWN_CROPS } from '../utils/crops.js';
import { getUserFields, getPlotsByField, getAllActiveCrops } from '../services/expenses.js';

const router = Router();

export async function formsGetHandler(req: Request, res: Response): Promise<void> {
  const session = await formSessionService.validate(req.params.token);
  if (!session) {
    res.status(404).json({ error: 'Este formulario venció. Pedime otro en el chat con «formulario siembra» o «formulario cosecha».' });
    return;
  }
  const def = FORM_DEFINITIONS[session.action];
  const fields = await getUserFields(session.user_id);
  const actives = (await getAllActiveCrops(session.user_id)) as Array<{ plot_id: number; crop: string }>;
  const activeByPlot = new Map(actives.map(a => [a.plot_id, a.crop]));
  const plots: Array<{ id: number; name: string; fieldName: string; activeCrop: string | null }> = [];
  for (const f of fields as Array<{ id: number; name: string }>) {
    for (const p of (await getPlotsByField(f.id)) as Array<{ id: number; name: string }>) {
      plots.push({ id: p.id, name: p.name, fieldName: f.name, activeCrop: activeByPlot.get(p.id) ?? null });
    }
  }
  const visible = session.action === 'harvest_crop' ? plots.filter(p => p.activeCrop) : plots;
  res.json({
    action: session.action,
    title: def.title,
    fields: def.fields,
    prefill: session.prefill,
    options: { plots: visible, crops: KNOWN_CROPS },
  });
}

export async function formsPostHandler(req: Request, res: Response): Promise<void> {
  const result = await submitForm(req.params.token, req.body ?? {});
  if (result.ok) {
    res.json({ ok: true, message: result.message });
    return;
  }
  res.status(result.status).json({ error: result.error });
}

router.get('/:token', (req, res) => { void formsGetHandler(req, res); });
router.post('/:token', (req, res) => { void formsPostHandler(req, res); });

export default router;
```

- [ ] **Step 4: Montar en `app.ts`**

1. Junto a `app.use('/api/map', mapRoutes);` (línea ~72):

```typescript
app.use('/api/forms', formsRoutes); // Público, token-authenticated (form_sessions)
```

con su import arriba: `import formsRoutes from './routes/forms.routes.js';`

2. Después del bloque de `reactAppRoutes` (línea ~82), servir la página del form (el catch-all sirve la landing, así que necesita ruta explícita ANTES):

```typescript
app.get('/form/:token', (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.sendFile(path.join(frontendDist, 'index.html'), (err) => { if (err) next(); });
});
```

- [ ] **Step 5: Correr y verificar que pasa**

Run: `npx vitest run src/routes/__tests__/forms.routes.test.ts && npm test`
Expected: PASS + baseline intacto.

- [ ] **Step 6: Commit**

```bash
git add src/routes/forms.routes.ts src/routes/__tests__/forms.routes.test.ts src/app.ts
git commit -m "feat(forms): rutas públicas token-based GET/POST /api/forms/:token + serving /form/:token"
```

---

### Task 9: Frontend — página `/form/:token`

**Files:**
- Create: `frontend/src/pages/FormPage.tsx`
- Modify: `frontend/src/App.tsx` (ruta pública nueva, lazy)

**Interfaces:**
- Consumes: `GET /api/forms/:token` y `POST /api/forms/:token` (Task 8) — con `fetch` pelado (NO `apiRequest`, que mete el JWT del dashboard; esta página no tiene sesión).
- Produces: página mobile-first Tailwind que renderiza cualquier `FormDefinition` genéricamente; en Telegram Mini App se cierra sola tras el éxito.

- [ ] **Step 1: Implementar `FormPage.tsx`**

```tsx
// frontend/src/pages/FormPage.tsx
// Formulario estructurado (siembra/cosecha) abierto desde el bot como
// Telegram Mini App o link. Sin sesión de dashboard: el token de la URL
// es la autenticación. Render 100% genérico desde la FormDefinition del GET.
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

interface FormFieldDef {
  key: string;
  label: string;
  type: 'select' | 'date' | 'number' | 'text' | 'group';
  required: boolean;
  optionsSource?: 'plots' | 'crops';
  allowOther?: boolean;
  min?: number;
  max?: number;
  noFuture?: boolean;
  fields?: FormFieldDef[];
  maxItems?: number;
  help?: string;
}

interface PlotOption { id: number; name: string; fieldName: string; activeCrop: string | null }

interface FormSpec {
  action: 'sow_crop' | 'harvest_crop';
  title: string;
  fields: FormFieldDef[];
  prefill: Record<string, unknown>;
  options: { plots: PlotOption[]; crops: string[] };
}

declare global {
  interface Window { Telegram?: { WebApp?: { ready: () => void; close: () => void; expand: () => void } } }
}

const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

export default function FormPage() {
  const { token } = useParams<{ token: string }>();
  const [spec, setSpec] = useState<FormSpec | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [otherCrop, setOtherCrop] = useState('');
  const [loads, setLoads] = useState<Array<Record<string, string>>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;

  useEffect(() => {
    tg?.ready();
    tg?.expand();
  }, [tg]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/forms/${token}`);
        const body = await res.json();
        if (!res.ok) { setLoadError(body.error ?? 'No se pudo cargar el formulario.'); return; }
        setSpec(body);
        const initial: Record<string, unknown> = { event_date: todayISO() };
        const prefillPlot = (body.prefill?.plotName as string | undefined)?.toLowerCase();
        if (prefillPlot) {
          const match = (body.options.plots as PlotOption[]).find(p => p.name.toLowerCase() === prefillPlot);
          if (match) initial.plot_id = match.id;
        } else if (body.options.plots.length === 1) {
          initial.plot_id = body.options.plots[0].id;
        }
        if (body.prefill?.eventDate) initial.event_date = body.prefill.eventDate;
        if (body.prefill?.hectares) initial.hectares = body.prefill.hectares;
        setValues(initial);
      } catch {
        setLoadError('No se pudo cargar el formulario. Revisá tu conexión.');
      }
    })();
  }, [token]);

  const selectedPlot = useMemo(
    () => spec?.options.plots.find(p => p.id === Number(values.plot_id)) ?? null,
    [spec, values.plot_id],
  );

  const set = (key: string, v: unknown) => setValues(prev => ({ ...prev, [key]: v }));

  async function handleSubmit() {
    if (!spec) return;
    setSubmitting(true);
    setSubmitError(null);
    const payload: Record<string, unknown> = { ...values };
    if (payload.crop === '__other__') payload.crop = otherCrop.trim();
    const cleanLoads = loads
      .filter(l => l.driver_name?.trim() || l.weight_kg?.trim())
      .map(l => ({
        driver_name: l.driver_name?.trim(),
        weight_kg: l.weight_kg ? Number(l.weight_kg) : undefined,
        destinatario: l.destinatario?.trim() || undefined,
        humidity_pct: l.humidity_pct ? Number(l.humidity_pct) : undefined,
      }));
    if (cleanLoads.length > 0) payload.loads = cleanLoads;
    try {
      const res = await fetch(`/api/forms/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) { setSubmitError(body.error ?? 'No se pudo registrar.'); return; }
      setSuccessMsg(body.message ?? '✅ Registrado.');
      if (tg) setTimeout(() => tg.close(), 1800);
    } catch {
      setSubmitError('Falló el envío. Probá de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return (
    <Shell><p className="text-center text-gray-600 mt-10 px-6">{loadError}</p></Shell>
  );
  if (!spec) return <Shell><p className="text-center text-gray-400 mt-10">Cargando…</p></Shell>;
  if (successMsg) return (
    <Shell>
      <div className="mt-10 px-6 text-center whitespace-pre-line">
        <p className="text-4xl mb-4">✅</p>
        <p className="text-gray-800">{successMsg}</p>
        {tg && <p className="text-gray-400 text-sm mt-6">Cerrando…</p>}
      </div>
    </Shell>
  );

  return (
    <Shell>
      <h1 className="text-xl font-semibold text-gray-800 px-4 pt-5 pb-3">{spec.title}</h1>
      <form className="px-4 pb-8 space-y-4" onSubmit={e => { e.preventDefault(); void handleSubmit(); }}>
        {spec.fields.map(f => {
          if (f.type === 'group') return (
            <LoadsEditor key={f.key} def={f} loads={loads} setLoads={setLoads} />
          );
          return (
            <div key={f.key}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {f.label}{f.required && <span className="text-red-500"> *</span>}
              </label>
              {f.type === 'select' && f.optionsSource === 'plots' && (
                <select required={f.required} value={String(values.plot_id ?? '')}
                  onChange={e => set('plot_id', Number(e.target.value))}
                  className="w-full rounded-lg border-gray-300 border p-3 bg-white">
                  <option value="" disabled>Elegí un lote…</option>
                  {spec.options.plots.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.fieldName} — {p.name}{p.activeCrop ? ` (${p.activeCrop})` : ''}
                    </option>
                  ))}
                </select>
              )}
              {f.type === 'select' && f.optionsSource === 'crops' && (
                <>
                  <select required={f.required} value={String(values.crop ?? '')}
                    onChange={e => set('crop', e.target.value)}
                    className="w-full rounded-lg border-gray-300 border p-3 bg-white">
                    <option value="" disabled>Elegí un cultivo…</option>
                    {spec.options.crops.map(c => <option key={c} value={c}>{c}</option>)}
                    {f.allowOther && <option value="__other__">Otro…</option>}
                  </select>
                  {values.crop === '__other__' && (
                    <input type="text" value={otherCrop} onChange={e => setOtherCrop(e.target.value)}
                      placeholder="¿Qué cultivo?" required
                      className="mt-2 w-full rounded-lg border-gray-300 border p-3" />
                  )}
                </>
              )}
              {f.type === 'date' && (
                <input type="date" required={f.required}
                  max={f.noFuture ? todayISO() : undefined}
                  value={String(values[f.key] ?? '')}
                  onChange={e => set(f.key, e.target.value)}
                  className="w-full rounded-lg border-gray-300 border p-3 bg-white" />
              )}
              {f.type === 'number' && (
                <input type="number" inputMode="decimal" required={f.required}
                  min={f.min} max={f.max} step="any"
                  value={String(values[f.key] ?? '')}
                  onChange={e => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))}
                  className="w-full rounded-lg border-gray-300 border p-3" />
              )}
              {f.type === 'text' && (
                <input type="text" required={f.required}
                  value={String(values[f.key] ?? '')}
                  onChange={e => set(f.key, e.target.value)}
                  className="w-full rounded-lg border-gray-300 border p-3" />
              )}
              {f.help && <p className="text-xs text-gray-400 mt-1">{f.help}</p>}
            </div>
          );
        })}
        {spec.action === 'harvest_crop' && selectedPlot?.activeCrop && (
          <p className="text-sm text-gray-500">Cultivo a cosechar: <b>{selectedPlot.activeCrop}</b></p>
        )}
        {submitError && (
          <p className="text-sm text-red-600 whitespace-pre-line bg-red-50 rounded-lg p-3">{submitError}</p>
        )}
        <button type="submit" disabled={submitting}
          className="w-full rounded-xl bg-green-700 text-white font-semibold p-4 disabled:opacity-50">
          {submitting ? 'Enviando…' : 'Registrar'}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-gray-50 max-w-md mx-auto">{children}</div>;
}

function LoadsEditor({ def, loads, setLoads }: {
  def: FormFieldDef;
  loads: Array<Record<string, string>>;
  setLoads: (l: Array<Record<string, string>>) => void;
}) {
  const update = (i: number, key: string, v: string) => {
    const next = loads.map((l, idx) => (idx === i ? { ...l, [key]: v } : l));
    setLoads(next);
  };
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{def.label}</label>
      {loads.map((l, i) => (
        <div key={i} className="rounded-lg border border-gray-200 p-3 mb-2 space-y-2 bg-white">
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-400">Carga {i + 1}</span>
            <button type="button" className="text-xs text-red-500"
              onClick={() => setLoads(loads.filter((_, idx) => idx !== i))}>Quitar</button>
          </div>
          <input type="text" placeholder="Chofer *" value={l.driver_name ?? ''}
            onChange={e => update(i, 'driver_name', e.target.value)}
            className="w-full rounded border-gray-300 border p-2 text-sm" />
          <input type="number" inputMode="numeric" placeholder="Peso (kg) *" value={l.weight_kg ?? ''}
            onChange={e => update(i, 'weight_kg', e.target.value)}
            className="w-full rounded border-gray-300 border p-2 text-sm" />
          <input type="text" placeholder="Destinatario (opcional)" value={l.destinatario ?? ''}
            onChange={e => update(i, 'destinatario', e.target.value)}
            className="w-full rounded border-gray-300 border p-2 text-sm" />
          <input type="number" inputMode="decimal" placeholder="Humedad % (opcional)" value={l.humidity_pct ?? ''}
            onChange={e => update(i, 'humidity_pct', e.target.value)}
            className="w-full rounded border-gray-300 border p-2 text-sm" />
        </div>
      ))}
      {(!def.maxItems || loads.length < def.maxItems) && (
        <button type="button" onClick={() => setLoads([...loads, {}])}
          className="text-sm text-green-700 font-medium">+ Agregar carga</button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Ruta en `App.tsx`**

```tsx
const FormPage = lazy(() => import('./pages/FormPage'));
```

y dentro de `<Routes>` (pública, sin `ProtectedRoute`):

```tsx
<Route path="/form/:token" element={<FormPage />} />
```

- [ ] **Step 3: Script de Telegram WebApp**

En `frontend/index.html`, dentro de `<head>`:

```html
<script src="https://telegram.org/js/telegram-web-app.js"></script>
```

(Es chico y sin side effects fuera de Telegram; cargarlo global evita condiciones de carrera con el `ready()` de la Mini App.)

- [ ] **Step 4: Build y verificación manual**

```bash
cd frontend && npm run build && cd ..
```

Expected: build sin errores. Verificación manual local (con `docker compose up -d` corriendo y el frontend buildeado): crear una sesión a mano por psql

```bash
/opt/homebrew/opt/libpq/bin/psql postgresql://campo:campo@localhost:5433/campo_bot -c \
 "INSERT INTO form_sessions (token,user_id,action,prefill,channel,channel_id,phone,had_pending,expires_at) \
  VALUES ('devtoken000000000000000000000000', <TEST_USER_ID>, 'sow_crop', '{}', 'testbot', 'x', 'testbot_<TEST_USER_ID>', false, NOW() + interval '30 min')"
```

y abrir `http://localhost:3000/form/devtoken000000000000000000000000`: el form carga lotes reales, valida y registra (la confirmación no llega a ningún chat porque el canal es testbot — el mensaje aparece en la respuesta del POST).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/FormPage.tsx frontend/src/App.tsx frontend/index.html
git commit -m "feat(forms): página /form/:token — render genérico de FormDefinition, Mini App-aware"
```

---

### Task 10: Regresiones de integración (invariante 14)

**Files:**
- Modify: `src/testing/integration/pipeline.integration.test.ts`

**Interfaces:**
- Consumes: harness FakeAgent existente del archivo (leer sus helpers al inicio del archivo y seguir su patrón de setup/user de prueba).
- Produces: 3 regresiones nuevas.

- [ ] **Step 1: Escribir los 3 tests**

Siguiendo el patrón del archivo (FakeAgent, DB real local, usuario de test):

1. **offerForm acompaña al pending**: mensaje "sembré en el lote norte" (FakeAgent → `sow_crop` sin crop) → la respuesta incluye un item interactive cuyo botón tiene `webAppUrl` conteniendo `/form/`, y `pendingActStore` tiene `missing:['crop']`. (Si `PUBLIC_URL` no está seteado en el entorno de test, setearlo vía el mecanismo de settings del harness al inicio del test.)
2. **Supresión en bulkMode**: compound de 2 tools (FakeAgent → `sow_crop` sin crop + `log_rainfall`) → NINGÚN item de la respuesta contiene `webAppUrl` y el log path del interceptor se ejercitó (assert de que no hay botón alcanza).
3. **Stale pending → 409**: crear sesión con `hadPending: true` vía `formSessionService.create`, limpiar el pending (`pendingActStore.clear`), llamar `submitForm(token, payloadVálido)` → `{ ok: false, status: 409 }` y `form_sessions.used_at` seteado.

- [ ] **Step 2: Correr**

Run: `npx vitest run src/testing/integration/pipeline.integration.test.ts`
Expected: PASS los 3 nuevos + los existentes (requiere `docker compose up -d db`).

- [ ] **Step 3: Commit**

```bash
git add src/testing/integration/pipeline.integration.test.ts
git commit -m "test(forms): regresiones de integración — offerForm, supresión en bulk, stale pending"
```

---

### Task 11: Esqueleto WhatsApp Flows (dark)

**Files:**
- Create: `src/forms/whatsapp-flow-generator.ts`
- Modify: `src/controllers/whatsapp.controller.ts` (branch `nfm_reply` en el parseo interactive, líneas ~168-191)
- Test: `src/forms/__tests__/whatsapp-flow-generator.test.ts`

**Interfaces:**
- Consumes: `FormDefinition` (T2), `submitForm` (T7).
- Produces:
  - `buildWhatsAppFlowJson(def: FormDefinition): Record<string, unknown>` — Flow JSON v7.2 de una pantalla; grupos repetibles se expanden a `maxItems=5` slots fijos opcionales (limitación documentada en el spec).
  - Branch `nfm_reply` que extrae `flow_token` del `response_json` y lo trata como token de `form_sessions` → `submitForm`. Dark: nunca se envían Flows todavía, el branch solo loguea si llega algo.

- [ ] **Step 1: Test que falla**

```typescript
// src/forms/__tests__/whatsapp-flow-generator.test.ts
import { describe, it, expect } from 'vitest';
import { FORM_DEFINITIONS } from '../form-definitions.js';
import { buildWhatsAppFlowJson } from '../whatsapp-flow-generator.js';

describe('buildWhatsAppFlowJson', () => {
  it('siembra: un screen con los 5 campos mapeados a componentes de Flow', () => {
    const flow = buildWhatsAppFlowJson(FORM_DEFINITIONS.sow_crop) as {
      version: string; screens: Array<{ id: string; layout: { children: Array<{ type: string; name?: string }> } }>;
    };
    expect(flow.version).toBe('7.2');
    expect(flow.screens).toHaveLength(1);
    const names = flow.screens[0].layout.children.filter(c => 'name' in c).map(c => c.name);
    expect(names).toContain('plot_id');
    expect(names).toContain('crop');
    expect(names).toContain('event_date');
  });

  it('cosecha: el grupo loads se expande a 5 slots fijos opcionales', () => {
    const flow = buildWhatsAppFlowJson(FORM_DEFINITIONS.harvest_crop) as {
      screens: Array<{ layout: { children: Array<{ name?: string }> } }>;
    };
    const names = flow.screens[0].layout.children.map(c => c.name).filter(Boolean);
    expect(names).toContain('loads_1_driver_name');
    expect(names).toContain('loads_5_weight_kg');
    expect(names).not.toContain('loads_6_driver_name');
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run src/forms/__tests__/whatsapp-flow-generator.test.ts`
Expected: FAIL (módulo inexistente)

- [ ] **Step 3: Implementar el generador**

```typescript
// src/forms/whatsapp-flow-generator.ts
// Genera el Flow JSON de WhatsApp desde la MISMA FormDefinition del form web.
// DARK hasta tener número de WhatsApp en prod: falta publicar el Flow en Meta
// Business Manager y configurar su flow_id en settings (grupo bot).
// Limitación conocida (spec): Flows no tiene grupos repetibles → los groups
// se expanden a maxItems=5 slots fijos opcionales.
import type { FormDefinition, FormField } from './form-definitions.js';

const FIXED_GROUP_SLOTS = 5;

function componentFor(f: FormField, name: string, labelPrefix = ''): Record<string, unknown> | null {
  const label = `${labelPrefix}${f.label}`;
  switch (f.type) {
    case 'select':
      // Las opciones dinámicas (lotes/cultivos) se inyectan como data del
      // screen al enviar el Flow; acá va la referencia.
      return { type: 'Dropdown', name, label, required: f.required, 'data-source': `\${data.${name}_options}` };
    case 'date':
      return { type: 'DatePicker', name, label, required: f.required };
    case 'number':
      return { type: 'TextInput', 'input-type': 'number', name, label, required: f.required };
    case 'text':
      return { type: 'TextInput', name, label, required: f.required };
    default:
      return null;
  }
}

export function buildWhatsAppFlowJson(def: FormDefinition): Record<string, unknown> {
  const children: Record<string, unknown>[] = [];
  for (const f of def.fields) {
    if (f.type === 'group') {
      for (let i = 1; i <= Math.min(f.maxItems ?? FIXED_GROUP_SLOTS, FIXED_GROUP_SLOTS); i++) {
        for (const sub of f.fields ?? []) {
          const c = componentFor({ ...sub, required: false }, `${f.key}_${i}_${sub.key}`, `${f.label} ${i}: `);
          if (c) children.push(c);
        }
      }
      continue;
    }
    const c = componentFor(f, f.key);
    if (c) children.push(c);
  }
  children.push({
    type: 'Footer', label: 'Registrar',
    'on-click-action': { name: 'complete', payload: {} },
  });
  return {
    version: '7.2',
    screens: [{
      id: 'FORM', title: def.title, terminal: true,
      layout: { type: 'SingleColumnLayout', children },
    }],
  };
}
```

- [ ] **Step 4: Branch `nfm_reply` en el controller**

En `src/controllers/whatsapp.controller.ts`, en el `if (message.type === 'interactive')` (líneas ~168-191), después del branch de `list_reply`, agregar:

```typescript
} else if ((interactiveData as { type?: string })?.type === 'nfm_reply') {
  // WhatsApp Flow response (DARK: aún no se envían Flows; si llega algo, entra
  // por el MISMO path de submit que la Mini App — invariante 1: se loguea).
  try {
    const raw = (interactiveData as { nfm_reply?: { response_json?: string } }).nfm_reply?.response_json;
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    const flowToken = parsed?.flow_token as string | undefined;
    console.log('[FORM] nfm_reply recibido, flow_token presente:', !!flowToken);
    if (flowToken && parsed) {
      const { submitForm } = await import('../forms/form-submit.service.js');
      const result = await submitForm(flowToken, parsed);
      if (!result.ok) await sendMessage(phone, result.error);
      // En éxito submitForm ya mandó la confirmación al chat.
    }
  } catch (err) {
    console.error('[FORM] nfm_reply inválido:', err);
  }
  res.sendStatus(200);
  return;
}
```

(Usar el sender de texto que el controller ya importa de `whatsapp.js`; si importa `sendMessage` con otro alias, respetar el existente.)

- [ ] **Step 5: Correr y verificar que pasa**

Run: `npx vitest run src/forms/__tests__/whatsapp-flow-generator.test.ts && npm test`
Expected: PASS + baseline intacto.

- [ ] **Step 6: Commit**

```bash
git add src/forms/whatsapp-flow-generator.ts src/forms/__tests__/whatsapp-flow-generator.test.ts src/controllers/whatsapp.controller.ts
git commit -m "feat(forms): esqueleto WhatsApp Flows dark — generador de Flow JSON + branch nfm_reply"
```

---

### Task 12: Documentación + verificación final

**Files:**
- Modify: `CLAUDE.md` (nueva subsección en "AI Agent Disambiguation Rules" o "Key Conventions" + Key File Map)
- Create: `docs/features/forms.md`

- [ ] **Step 1: `CLAUDE.md`**

Agregar en "Key Conventions" (o como subsección de Misc):

```markdown
- **Formularios estructurados (Ago 2026, migración 105)**: siembra/cosecha se pueden cargar por form de pantalla única (Telegram Mini App; WhatsApp Flows dark). `FormDefinition` en `src/forms/form-definitions.ts` es la fuente ÚNICA (render React + validación server + Flow JSON). Sesiones token-based en `form_sessions` (30 min, un uso). El botón se ofrece vía sideEffect `offerForm` (suprimido en bulkMode) y comando trivial `formulario`. El submit entra por `routeCommand` con `withUserLock` — sin IA. Todo path loguea `[FORM]`. Ver docs/features/forms.md.
```

Y en el Key File Map, bajo una línea nueva:

```markdown
- `src/forms/` — form-definitions (fuente única) + form-offer + form-submit.service + whatsapp-flow-generator
```

- [ ] **Step 2: `docs/features/forms.md`**

Escribir el deep-dive (~60 líneas): arquitectura, tabla `form_sessions`, flujo de oferta y submit, reglas de resultado (404/409/422), caso borde stale-pending, limitación de Flows (5 slots), y checklist de activación de WhatsApp Flows cuando llegue el número (publicar Flow en Meta Business Manager, flow_id en settings, probar `nfm_reply`). Basarse en el spec `docs/superpowers/specs/2026-08-03-structured-forms-design.md`.

- [ ] **Step 3: Verificación final completa**

```bash
npm test
cd frontend && npm run build && cd ..
docker compose up -d && npx vitest run src/testing/integration/pipeline.integration.test.ts
npm run eval
```

Expected: unit baseline (1753 + 16 env-dependent), build OK, integración verde, eval 25/25 (el eval NO debería moverse — el submit no toca IA — pero el comando trivial nuevo y el cambio en el handler de sow/harvest obligan a correrlo; si falla masivo, chequear "credit balance is too low" antes de debuggear).

- [ ] **Step 4: Commit final**

```bash
git add CLAUDE.md docs/features/forms.md
git commit -m "docs(forms): CLAUDE.md + deep-dive de formularios estructurados"
```

---

## Self-review (hecho al escribir el plan)

- **Cobertura del spec**: sesiones token-based (T1), FormDefinition única (T2), botón web_app (T3), offerForm + bulk (T4-T5), comando trivial (T6), submit por router con lock/pending/confirmación (T7), rutas + serving (T8), página React (T9), regresiones invariante 14 (T10), esqueleto WA (T11), docs (T12). El caso borde stale-pending está en T7+T10. Variedad (spec §formularios) en T1 (columna) + T5 (plumbing).
- **Simplificación deliberada vs. spec**: "formulario siembra" muestra el picker igual (un tap extra) para no depender de extracción de args en el parser trivial — documentado en T6.
- **Consistencia de tipos**: `offerForm {action, prefill}` idéntico en T4/T5/T6; `FormSessionRow` de T1 usado en T7; `submitForm` de T7 consumido por T8 y T11; `webAppUrl` de T3 usado en T4/T9/T10.
