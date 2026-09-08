import { describe, it, expect } from 'vitest';
import { DEFAULT_WHISPER_PROMPT } from '../audio.types.js';

/**
 * Whisper usa el prompt como "transcripción previa" y con un audio corto lo copia.
 * En prod (8 sep 2026) el prompt decía "compré diez vaquillonas ... 500 mil por
 * cabeza" y un audio que decía "compré yerba" salió "Compré 10 novillas por 500":
 * se registró un grupo de 10 vaquillonas y un gasto de $5.000.000 inventados.
 * Un prompt sin números no puede fabricar cantidades ni precios.
 */
// \b es ASCII en JS: "milímetros" haría match con \bmil\b. Lookarounds Unicode.
const NUMBER_WORDS =
  /(?<!\p{L})(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|quinientos|mil|millón|millones|medio|media|docena)(?!\p{L})/iu;

describe('DEFAULT_WHISPER_PROMPT — sin cantidades ni precios', () => {
  it('no contiene dígitos', () => {
    expect(DEFAULT_WHISPER_PROMPT).not.toMatch(/\d/);
  });

  it('no contiene números escritos en palabras', () => {
    const m = DEFAULT_WHISPER_PROMPT.match(NUMBER_WORDS);
    expect(m, `número en el prompt: "${m?.[0]}"`).toBeNull();
  });

  it('no contiene símbolos de moneda ni "por cabeza"', () => {
    expect(DEFAULT_WHISPER_PROMPT).not.toMatch(/\$|usd|u\$s|por cabeza|c\/u|cada un/i);
  });

  it('sigue llevando el vocabulario de hacienda y de insumos que Whisper mangla', () => {
    for (const w of ['vaquillonas', 'novillos', 'desteté', 'parieron', 'IATF', 'aftosa', 'glifosato', 'yerba']) {
      expect(DEFAULT_WHISPER_PROMPT).toContain(w);
    }
  });

  it('se mantiene corto (< 900 chars ≈ 220 tokens)', () => {
    expect(DEFAULT_WHISPER_PROMPT.length).toBeLessThan(900);
  });
});
