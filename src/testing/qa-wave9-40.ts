/**
 * QA Wave 9 — 40 NEW scenarios. Foco principal: re-verificación intensiva
 * del P0 fix (vendí livestock → remove_livestock + auto-linked income).
 *
 * Groups:
 *   W — P0 hacienda venta/compra intensive (10) — varias variantes con $X c/u
 *   X — Date intelligence v2 (5)
 *   Y — Reports & exports (5)
 *   Z — Long compounds 5-8 actions (8)
 *   AA — Repro chains v2 (5)
 *   BB — Novel edge cases (7)
 *
 * Auth: qa-wave9@campo.test / qatest123 / Don Noveno
 * Run: docker compose up -d && npx tsx src/testing/qa-wave9-40.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL = 'qa-wave9@campo.test';
const PASSWORD = 'qatest123';
const NAME = 'Don Noveno';

// ── API helpers (identical pattern to wave-8) ──────────────────────────

async function apiRegister(): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, last_name: 'Test', email: EMAIL, password: PASSWORD }),
  });
  if (res.ok) { const d = await res.json() as any; return { token: d.tokens.accessToken, userId: d.user.id }; }
  if (res.status === 409) return apiLogin();
  throw new Error(`Register failed: ${res.status}`);
}
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
async function apiReset(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test-bot/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` }, body: '{}',
  });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}
async function apiSend(message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  return res.json();
}
async function apiTap(buttonId: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status}`);
  return res.json();
}
async function apiQueryDb(sql: string, params: unknown[]): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`Query failed: ${res.status}`);
  const d = await res.json() as any;
  return d.rows ?? [];
}
function extractText(data: any): string {
  return (data.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}
async function sendAndLog(message: string): Promise<string> {
  return extractText(await apiSend(message));
}

// ── Counts ─────────────────────────────────────────────────────────────

interface Counts { e: number; i: number; d: number; o: number; s: number; lm: number; sm: number; r: number; }
const COUNT_SQL = `SELECT
  (SELECT COUNT(*)::int FROM expenses WHERE user_id=$1 AND deleted_at IS NULL) as e,
  (SELECT COUNT(*)::int FROM incomes WHERE user_id=$1 AND deleted_at IS NULL) as i,
  (SELECT COUNT(*)::int FROM domain_events WHERE user_id=$1) as d,
  (SELECT COUNT(*)::int FROM agro_observations WHERE user_id=$1) as o,
  (SELECT COUNT(*)::int FROM crop_scoutings WHERE user_id=$1) as s,
  (SELECT COUNT(*)::int FROM livestock_movements WHERE user_id=$1) as lm,
  (SELECT COUNT(*)::int FROM stock_movements WHERE user_id=$1) as sm,
  (SELECT COUNT(*)::int FROM rainfall WHERE user_id=$1) as r`;
async function countAll(userId: number): Promise<Counts> {
  const r = (await apiQueryDb(COUNT_SQL, [userId]))[0] ?? {};
  return { e: +r.e || 0, i: +r.i || 0, d: +r.d || 0, o: +r.o || 0, s: +r.s || 0, lm: +r.lm || 0, sm: +r.sm || 0, r: +r.r || 0 };
}
function diff(b: Counts, a: Counts): Counts {
  return { e: a.e - b.e, i: a.i - b.i, d: a.d - b.d, o: a.o - b.o, s: a.s - b.s, lm: a.lm - b.lm, sm: a.sm - b.sm, r: a.r - b.r };
}

// ── Setup ─────────────────────────────────────────────────────────────

async function setupSharedState(): Promise<void> {
  console.log('🔧 Setup shared state...');
  await sendAndLog('agregar campo La Magdalena');
  await apiTap('flow_field_loc_city');
  await sendAndLog('Junín');
  await apiTap('flow_confirm');
  for (const [name, ha] of [['Lote 1', 100], ['Lote 2', 150], ['Lote 3', 80]] as const) {
    await sendAndLog(`agregar lote ${name} al campo La Magdalena`);
    await sendAndLog(String(ha));
  }
  await sendAndLog('sembré soja en Lote 1');
  await sendAndLog('sembré maíz en Lote 2');
  await sendAndLog('sembré trigo en Lote 3');
  await sendAndLog('agregué 80 vacas Angus en Lote 1');
  await sendAndLog('agregué 50 novillos Hereford en Lote 2');
  await sendAndLog('agregué 40 terneros en Lote 3');
  await sendAndLog('agregué 10 toros Limousin en Lote 1');
  await sendAndLog('crear galpón Big en La Magdalena');
  await sendAndLog('agregar 200 bolsas semilla maíz al galpón Big');
  await sendAndLog('agregar 150 lt 2,4D al galpón Big');
  console.log('✅ Setup done\n');
}

// ── Spec ─────────────────────────────────────────────────────────────

type Group = 'W_P0_intensive' | 'X_dates_v2' | 'Y_reports' | 'Z_long_compound' | 'AA_repro' | 'BB_novel_edges';
interface ExpectCtx { userId: number; d: Counts; text: string; }
type ExpectFn = (ctx: ExpectCtx) => Promise<{ pass: boolean; reason: string }> | { pass: boolean; reason: string };
interface TestSpec { name: string; desc: string; group: Group; compound: string; answers?: string[]; expect: ExpectFn; }

function botIsAsking(text: string): boolean {
  if (!text) return false;
  if (/\?/.test(text)) return true;
  return /cu[aá]nt|cu[aá]l|en qu[eé]|qu[eé] |c[oó]mo|d[oó]nde|me lo dec/i.test(text);
}

// Helper for P0 verification: check there's a livestock_movement matching count + unit_price.
async function expectLivestockMovement(
  userId: number,
  predicate: (row: any) => boolean,
  movementType: 'salida' | 'entrada' = 'salida',
): Promise<{ pass: boolean; reason: string }> {
  // category lives on livestock_groups, not livestock_movements. JOIN via
  // source_group_id (for 'salida') or dest_group_id (for 'entrada').
  const groupKey = movementType === 'salida' ? 'source_group_id' : 'dest_group_id';
  const rows = await apiQueryDb(
    `SELECT lm.movement_type, lm.count, lm.unit_price_usd, lm.unit_price_ars,
            lm.linked_income_id, lm.linked_expense_id, lg.category
       FROM livestock_movements lm
       LEFT JOIN livestock_groups lg ON lg.id = lm.${groupKey}
      WHERE lm.user_id=$1
        AND lm.created_at > NOW() - INTERVAL '90 seconds'
        AND lm.movement_type=$2
   ORDER BY lm.id DESC LIMIT 5`,
    [userId, movementType],
  );
  const match = rows.find(predicate);
  if (!match) return { pass: false, reason: `no ${movementType} matching predicate; rows=${JSON.stringify(rows.slice(0, 3))}` };
  const linkedKey = movementType === 'salida' ? 'linked_income_id' : 'linked_expense_id';
  const hasLink = match[linkedKey] != null;
  return { pass: hasLink, reason: `match found, ${linkedKey}=${match[linkedKey]}` };
}

const TESTS: TestSpec[] = [
  // ───── W — P0 hacienda venta/compra intensive (10) ─────
  {
    name: 'W01_vendi_5_vacas_1500usd', group: 'W_P0_intensive',
    desc: 'P0 verify (same as wave-8 Q09): vendí 5 vacas a 1500 USD c/u',
    compound: 'vendí 5 vacas a 1500 USD cada una en Lote 1',
    expect: ({ userId }) => expectLivestockMovement(userId, r => Number(r.count) === 5 && Number(r.unit_price_usd) === 1500 && r.category === 'vaca'),
  },
  {
    name: 'W02_vendi_3_novillos_1800usd', group: 'W_P0_intensive',
    desc: 'P0: vendí 3 novillos a 1800 USD c/u',
    compound: 'vendí 3 novillos a 1800 dólares cada uno en Lote 2',
    expect: ({ userId }) => expectLivestockMovement(userId, r => Number(r.count) === 3 && Number(r.unit_price_usd) === 1800 && r.category === 'novillo'),
  },
  {
    name: 'W03_vendi_7_terneros_pesos', group: 'W_P0_intensive',
    desc: 'P0: vendí 7 terneros a 900000 pesos c/u (ARS, no USD)',
    compound: 'vendí 7 terneros a 900000 pesos cada uno en Lote 3',
    expect: ({ userId }) => expectLivestockMovement(userId, r => Number(r.count) === 7 && Number(r.unit_price_ars) === 900000 && r.category === 'ternero'),
  },
  {
    name: 'W04_vendi_2_toros_por_cabeza', group: 'W_P0_intensive',
    desc: 'P0: vendí 2 toros a 2500 USD por cabeza (phrasing variant)',
    compound: 'vendí 2 toros a 2500 USD por cabeza en Lote 1',
    expect: ({ userId }) => expectLivestockMovement(userId, r => Number(r.count) === 2 && Number(r.unit_price_usd) === 2500 && r.category === 'toro'),
  },
  {
    name: 'W05_compre_8_vaquillonas', group: 'W_P0_intensive',
    desc: 'P0 parity: compré 8 vaquillonas Angus a 1300 USD c/u → add_livestock',
    compound: 'compré 8 vaquillonas Angus a 1300 USD cada una para Lote 1',
    expect: ({ userId }) => expectLivestockMovement(userId, r => Number(r.count) === 8 && Number(r.unit_price_usd) === 1300 && r.category === 'vaquillona', 'entrada'),
  },
  {
    name: 'W06_compound_2_ventas', group: 'W_P0_intensive',
    desc: 'P0 compound: 2 ventas distintas categorías y precios',
    compound: 'vendí 6 novillos a 1900 USD c/u y vendí 4 vacas a 1600 USD c/u en Lote 1',
    expect: async ({ userId }) => {
      const novillos = await expectLivestockMovement(userId, r => r.category === 'novillo' && Number(r.count) === 6 && Number(r.unit_price_usd) === 1900);
      const vacas = await expectLivestockMovement(userId, r => r.category === 'vaca' && Number(r.count) === 4 && Number(r.unit_price_usd) === 1600);
      return { pass: novillos.pass && vacas.pass, reason: `novillos=${novillos.pass} vacas=${vacas.pass}` };
    },
  },
  {
    name: 'W07_compound_venta_compra', group: 'W_P0_intensive',
    desc: 'P0 mix: venta + compra en mismo compound',
    compound: 'vendí 4 toros Limousin a 2200 USD c/u en Lote 1 y compré 6 vaquillonas Brangus a 1100 USD c/u para Lote 2',
    expect: async ({ userId }) => {
      const venta = await expectLivestockMovement(userId, r => r.category === 'toro' && Number(r.count) === 4 && Number(r.unit_price_usd) === 2200);
      const compra = await expectLivestockMovement(userId, r => r.category === 'vaquillona' && Number(r.count) === 6 && Number(r.unit_price_usd) === 1100, 'entrada');
      return { pass: venta.pass && compra.pass, reason: `venta=${venta.pass} compra=${compra.pass}` };
    },
  },
  {
    name: 'W08_vendi_grandes_numeros', group: 'W_P0_intensive',
    desc: 'P0 con números grandes: vendí 15 vacas a 1.450.000 ARS c/u',
    compound: 'vendí 15 vacas a 1.450.000 pesos cada una en Lote 1',
    expect: ({ userId }) => expectLivestockMovement(userId, r => Number(r.count) === 15 && Number(r.unit_price_ars) === 1450000 && r.category === 'vaca'),
  },
  {
    name: 'W09_compre_animal_singular', group: 'W_P0_intensive',
    desc: 'compré 1 toro reproductor a 5000 USD',
    compound: 'compré 1 toro reproductor a 5000 USD para Lote 1',
    expect: ({ userId }) => expectLivestockMovement(userId, r => Number(r.count) === 1 && Number(r.unit_price_usd) === 5000 && r.category === 'toro', 'entrada'),
  },
  {
    name: 'W10_venta_breed_specific', group: 'W_P0_intensive',
    desc: 'venta con breed específico: vendí 5 vacas Angus a 1700 USD c/u',
    compound: 'vendí 5 vacas Angus a 1700 USD c/u en Lote 1',
    expect: async ({ userId }) => {
      const rows = await apiQueryDb(
        `SELECT count, unit_price_usd, category FROM livestock_movements WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND movement_type='salida' ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const match = rows.find((r: any) => Number(r.count) === 5 && Number(r.unit_price_usd) === 1700 && r.category === 'vaca');
      return { pass: !!match, reason: `match=${!!match} rows=${JSON.stringify(rows.slice(0,2))}` };
    },
  },

  // ───── X — Date intelligence v2 (5) ─────
  {
    name: 'X11_la_semana_pasada', group: 'X_dates_v2',
    desc: 'fecha relativa "la semana pasada"',
    compound: 'la semana pasada vendí 25 tn de soja a 460 USD por tonelada',
    expect: async ({ userId, d }) => {
      if (d.i < 1) return { pass: false, reason: `i=${d.i}` };
      const rows = await apiQueryDb(
        `SELECT income_date FROM incomes WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 2`,
        [userId],
      );
      const oldDate = rows.some((r: any) => r.income_date && new Date(r.income_date) < new Date(Date.now() - 3 * 86400000));
      return { pass: oldDate, reason: `pastDate=${oldDate} rows=${JSON.stringify(rows)}` };
    },
  },
  {
    name: 'X12_el_lunes', group: 'X_dates_v2',
    desc: 'fecha específica "el lunes" (último lunes)',
    compound: 'el lunes compré 60 bolsas urea a 9000 c/u',
    expect: async ({ userId, d }) => {
      if (d.e < 1) return { pass: false, reason: `e=${d.e}` };
      const rows = await apiQueryDb(
        `SELECT expense_date FROM expenses WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 2`,
        [userId],
      );
      const notToday = rows.some((r: any) => r.expense_date && new Date(r.expense_date).toDateString() !== new Date().toDateString());
      return { pass: notToday, reason: `notToday=${notToday} rows=${JSON.stringify(rows)}` };
    },
  },
  {
    name: 'X13_fechas_chain_4', group: 'X_dates_v2',
    desc: '4 acciones con fechas distintas',
    compound: 'ayer fumigué Lote 1 con glifosato 3 lt/ha, anteayer compré 40 bolsas urea a 8500, hoy sembré avena en Lote 3 y la semana pasada gasté 50mil en repuestos',
    expect: ({ d }) => ({
      pass: d.d + d.e >= 3,
      reason: `d=${d.d} e=${d.e} (esperado d+e >= 3 actions)`,
    }),
  },
  {
    name: 'X14_mes_actual_query', group: 'X_dates_v2',
    desc: 'query del mes actual + write',
    compound: 'cuánto vendí este mes y registrá un gasto de 80mil en sueldos hoy',
    expect: ({ text, d }) => {
      const hasQuery = /vend|mes|ingres|sin.*ventas|todavía/i.test(text);
      return { pass: hasQuery && d.e >= 1, reason: `query=${hasQuery} e=${d.e}` };
    },
  },
  {
    name: 'X15_ayer_vs_today_no_dedup', group: 'X_dates_v2',
    desc: 'lluvia ayer + hoy NO debe dedup',
    compound: 'llovieron 15mm ayer en La Magdalena y 22mm hoy en La Magdalena',
    expect: ({ d }) => ({
      pass: d.r >= 2,
      reason: `r=${d.r} (esperado 2 lluvias diferentes)`,
    }),
  },

  // ───── Y — Reports & exports (5) ─────
  {
    name: 'Y16_reporte_agro', group: 'Y_reports',
    desc: 'pedido reporte agronómico',
    compound: 'generame el reporte agronómico de este mes',
    expect: ({ text, d }) => {
      const noWrites = d.e === 0 && d.i === 0;
      const isReport = /report|gener|pdf|agro/i.test(text);
      return { pass: noWrites && isReport, reason: `noWrites=${noWrites} isReport=${isReport}` };
    },
  },
  {
    name: 'Y17_export_csv', group: 'Y_reports',
    desc: 'exportar gastos en CSV',
    compound: 'exportá los gastos del último mes en CSV',
    expect: ({ text }) => {
      const isExport = /csv|export|enviar.*archivo|descarga/i.test(text);
      return { pass: isExport, reason: `isExport=${isExport}` };
    },
  },
  {
    name: 'Y18_resumen_mensual', group: 'Y_reports',
    desc: 'resumen mensual',
    compound: 'mostrame el resumen del mes',
    expect: ({ text, d }) => {
      const noWrites = d.e === 0 && d.i === 0;
      const hasResumen = /resumen|mes|ingres|gast|resultado|margen/i.test(text);
      return { pass: noWrites && hasResumen, reason: `noWrites=${noWrites} hasResumen=${hasResumen}` };
    },
  },
  {
    name: 'Y19_campaign_stats', group: 'Y_reports',
    desc: 'campaign stats',
    compound: 'cómo viene la campaña de soja',
    expect: ({ text }) => {
      const isCampaign = /camp|soja|rinde|hect|sembr/i.test(text);
      return { pass: isCampaign, reason: `isCampaign=${isCampaign}` };
    },
  },
  {
    name: 'Y20_historico_lote', group: 'Y_reports',
    desc: 'historial de un lote',
    compound: 'mostrame el historial del Lote 1',
    expect: ({ text }) => {
      const hasHistory = /histor|actividad|registr|fumig|siembra|cosech/i.test(text);
      return { pass: hasHistory, reason: `hasHistory=${hasHistory}` };
    },
  },

  // ───── Z — Long compounds 5-8 actions (8) ─────
  {
    name: 'Z21_6_actions_full', group: 'Z_long_compound',
    desc: '6 acciones todas con datos completos',
    compound: 'vendí 12 tn de maíz a 200 USD c/u, compré 80 bolsas urea a 9mil, fumigué Lote 1 con glifosato 3 lt/ha, agregué 10 vaquillonas Hereford en Lote 2, monitoreé Lote 3 con V5 sin plagas, gasté 60mil en gasoil',
    expect: ({ d }) => ({
      pass: d.i + d.e + d.d + d.lm + d.s >= 5,
      reason: `i=${d.i} e=${d.e} d=${d.d} lm=${d.lm} s=${d.s}`,
    }),
  },
  {
    name: 'Z22_7_agro_chain', group: 'Z_long_compound',
    desc: '7 actividades agronómicas',
    compound: 'sembré avena en Lote 3, fumigué Lote 1 con 2,4D 1.5 lt/ha, fertilicé Lote 2 con urea 100 kg/ha, llovieron 18mm, monitoreé Lote 1 V6, observé liebres en Lote 3, aré Lote 2',
    expect: ({ d }) => ({
      pass: d.d + d.r + d.s + d.o >= 5,
      reason: `d=${d.d} r=${d.r} s=${d.s} o=${d.o}`,
    }),
  },
  {
    name: 'Z23_5_hacienda_chain', group: 'Z_long_compound',
    desc: '5 acciones hacienda compound (verifica multi-P0)',
    compound: 'agregué 20 vaquillonas Hereford en Lote 2, vacuné 50 vacas contra aftosa, pesé 40 terneros 250 kg promedio, vendí 8 novillos a 1900 USD c/u, eché el toro Centauro en Lote 1',
    expect: ({ d }) => ({
      pass: d.lm + d.d >= 3,
      reason: `lm=${d.lm} d=${d.d}`,
    }),
  },
  {
    name: 'Z24_5_financial_pure', group: 'Z_long_compound',
    desc: '5 financial pure compound',
    compound: 'vendí 15 tn soja a 480 USD c/u, vendí 10 tn maíz a 200 USD c/u, compré 50 bolsas DAP a 12mil, compré 100 lt gasoil a 850, gasté 80mil en mantenimiento',
    expect: ({ d }) => ({
      pass: d.i >= 1 && d.e >= 2,
      reason: `i=${d.i} e=${d.e}`,
    }),
  },
  {
    name: 'Z25_8_max_mixed', group: 'Z_long_compound',
    desc: '8-action mega compound (todos los dominios)',
    compound: 'vendí 15 tn cebada a 165 USD, compré 80 bolsas DAP a 9mil, fumigué Lote 1 con 2,4D 1.5 lt/ha, agregué 20 terneros en Lote 3, monitoreé Lote 2 V5 sin plagas, llovieron 22mm, observé encharcamiento en Lote 1, gasté 50mil en repuestos',
    expect: ({ d }) => ({
      pass: d.i + d.e + d.d + d.r + d.s + d.o + d.lm >= 6,
      reason: `i=${d.i} e=${d.e} d=${d.d} r=${d.r} s=${d.s} o=${d.o} lm=${d.lm}`,
    }),
  },
  {
    name: 'Z26_5_stock_chain', group: 'Z_long_compound',
    desc: 'stock chain 5 actions',
    compound: 'agregué 100 bolsas urea al galpón Big a 9mil c/u, agregué 50 lt cipermetrina a 1200 c/u, saqué 30 bolsas semilla maíz del galpón Big, saqué 50 lt 2,4D del galpón Big para Lote 1, fumigué Lote 1 con 2,4D 1.5 lt/ha',
    expect: ({ d }) => ({
      pass: d.sm >= 2,
      reason: `sm=${d.sm} d=${d.d}`,
    }),
  },
  {
    name: 'Z27_5_query_then_writes', group: 'Z_long_compound',
    desc: 'query + 4 writes en compound',
    compound: 'cuánto gasté este mes, gasté 30mil en gasoil, agregué 5 terneros en Lote 3, vendí 12 tn soja a 470 USD c/u, fumigué Lote 2 con 2,4D 1 lt/ha',
    expect: ({ d }) => ({
      pass: d.e + d.i + d.lm + d.d >= 3,
      reason: `e=${d.e} i=${d.i} lm=${d.lm} d=${d.d}`,
    }),
  },
  {
    name: 'Z28_5_partials_serial', group: 'Z_long_compound',
    desc: '5 partials → debería disparar serial queue',
    compound: 'vendí soja, compré urea, fumigué, agregué hacienda, gasté en algo',
    answers: ['25 tn a 480 USD', '50 bolsas a 9mil', 'Lote 1 con glifosato 3 lt/ha', '10 terneros en Lote 3', '60 mil en gasoil'],
    expect: ({ d, text }) => {
      const hasAsked = /\?|cuánt|cuál/i.test(text);
      return { pass: hasAsked || d.e + d.i + d.d + d.lm >= 2, reason: `asked=${hasAsked} writes=${d.e + d.i + d.d + d.lm}` };
    },
  },

  // ───── AA — Repro chains v2 (5) ─────
  {
    name: 'AA29_eche_toro_simple', group: 'AA_repro',
    desc: 'eché el toro (simple)',
    compound: 'eché el toro Don Pedro en Lote 1',
    expect: async ({ userId }) => {
      const rows = await apiQueryDb(
        `SELECT COUNT(*)::int as c FROM domain_events WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND event_type='repro_event'`,
        [userId],
      );
      return { pass: Number(rows[0]?.c) >= 1, reason: `repro=${rows[0]?.c}` };
    },
  },
  {
    name: 'AA30_inseminacion_iatf', group: 'AA_repro',
    desc: 'inseminé 20 vacas IATF',
    compound: 'inseminé 20 vacas con IATF en Lote 1',
    expect: async ({ userId }) => {
      const rows = await apiQueryDb(
        `SELECT COUNT(*)::int as c FROM domain_events WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND event_type='repro_event'`,
        [userId],
      );
      return { pass: Number(rows[0]?.c) >= 1, reason: `repro=${rows[0]?.c}` };
    },
  },
  {
    name: 'AA31_destete', group: 'AA_repro',
    desc: 'desteté 25 terneros',
    compound: 'desteté 25 terneros en Lote 3',
    expect: async ({ userId }) => {
      const rows = await apiQueryDb(
        `SELECT COUNT(*)::int as c FROM domain_events WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND event_type='repro_event'`,
        [userId],
      );
      return { pass: Number(rows[0]?.c) >= 1, reason: `repro=${rows[0]?.c}` };
    },
  },
  {
    name: 'AA32_repro_compound', group: 'AA_repro',
    desc: 'compound repro: toro + inseminé + detecté celo',
    compound: 'eché el toro Maximo en Lote 1, inseminé 15 vacas con monta natural y detecté 8 vacas en celo',
    expect: async ({ userId }) => {
      const rows = await apiQueryDb(
        `SELECT COUNT(*)::int as c FROM domain_events WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' AND event_type='repro_event'`,
        [userId],
      );
      return { pass: Number(rows[0]?.c) >= 2, reason: `repro=${rows[0]?.c} (esperado >=2)` };
    },
  },
  {
    name: 'AA33_tacto_event', group: 'AA_repro',
    desc: 'tacto en 40 vacas: 32 preñadas, 8 vacías',
    compound: 'hice tacto en 40 vacas, 32 preñadas y 8 vacías en Lote 1',
    expect: ({ d }) => ({
      pass: d.d >= 1,
      reason: `d=${d.d} (debería haber 1 tacto event)`,
    }),
  },

  // ───── BB — Novel edge cases (7) ─────
  {
    name: 'BB34_decimal_quantity', group: 'BB_novel_edges',
    desc: 'cantidad decimal: 2.5 toneladas',
    compound: 'vendí 2.5 toneladas de soja a 480 USD por tonelada',
    expect: async ({ userId, d }) => {
      if (d.i < 1) return { pass: false, reason: `i=${d.i}` };
      const rows = await apiQueryDb(
        `SELECT quantity, amount FROM incomes WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 2`,
        [userId],
      );
      const has25 = rows.some((r: any) => Number(r.quantity) === 2.5 || Math.abs(Number(r.amount) - 1200) < 1);
      return { pass: has25, reason: `decimal handled=${has25} rows=${JSON.stringify(rows)}` };
    },
  },
  {
    name: 'BB35_currency_symbol', group: 'BB_novel_edges',
    desc: 'monto con símbolo $: $80.000 en gasoil',
    compound: 'gasté $80.000 en gasoil',
    expect: ({ d }) => ({
      pass: d.e >= 1,
      reason: `e=${d.e}`,
    }),
  },
  {
    name: 'BB36_uppercase_message', group: 'BB_novel_edges',
    desc: 'mensaje en MAYÚSCULAS',
    compound: 'VENDÍ 10 TN DE SOJA A 470 USD POR TONELADA',
    expect: ({ d }) => ({
      pass: d.i >= 1,
      reason: `i=${d.i}`,
    }),
  },
  {
    name: 'BB37_question_only', group: 'BB_novel_edges',
    desc: 'mensaje 100% pregunta (no debe escribir)',
    compound: 'qué cultivo tiene el Lote 1',
    expect: ({ d, text }) => {
      const noWrites = d.e === 0 && d.i === 0 && d.d === 0;
      const hasInfo = /soja|cultivo|lote 1/i.test(text);
      return { pass: noWrites && hasInfo, reason: `noWrites=${noWrites} hasInfo=${hasInfo}` };
    },
  },
  {
    name: 'BB38_mixed_observation_scouting', group: 'BB_novel_edges',
    desc: 'observación libre (sin métricas) → log_observation, no scouting',
    compound: 'vi unas malezas raras en Lote 1',
    expect: ({ d }) => ({
      pass: d.o >= 1 || d.s >= 1,
      reason: `o=${d.o} s=${d.s} (alguno debe ser >= 1)`,
    }),
  },
  {
    name: 'BB39_correction_inline', group: 'BB_novel_edges',
    desc: 'corrección inline "no era X, eran Y"',
    compound: 'vendí 8 tn de maíz a 200 USD c/u, no eran 8, eran 12',
    expect: async ({ userId, d }) => {
      if (d.i < 1) return { pass: false, reason: `i=${d.i}` };
      const rows = await apiQueryDb(
        `SELECT quantity FROM incomes WHERE user_id=$1 AND created_at > NOW() - INTERVAL '90 seconds' ORDER BY id DESC LIMIT 3`,
        [userId],
      );
      const has12 = rows.some((r: any) => Number(r.quantity) === 12);
      const has8 = rows.some((r: any) => Number(r.quantity) === 8);
      // Ideally: only 12 (corrected). Acceptable: 8 (correction not processed but no dup).
      return { pass: has12 || (has8 && rows.length === 1), reason: `has12=${has12} has8=${has8} rows=${rows.length}` };
    },
  },
  {
    name: 'BB40_emoji_only_action', group: 'BB_novel_edges',
    desc: 'emoji + acción concisa',
    compound: '🐄 vendí 5 vacas a 1500 USD c/u en Lote 1',
    expect: ({ userId }) => expectLivestockMovement(userId, r => Number(r.count) === 5 && Number(r.unit_price_usd) === 1500),
  },
];

// ── Runner ─────────────────────────────────────────────────────────────

interface Result { test: TestSpec; status: 'PASS' | 'FAIL' | 'WARN'; reason: string; turns: string[]; }

async function runTest(t: TestSpec, userId: number): Promise<Result> {
  try { await sendAndLog('cancelar'); } catch { /* ignore */ }

  const before = await countAll(userId);
  let resp = await apiSend(t.compound);
  let text = extractText(resp);
  const turns: string[] = [text];

  for (const answer of t.answers ?? []) {
    if (!botIsAsking(text)) break;
    resp = await apiSend(answer);
    text = extractText(resp);
    turns.push(text);
  }

  await new Promise(r => setTimeout(r, 250));
  const after = await countAll(userId);
  const d = diff(before, after);

  try {
    const result = await Promise.resolve(t.expect({ userId, d, text: turns.join('\n') }));
    return { test: t, status: result.pass ? 'PASS' : 'FAIL', reason: result.reason, turns };
  } catch (err: any) {
    return { test: t, status: 'FAIL', reason: `expect-fn threw: ${err.message}`, turns };
  }
}

