import { describe, it, expect, beforeEach } from 'vitest';
import { callbackPayloadStore, runWithCallbackOwner } from '../callback-payload-store.js';
import { consumeOnce, isOneShotCallback, _resetOneShotCallbacks } from '../one-shot-callbacks.js';

describe('callbackPayloadStore', () => {
  beforeEach(() => {
    callbackPayloadStore._clear();
  });

  it('round-trips a payload', () => {
    const payload = 'eyJhIjoxLCJjIjoiQVJTIn0';
    const token = callbackPayloadStore.set(payload);
    expect(token.length).toBeLessThanOrEqual(12);
    expect(callbackPayloadStore.get(token)).toBe(payload);
  });

  it('returns null for unknown token', () => {
    expect(callbackPayloadStore.get('nonexistent')).toBeNull();
  });

  it('produces unique tokens for different payloads', () => {
    const t1 = callbackPayloadStore.set('payload-A');
    const t2 = callbackPayloadStore.set('payload-B');
    expect(t1).not.toBe(t2);
  });

  it('token + cat_pick_exp_ prefix fits in Telegram 64-byte limit', () => {
    // Worst-case: token + 13 char prefix + _<categoryId up to 6 digits>
    const token = callbackPayloadStore.set('a-very-long-payload-that-is-200-chars-long-base64url-encoded'.repeat(5));
    const callbackData = `cat_pick_exp_${token}_999999`;
    expect(Buffer.byteLength(callbackData)).toBeLessThanOrEqual(64);
  });

  it('returns null after TTL (simulated via _clear)', () => {
    const token = callbackPayloadStore.set('test');
    callbackPayloadStore._clear();
    expect(callbackPayloadStore.get(token)).toBeNull();
  });
});

// Auditoría oct 2026 (AIS-1): un token solo lo resuelve el usuario al que se
// le mandó el botón.
describe('callbackPayloadStore — dueño del token', () => {
  beforeEach(() => callbackPayloadStore._clear());

  it('el dueño lo resuelve; otro usuario no', () => {
    const token = runWithCallbackOwner(1, () => callbackPayloadStore.set('payload-de-1'));
    expect(runWithCallbackOwner(1, () => callbackPayloadStore.get(token))).toBe('payload-de-1');
    expect(runWithCallbackOwner(2, () => callbackPayloadStore.get(token))).toBeNull();
  });

  it('un token creado fuera de contexto (cron, formulario) no queda atado', () => {
    const token = callbackPayloadStore.set('libre');
    expect(runWithCallbackOwner(2, () => callbackPayloadStore.get(token))).toBe('libre');
  });
});

// HAC-9 / CONV-3: todas las opciones de un mismo teclado comparten el token y
// se consume el token, no el botón.
describe('taps de un solo uso por token', () => {
  beforeEach(() => _resetOneShotCallbacks());

  it('[En un lote] y [En un feedlot] del mismo teclado: vale solo el primero', () => {
    expect(isOneShotCallback('lv_loc_lote_AbCd1234')).toBe(true);
    expect(consumeOnce(7, 'lv_loc_lote_AbCd1234')).toBe(true);
    expect(consumeOnce(7, 'lv_loc_feedlot_AbCd1234')).toBe(false);
  });

  it('elegir otra ubicación del mismo picker de sanidad no repite el evento', () => {
    expect(consumeOnce(7, 'lv_pick_loc_health_Zz_9-xyz_10_null')).toBe(true);
    expect(consumeOnce(7, 'lv_pick_loc_health_Zz_9-xyz_11_null')).toBe(false);
  });

  it('[Moverlos] dos veces = un traslado; otro usuario no consume el del primero', () => {
    expect(consumeOnce(7, 'lv_move_yes_Mv000001')).toBe(true);
    expect(consumeOnce(7, 'lv_move_yes_Mv000001')).toBe(false);
    expect(consumeOnce(8, 'lv_move_yes_Mv000001')).toBe(true);
  });

  it('un teclado distinto (otro token) sí vale', () => {
    expect(consumeOnce(7, 'lv_loc_lote_AAAAAAAA')).toBe(true);
    expect(consumeOnce(7, 'lv_loc_lote_BBBBBBBB')).toBe(true);
  });
});

