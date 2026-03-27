import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationHistoryService } from '../conversation-history.service.js';

// Mock the pool
const mockQuery = vi.fn();
vi.mock('../../config/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('ConversationHistoryService', () => {
  const service = new ConversationHistoryService();

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns empty array when no history', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const turns = await service.getRecentTurns(1 as any);
    expect(turns).toEqual([]);
  });

  it('returns turns in chronological order (oldest first)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { message_text: 'third', response_text: 'reply3' },
        { message_text: 'second', response_text: 'reply2' },
        { message_text: 'first', response_text: 'reply1' },
      ],
    });

    const turns = await service.getRecentTurns(1 as any, 3);
    expect(turns[0]).toEqual({ role: 'user', content: 'first' });
    expect(turns[1]).toEqual({ role: 'assistant', content: 'reply1' });
    expect(turns[2]).toEqual({ role: 'user', content: 'second' });
    expect(turns[3]).toEqual({ role: 'assistant', content: 'reply2' });
    expect(turns[4]).toEqual({ role: 'user', content: 'third' });
    expect(turns[5]).toEqual({ role: 'assistant', content: 'reply3' });
  });

  it('truncates oldest turns to stay within 800 char budget', async () => {
    const longText = 'A'.repeat(400);
    mockQuery.mockResolvedValue({
      rows: [
        { message_text: 'recent', response_text: 'reply' },
        { message_text: longText, response_text: longText },
      ],
    });

    const turns = await service.getRecentTurns(1 as any, 3);
    // The long pair (800 chars) should be dropped, keeping the short pair
    const totalChars = turns.reduce((sum, t) => sum + t.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(800);
    expect(turns.some(t => t.content === 'recent')).toBe(true);
  });

  it('handles null response_text gracefully', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { message_text: 'hello', response_text: null },
      ],
    });

    const turns = await service.getRecentTurns(1 as any);
    expect(turns).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('queries with correct limit parameter', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await service.getRecentTurns(42 as any, 5);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('conversation_logs'),
      [42, 5],
    );
  });
});
