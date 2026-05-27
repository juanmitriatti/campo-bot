import { describe, it, expect, beforeEach } from 'vitest';
import { callbackPayloadStore } from '../callback-payload-store.js';

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
