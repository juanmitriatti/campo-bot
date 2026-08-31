#!/usr/bin/env npx tsx
/**
 * probe-dashboard-writes.ts — las escrituras que hace el DASHBOARD, con el mismo
 * cuerpo que manda el cliente del front.
 *
 * `apiRequest` serializa el body internamente. Los componentes se lo pasaban ya
 * serializado, así que el servidor recibía una cadena JSON en vez de un objeto y
 * los campos llegaban vacíos: la carga de RENSPA, el reemplazo de caravana y el
 * import se rompían en silencio. Los tests de rutas no lo veían porque usan
 * `fetch` directo. Este probe manda exactamente lo que manda el front.
 */
const BASE = process.env.QA_BASE_URL || 'http://localhost:3000';
let TOKEN = '';

async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
  const r = await fetch(`${BASE}/api/auth${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    // Mismo tratamiento que apiRequest: el body se serializa ACÁ, una sola vez.
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as T };
}

function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const email = `dashw-${Date.now()}@campo.test`;
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Dash W', email, password: 'dashw2026!' }),
  });
  TOKEN = ((await reg.json()) as { tokens: { accessToken: string } }).tokens.accessToken;

  const f = await api<{ field: { id: number } }>('/fields', { method: 'POST', body: { name: 'Campo Dash' } });
  const fieldId = f.data.field?.id ?? (f.data as unknown as { id: number }).id;

  // 1. RENSPA / CUIG — la pantalla que faltaba.
  const upd = await api<{ field: Record<string, unknown> }>(`/fields/${fieldId}`, {
    method: 'PATCH',
    body: { renspa: '01.234.5.67890/12', cuig: 'AB123', senasa_titular: 'Juan P. M.' },
  });
  check(upd.status === 200, 'PATCH /fields con datos SENASA', `status ${upd.status}`);
  check(upd.data.field?.renspa === '01.234.5.67890/12', 'el RENSPA se guardó', String(upd.data.field?.renspa));
  check(upd.data.field?.cuig === 'AB123', 'el CUIG se guardó', String(upd.data.field?.cuig));

  const tree = await api<{ fields: Array<{ id: number; renspa: string | null }> }>('/fields-tree');
  const mine = tree.data.fields.find(x => x.id === fieldId);
  check(mine?.renspa === '01.234.5.67890/12', 'fields-tree devuelve el RENSPA para pintarlo');

  // 2. Alta de animal + reemplazo de caravana desde la ficha.
  const created = await api<{ animal: { id: string } }>('/animals', {
    method: 'POST',
    body: { category: 'vaca', rfid: '032010000000501', field_id: fieldId },
  });
  check(created.status === 201, 'POST /animals', `status ${created.status}`);
  const animalId = created.data.animal?.id;

  const repl = await api<{ created: { value: string } }>(`/animals/${animalId}/identifications`, {
    method: 'POST', body: { value: '032010000000502', reason: 'perdida' },
  });
  check(repl.status === 201, 'reemplazo de caravana desde la ficha', `status ${repl.status}`);
  check(repl.data.created?.value === '032010000000502', 'la caravana nueva quedó vigente');

  // 3. Import: preview + aplicar.
  const p = await api<{ id: number }>('/fields', { method: 'GET' });
  void p;
  const plots = await api<{ fields: Array<{ id: number; plots: Array<{ id: number }> }> }>('/fields-tree');
  let plotId = plots.data.fields.find(x => x.id === fieldId)?.plots?.[0]?.id;
  if (!plotId) {
    const np = await api<{ plot: { id: number } }>(`/fields/${fieldId}/plots`, { method: 'POST', body: { name: 'Norte' } });
    plotId = np.data.plot?.id ?? (np.data as unknown as { id: number }).id;
  }

  const preview = await api<{ batchId: string; summary: { raw: number; matched: number } }>('/animals/import', {
    method: 'POST', body: { text: '032010000000502\n032010000000999' },
  });
  check(preview.status === 200, 'preview de import', `status ${preview.status}`);
  check(preview.data.summary?.raw === 2 && preview.data.summary?.matched === 1,
    'el preview cuadra los números', JSON.stringify(preview.data.summary));

  const applied = await api<{ moved: number }>(`/animals/batches/${preview.data.batchId}/apply`, {
    method: 'POST', body: { plot_id: plotId },
  });
  check(applied.status === 200 && applied.data.moved === 1, 'aplicar el lote mueve el animal', `moved=${applied.data.moved}`);

  // 4. La tira de trazabilidad de la Vista ganadera.
  const an = await api<{ individualization?: { total: number; identified: number } }>(`/analytics/livestock?field_id=${fieldId}`);
  check(an.status === 200, 'GET /analytics/livestock', `status ${an.status}`);
  check(an.data.individualization?.identified === 1,
    'la vista ganadera informa 1 animal con caravana', JSON.stringify(an.data.individualization));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
