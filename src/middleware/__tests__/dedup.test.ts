import { describe, it, expect } from 'vitest';
import { MessageDedup } from '../dedup.js';

describe('MessageDedup', () => {
  it('flags a repeat of the same id', () => {
    const d = new MessageDedup();
    expect(d.isDuplicate('u1')).toBe(false);
    expect(d.isDuplicate('u1')).toBe(true);
    expect(d.isDuplicate('u2')).toBe(false);
  });
  it('catches a fast retry (57ms) with other traffic interleaved', () => {
    const d = new MessageDedup(10_000);
    expect(d.isDuplicate('target', 0)).toBe(false);
    for (let i = 0; i < 50; i++) d.isDuplicate('id' + i, 1 + i);
    expect(d.isDuplicate('target', 57)).toBe(true); // the real double-delivery window
  });
  it('forgets an id after the TTL', () => {
    const d = new MessageDedup(1000);
    expect(d.isDuplicate('x', 0)).toBe(false);
    expect(d.isDuplicate('x', 2000)).toBe(false);
  });
});
