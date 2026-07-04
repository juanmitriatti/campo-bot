import { describe, it, expect } from 'vitest';
import { livestockLocationIntent } from '../livestock-location-intent.js';

describe('livestockLocationIntent', () => {
  it('ambiguo: menciona lote Y feedlot', () => {
    expect(livestockLocationIntent('y tengo 50 vacas, no sé si van en un lote o en un feedlot')).toBe('ambiguous');
    expect(livestockLocationIntent('las pongo en un lote o en el corral?')).toBe('ambiguous');
  });

  it('ambiguo: feedlot + duda explícita', () => {
    expect(livestockLocationIntent('no sé, capaz al feedlot')).toBe('ambiguous');
  });

  it('feedlot: feedlot/corral/engorde sin lote', () => {
    expect(livestockLocationIntent('ponelas en el feedlot')).toBe('feedlot');
    expect(livestockLocationIntent('van a engorde a corral')).toBe('feedlot');
    expect(livestockLocationIntent('meté las vacas en un corral')).toBe('feedlot');
    expect(livestockLocationIntent('arranco el encierre con 100 novillos')).toBe('feedlot');
  });

  it('lote: lote/potrero sin feedlot', () => {
    expect(livestockLocationIntent('ponelas en un potrero')).toBe('lote');
    expect(livestockLocationIntent('en el lote norte')).toBe('lote');
  });

  it('none: sin señal de ubicación', () => {
    expect(livestockLocationIntent('tengo 50 vacas')).toBe('none');
    expect(livestockLocationIntent('compré 30 novillos angus')).toBe('none');
    expect(livestockLocationIntent('')).toBe('none');
    expect(livestockLocationIntent(null)).toBe('none');
  });

  it('acentos / mayúsculas no afectan', () => {
    expect(livestockLocationIntent('NO SÉ si LOTE o FEEDLOT')).toBe('ambiguous');
    expect(livestockLocationIntent('Engordé a corral')).toBe('feedlot');
  });
});
