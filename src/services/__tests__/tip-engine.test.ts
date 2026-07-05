/**
 * Tips contextuales — catálogo (sanidad) + motor (elegibilidad, tope diario,
 * once-ever, opt-out, feature gate) + regex de opt-out del parser.
 * La parte de motor requiere DB (se saltea sin ella).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TIPS_CATALOG } from '../tips-catalog.js';
import { TOOL_NAMES } from '../../ai/tool-definitions.js';
import { parseCommand } from '../../utils/parser.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe('TIPS_CATALOG — sanidad', () => {
  it('keys únicas y estables', () => {
    const keys = TIPS_CATALOG.map(t => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z_]+$/);
  });

  it('todos los triggerCommands son tools/comandos reales', () => {
    // Comandos del router que no son tools del agente (regex-only) permitidos acá:
    const NON_TOOL_COMMANDS = new Set<string>([]);
    for (const tip of TIPS_CATALOG) {
      expect(tip.triggerCommands.length).toBeGreaterThan(0);
      for (const cmd of tip.triggerCommands) {
        expect(
          TOOL_NAMES.has(cmd) || NON_TOOL_COMMANDS.has(cmd),
          `trigger desconocido "${cmd}" en tip "${tip.key}" — ¿typo? El tip jamás se mostraría`,
        ).toBe(true);
      }
    }
  });

  it('todos los textos empiezan con 💡 y son de una sola idea (sin \\n)', () => {
    for (const tip of TIPS_CATALOG) {
      expect(tip.text.startsWith('💡'), tip.key).toBe(true);
      expect(tip.text.includes('\n'), `tip "${tip.key}" tiene salto de línea`).toBe(false);
    }
  });
});

describe('parser — opt-out/in de tips', () => {
  it('variantes de opt-out', () => {
    for (const t of ['no me des más tips', 'no quiero mas consejos', 'no más tips', 'sacame los tips', 'apagá los consejos']) {
      expect(parseCommand(t)?.command, t).toBe('disable_tips');
    }
  });
  it('opt-in', () => {
    for (const t of ['dame tips de nuevo', 'quiero los consejos', 'activá los tips']) {
      expect(parseCommand(t)?.command, t).toBe('enable_tips');
    }
  });
  it('no roba frases normales', () => {
    expect(parseCommand('no me des más trabajo')?.command).not.toBe('disable_tips');
    expect(parseCommand('dame el reporte')?.command).not.toBe('enable_tips');
  });
});

describe.skipIf(!dbAvailable)('TipEngine — reglas con DB', () => {
  let pool: typeof import('../../config/db.js').pool;
  let engine: import('../tip-engine.js').TipEngine;
  let userId: number;
  const CMD = { command: 'log_expense' } as import('../../types/index.js').ParsedCommand;
  const OK_RESPONSE = { messages: ['✅ Gasto registrado'] } as import('../../types/index.js').HandlerResponse;
  const USER = { id: 0, phone_number: '5491100000001', name: 'Tip Test', city: null } as unknown as import('../../types/index.js').User;

  beforeAll(async () => {
    ({ pool } = await import('../../config/db.js'));
    const { TipEngine } = await import('../tip-engine.js');
    const { FeatureGate } = await import('../../domain/billing/feature-gate.js');
    engine = new TipEngine(new FeatureGate());
    await pool.query(`DELETE FROM users WHERE email = 'tip-engine@test.local'`);
    const u = await pool.query(`INSERT INTO users (name, email, password_hash, plan_id) VALUES ('TipTest','tip-engine@test.local','x',4) RETURNING id`);
    userId = u.rows[0].id;
    await pool.query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('TIPS_ENABLED','true'), ('TIPS_MAX_PER_DAY','1')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it('primer gasto → tip con pie de opt-out; segundo intento mismo día → nada (tope diario)', async () => {
    const tip1 = await engine.maybeGetTip(CMD, OK_RESPONSE, userId, USER);
    expect(tip1).toBeTruthy();
    expect(tip1).toContain('💡');
    expect(tip1).toContain('no más tips'); // pie de opt-out en el primero

    const tip2 = await engine.maybeGetTip(CMD, OK_RESPONSE, userId, USER);
    expect(tip2).toBeNull(); // tope 1/día
  });

  it('al día siguiente muestra OTRO tip (nunca repite)', async () => {
    const shown = await pool.query(`SELECT tips_shown FROM user_settings WHERE user_id = $1`, [userId]);
    const firstKey = (shown.rows[0].tips_shown as string[])[0];
    // Simular que el último tip fue ayer
    await pool.query(`UPDATE user_settings SET last_tip_date = CURRENT_DATE - 1 WHERE user_id = $1`, [userId]);
    const tip = await engine.maybeGetTip(CMD, OK_RESPONSE, userId, USER);
    expect(tip).toBeTruthy();
    expect(tip).not.toContain('no más tips'); // el pie va solo en el primero
    const after = await pool.query(`SELECT tips_shown FROM user_settings WHERE user_id = $1`, [userId]);
    const keys = after.rows[0].tips_shown as string[];
    expect(keys.length).toBe(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe(firstKey);
  });

  it('opt-out del usuario → nada', async () => {
    await pool.query(`UPDATE user_settings SET tips_enabled = FALSE, last_tip_date = CURRENT_DATE - 1 WHERE user_id = $1`, [userId]);
    expect(await engine.maybeGetTip(CMD, OK_RESPONSE, userId, USER)).toBeNull();
    await pool.query(`UPDATE user_settings SET tips_enabled = TRUE WHERE user_id = $1`, [userId]);
  });

  it('respuestas NO exitosas nunca disparan tip', async () => {
    await pool.query(`UPDATE user_settings SET last_tip_date = CURRENT_DATE - 1 WHERE user_id = $1`, [userId]);
    const cases: Array<import('../../types/index.js').HandlerResponse> = [
      { messages: ['❌ No pude registrar el gasto'] },
      { messages: ['¿En qué lote lo registramos?'] },
      { messages: ['No encontré el lote Norte.'] },
      { messages: ['✅ ok'], sideEffects: { setPendingActivity: { command: 'x', data: {} } } },
    ];
    for (const r of cases) {
      expect(await engine.maybeGetTip(CMD, r, userId, USER), JSON.stringify(r.messages)).toBeNull();
    }
  });

  it('usuarios testbot_ excluidos (no contaminar eval/QA)', async () => {
    await pool.query(`UPDATE user_settings SET last_tip_date = CURRENT_DATE - 1 WHERE user_id = $1`, [userId]);
    const testUser = { ...USER, phone_number: 'testbot_999' } as import('../../types/index.js').User;
    expect(await engine.maybeGetTip(CMD, OK_RESPONSE, userId, testUser)).toBeNull();
  });

  it('bulkMode (compound) excluido', async () => {
    const bulkCmd = { command: 'log_expense', _bulkMode: true } as unknown as import('../../types/index.js').ParsedCommand;
    expect(await engine.maybeGetTip(bulkCmd, OK_RESPONSE, userId, USER)).toBeNull();
  });

  it('comando sin tips en catálogo → null sin tocar DB', async () => {
    const cmd = { command: 'greeting' } as import('../../types/index.js').ParsedCommand;
    expect(await engine.maybeGetTip(cmd, OK_RESPONSE, userId, USER)).toBeNull();
  });
});
