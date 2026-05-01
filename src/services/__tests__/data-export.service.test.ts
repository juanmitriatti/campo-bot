import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '../../types/index.js';
import { Readable, Writable } from 'stream';

const mockQuery = vi.fn();
vi.mock('../../config/db.js', () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
}));

import { DataExportService } from '../data-export.service.js';

/**
 * Pretend Express Response — captures buffers so we can assert on the resulting ZIP.
 */
function makeFakeRes() {
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  let ended = false;
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  }) as unknown as import('express').Response & { _ended: () => boolean; _chunks: Buffer[]; _headers: Record<string, string> };
  (res as any).setHeader = (k: string, v: string) => { headers[k.toLowerCase()] = v; };
  (res as any).getHeader = (k: string) => headers[k.toLowerCase()];
  (res as any).headersSent = false;
  // capture .end()
  const origEnd = res.end.bind(res);
  res.end = ((...args: any[]) => { ended = true; return origEnd(...args); }) as any;
  (res as any)._ended = () => ended;
  (res as any)._chunks = chunks;
  (res as any)._headers = headers;
  return res as unknown as import('express').Response & { _ended: () => boolean; _chunks: Buffer[]; _headers: Record<string, string> };
}

describe('DataExportService.streamUserExport', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('streams a ZIP with correct headers and the expected entries', async () => {
    // Default: every per-table query returns empty rows. The user lookup returns a stub row.
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM users WHERE id/.test(sql)) {
        return {
          rows: [{
            id: 1, name: 'Juan', last_name: null, email: 'j@b.com', role: 'end_user',
            city: 'Pergamino', province: 'Buenos Aires',
            phone_number: '+541155123456', telegram_id: null,
            whatsapp_verified_at: null, telegram_verified_at: null,
          }],
        };
      }
      if (/FROM plans p JOIN users u/.test(sql)) {
        return { rows: [{ id: 1, name: 'free', display_name: 'Gratis' }] };
      }
      // All per-domain queries return empty rows
      return { rows: [] };
    });

    const svc = new DataExportService();
    const res = makeFakeRes();
    await svc.streamUserExport(1 as UserId, res);

    // wait one tick for stream finalize
    await new Promise(r => setTimeout(r, 30));

    expect(res._headers['content-type']).toBe('application/zip');
    expect(res._headers['content-disposition']).toMatch(/attachment.*\.zip"$/);

    const buf = Buffer.concat(res._chunks);
    expect(buf.length).toBeGreaterThan(50);
    // ZIP magic bytes
    expect(buf.slice(0, 2).toString()).toBe('PK');

    // The ZIP should contain README.txt and metadata.json names somewhere in the central directory
    const text = buf.toString('utf8');
    expect(text).toContain('README.txt');
    expect(text).toContain('metadata.json');
    expect(text).toContain('expenses.csv');
    expect(text).toContain('fields.csv');
    expect(text).toContain('livestock_groups.csv');
  });

  it('continues when a single table query fails (logs but does not abort)', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM users WHERE id/.test(sql)) {
        return { rows: [{ id: 1, name: 'X', email: null, role: 'end_user' }] };
      }
      if (/FROM plans p/.test(sql)) return { rows: [] };
      // Make ONE specific table query fail
      if (/FROM crop_scoutings/.test(sql)) {
        throw new Error('table missing in test DB');
      }
      return { rows: [] };
    });

    const svc = new DataExportService();
    const res = makeFakeRes();
    // Should NOT throw — the failing table is replaced with an error stub.
    await expect(svc.streamUserExport(1 as UserId, res)).resolves.toBeUndefined();

    await new Promise(r => setTimeout(r, 30));
    const text = Buffer.concat(res._chunks).toString('utf8');
    expect(text).toContain('scoutings.csv'); // still present (with error stub)
  });
});
