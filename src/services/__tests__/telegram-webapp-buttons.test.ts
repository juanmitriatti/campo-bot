import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();

describe('sendTelegramButtons con webAppUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mapea webAppUrl a web_app y el resto a callback_data', async () => {
    const { sendTelegramButtons } = await import('../telegram.js');
    await sendTelegramButtons(123, 'Elegí', [
      { id: 'a', title: 'Normal' },
      { id: 'b', title: '📝 Formulario', webAppUrl: 'https://x.test/form/tok' },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reply_markup.inline_keyboard[0][0]).toEqual({ text: 'Normal', callback_data: 'a' });
    expect(body.reply_markup.inline_keyboard[1][0]).toEqual({
      text: '📝 Formulario', web_app: { url: 'https://x.test/form/tok' },
    });
  });
});
