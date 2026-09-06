/**
 * Crea / actualiza / valida / publica los WhatsApp Flows de los formularios
 * estructurados (siembra, cosecha — todo lo que haya en FORM_DEFINITIONS)
 * contra la Graph API de Meta, y opcionalmente guarda los flow_id en settings.
 *
 * El Flow JSON sale de `buildWhatsAppFlowJson(def)` — la MISMA FormDefinition
 * que renderiza el form web y valida el submit. Nunca se pega JSON a mano.
 *
 * Uso:
 *   npx tsx src/scripts/publish-whatsapp-flows.ts --dump <dir>     # solo escribe los JSON (sin token)
 *   npx tsx src/scripts/publish-whatsapp-flows.ts                  # crea/actualiza drafts + valida
 *   npx tsx src/scripts/publish-whatsapp-flows.ts --publish        # ...y publica los que validan
 *   npx tsx src/scripts/publish-whatsapp-flows.ts --publish --save-settings   # ...y guarda WHATSAPP_FLOW_ID_*
 *   --waba-id <id>   WABA a usar (si no: env WHATSAPP_WABA_ID → auto-detección por el token)
 *   --recreate       si el Flow ya está PUBLISHED (inmutable), crea uno nuevo con el mismo nombre
 *
 * Requiere WHATSAPP_TOKEN con permisos whatsapp_business_management (+ messaging).
 * Un Flow PUBLISHED no se puede editar: cambiar la FormDefinition ⇒ --recreate
 * ⇒ nuevo flow_id ⇒ --save-settings (o pegarlo en /admin → grupo bot).
 */
import dotenv from 'dotenv';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { FORM_DEFINITIONS, type FormDefinition } from '../forms/form-definitions.js';
import { buildWhatsAppFlowJson } from '../forms/whatsapp-flow-generator.js';

dotenv.config();

const GRAPH = 'https://graph.facebook.com/v22.0';

/**
 * Nombre del Flow en WhatsApp Manager. SIN emoji: la Graph API guarda el
 * nombre con los caracteres de 4 bytes reemplazados por U+FFFD, y después el
 * lookup por nombre exacto no encuentra el Flow que el script mismo creó.
 */
function flowName(def: FormDefinition): string {
  const title = def.title.replace(/[^\x20-\x7E -ÿ]/gu, '').replace(/\s+/g, ' ').trim();
  return `campo-bot - ${title}`;
}

/** Clave tolerante para matchear nombres ya guardados (con o sin mangling). */
function nameKey(s: string): string {
  return s.normalize('NFD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

interface ValidationError {
  error: string; error_type: string; message: string;
  line_start?: number; column_start?: number;
  pointers?: Array<{ path?: string }>;
}
interface FlowRow { id: string; name: string; status: string; validation_errors?: ValidationError[] }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

async function graph<T = Record<string, unknown>>(
  token: string, pathname: string, init: RequestInit = {},
): Promise<T> {
  const url = pathname.startsWith('http') ? pathname : `${GRAPH}/${pathname}`;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.error) {
    const e = body.error as { message?: string; code?: number; error_subcode?: number } | undefined;
    throw new Error(`Graph ${pathname} -> HTTP ${res.status}: ${e?.message ?? JSON.stringify(body)} (code ${e?.code}/${e?.error_subcode})`);
  }
  return body as T;
}

function printErrors(errs: ValidationError[] | undefined): boolean {
  if (!errs || errs.length === 0) { console.log('   OK: sin errores de validación'); return false; }
  for (const e of errs) {
    const where = e.pointers?.[0]?.path ? ` @ ${e.pointers[0].path}` : (e.line_start ? ` @ línea ${e.line_start}` : '');
    console.log(`   ERROR [${e.error_type}/${e.error}] ${e.message}${where}`);
  }
  return true;
}

/** WABA: flag -> env -> granular_scopes del token -> businesses del token. */
async function resolveWabaId(token: string, phoneNumberId: string): Promise<string> {
  const explicit = arg('--waba-id') ?? process.env.WHATSAPP_WABA_ID;
  const candidates = new Set<string>();
  if (explicit) candidates.add(explicit);

  if (candidates.size === 0) {
    try {
      const dbg = await graph<{ data?: { granular_scopes?: Array<{ scope: string; target_ids?: string[] }> } }>(
        token, `debug_token?input_token=${encodeURIComponent(token)}`,
      );
      for (const s of dbg.data?.granular_scopes ?? []) {
        if (s.scope.startsWith('whatsapp_business')) for (const id of s.target_ids ?? []) candidates.add(id);
      }
    } catch (err) { console.log(`   (debug_token no disponible: ${(err as Error).message})`); }
  }
  if (candidates.size === 0) {
    try {
      const biz = await graph<{ data?: Array<{ id: string; name: string }> }>(token, 'me/businesses');
      for (const b of biz.data ?? []) {
        for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
          const r = await graph<{ data?: Array<{ id: string }> }>(token, `${b.id}/${edge}`).catch(() => ({ data: [] }));
          for (const w of r.data ?? []) candidates.add(w.id);
        }
      }
    } catch (err) { console.log(`   (me/businesses no disponible: ${(err as Error).message})`); }
  }
  if (candidates.size === 0) {
    throw new Error('No pude detectar el WABA. Pasá --waba-id <id> (WhatsApp Manager -> Configuración -> Cuenta de WhatsApp Business -> ID).');
  }

  // Elegir el WABA que contiene nuestro número.
  for (const id of candidates) {
    const r = await graph<{ data?: Array<{ id: string; display_phone_number: string }> }>(
      token, `${id}/phone_numbers?fields=id,display_phone_number`,
    ).catch(() => ({ data: [] }));
    const hit = (r.data ?? []).find(p => p.id === phoneNumberId);
    if (hit) { console.log(`   WABA ${id} contiene el número ${hit.display_phone_number} (${phoneNumberId})`); return id; }
  }
  const first = [...candidates][0];
  console.log(`   AVISO: ningún WABA candidato lista el phone_number_id ${phoneNumberId}; uso ${first} (candidatos: ${[...candidates].join(', ')})`);
  return first;
}

