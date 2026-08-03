import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../../config/db.js', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

const { formSessionService } = await import('../form-session.service.js');

describe('FormSessionService', () => {
  beforeEach(() => queryMock.mockReset());

  it('create inserta con token hex de 32 chars y expiración', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const token = await formSessionService.create({
      userId: 1, action: 'sow_crop', prefill: { plotName: 'Norte' },
      channel: 'telegram', channelId: '123', phone: 'tg_123', hadPending: true,
    });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO form_sessions');
    expect(params[0]).toBe(token);
    expect(params[1]).toBe(1);
    expect(params[2]).toBe('sow_crop');
    expect(JSON.parse(params[3])).toEqual({ plotName: 'Norte' });
    expect(params[4]).toBe('telegram');
    expect(params[5]).toBe('123');
    expect(params[6]).toBe('tg_123');
    expect(params[7]).toBe(true); // had_pending
    expect(params[8]).toBeInstanceOf(Date);
    expect((params[8] as Date).getTime()).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
  });

  it('validate devuelve null si no hay fila viva', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await formSessionService.validate('deadbeef')).toBeNull();
    expect(queryMock.mock.calls[0][0]).toContain('used_at IS NULL');
    expect(queryMock.mock.calls[0][0]).toContain('expires_at > NOW()');
  });

  it('validate devuelve la fila viva', async () => {
    const row = { token: 't', user_id: 1, action: 'harvest_crop' };
    queryMock.mockResolvedValue({ rows: [row] });
    expect(await formSessionService.validate('t')).toEqual(row);
  });

  it('markUsed setea used_at', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await formSessionService.markUsed('t');
    expect(queryMock.mock.calls[0][0]).toContain('SET used_at = NOW()');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('markUsed logs warning si token no existe o ya fue usado', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await formSessionService.markUsed('deadbeef');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[FORM] markUsed: token not found or already used'));
    warnSpy.mockRestore();
  });
});
