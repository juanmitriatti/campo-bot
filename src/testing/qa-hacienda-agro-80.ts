/**
 * QA Hacienda + Agro — 80 multi-query conversations against qa-hist-v2.
 *
 * Split: 48 hacienda (60%) + 32 agro (40%).
 * Mix of: multi-tool single message, multi-turn refinement, inferential
 * (calculated metrics), ambiguous references, hypothetical, period overlaps.
 *
 * Auto-seeds extras before running:
 *  - 8 agro_observations (text observations across lotes/months)
 *  - 1 extra livestock group (Hereford in N3 corral-style or extra in N1)
 *  - 1 extra health event (revisión sanitaria) to broaden product mix
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-hacienda-agro-80.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-hist-v2@campo.test';
const PASSWORD = 'qatest123';

// ── API helpers ─────────────────────────────────────────────────────────

async function apiLogin(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const d = await res.json() as any;
  return { token: d.tokens.accessToken, userId: d.user.id };
}

let TOKEN = '';

async function apiSend(message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  return res.json();
}

async function apiQueryDb(sql: string, params: unknown[]): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Query failed ${res.status}: ${t.slice(0, 200)}`);
  }
  const d = await res.json() as any;
  return d.rows ?? [];
}

function extractText(data: any): string {
  return (data.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}

// ── Seed extras (idempotent) ───────────────────────────────────────────

async function seedExtras(userId: number): Promise<void> {
  console.log('🌱 Seeding extras…');

  const fieldRow = (await apiQueryDb(
    `SELECT id FROM fields WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [userId],
  ))[0];
  if (!fieldRow) throw new Error('Field not found — run qa-historical-consistency-v2 first');
  const fieldId = fieldRow.id;

  const plots = await apiQueryDb(
    `SELECT id, name FROM plots WHERE field_id=$1 AND deleted_at IS NULL ORDER BY name`,
    [fieldId],
  );
  const plotN1 = plots.find((p: any) => p.name === 'N1').id;
  const plotN2 = plots.find((p: any) => p.name === 'N2').id;
  const plotN3 = plots.find((p: any) => p.name === 'N3').id;

  // Observations (only insert if not present)
  const obsCount = (await apiQueryDb(`SELECT count(*) AS c FROM agro_observations WHERE user_id=$1`, [userId]))[0];
  if (Number(obsCount?.c || 0) < 5) {
    const observations = [
      { date: '2026-01-12', plot: plotN1, text: 'soja en N1 viene espectacular, plantas vigorosas', cat: 'cultivo' },
      { date: '2026-02-05', plot: plotN1, text: 'detecté algunas chinches en el borde norte de N1', cat: 'plagas' },
      { date: '2026-02-20', plot: plotN2, text: 'maíz floreciendo en N2, todo verde, sin problemas', cat: 'cultivo' },
      { date: '2026-03-08', plot: plotN1, text: 'roya leve en hojas inferiores de soja N1, hay que monitorear', cat: 'plagas' },
      { date: '2026-03-22', plot: plotN3, text: 'lote N3 con algo de helada matinal, plantas resentidas', cat: 'clima' },
      { date: '2026-04-15', plot: plotN1, text: 'cosecha de soja N1 ok pero rinde menor al esperado', cat: 'cultivo' },
      { date: '2026-05-02', plot: plotN3, text: 'trigo N3 emergencia desigual, sectores ralos', cat: 'cultivo' },
      { date: '2026-05-10', plot: null, text: 'predio en general muy seco, falta agua', cat: 'clima' },
    ];
    for (const o of observations) {
      await apiQueryDb(
        `INSERT INTO agro_observations (user_id, field_id, plot_id, observation_text, category, observation_date)
         VALUES ($1, $2, $3, $4, $5, $6::date)`,
        [userId, fieldId, o.plot, o.text, o.cat, o.date],
      );
    }
    console.log(`  ✅ ${observations.length} observations`);
  } else {
    console.log(`  ⏭️  observations already seeded (${obsCount.c})`);
  }

  // Extra livestock group: Hereford in N3
  const herefordCheck = await apiQueryDb(
    `SELECT id FROM livestock_groups WHERE user_id=$1 AND breed='Hereford' AND deleted_at IS NULL`,
    [userId],
  );
  if (herefordCheck.length === 0) {
    await apiQueryDb(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count, avg_weight_kg)
       VALUES ($1, $2, $3, 'vaca', 'Hereford', 30, 410)`,
      [userId, fieldId, plotN3],
    );
    console.log(`  ✅ 1 livestock group (30 vacas Hereford en N3)`);
  } else {
    console.log(`  ⏭️  Hereford already seeded`);
  }

  // Extra health event (revisión sanitaria)
  const healthCheck = await apiQueryDb(
    `SELECT id FROM domain_events WHERE user_id=$1 AND event_type='health_event' AND product_type='revision_sanitaria' LIMIT 1`,
    [userId],
  );
  if (healthCheck.length === 0) {
    await apiQueryDb(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, animal_category, animals_affected, product, product_type, notes)
       VALUES ($1, $2, 'health_event', '2026-05-12'::date, 'vaca', 30, 'control sanitario', 'revision_sanitaria', 'revisé las Hereford')`,
      [userId, plotN3],
    );
    console.log(`  ✅ 1 revisión sanitaria evento`);
  }

  console.log('');
}

// ── Test spec ──────────────────────────────────────────────────────────

interface MultiTurnTest {
  name: string;
  description: string;
  turns: string[];
  validate?: Array<(text: string) => { pass: boolean; note: string }>;
}

const HACIENDA_TESTS: MultiTurnTest[] = [
  // Inventory & breeds (10)
  { name: 'H01_count_angus', turns: ['cuántas Angus tengo'], description: 'count por raza' },
  { name: 'H02_razas', turns: ['qué razas tengo'], description: 'multi-breed listing' },
  { name: 'H03_vacas_por_lote', turns: ['cuántas vacas tengo en N1 y cuántas en N3'], description: 'count cruzado 2 plots' },
  { name: 'H04_distribucion_raza', turns: ['distribución por raza'], description: 'breakdown raza' },
  { name: 'H05_peso_promedio_rodeo', turns: ['peso promedio del rodeo'], description: 'avg weight all groups' },
  { name: 'H06_kg_totales', turns: ['cuántos kg de hacienda tengo en total'], description: 'count × avg_weight (inferential)' },
  { name: 'H07_categoria_mas', turns: ['qué categoría tiene más cabezas'], description: 'top category' },
  { name: 'H08_machos_hembras', turns: ['cuántos machos y cuántas hembras tengo'], description: 'gender breakdown (inferential)' },
  { name: 'H09_campo_mas', turns: ['en qué campo tengo más hacienda'], description: 'field ranking' },
  { name: 'H10_ratio_destete', turns: ['cuál es el ratio de terneros sobre vacas'], description: 'parición % (calc)' },

  // Sales/movements (10)
  { name: 'H11_ventas_marzo', turns: ['cuánto facturé en hacienda en marzo'], description: 'financial pivot' },
  { name: 'H12_ventas_count', turns: ['cuántas ventas de hacienda hice este año'], description: 'count ventas' },
  { name: 'H13_precio_novillo', turns: ['precio promedio de venta por novillo'], description: 'avg price' },
  { name: 'H14_precio_vaca', turns: ['precio promedio por vaca vendida'], description: 'avg vaca price' },
  { name: 'H15_compound_vendidas', turns: ['cuántas vacas y cuántos novillos vendí'], description: '2 metrics' },
  { name: 'H16_mes_mas_ventas', turns: ['mes con más ventas de hacienda'], description: 'top month' },
  { name: 'H17_total_movimientos', turns: ['cuántas cabezas se movieron este año entre ventas, muertes y nacimientos'], description: '3-way aggregate' },
  { name: 'H18_balance_year', turns: ['balance hacienda del año: entradas vs salidas'], description: 'flow analysis' },
  { name: 'H19_compra_o_venta', turns: ['estoy comprando o vendiendo más hacienda?'], description: 'conversational direction' },
  { name: 'H20_ultima_venta', turns: ['cuándo fue la última venta de hacienda'], description: 'last sale date' },

  // Deaths & births (6)
  { name: 'H21_muertes_total', turns: ['cuántos animales murieron este año'], description: 'sum deaths' },
  { name: 'H22_mortalidad_pct', turns: ['porcentaje de mortalidad'], description: 'mortality rate (calc)' },
  { name: 'H23_pariciones', turns: ['cuántas pariciones tuvimos'], description: 'count births' },
  { name: 'H24_pct_parision', turns: ['porcentaje de parición sobre vacas'], description: 'parición % (calc)' },
  { name: 'H25_ultima_muerte', turns: ['cuándo murió la última vaca'], description: 'last death' },
  { name: 'H26_causas_muerte', turns: ['qué causó las muertes'], description: 'reason aggregation' },

  // Health (8)
  { name: 'H27_aftosa', turns: ['cuántas vacunaciones de aftosa hice'], description: 'count by product' },
  { name: 'H28_ultima_vacuna', turns: ['cuándo fue la última vacunación'], description: 'last vaccine' },
  { name: 'H29_brucelosis_count', turns: ['cuántos animales vacuné contra brucelosis'], description: 'sum animals by product' },
  { name: 'H30_desparas_por_cat', turns: ['cuántas desparasitaciones hice por categoría'], description: 'group_by cat' },
  { name: 'H31_compound_aftosa', turns: ['cuántas vacunaciones de aftosa hice y cuándo fue la última'], description: 'count + last' },
  { name: 'H32_proxima_vacuna', turns: ['cuándo me toca la próxima vacunación'], description: 'inferential future' },
  { name: 'H33_revisiones', turns: ['cuántas revisiones sanitarias hice'], description: 'count revisión' },
  { name: 'H34_productos_sanitarios', turns: ['qué productos sanitarios usé este año'], description: 'distinct products' },

  // Repro (4)
  { name: 'H35_servicio_destete', turns: ['cuándo eché el toro y cuándo desteté'], description: '2 repro events' },
  { name: 'H36_count_destetes', turns: ['cuántos terneros desteté'], description: 'sum animals weaned' },
  { name: 'H37_tiempo_servicio_destete', turns: ['cuánto tiempo entre el servicio y el destete'], description: 'date diff (calc)' },
  { name: 'H38_eventos_repro_year', turns: ['eventos reproductivos del año'], description: 'list repro' },

  // Weighings & GDPV (4)
  { name: 'H39_evolucion_peso', turns: ['evolución del peso de las vacas'], description: 'weighing series' },
  { name: 'H40_gdpv', turns: ['cuánto subieron de peso desde enero'], description: 'weight gain (calc)' },
  { name: 'H41_compound_peso', turns: ['cuánto pesan ahora las vacas y cuánto pesaban en enero'], description: '2 weighings' },
  { name: 'H42_kg_ganados', turns: ['cuántos kg ganó el rodeo desde enero'], description: 'total kg gained (calc)' },

  // Complex multi-tool (4) — flagship hard cases
  { name: 'H43_resumen_full', turns: ['dame un resumen completo del rodeo: cabezas, ventas, sanidad y peso'], description: '4 tools in one message' },
  { name: 'H44_balance_mov_money', turns: ['movimientos hacienda y plata generada del año'], description: 'movements + financial' },
  { name: 'H45_inventario_peso_gdpv', turns: ['inventario actual, último peso y cuánto subieron'], description: '3 tools' },
  { name: 'H46_facturacion_costo', turns: ['cuánto facturé en hacienda y cuánto me costó comprar'], description: 'ingresos + gastos hacienda' },

  // Multi-turn refinements (2)
  { name: 'H47_refine_breed', turns: ['cuántas vacas tengo', 'y de qué razas?', 'solo las Hereford'], description: '3-turn drill' },
  { name: 'H48_refine_ventas', turns: ['ventas de hacienda', 'solo las de marzo', 'y precio promedio?'], description: '3-turn sales drill' },
];

const AGRO_TESTS: MultiTurnTest[] = [
  // Siembra (6)
  { name: 'A01_cultivo_n1', turns: ['qué sembré en N1'], description: 'active crop plot' },
  { name: 'A02_total_ha_sembradas', turns: ['cuántas hectáreas sembré en total'], description: 'sum hectares' },
  { name: 'A03_fechas_siembra', turns: ['cuándo sembré cada lote'], description: 'list with dates' },
  { name: 'A04_termine_siembra', turns: ['ya terminé de sembrar'], description: 'conversational completion' },
  { name: 'A05_compound_cultivos', turns: ['qué cultivos tengo y cuántas ha en total'], description: 'crops + hectares' },
  { name: 'A06_siembra_por_super', turns: ['lotes ordenados por superficie sembrada'], description: 'ranking ha' },

  // Cosecha (10)
  { name: 'A07_rinde_por_lote', turns: ['rinde por lote'], description: 'yield breakdown' },
  { name: 'A08_total_cosechado', turns: ['cuántas tn coseché en total'], description: 'sum tn' },
  { name: 'A09_mejor_rinde', turns: ['cuál lote tuvo el mejor rinde'], description: 'top yield' },
  { name: 'A10_peor_rinde', turns: ['cuál lote tuvo el peor rinde'], description: 'bottom yield' },
  { name: 'A11_cultivo_mas_volumen', turns: ['qué cultivo cosechamos más'], description: 'top crop by volume' },
  { name: 'A12_destinatarios', turns: ['cuánto entregamos a cada destinatario'], description: 'group_by destinatario' },
  { name: 'A13_compound_choferes', turns: ['choferes y cuántos viajes hizo cada uno'], description: 'group_by driver' },
  { name: 'A14_humedad_fuera_norma', turns: ['cosechas con humedad arriba de 14%'], description: 'filtered loads' },
  { name: 'A15_ultima_cosecha', turns: ['cuándo fue la última cosecha'], description: 'last harvest' },
  { name: 'A16_compare_yields', turns: ['compará rinde soja N1 vs trigo N3'], description: 'cross-crop compare' },

  // Monitoreo (10)
  { name: 'A17_monitoreos_por_estadio', turns: ['cuántos monitoreos hice en cada estadio'], description: 'group_by stage' },
  { name: 'A18_peor_plaga_lote', turns: ['cuál lote tiene la peor presión de plagas'], description: 'max pest sev' },
  { name: 'A19_evolucion_malezas', turns: ['evolución de malezas del lote N1'], description: 'time series scoutings' },
  { name: 'A20_filtro_15', turns: ['lotes con malezas arriba de 15%'], description: 'filter weed_pct' },
  { name: 'A21_promedio_maleza_cultivo', turns: ['promedio de % maleza por cultivo'], description: 'group_by crop avg' },
  { name: 'A22_plagas_frecuentes', turns: ['plagas más frecuentes'], description: 'top pest species' },
  { name: 'A23_sanidad_general', turns: ['cómo viene la sanidad del cultivo en general'], description: 'broad summary' },
  { name: 'A24_compare_plagas', turns: ['compará presión de plagas N1 vs N2'], description: 'compare plots' },
  { name: 'A25_compound_monitor', turns: ['monitoreos N1 con plagas y monitoreos N2 con plagas'], description: '2 query_scoutings' },
  { name: 'A26_dias_sin_monitor', turns: ['cuántos días pasaron desde el último monitoreo'], description: 'date diff' },

  // Observaciones (6)
  { name: 'A27_obs_recientes', turns: ['observaciones recientes'], description: 'last observations' },
  { name: 'A28_obs_n1', turns: ['observaciones del lote N1'], description: 'filter by plot' },
  { name: 'A29_ultima_obs', turns: ['cuál fue la última observación'], description: 'most recent' },
  { name: 'A30_obs_keyword', turns: ['observaciones donde hablo de roya'], description: 'keyword search' },
  { name: 'A31_obs_mayo', turns: ['observaciones de mayo'], description: 'period filter' },
  { name: 'A32_compound_obs_monitor', turns: ['observaciones del lote N1 y los monitoreos del lote N1'], description: 'obs + scoutings same plot' },
];

const ALL_TESTS = [...HACIENDA_TESTS, ...AGRO_TESTS];

// ── Main ───────────────────────────────────────────────────────────────

interface TurnResult { message: string; response: string; pass: boolean; note: string; }
interface TestResult { name: string; description: string; turns: TurnResult[]; overallPass: boolean; }

async function main(): Promise<void> {
  console.log(`🧪 QA Hacienda+Agro 80 — ${HACIENDA_TESTS.length} hacienda + ${AGRO_TESTS.length} agro\n`);

  const auth = await apiLogin();
  TOKEN = auth.token;
  console.log(`✅ Login user ${auth.userId} (${EMAIL})\n`);

  await seedExtras(auth.userId);

  const allResults: TestResult[] = [];
  let pass = 0, fail = 0;

  for (let i = 0; i < ALL_TESTS.length; i++) {
    const test = ALL_TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    const group = i < HACIENDA_TESTS.length ? '🐄' : '🌱';
    console.log(`\n${num}/${ALL_TESTS.length} ${group} ${test.name} — ${test.description}`);

    const turnResults: TurnResult[] = [];
    let allTurnsPass = true;

    try { await apiSend('cancelar'); } catch { /* ignore */ }

    for (let t = 0; t < test.turns.length; t++) {
      const message = test.turns[t];
      console.log(`  T${t + 1} 👤 ${message}`);
      try {
        const data = await apiSend(message);
        const text = extractText(data) || '(empty)';
        const preview = text.substring(0, 300).replace(/\n/g, ' ');
        console.log(`  T${t + 1} 🤖 ${preview}${text.length > 300 ? '…' : ''}`);

        let turnPass = true;
        let note = 'auto-pass';
        if (test.validate && test.validate[t]) {
          const v = test.validate[t]!(text);
          turnPass = v.pass;
          note = v.note;
        } else {
          const isErrorOnly = /^(error|err|fail|fallo)/i.test(text.trim()) || text.trim() === '(empty)';
          const tooGeneric = /No pude identificar|necesito.*lote\/corral|necesito categor/i.test(text);
          turnPass = !isErrorOnly && !tooGeneric && text.length > 5;
          note = turnPass ? 'non-empty informative' : tooGeneric ? 'generic ask (bad UX)' : 'empty/error';
        }

        if (!turnPass) allTurnsPass = false;
        turnResults.push({ message, response: text, pass: turnPass, note });
        console.log(`  T${t + 1} ${turnPass ? '✅' : '❌'} ${note}`);
      } catch (err: any) {
        console.log(`  T${t + 1} 💥 ${err.message}`);
        turnResults.push({ message, response: `ERROR: ${err.message}`, pass: false, note: 'runtime error' });
        allTurnsPass = false;
      }
    }

    if (allTurnsPass) pass++; else fail++;
    allResults.push({ name: test.name, description: test.description, turns: turnResults, overallPass: allTurnsPass });
  }

  console.log('\n\n═══════════════════════ SUMMARY ═══════════════════════');
  console.log(`  ✅ PASS:    ${pass} / ${ALL_TESTS.length}`);
  console.log(`  ❌ FAIL:    ${fail} / ${ALL_TESTS.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / ALL_TESTS.length) * 100)}%`);
  console.log(`  📊 Hacienda: ${allResults.slice(0, HACIENDA_TESTS.length).filter(r => r.overallPass).length} / ${HACIENDA_TESTS.length}`);
  console.log(`  📊 Agro:     ${allResults.slice(HACIENDA_TESTS.length).filter(r => r.overallPass).length} / ${AGRO_TESTS.length}\n`);

  console.log('═══════════════════════ DETALLE FAILS ═══════════════════════\n');
  for (const r of allResults) {
    if (r.overallPass) continue;
    console.log(`\n[${r.name}] ${r.description}`);
    for (const t of r.turns) {
      console.log(`  ${t.pass ? '✅' : '❌'} 👤 ${t.message}`);
      console.log(`     🤖 ${t.response.substring(0, 350).replace(/\n/g, ' ')}${t.response.length > 350 ? '…' : ''}`);
      if (!t.pass) console.log(`     💡 ${t.note}`);
    }
  }

  // Ruta relativa a ESTE archivo. Antes era una absoluta de macOS
  // (/Users/…/campo-bot/…), así que en Windows la suite corría entera y recién
  // al final explotaba con ENOENT, perdiendo el reporte.
  const fs = await import('fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  fs.writeFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'qa-hacienda-agro-80-results.json'),
    JSON.stringify({ summary: { pass, fail, total: ALL_TESTS.length }, tests: allResults }, null, 2),
  );
  console.log(`\n📄 Full report: src/testing/qa-hacienda-agro-80-results.json`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
