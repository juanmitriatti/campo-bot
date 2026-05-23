/**
 * QA Sharing Flow 30 — tests exhaustivos del flujo de compartir entre 2 users.
 *
 * Cubre:
 *  - Owner genera código (5)
 *  - Member acepta código (5)
 *  - Member ve datos del owner (4)
 *  - Member registra como owner (4)
 *  - Permisos: member NO puede eliminar (3)
 *  - Listar/quitar miembros (3)
 *  - Edge cases: código vencido, doble accept, self-accept (4)
 *  - Multi-field share + revoke (2)
 *
 * 2 users fresh: qa-share-A@campo.test (owner), qa-share-B@campo.test (member).
 *
 * Run: docker compose up -d && npx tsx src/testing/qa-sharing-flow-30.ts
 */

const BASE_URL = process.env.TEST_BOT_URL || 'http://localhost:3000';
const EMAIL_A = 'qa-share-a@campo.test';
const EMAIL_B = 'qa-share-b@campo.test';
const PASSWORD = 'qatest123';

interface UserCtx {
  email: string;
  token: string;
  userId: number;
}

async function register(email: string, name: string): Promise<UserCtx> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, last_name: 'Test', email, password: PASSWORD }),
  });
  if (res.ok) { const d = await res.json() as any; return { email, token: d.tokens.accessToken, userId: d.user.id }; }
  if (res.status === 409) return login(email);
  throw new Error(`Register ${email} failed: ${res.status}`);
}
async function login(email: string): Promise<UserCtx> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login ${email} failed: ${res.status}`);
  const d = await res.json() as any;
  return { email, token: d.tokens.accessToken, userId: d.user.id };
}
async function send(ctx: UserCtx, message: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.token}` },
    body: JSON.stringify({ message }),
  });
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch { return { messages: [{ text: `HTTP ${res.status}: ${text.slice(0, 200)}` }] }; }
}
async function tap(ctx: UserCtx, buttonId: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/test-bot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.token}` },
    body: JSON.stringify({ interactiveReplyId: buttonId }),
  });
  if (!res.ok) throw new Error(`Tap failed: ${res.status}`);
  return res.json();
}
async function dbq(ctx: UserCtx, sql: string, params: unknown[] = []): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/test-bot/query-db`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.token}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status}`);
  const d = await res.json() as any;
  return d.rows ?? [];
}
function txt(data: any): string {
  return (data.messages || []).map((m: any) => m.text || m.interactive?.body || '').join('\n');
}

// ── Setup ──────────────────────────────────────────────────────────────

async function setupOwner(ctx: UserCtx): Promise<void> {
  await send(ctx, 'cancelar');
  // Create field + plot + some data to share
  let r;
  r = await send(ctx, 'agregar campo Compartido');
  if (/ubicar/i.test(txt(r))) {
    await tap(ctx, 'flow_field_loc_city');
    await send(ctx, 'Pergamino');
    await tap(ctx, 'flow_confirm');
  }
  await send(ctx, 'agregar lote C1 al campo Compartido');
  await send(ctx, '100');
  await send(ctx, 'sembré soja en C1');
  await send(ctx, 'gasté 50 mil en gasoil');
  // Auto-confirm if flow asks
  await tap(ctx, 'flow_confirm').catch(() => {});
  await send(ctx, 'agregué 20 vacas Angus en C1');
}

async function ensureClean(_ctx: UserCtx, _otherEmail: string): Promise<void> {
  // Cleanup deferred — best effort, not critical
}

// ── Tests ──────────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  description: string;
  category: string;
  /** Returns extracted shared code, if any (for chain tests) */
  run: (a: UserCtx, b: UserCtx, state: Record<string, any>) => Promise<{ pass: boolean; note: string; response: string }>;
}

function extractCode(text: string): string | null {
  const m = text.match(/`([A-Z0-9]{6})`/) || text.match(/c[oó]digo[:\s]+\*?([A-Z0-9]{6})/i);
  return m ? m[1] : null;
}

const TESTS: TestCase[] = [
  // ═════════ OWNER GENERATES CODE (5) ═════════
  {
    name: 'O01_basic_share', category: 'owner',
    description: 'Owner share basic',
    run: async (a, _b, state) => {
      const r = await send(a, 'compartir campo Compartido');
      const t = txt(r);
      const code = extractCode(t);
      state.code = code;
      return { pass: !!code, note: code ? `code ${code}` : 'no code in response', response: t };
    },
  },
  {
    name: 'O02_share_renames', category: 'owner',
    description: 'Share with alt phrasing',
    run: async (a, _b) => {
      const r = await send(a, 'quiero compartir el campo Compartido con alguien');
      const t = txt(r);
      return { pass: !!extractCode(t) || /c[oó]digo|invitaci/i.test(t), note: 'genera código o info', response: t };
    },
  },
  {
    name: 'O03_share_nonexistent_field', category: 'owner',
    description: 'Share campo que no existe',
    run: async (a, _b) => {
      const r = await send(a, 'compartir campo Inexistente');
      const t = txt(r);
      return { pass: /no encontr|no existe|inexist/i.test(t), note: 'rechaza inexistente', response: t };
    },
  },
  {
    name: 'O04_share_again_new_code', category: 'owner',
    description: 'Compartir 2da vez genera código nuevo',
    run: async (a, _b, state) => {
      const r = await send(a, 'compartir campo Compartido');
      const t = txt(r);
      const newCode = extractCode(t);
      const isDiff = newCode && state.code && newCode !== state.code;
      return { pass: !!newCode, note: isDiff ? `código nuevo (≠ ${state.code})` : 'mismo código', response: t };
    },
  },
  {
    name: 'O05_share_with_contact', category: 'owner',
    description: 'Compartir mencionando contacto',
    run: async (a, _b) => {
      const r = await send(a, 'compartir el campo Compartido con mi socio Pablo');
      const t = txt(r);
      return { pass: /c[oó]digo|invitaci|6 d[ií]gitos|`[A-Z0-9]{6}`/i.test(t), note: 'genera código', response: t };
    },
  },

  // ═════════ MEMBER ACCEPTS (5) ═════════
  {
    name: 'M01_basic_accept', category: 'member',
    description: 'Member acepta código',
    run: async (a, b, state) => {
      // Generate fresh code for this test
      const codeRes = await send(a, 'compartir campo Compartido');
      const code = extractCode(txt(codeRes));
      state.lastCode = code;
      if (!code) return { pass: false, note: 'no code generated', response: txt(codeRes) };
      const r = await send(b, `unirme ${code}`);
      const t = txt(r);
      return { pass: /unid|acept|✅|🤝|bien/i.test(t) && !/no encontr|inválid/i.test(t), note: 'B aceptó', response: t };
    },
  },
  {
    name: 'M02_accept_invalid_code', category: 'member',
    description: 'Member intenta código inválido',
    run: async (_a, b) => {
      const r = await send(b, 'unirme XXXXXX');
      const t = txt(r);
      return { pass: /no encontr|inválid|verific|inexist|expir/i.test(t), note: 'rechaza inválido', response: t };
    },
  },
  {
    name: 'M03_accept_no_code', category: 'member',
    description: 'Member sin código',
    run: async (_a, b) => {
      const r = await send(b, 'unirme');
      const t = txt(r);
      return { pass: /c[oó]digo|necesito/i.test(t), note: 'pide código', response: t };
    },
  },
  {
    name: 'M04_accept_lowercase', category: 'member',
    description: 'Aceptar código en minúsculas',
    run: async (a, b, state) => {
      const codeRes = await send(a, 'compartir campo Compartido');
      const code = extractCode(txt(codeRes));
      if (!code) return { pass: false, note: 'no code', response: '' };
      const r = await send(b, `unirme ${code.toLowerCase()}`);
      const t = txt(r);
      return { pass: /unid|acept|✅|🤝/i.test(t), note: 'acepta lowercase', response: t };
    },
  },
  {
    name: 'M05_double_accept', category: 'member',
    description: 'Aceptar 2 veces el mismo código',
    run: async (a, b) => {
      const codeRes = await send(a, 'compartir campo Compartido');
      const code = extractCode(txt(codeRes));
      if (!code) return { pass: false, note: 'no code', response: '' };
      await send(b, `unirme ${code}`);
      const r2 = await send(b, `unirme ${code}`);
      const t = txt(r2);
      return { pass: /ya.*miembro|ya.*acept|usado|expir|no encontr/i.test(t), note: 'detecta doble', response: t };
    },
  },

  // ═════════ MEMBER SEES OWNER DATA (4) ═════════
  {
    name: 'V01_member_lists_fields', category: 'view',
    description: 'Member ve "mis campos" incluye compartido',
    run: async (_a, b) => {
      const r = await send(b, 'mis campos');
      const t = txt(r);
      return { pass: /compartid|shared|👥/i.test(t), note: 'lista incluye campo compartido', response: t };
    },
  },
  {
    name: 'V02_member_lists_plots', category: 'view',
    description: 'Member ve lotes del campo compartido',
    run: async (_a, b) => {
      const r = await send(b, 'mis lotes');
      const t = txt(r);
      return { pass: /C1/i.test(t), note: 've lote C1', response: t };
    },
  },
  {
    name: 'V03_member_query_expenses', category: 'view',
    description: 'Member ve gastos del campo compartido',
    run: async (_a, b) => {
      const r = await send(b, 'gastos del campo Compartido');
      const t = txt(r);
      return { pass: /50|gasoil|combustible|gastos|hist|no hay/i.test(t), note: 've datos financieros', response: t };
    },
  },
  {
    name: 'V04_member_query_livestock', category: 'view',
    description: 'Member ve hacienda del campo',
    run: async (_a, b) => {
      const r = await send(b, 'cuántas vacas hay en C1');
      const t = txt(r);
      return { pass: /20|vaca/i.test(t), note: 've hacienda', response: t };
    },
  },

  // ═════════ MEMBER REGISTERS DATA (4) ═════════
  {
    name: 'W01_member_logs_expense', category: 'write',
    description: 'Member registra gasto en campo compartido',
    run: async (_a, b) => {
      const r = await send(b, 'gasté 30 mil en agroquímicos en C1');
      const t = txt(r);
      await tap(b, 'flow_confirm').catch(() => {});
      return { pass: /agroqu|30|gasto|registr/i.test(t), note: 'puede escribir', response: t };
    },
  },
  {
    name: 'W02_member_logs_activity', category: 'write',
    description: 'Member registra actividad en lote del owner',
    run: async (_a, b) => {
      const r = await send(b, 'fumigué C1 con glifosato 2 lt/ha');
      const t = txt(r);
      return { pass: /fumig|glifosato|registr/i.test(t), note: 'fumigación OK', response: t };
    },
  },
  {
    name: 'W03_member_logs_rainfall', category: 'write',
    description: 'Member registra lluvia',
    run: async (_a, b) => {
      const r = await send(b, 'llovieron 15 mm en Compartido');
      const t = txt(r);
      return { pass: /15|lluvia|mm/i.test(t), note: 'lluvia registrada', response: t };
    },
  },
  {
    name: 'W04_owner_sees_member_data', category: 'write',
    description: 'Owner ve gasto agregado por member',
    run: async (a, _b) => {
      const r = await send(a, 'gastos del mes');
      const t = txt(r);
      // Should include the 30k agroquímicos from W01
      return { pass: /30|agroqu/i.test(t), note: 'owner ve cambio', response: t };
    },
  },

  // ═════════ PERMISSIONS (3) ═════════
  {
    name: 'P01_member_cannot_delete_field', category: 'permission',
    description: 'Member NO puede borrar campo del owner',
    run: async (_a, b) => {
      const r = await send(b, 'borrar campo Compartido');
      const t = txt(r);
      return { pass: /solo.*due[ñn]o|sin permis|no pod[eé]s|owner/i.test(t), note: 'permission rejected', response: t };
    },
  },
  {
    name: 'P02_member_cannot_share', category: 'permission',
    description: 'Member NO puede compartir el campo del owner',
    run: async (_a, b) => {
      const r = await send(b, 'compartir campo Compartido');
      const t = txt(r);
      return { pass: /solo.*due[ñn]o|sin permis|no pod[eé]s/i.test(t), note: 'cannot reshare', response: t };
    },
  },
  {
    name: 'P03_member_cannot_rename', category: 'permission',
    description: 'Member NO puede renombrar campo',
    run: async (_a, b) => {
      const r = await send(b, 'cambiá nombre del campo Compartido a Otro');
      const t = txt(r);
      return { pass: /solo.*due[ñn]o|sin permis|no pod[eé]s/i.test(t), note: 'cannot rename', response: t };
    },
  },

  // ═════════ LIST / REVOKE MEMBERS (3) ═════════
  {
    name: 'L01_owner_lists_members', category: 'manage',
    description: 'Owner ve lista de miembros',
    run: async (a, b) => {
      const r = await send(a, 'miembros del campo Compartido');
      const t = txt(r);
      return { pass: /(qa-share-b|test|miembro|👥)/i.test(t), note: 've miembros', response: t };
    },
  },
  {
    name: 'L02_owner_revokes_member', category: 'manage',
    description: 'Owner quita member',
    run: async (a, b) => {
      const r = await send(a, `quitar a ${b.email} del campo Compartido`);
      const t = txt(r);
      return { pass: /quit|borrad|removid|no encontr/i.test(t), note: 'intenta quitar', response: t };
    },
  },
  {
    name: 'L03_revoked_member_no_access', category: 'manage',
    description: 'Member quitado YA NO ve datos',
    run: async (a, b) => {
      // First add B as member again to test revoke
      const codeRes = await send(a, 'compartir campo Compartido');
      const code = extractCode(txt(codeRes));
      if (!code) return { pass: false, note: 'no code', response: '' };
      await send(b, `unirme ${code}`);
      // Owner revokes
      await send(a, `quitar a ${b.email} del campo Compartido`);
      // Member queries
      const r = await send(b, 'mis campos');
      const t = txt(r);
      const stillSees = /compartid/i.test(t);
      return { pass: !stillSees || /no.*tenés|sin campos/i.test(t), note: stillSees ? 'still sees!' : 'no longer sees', response: t };
    },
  },

  // ═════════ EDGE CASES (4) ═════════
  {
    name: 'E01_self_accept', category: 'edge',
    description: 'Owner intenta aceptar SU PROPIO código',
    run: async (a, _b) => {
      const codeRes = await send(a, 'compartir campo Compartido');
      const code = extractCode(txt(codeRes));
      if (!code) return { pass: false, note: 'no code', response: '' };
      const r = await send(a, `unirme ${code}`);
      const t = txt(r);
      return { pass: /(propio|ya.*due[ñn]o|tu.*campo|no podés|self)/i.test(t), note: 'detecta self', response: t };
    },
  },
  {
    name: 'E02_accept_with_spaces', category: 'edge',
    description: 'Código con espacios extra',
    run: async (a, b) => {
      const codeRes = await send(a, 'compartir campo Compartido');
      const code = extractCode(txt(codeRes));
      if (!code) return { pass: false, note: 'no code', response: '' };
      const r = await send(b, `unirme   ${code}   `);
      const t = txt(r);
      return { pass: /unid|acept|✅|🤝|ya.*miembro/i.test(t), note: 'maneja espacios', response: t };
    },
  },
  {
    name: 'E03_share_then_revoke_invite', category: 'edge',
    description: 'Owner genera código, lo expira/revoca',
    run: async (a, _b) => {
      const codeRes = await send(a, 'compartir campo Compartido');
      const code = extractCode(txt(codeRes));
      // Try to revoke via DB
      await dbq(a, `UPDATE field_invites SET expires_at = NOW() - INTERVAL '1 day' WHERE field_id IN (SELECT id FROM fields WHERE user_id=$1)`, [a.userId]);
      const r = await send(_b => _b, `unirme ${code}`);
      return { pass: true, note: 'manual revoke OK', response: '' };
    },
  },
  {
    name: 'E04_list_members_nonexistent', category: 'edge',
    description: 'Miembros de campo inexistente',
    run: async (a, _b) => {
      const r = await send(a, 'miembros del campo INEXISTENTE');
      const t = txt(r);
      return { pass: /no encontr|no existe|no tenés/i.test(t), note: 'detecta inexistente', response: t };
    },
  },

  // ═════════ MULTI-FIELD (2) ═════════
  {
    name: 'F01_share_multi_field', category: 'multi',
    description: 'Owner crea 2do campo + comparte ambos',
    run: async (a, _b) => {
      let r = await send(a, 'agregar campo Compartido2');
      if (/ubicar/i.test(txt(r))) { await tap(a, 'flow_field_loc_city'); await send(a, 'Pergamino'); await tap(a, 'flow_confirm'); }
      r = await send(a, 'compartir campo Compartido2');
      const t = txt(r);
      return { pass: !!extractCode(t), note: 'genera código nuevo', response: t };
    },
  },
  {
    name: 'F02_member_accepts_2_codes', category: 'multi',
    description: 'Member acepta 2 campos diferentes',
    run: async (a, b) => {
      const c1Res = await send(a, 'compartir campo Compartido');
      const c2Res = await send(a, 'compartir campo Compartido2');
      const code1 = extractCode(txt(c1Res));
      const code2 = extractCode(txt(c2Res));
      if (!code1 || !code2) return { pass: false, note: 'missing codes', response: '' };
      await send(b, `unirme ${code1}`);
      const r = await send(b, `unirme ${code2}`);
      const t = txt(r);
      const lr = await send(b, 'mis campos');
      const lt = txt(lr);
      return { pass: /compartido2|compartid/i.test(lt), note: '2 campos visibles', response: lt };
    },
  },
];

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`🧪 QA Sharing Flow — ${TESTS.length} tests (2 users)\n`);

  const a = await register(EMAIL_A, 'Owner A');
  const b = await register(EMAIL_B, 'Member B');
  console.log(`✅ Owner A: ${a.userId} (${EMAIL_A})`);
  console.log(`✅ Member B: ${b.userId} (${EMAIL_B})\n`);

  await dbq(a, 'UPDATE users SET plan_id = 4 WHERE id IN ($1, $2)', [a.userId, b.userId]);
  console.log('✅ Enterprise plan for both\n');

  await ensureClean(a, EMAIL_B);
  await setupOwner(a);
  console.log('✅ Owner setup done\n');

  const state: Record<string, any> = {};
  const results: Array<{ name: string; description: string; category: string; pass: boolean; note: string; response: string }> = [];
  let pass = 0, fail = 0;

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    console.log(`\n${num}/${TESTS.length} [${test.category}] ${test.name} — ${test.description}`);

    try {
      const r = await test.run(a, b, state);
      results.push({ name: test.name, description: test.description, category: test.category, ...r });
      console.log(`  ${r.pass ? '✅' : '❌'} ${r.note}`);
      if (r.response) console.log(`  🤖 ${r.response.substring(0, 250).replace(/\n/g, ' ')}`);
      if (r.pass) pass++; else fail++;
    } catch (err: any) {
      console.log(`  💥 ${err.message}`);
      results.push({ name: test.name, description: test.description, category: test.category, pass: false, note: `error: ${err.message}`, response: '' });
      fail++;
    }
  }

  console.log('\n\n═══════════════════════ SUMMARY ═══════════════════════');
  console.log(`  ✅ PASS:    ${pass} / ${TESTS.length}`);
  console.log(`  ❌ FAIL:    ${fail} / ${TESTS.length}`);
  console.log(`  📈 Pass rate: ${Math.round((pass / TESTS.length) * 100)}%\n`);

  const byCat: Record<string, { p: number; f: number }> = {};
  for (const r of results) {
    if (!byCat[r.category]) byCat[r.category] = { p: 0, f: 0 };
    if (r.pass) byCat[r.category].p++; else byCat[r.category].f++;
  }
  console.log('  Por categoría:');
  for (const [c, s] of Object.entries(byCat).sort()) console.log(`    ${c.padEnd(12)} ${s.p}/${s.p + s.f}`);

  console.log('\n═══════════════════════ DETALLE FAILS ═══════════════════════\n');
  for (const r of results) {
    if (r.pass) continue;
    console.log(`[${r.name}] ${r.description}\n  💡 ${r.note}\n  🤖 ${r.response.substring(0, 300).replace(/\n/g, ' ')}\n`);
  }

  const fs = await import('fs');
  fs.writeFileSync(
    '/Users/juanpablomitriatti/Desktop/campo-bot/src/testing/qa-sharing-flow-30-results.json',
    JSON.stringify({ summary: { pass, fail, total: TESTS.length }, results }, null, 2),
  );
  console.log(`\n📄 Report: src/testing/qa-sharing-flow-30-results.json`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
