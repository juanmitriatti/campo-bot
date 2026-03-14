import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextResolver } from '../context-resolver.js';
import type { UserId, Intent, VocabularyEntry } from '../../../types/index.js';

function makeVocab(overrides: Partial<VocabularyEntry>): VocabularyEntry {
  return {
    id: 'test-id',
    user_id: 1,
    phrase: 'test',
    normalized_phrase: 'test',
    resolved_value: 'test:test',
    category: 'lot_name',
    confidence: 0.7,
    hit_count: 3,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const mockRepo = {
  upsertVocabulary: vi.fn().mockResolvedValue({}),
  savePattern: vi.fn().mockResolvedValue({}),
  getVocabulary: vi.fn().mockResolvedValue([]),
  findByPhrase: vi.fn().mockResolvedValue([]),
  findMatchesInText: vi.fn().mockResolvedValue([]),
  getRecentPatterns: vi.fn().mockResolvedValue([]),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const userId = 1 as UserId;

describe('ContextResolver', () => {
  let resolver: ContextResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new ContextResolver(mockRepo);
  });

  describe('enrichIntent', () => {
    it('resolves lot name from learned vocabulary', async () => {
      mockRepo.getVocabulary.mockImplementation((_uid: number, cat?: string) => {
        if (cat === 'lot_name') return Promise.resolve([
          makeVocab({ phrase: 'el bajo', normalized_phrase: 'el bajo', category: 'lot_name', confidence: 0.8 }),
        ]);
        return Promise.resolve([]);
      });

      const intent: Intent = {
        type: 'command',
        data: {
          command: 'log_spraying',
          plotName: null,
          fieldName: null,
          product: 'Glifosato',
          productType: 'herbicida',
          quantity: 3,
          unit: 'lt',
          crop: null,
          eventDate: null,
        },
      };

      const enriched = await resolver.enrichIntent(userId, 'fumigamos el bajo con glifosato', intent);

      expect(enriched.type).toBe('command');
      if (enriched.type === 'command') {
        expect(enriched.data.plotName).toBe('el bajo');
        // Original fields preserved
        expect(enriched.data.product).toBe('Glifosato');
      }
    });

    it('resolves crop from learned vocabulary', async () => {
      mockRepo.getVocabulary.mockImplementation((_uid: number, cat?: string) => {
        if (cat === 'crop') return Promise.resolve([
          makeVocab({ phrase: 'garbanzo', normalized_phrase: 'garbanzo', category: 'crop', confidence: 0.6 }),
        ]);
        return Promise.resolve([]);
      });

      const intent: Intent = {
        type: 'command',
        data: {
          command: 'sow_crop',
          plotName: 'lote 3',
          fieldName: null,
          crop: null,
          eventDate: null,
        },
      };

      const enriched = await resolver.enrichIntent(userId, 'sembramos garbanzo en lote 3', intent);

      if (enriched.type === 'command') {
        expect(enriched.data.crop).toBe('garbanzo');
        // plotName preserved
        expect(enriched.data.plotName).toBe('lote 3');
      }
    });

    it('does not overwrite existing parsed data', async () => {
      mockRepo.getVocabulary.mockImplementation((_uid: number, cat?: string) => {
        if (cat === 'lot_name') return Promise.resolve([
          makeVocab({ phrase: 'el bajo', normalized_phrase: 'el bajo', category: 'lot_name', confidence: 0.8 }),
        ]);
        return Promise.resolve([]);
      });

      const intent: Intent = {
        type: 'command',
        data: {
          command: 'log_spraying',
          plotName: 'lote 5',  // Already has a plot
          fieldName: null,
          product: null,
          productType: null,
          quantity: null,
          unit: null,
          crop: null,
          eventDate: null,
        },
      };

      const enriched = await resolver.enrichIntent(userId, 'fumigamos el bajo en lote 5', intent);

      if (enriched.type === 'command') {
        // Should keep "lote 5", not replace with "el bajo"
        expect(enriched.data.plotName).toBe('lote 5');
      }
    });

    it('does not enrich non-command intents', async () => {
      const intent: Intent = {
        type: 'expense',
        data: {
          type: 'expense',
          amount: 50000,
          category: 'Combustible',
          description: 'gasoil',
          currency: 'ARS',
        },
      };

      const enriched = await resolver.enrichIntent(userId, 'gasoil 50 lucas', intent);

      // Should return the exact same intent unchanged
      expect(enriched).toBe(intent);
      expect(mockRepo.getVocabulary).not.toHaveBeenCalled();
    });

    it('does not enrich non-enrichable commands', async () => {
      const intent: Intent = {
        type: 'command',
        data: { command: 'help' },
      };

      const enriched = await resolver.enrichIntent(userId, 'ayuda', intent);

      expect(enriched).toBe(intent);
      expect(mockRepo.getVocabulary).not.toHaveBeenCalled();
    });

    it('prefers longer matches over shorter ones', async () => {
      mockRepo.getVocabulary.mockImplementation((_uid: number, cat?: string) => {
        if (cat === 'lot_name') return Promise.resolve([
          makeVocab({ phrase: 'norte', normalized_phrase: 'norte', category: 'lot_name', confidence: 0.7 }),
          makeVocab({ phrase: 'loma norte', normalized_phrase: 'loma norte', category: 'lot_name', confidence: 0.7 }),
        ]);
        return Promise.resolve([]);
      });

      const intent: Intent = {
        type: 'command',
        data: {
          command: 'log_rainfall',
          plotName: null,
          fieldName: null,
        },
      };

      const enriched = await resolver.enrichIntent(userId, 'cayeron 20mm en loma norte', intent);

      if (enriched.type === 'command') {
        expect(enriched.data.plotName).toBe('loma norte');
      }
    });

    it('ignores low-confidence vocabulary entries for crops/products', async () => {
      mockRepo.getVocabulary.mockImplementation((_uid: number, cat?: string) => {
        if (cat === 'crop') return Promise.resolve([
          makeVocab({ phrase: 'mijo', normalized_phrase: 'mijo', category: 'crop', confidence: 0.3 }),
        ]);
        return Promise.resolve([]);
      });

      const intent: Intent = {
        type: 'command',
        data: {
          command: 'sow_crop',
          plotName: 'lote 1',
          fieldName: null,
          crop: null,
          eventDate: null,
        },
      };

      const enriched = await resolver.enrichIntent(userId, 'sembramos mijo en lote 1', intent);

      if (enriched.type === 'command') {
        // confidence 0.3 is below threshold 0.5 for crops — field stays null
        expect(enriched.data.crop).toBeNull();
      }
    });

    it('resolves product from learned vocabulary', async () => {
      mockRepo.getVocabulary.mockImplementation((_uid: number, cat?: string) => {
        if (cat === 'product') return Promise.resolve([
          makeVocab({ phrase: 'engorde plus', normalized_phrase: 'engorde plus', category: 'product', confidence: 0.7 }),
        ]);
        return Promise.resolve([]);
      });

      const intent: Intent = {
        type: 'command',
        data: {
          command: 'log_fertilization',
          plotName: 'lote 2',
          fieldName: null,
          product: null,
          productType: null,
          quantity: 50,
          unit: 'kg',
          crop: null,
          eventDate: null,
        },
      };

      const enriched = await resolver.enrichIntent(userId, 'echamos engorde plus 50kg en lote 2', intent);

      if (enriched.type === 'command') {
        expect(enriched.data.product).toBe('engorde plus');
      }
    });

    it('returns intent unchanged when no vocabulary matches', async () => {
      mockRepo.getVocabulary.mockResolvedValue([]);

      const intent: Intent = {
        type: 'command',
        data: {
          command: 'log_spraying',
          plotName: null,
          fieldName: null,
          product: null,
          productType: null,
          quantity: null,
          unit: null,
          crop: null,
          eventDate: null,
        },
      };

      const enriched = await resolver.enrichIntent(userId, 'fumigamos algo', intent);

      // No changes → returns original
      expect(enriched).toBe(intent);
    });
  });

  describe('loadContext', () => {
    it('loads vocabulary grouped by category', async () => {
      mockRepo.getVocabulary.mockImplementation((_uid: number, cat?: string) => {
        if (cat === 'lot_name') return Promise.resolve([makeVocab({ category: 'lot_name' })]);
        if (cat === 'crop') return Promise.resolve([makeVocab({ category: 'crop' })]);
        if (cat === 'product') return Promise.resolve([makeVocab({ category: 'product' })]);
        if (cat === 'slang') return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const ctx = await resolver.loadContext(userId);

      expect(ctx.lots).toHaveLength(1);
      expect(ctx.crops).toHaveLength(1);
      expect(ctx.products).toHaveLength(1);
      expect(ctx.slang).toHaveLength(0);

      expect(mockRepo.getVocabulary).toHaveBeenCalledTimes(4);
    });
  });
});