async function main(): Promise<void> {
  console.log('🧪 QA Wave 9 — 40 NEW (P0 re-verify intensive + 6 new groups)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const auth = await apiRegister();
  TOKEN = auth.token;
  const userId = auth.userId;
  console.log(`✅ Authenticated as user ${userId}`);
  await apiReset();
  await apiQueryDb('UPDATE users SET plan_id = 4 WHERE id = $1', [userId]);
  console.log('✅ Reset + enterprise plan');
  await setupSharedState();

  const results: Result[] = [];
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`${num}/${TESTS.length} [${t.group}] ${t.name}\n   `);
    try {
      const r = await runTest(t, userId);
      results.push(r);
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`${icon} ${r.status} — ${r.reason}`);
    } catch (err: any) {
      console.log(`💥 ${err.message}`);
      results.push({ test: t, status: 'FAIL', reason: `runtime: ${err.message}`, turns: [] });
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('                 SUMMARY');
  console.log('═══════════════════════════════════════════\n');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`  ✅ PASS: ${pass}  ❌ FAIL: ${fail}  📊 ${results.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / results.length) * 100)}%\n`);

  const byGroup: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    if (!byGroup[r.test.group]) byGroup[r.test.group] = { pass: 0, total: 0 };
    byGroup[r.test.group].total++;
    if (r.status === 'PASS') byGroup[r.test.group].pass++;
  }
  for (const [g, c] of Object.entries(byGroup)) console.log(`  ${g}: ${c.pass}/${c.total}`);

  if (fail > 0) {
    console.log('\n─── FAILURES ───\n');
    for (const r of results.filter(x => x.status === 'FAIL')) {
      console.log(`  ❌ ${r.test.name}: ${r.reason.substring(0, 120)}`);
    }
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-wave9-results.json',
    JSON.stringify(results.map(r => ({ name: r.test.name, group: r.test.group, status: r.status, reason: r.reason, compound: r.test.compound, turns: r.turns })), null, 2),
  );
  console.log(`\n📄 Report: src/testing/qa-wave9-results.json`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