async function uploadAsset(token: string, flowId: string, json: Record<string, unknown>): Promise<ValidationError[]> {
  const form = new FormData();
  form.append('file', new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), 'flow.json');
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  const r = await graph<{ success: boolean; validation_errors?: ValidationError[] }>(
    token, `${flowId}/assets`, { method: 'POST', body: form },
  );
  return r.validation_errors ?? [];
}

async function main(): Promise<void> {
  const dumpDir = arg('--dump');
  const defs = Object.values(FORM_DEFINITIONS);

  if (dumpDir) {
    await mkdir(dumpDir, { recursive: true });
    for (const def of defs) {
      const file = path.join(dumpDir, `flow-${def.action}.json`);
      await writeFile(file, JSON.stringify(buildWhatsAppFlowJson(def), null, 2));
      console.log(`${def.action} -> ${file}`);
    }
    return;
  }

  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error('Faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID en el entorno (.env).');

  console.log('Resolviendo WABA...');
  const wabaId = await resolveWabaId(token, phoneNumberId);

  const existing = await graph<{ data?: FlowRow[] }>(token, `${wabaId}/flows?fields=id,name,status,validation_errors&limit=100`);
  const byName = new Map<string, FlowRow[]>();
  for (const f of existing.data ?? []) {
    byName.set(nameKey(f.name), [...(byName.get(nameKey(f.name)) ?? []), f]);
  }

  const results: Array<{ action: string; id: string; status: string; setting: string; ok: boolean }> = [];
  let anyError = false;

  for (const def of defs) {
    const name = flowName(def);
    const json = buildWhatsAppFlowJson(def);
    console.log(`\n> ${def.action} — "${name}" (${JSON.stringify(json).length} bytes de Flow JSON)`);

    const rows = byName.get(nameKey(name)) ?? [];
    const published = rows.find(r => r.status === 'PUBLISHED');
    const draft = rows.find(r => r.status === 'DRAFT');
    if (draft && draft.name !== name) {
      // Nombre mangleado por Meta (emoji → U+FFFD): lo dejo limpio.
      await graph(token, draft.id, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      }).catch(err => console.log(`   (no pude renombrar ${draft.id}: ${(err as Error).message})`));
    }
    let flowId: string;
    let status: string;
    let errs: ValidationError[] = [];

    if (draft) {
      console.log(`   draft existente ${draft.id} -> subo el Flow JSON nuevo`);
      flowId = draft.id; status = 'DRAFT';
      errs = await uploadAsset(token, flowId, json);
    } else if (published && !has('--recreate')) {
      console.log(`   ya PUBLISHED como ${published.id} (inmutable). Para una versión nueva: --recreate`);
      flowId = published.id; status = 'PUBLISHED';
    } else {
      if (published) console.log(`   PUBLISHED ${published.id} queda como está; creo uno nuevo (--recreate)`);
      const r = await graph<{ id: string; success: boolean; validation_errors?: ValidationError[] }>(
        token, `${wabaId}/flows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, categories: ['OTHER'], flow_json: JSON.stringify(json), publish: false }),
        },
      );
      flowId = r.id; status = 'DRAFT';
      console.log(`   creado ${flowId}`);
      errs = r.validation_errors ?? [];
    }

    if (status === 'DRAFT') {
      // Releer: el create a veces devuelve validation_errors vacío antes de terminar de procesar.
      const fresh = await graph<FlowRow>(token, `${flowId}?fields=id,name,status,validation_errors`);
      errs = fresh.validation_errors?.length ? fresh.validation_errors : errs;
      const bad = printErrors(errs);
      anyError = anyError || bad;
      if (!bad && has('--publish')) {
        await graph(token, `${flowId}/publish`, { method: 'POST' });
        status = 'PUBLISHED';
        console.log('   PUBLICADO');
      } else if (!bad) {
        console.log('   (draft validado; agregá --publish para publicarlo)');
      }
    }

    results.push({ action: def.action, id: flowId, status, setting: def.settingKey, ok: errs.length === 0 });
  }

  console.log('\n=== Resumen ===');
  for (const r of results) console.log(`${r.ok ? 'OK ' : 'ERR'} ${r.action.padEnd(13)} ${r.status.padEnd(9)} flow_id=${r.id}  -> ${r.setting}`);

  if (has('--save-settings')) {
    const { setSetting } = await import('../services/settings.service.js');
    const { pool } = await import('../config/db.js');
    for (const r of results) {
      if (!r.ok || r.status !== 'PUBLISHED') { console.log(`   omitido ${r.setting}: no guardado (${r.ok ? r.status : 'con errores'})`); continue; }
      await setSetting(r.setting, r.id);
      console.log(`   guardado ${r.setting} = ${r.id}`);
    }
    await pool.end();
    console.log('   (el bot lo toma en <=5 min por el cache de settings)');
  } else {
    console.log('\nPara guardar los ids en settings: --save-settings, o pegarlos en /admin -> Configuración -> grupo bot.');
  }

  if (anyError) process.exitCode = 1;
}

main().catch(err => {
  console.error('\nFALLO:', (err as Error).message);
  process.exit(1);
});
