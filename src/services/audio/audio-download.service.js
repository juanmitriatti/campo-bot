import axios from 'axios';
import { getAudioConfig } from './audio.types.js';

const GRAPH_API_BASE = 'https://graph.facebook.com/v22.0';

// Approximate bytes-per-second for opus audio (~2 KB/s)
const OPUS_BYTES_PER_SECOND = 2000;

export class AudioDownloadService {
  /**
   * Download media from WhatsApp Cloud API.
   * Two-step process: get media URL, then download binary.
   */
  async download(mediaId, mimeType) {
    const token = process.env.WHATSAPP_TOKEN;
    const authHeader = { Authorization: `Bearer ${token}` };

    // Step 1: Get media URL
    const meta = await axios.get(`${GRAPH_API_BASE}/${mediaId}`, {
      headers: authHeader,
    });

    // Step 2: Download binary
    const response = await axios.get(meta.data.url, {
      headers: authHeader,
      responseType: 'arraybuffer',
    });

    const buffer = Buffer.from(response.data);

    return {
      mediaId,
      mimeType,
      buffer,
      sizeBytes: buffer.length,
    };
  }

  /**
   * Estimate audio duration from buffer size.
   */
  estimateDurationSeconds(sizeBytes) {
    return Math.ceil(sizeBytes / OPUS_BYTES_PER_SECOND);
  }

  /**
   * Check if audio exceeds the maximum allowed duration.
   */
  isAudioTooLong(sizeBytes) {
    const config = getAudioConfig();
    return this.estimateDurationSeconds(sizeBytes) > config.maxAudioDurationSeconds;
  }
}
