import { describe, it, expect } from 'vitest';
import { encodeLivestockPayload, decodeLivestockPayload } from '../livestock-payload.js';
import type { LivestockPendingPayload } from '../livestock-payload.js';

describe('livestock-payload', () => {
  it('round-trips a minimal payload', () => {
    const p: LivestockPendingPayload = {
      cmd: { command: 'log_health_event', healthType: 'vacunacion' as unknown as string } as any,
      step: 'pick_loc',
    };
    const b64 = encodeLivestockPayload(p);
    const out = decodeLivestockPayload(b64);
    expect(out).toEqual(p);
  });

  it('round-trips with full context', () => {
    const p: LivestockPendingPayload = {
      cmd: { command: 'log_weighing', avgWeightKg: 380, animalCategory: 'novillo' } as any,
      step: 'animals',
      resolvedLocation: { plotId: null, corralId: 5, label: 'Corral 1' },
      knownGroupCount: 47,
    };
    const b64 = encodeLivestockPayload(p);
    const out = decodeLivestockPayload(b64);
    expect(out).toEqual(p);
  });

  it('payload is URL-safe (no +, /, =)', () => {
    const p: LivestockPendingPayload = {
      cmd: { command: 'add_livestock', count: 30 } as any,
      step: 'create_loc',
      missingType: 'corral',
      missingName: 'Norte',
    };
    const b64 = encodeLivestockPayload(p);
    expect(b64).not.toMatch(/[+/=]/);
  });
});
