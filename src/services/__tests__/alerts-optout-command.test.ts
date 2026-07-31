import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../utils/parser.js';

describe('parser — opt-out/in de alertas proactivas', () => {
  it('variantes de opt-out', () => {
    for (const t of ['no más alertas', 'no me mandes más alertas', 'no quiero más avisos', 'apagá las alertas', 'sacame los avisos']) {
      expect(parseCommand(t)?.command, t).toBe('disable_alerts');
    }
  });
  it('opt-in', () => {
    for (const t of ['dame alertas de nuevo', 'quiero las alertas', 'activá los avisos']) {
      expect(parseCommand(t)?.command, t).toBe('enable_alerts');
    }
  });
  it('no roba frases normales ni las de tips', () => {
    expect(parseCommand('registrá 50mil de gasoil')?.command).not.toBe('disable_alerts');
    expect(parseCommand('no más tips')?.command).toBe('disable_tips');
    expect(parseCommand('avisos')?.command).not.toBe('enable_alerts');
  });
});
