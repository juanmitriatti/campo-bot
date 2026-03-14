import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioDownloadService } from '../audio-download.service.js';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

describe('AudioDownloadService', () => {
  let service: AudioDownloadService;

  beforeEach(() => {
    service = new AudioDownloadService();
    vi.clearAllMocks();
  });

  describe('download', () => {
    it('downloads media via two-step WhatsApp API flow', async () => {
      const axios = (await import('axios')).default;
      const mockedGet = vi.mocked(axios.get);

      // Step 1: Get media URL
      mockedGet.mockResolvedValueOnce({
        data: { url: 'https://media.whatsapp.com/file123' },
      });
      // Step 2: Download binary
      mockedGet.mockResolvedValueOnce({
        data: Buffer.from('audio-data'),
      });

      const result = await service.download('media-123', 'audio/ogg; codecs=opus');

      expect(result.mediaId).toBe('media-123');
      expect(result.mimeType).toBe('audio/ogg; codecs=opus');
      expect(result.buffer).toEqual(Buffer.from('audio-data'));
      expect(result.sizeBytes).toBe(10);

      // Verify two API calls
      expect(mockedGet).toHaveBeenCalledTimes(2);
      expect(mockedGet.mock.calls[0][0]).toContain('media-123');
      expect(mockedGet.mock.calls[1][0]).toBe('https://media.whatsapp.com/file123');
    });
  });

  describe('estimateDurationSeconds', () => {
    it('estimates duration from bytes (~2KB per second)', () => {
      expect(service.estimateDurationSeconds(2000)).toBe(1);
      expect(service.estimateDurationSeconds(10000)).toBe(5);
      expect(service.estimateDurationSeconds(60000)).toBe(30);
    });
  });

  describe('isAudioTooLong', () => {
    it('returns false for short audio', () => {
      // 5000 bytes ≈ 3 seconds, well under 120s default
      expect(service.isAudioTooLong(5000)).toBe(false);
    });

    it('returns true for very long audio', () => {
      // 300000 bytes ≈ 150 seconds, over 120s default
      expect(service.isAudioTooLong(300000)).toBe(true);
    });
  });
});
