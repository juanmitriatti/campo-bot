import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LearningService } from '../learning.service.js';
import type { UserId, Intent } from '../../../types/index.js';

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

describe('LearningService', () => {
  let service: LearningService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LearningService(mockRepo);
  });

  describe('learnFromMessage', () => {
    it('stores pattern for a successful expense', async () => {
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

      await service.learnFromMessage(userId, 'pague 50mil en gasoil', intent, false);

      expect(mockRepo.savePattern).toHaveBeenCalledWith(
        userId,
        'pague 50mil en gasoil',
        expect.any(String),
        'expense',
        { amount: 50000, category: 'Combustible', currency: 'ARS' },
        'parser',
      );
    });

    it('stores pattern with source "claude" when AI was used', async () => {
      const intent: Intent = {
        type: 'expense',
        data: {
          type: 'expense',
          amount: 10000,
          category: 'Otros',
          description: 'repuestos',
          currency: 'ARS',
        },
      };

      await service.learnFromMessage(userId, 'compre repuestos', intent, true);

      expect(mockRepo.savePattern).toHaveBeenCalledWith(
        userId,
        'compre repuestos',
        expect.any(String),
        'expense',
        expect.objectContaining({ category: 'Otros' }),
        'claude',
      );
    });

    it('learns lot name from agronomy command', async () => {
      const intent: Intent = {
        type: 'command',
        data: {
          command: 'log_spraying',
          plotName: 'el bajo',
          fieldName: null,
          product: 'Glifosato',
          productType: 'herbicida',
          quantity: 3,
          unit: 'lt',
          crop: null,
          eventDate: null,
        },
      };

      await service.learnFromMessage(userId, 'fumigamos el bajo con glifosato', intent, false);

      // Should learn "el bajo" as lot_name
      expect(mockRepo.upsertVocabulary).toHaveBeenCalledWith(
        userId,
        'el bajo',
        'el bajo',
        'lot_name:el bajo',
        'lot_name',
        0.6,
      );
    });

    it('learns crop from sow command', async () => {
      const intent: Intent = {
        type: 'command',
        data: {
          command: 'sow_crop',
          plotName: 'lote 3',
          fieldName: null,
          crop: 'garbanzo',
          eventDate: null,
        },
      };

      await service.learnFromMessage(userId, 'sembramos garbanzo en el lote 3', intent, false);

      // "garbanzo" is not a known crop in the parser
      expect(mockRepo.upsertVocabulary).toHaveBeenCalledWith(
        userId,
        'garbanzo',
        'garbanzo',
        'crop:garbanzo',
        'crop',
        0.5,
      );
    });

    it('does not learn known crops as new vocabulary', async () => {
      const intent: Intent = {
        type: 'command',
        data: {
          command: 'sow_crop',
          plotName: null,
          fieldName: null,
          crop: 'soja',
          eventDate: null,
        },
      };

      await service.learnFromMessage(userId, 'sembramos soja', intent, false);

      // "soja" is already known — should NOT be learned as crop
      const cropCalls = mockRepo.upsertVocabulary.mock.calls.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any[]) => c[4] === 'crop' && c[2] === 'soja'
      );
      expect(cropCalls).toHaveLength(0);
    });

    it('does not learn from unknown intent', async () => {
      const intent: Intent = {
        type: 'unknown',
        raw: 'algo random',
      };

      await service.learnFromMessage(userId, 'algo random', intent, true);

      // Pattern is saved, but no vocabulary learned
      expect(mockRepo.savePattern).toHaveBeenCalled();
      expect(mockRepo.upsertVocabulary).not.toHaveBeenCalled();
    });

    it('learns fuel word from combustible expense', async () => {
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

      await service.learnFromMessage(userId, 'cargue gasoil 50 lucas', intent, false);

      // "gasoil" is known fuel — should be learned with higher confidence
      expect(mockRepo.upsertVocabulary).toHaveBeenCalledWith(
        userId,
        'gasoil',
        'gasoil',
        'fuel:gasoil',
        'fuel',
        0.6,
      );
    });

    it('detects potential lot name from text patterns', async () => {
      const intent: Intent = {
        type: 'command',
        data: {
          command: 'log_spraying',
          plotName: null,
          fieldName: null,
          product: 'Glifosato',
          productType: 'herbicida',
          quantity: null,
          unit: null,
          crop: null,
          eventDate: null,
        },
      };

      await service.learnFromMessage(userId, 'fumigamos en la loma con glifosato', intent, false);

      // "loma" should be detected as a lot name from "en la loma"
      expect(mockRepo.upsertVocabulary).toHaveBeenCalledWith(
        userId,
        'loma',
        'loma',
        'lot_name:loma',
        'lot_name',
        0.4,
      );
    });

    it('stores income pattern with entities', async () => {
      const intent: Intent = {
        type: 'income',
        data: {
          type: 'income',
          amount: 2000000,
          category: 'Soja',
          description: 'venta de soja',
          currency: 'ARS',
          quantity: 30,
          unit: 'tn',
          unit_price: null,
        },
      };

      await service.learnFromMessage(userId, 'vendí 30 tn de soja', intent, false);

      expect(mockRepo.savePattern).toHaveBeenCalledWith(
        userId,
        'vendí 30 tn de soja',
        expect.any(String),
        'income',
        expect.objectContaining({
          amount: 2000000,
          category: 'Soja',
          quantity: 30,
          unit: 'tn',
        }),
        'parser',
      );
    });

    it('handles errors gracefully without throwing', async () => {
      mockRepo.savePattern.mockRejectedValueOnce(new Error('DB error'));

      const intent: Intent = {
        type: 'expense',
        data: {
          type: 'expense',
          amount: 1000,
          category: 'Otros',
          description: 'test',
          currency: 'ARS',
        },
      };

      // Should not throw
      await expect(
        service.learnFromMessage(userId, 'test', intent, false)
      ).resolves.toBeUndefined();
    });
  });
});
