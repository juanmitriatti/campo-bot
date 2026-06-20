import { describe, it, expect } from 'vitest';
import { InteractiveRouter } from '../interactive.router.js';
import { callbackPayloadStore } from '../../../middleware/callback-payload-store.js';

describe('InteractiveRouter — weather city picker (wcity_)', () => {
  const router = new InteractiveRouter();

  it('decodes a wcity token into weather_full with city + province', () => {
    const token = callbackPayloadStore.set(JSON.stringify({ c: 'Florentino Ameghino', p: 'Buenos Aires' }));
    const intent = router.route(`wcity_${token}`);
    expect(intent).not.toBeNull();
    expect(intent!.type).toBe('command');
    if (intent!.type === 'command') {
      expect(intent!.data.command).toBe('weather_full');
      expect(intent!.data.city).toBe('Florentino Ameghino');
      expect(intent!.data.province).toBe('Buenos Aires');
    }
  });

  it('returns null for an unknown/expired token (no silent wrong city)', () => {
    expect(router.route('wcity_doesnotexist')).toBeNull();
  });

  it('returns null when the stored payload is malformed', () => {
    const token = callbackPayloadStore.set('not-json');
    expect(router.route(`wcity_${token}`)).toBeNull();
  });
});
