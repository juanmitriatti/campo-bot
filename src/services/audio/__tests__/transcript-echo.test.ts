import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildTranscriptEcho } from '../transcript-echo.js';
import * as settings from '../../settings.service.js';

describe('buildTranscriptEcho (R3.4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('con el setting ON (default) devuelve el eco con el texto', async () => {
    vi.spyOn(settings, 'getSettingBool').mockResolvedValue(true);
    const echo = await buildTranscriptEcho('gasté 50 mil en gasoil');
    expect(echo).toContain('🎙️');
    expect(echo).toContain('gasté 50 mil en gasoil');
  });

  it('con AUDIO_ECHO_TRANSCRIPT=false devuelve null', async () => {
    vi.spyOn(settings, 'getSettingBool').mockResolvedValue(false);
    expect(await buildTranscriptEcho('lo que sea')).toBeNull();
  });

  it('transcripción vacía o solo espacios → null (no mandar eco vacío)', async () => {
    vi.spyOn(settings, 'getSettingBool').mockResolvedValue(true);
    expect(await buildTranscriptEcho('')).toBeNull();
    expect(await buildTranscriptEcho('   ')).toBeNull();
  });

  it('trunca transcripciones largas a ~220 chars con elipsis', async () => {
    vi.spyOn(settings, 'getSettingBool').mockResolvedValue(true);
    const long = 'a'.repeat(500);
    const echo = await buildTranscriptEcho(long);
    expect(echo).toContain('…');
    expect((echo as string).length).toBeLessThan(260);
  });
});
