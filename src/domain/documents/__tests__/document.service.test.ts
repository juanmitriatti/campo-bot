import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatExtractionSummary, buildSuggestedExpenses, isInsumoCategory, buildPostExtractionButtons } from '../document.helpers.js';
import type { DocumentExtraction } from '../../../types/index.js';
import type { DocumentUploadIntent } from '../../../middleware/pending-document-upload.js';

// ============================================================================
// Magic bytes validation (unit tests without DB/sharp deps)
// ============================================================================

describe('Magic bytes validation', () => {
  // We test the logic directly since the method is private — we test via the signatures
  const MAGIC_BYTES: Record<string, number[]> = {
    'image/jpeg': [0xFF, 0xD8, 0xFF],
    'image/png': [0x89, 0x50, 0x4E, 0x47],
    'application/pdf': [0x25, 0x50, 0x44, 0x46],
  };

  function validateMagicBytes(buffer: Buffer, mimeType: string): boolean {
    const expected = MAGIC_BYTES[mimeType];
    if (!expected) return true;
    for (let i = 0; i < expected.length; i++) {
      if (buffer[i] !== expected[i]) return false;
    }
    return true;
  }

  it('validates correct JPEG magic bytes', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
    expect(validateMagicBytes(buf, 'image/jpeg')).toBe(true);
  });

  it('validates correct PNG magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D]);
    expect(validateMagicBytes(buf, 'image/png')).toBe(true);
  });

  it('validates correct PDF magic bytes', () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]);
    expect(validateMagicBytes(buf, 'application/pdf')).toBe(true);
  });

  it('rejects incorrect JPEG magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D]); // PNG bytes
    expect(validateMagicBytes(buf, 'image/jpeg')).toBe(false);
  });

  it('rejects incorrect PNG magic bytes', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]); // JPEG bytes
    expect(validateMagicBytes(buf, 'image/png')).toBe(false);
  });

  it('rejects incorrect PDF magic bytes', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]); // JPEG bytes
    expect(validateMagicBytes(buf, 'application/pdf')).toBe(false);
  });

  it('accepts unknown mime types (no validation)', () => {
    const buf = Buffer.from([0x00, 0x00, 0x00]);
    expect(validateMagicBytes(buf, 'image/webp')).toBe(true);
  });
});

// ============================================================================
// formatExtractionSummary
// ============================================================================

describe('formatExtractionSummary', () => {
  it('formats a complete invoice extraction', () => {
    const extraction: DocumentExtraction = {
      supplier: 'AgroInsumos SA',
      date: '2026-03-15',
      document_number: 'A-0001-00042',
      total_amount: 150000,
      currency: 'ARS',
      tax_amount: 31500,
      line_items: [
        { product: 'Glifosato', quantity: 100, unit: 'lt', unit_price: 1000, total: 100000 },
        { product: 'Cipermetrina', quantity: 50, unit: 'lt', unit_price: 1000, total: 50000 },
      ],
    };

    const result = formatExtractionSummary(extraction, 1, 'factura');
    expect(result).toContain('Factura procesada (#1)');
    expect(result).toContain('AgroInsumos SA');
    expect(result).toContain('A-0001-00042');
    expect(result).toContain('15/03/2026');
    expect(result).toContain('Glifosato');
    expect(result).toContain('Cipermetrina');
    expect(result).toContain('150.000');
  });

  it('formats a document without line items', () => {
    const extraction: DocumentExtraction = {
      supplier: 'Proveedor X',
      total_amount: 50000,
      currency: 'USD',
    };

    const result = formatExtractionSummary(extraction, 5, 'remito');
    expect(result).toContain('Remito procesado (#5)');
    expect(result).toContain('Proveedor X');
    expect(result).toContain('USD');
    expect(result).toContain('50.000');
  });

  it('formats a non-invoice document with raw_text_summary', () => {
    const extraction: DocumentExtraction = {
      raw_text_summary: 'Nota de pedido informal sin datos financieros',
    };

    const result = formatExtractionSummary(extraction, 3, 'otro');
    expect(result).toContain('Documento procesado (#3)');
    expect(result).toContain('Nota de pedido');
  });
});

// ============================================================================
// buildSuggestedExpenses
// ============================================================================

describe('buildSuggestedExpenses', () => {
  it('builds expenses from line items', () => {
    const extraction: DocumentExtraction = {
      supplier: 'AgroInsumos SA',
      date: '2026-03-15',
      currency: 'ARS',
      total_amount: 150000,
      line_items: [
        { product: 'Glifosato', quantity: 100, unit: 'lt', total: 100000, category: 'Agroquímicos' },
        { product: 'Urea', quantity: 200, unit: 'kg', total: 50000, category: 'Fertilizantes' },
      ],
    };

    const expenses = buildSuggestedExpenses(extraction);
    expect(expenses).toHaveLength(2);

    expect(expenses[0].amount).toBe(100000);
    expect(expenses[0].category).toBe('Agroquímicos');
    expect(expenses[0].product).toBe('Glifosato');
    expect(expenses[0].expenseType).toBe('insumo');
    expect(expenses[0].expenseDate).toBe('2026-03-15');

    expect(expenses[1].amount).toBe(50000);
    expect(expenses[1].category).toBe('Fertilizantes');
    expect(expenses[1].product).toBe('Urea');
    expect(expenses[1].expenseType).toBe('insumo');
  });

  it('builds single expense from total when no line items', () => {
    const extraction: DocumentExtraction = {
      supplier: 'Combustibles SRL',
      total_amount: 80000,
      currency: 'USD',
    };

    const expenses = buildSuggestedExpenses(extraction);
    expect(expenses).toHaveLength(1);
    expect(expenses[0].amount).toBe(80000);
    expect(expenses[0].currency).toBe('USD');
    expect(expenses[0].description).toContain('Combustibles SRL');
  });

  it('returns empty array when no total or items', () => {
    const extraction: DocumentExtraction = {
      raw_text_summary: 'Just a photo of a field',
    };

    const expenses = buildSuggestedExpenses(extraction);
    expect(expenses).toHaveLength(0);
  });

  it('skips line items with zero or no total', () => {
    const extraction: DocumentExtraction = {
      currency: 'ARS',
      total_amount: 50000,
      line_items: [
        { product: 'Roundup', quantity: 50, unit: 'lt', total: 50000 },
        { product: 'Muestra gratis', quantity: 1, unit: 'lt', total: 0 },
        { product: 'Sin precio', quantity: 1, unit: 'lt' },
      ],
    };

    const expenses = buildSuggestedExpenses(extraction);
    expect(expenses).toHaveLength(1);
    expect(expenses[0].product).toBe('Roundup');
  });

  it('maps category strings to canonical expense categories', () => {
    const extraction: DocumentExtraction = {
      currency: 'ARS',
      total_amount: 10000,
      line_items: [
        { product: 'Gasoil', total: 10000, category: 'Combustible' },
      ],
    };

    const expenses = buildSuggestedExpenses(extraction);
    expect(expenses[0].category).toBe('Combustible');
    expect(expenses[0].expenseType).toBe('insumo');
  });
});

// ============================================================================
// PendingDocumentStore
// ============================================================================

describe('PendingDocumentStore', () => {
  it('stores and retrieves pending document actions', async () => {
    const { PendingDocumentStore } = await import('../../../middleware/pending-documents.js');
    const store = new PendingDocumentStore();

    const action = {
      documentId: 1,
      extraction: { supplier: 'Test', total_amount: 100 } as DocumentExtraction,
      suggestedExpenses: [],
      timestamp: Date.now(),
    };

    store.set('user1', action);
    expect(store.get('user1')).toEqual(action);
  });

  it('clears pending actions', async () => {
    const { PendingDocumentStore } = await import('../../../middleware/pending-documents.js');
    const store = new PendingDocumentStore();

    store.set('user1', {
      documentId: 1,
      extraction: {} as DocumentExtraction,
      suggestedExpenses: [],
      timestamp: Date.now(),
    });

    store.clear('user1');
    expect(store.get('user1')).toBeUndefined();
  });

  it('returns undefined for expired actions', async () => {
    const { PendingDocumentStore } = await import('../../../middleware/pending-documents.js');
    const store = new PendingDocumentStore();

    // Contrato nuevo (TypedPendingStore): set() SIEMPRE pisa timestamp, así
    // que la expiración se testea avanzando el reloj, no backdateando.
    vi.useFakeTimers();
    try {
      store.set('user1', {
        documentId: 1,
        extraction: {} as DocumentExtraction,
        suggestedExpenses: [],
        timestamp: Date.now(),
      });
      vi.advanceTimersByTime(31 * 60 * 1000); // TTL 30 min
      expect(store.get('user1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// Document type classification
// ============================================================================

describe('Document type classification', () => {
  // Extracted from DocumentService.classifyDocumentType logic
  function classifyDocumentType(extraction: DocumentExtraction): string {
    const summary = (extraction.raw_text_summary || '').toLowerCase();
    if (extraction.document_number) {
      if (summary.includes('remito')) return 'remito';
      if (summary.includes('ticket') || summary.includes('tkt')) return 'ticket';
      return 'factura';
    }
    if (extraction.total_amount && extraction.total_amount > 0) return 'factura';
    if (summary.includes('remito')) return 'remito';
    if (summary.includes('ticket')) return 'ticket';
    return 'otro';
  }

  it('classifies as factura when document_number present', () => {
    expect(classifyDocumentType({ document_number: 'A-0001' })).toBe('factura');
  });

  it('classifies as remito when summary mentions remito', () => {
    expect(classifyDocumentType({ document_number: '123', raw_text_summary: 'Remito de entrega' })).toBe('remito');
  });

  it('classifies as ticket when summary mentions ticket', () => {
    expect(classifyDocumentType({ document_number: '123', raw_text_summary: 'Ticket fiscal' })).toBe('ticket');
  });

  it('classifies as factura when total_amount present without doc number', () => {
    expect(classifyDocumentType({ total_amount: 50000 })).toBe('factura');
  });

  it('classifies as otro when no financial data', () => {
    expect(classifyDocumentType({ raw_text_summary: 'Some random text' })).toBe('otro');
  });
});

// ============================================================================
// PendingDocumentUploadStore
// ============================================================================

describe('PendingDocumentUploadStore', () => {
  it('stores and retrieves intent state (State A)', async () => {
    const { PendingDocumentUploadStore } = await import('../../../middleware/pending-document-upload.js');
    const store = new PendingDocumentUploadStore();

    const data = { intent: 'factura' as DocumentUploadIntent, timestamp: Date.now() };
    store.set('user1', data);
    expect(store.get('user1')).toEqual(data);
  });

  it('stores and retrieves mediaRef state (State B)', async () => {
    const { PendingDocumentUploadStore } = await import('../../../middleware/pending-document-upload.js');
    const store = new PendingDocumentUploadStore();

    const data = {
      mediaRef: { mediaId: 'abc123', mimeType: 'image/jpeg', caption: 'test' },
      timestamp: Date.now(),
    };
    store.set('user1', data);
    const result = store.get('user1');
    expect(result?.mediaRef?.mediaId).toBe('abc123');
  });

  it('clears pending upload', async () => {
    const { PendingDocumentUploadStore } = await import('../../../middleware/pending-document-upload.js');
    const store = new PendingDocumentUploadStore();

    store.set('user1', { intent: 'remito' as DocumentUploadIntent, timestamp: Date.now() });
    store.clear('user1');
    expect(store.get('user1')).toBeUndefined();
  });

  it('returns undefined for expired entries', async () => {
    const { PendingDocumentUploadStore } = await import('../../../middleware/pending-document-upload.js');
    const store = new PendingDocumentUploadStore();

    vi.useFakeTimers();
    try {
      store.set('user1', {
        intent: 'factura' as DocumentUploadIntent,
        timestamp: Date.now(),
      });
      vi.advanceTimersByTime(31 * 60 * 1000); // TTL 30 min
      expect(store.get('user1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not return other users data', async () => {
    const { PendingDocumentUploadStore } = await import('../../../middleware/pending-document-upload.js');
    const store = new PendingDocumentUploadStore();

    store.set('user1', { intent: 'factura' as DocumentUploadIntent, timestamp: Date.now() });
    expect(store.get('user2')).toBeUndefined();
  });
});

// ============================================================================
// isInsumoCategory (now exported)
// ============================================================================

describe('isInsumoCategory', () => {
  it('returns true for agroquímicos', () => {
    expect(isInsumoCategory('Agroquímicos')).toBe(true);
  });

  it('returns true for fertilizantes', () => {
    expect(isInsumoCategory('fertilizantes')).toBe(true);
  });

  it('returns true for semillas', () => {
    expect(isInsumoCategory('Semillas de soja')).toBe(true);
  });

  it('returns true for combustible', () => {
    expect(isInsumoCategory('combustible')).toBe(true);
  });

  it('returns false for servicios', () => {
    expect(isInsumoCategory('Servicios')).toBe(false);
  });

  it('returns false for repuestos', () => {
    expect(isInsumoCategory('Repuestos')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isInsumoCategory(undefined)).toBe(false);
    expect(isInsumoCategory(null as any)).toBe(false);
  });
});

// ============================================================================
// buildPostExtractionButtons
// ============================================================================

describe('buildPostExtractionButtons', () => {
  it('returns Registrar gasto / Solo guardar for factura with insumo amount + stock (no Gasto+Stock)', () => {
    const extraction: DocumentExtraction = {
      total_amount: 100000,
      line_items: [
        { product: 'Glifosato', total: 100000, category: 'Agroquímicos' },
      ],
    };
    const result = buildPostExtractionButtons(extraction, 1, 'factura', true);
    expect(result).not.toBeNull();
    expect(result!.buttons).toHaveLength(2);
    expect(result!.buttons[0].id).toBe('doc_expense_yes_1');
    expect(result!.buttons[0].title).toBe('Registrar gasto');
    expect(result!.buttons[1].title).toBe('Solo guardar');
  });

  it('returns Registrar gasto / Solo guardar for factura with insumo WITHOUT stock feature', () => {
    const extraction: DocumentExtraction = {
      total_amount: 100000,
      line_items: [
        { product: 'Glifosato', total: 100000, category: 'Agroquímicos' },
      ],
    };
    const result = buildPostExtractionButtons(extraction, 2, 'factura', false);
    expect(result).not.toBeNull();
    expect(result!.buttons).toHaveLength(2);
    expect(result!.buttons[0].title).toBe('Registrar gasto');
    expect(result!.buttons[1].title).toBe('Solo guardar');
  });

  it('returns Registrar gasto / Solo guardar for factura with non-insumo amount', () => {
    const extraction: DocumentExtraction = {
      total_amount: 50000,
      line_items: [
        { product: 'Reparación motor', total: 50000, category: 'Repuestos' },
      ],
    };
    const result = buildPostExtractionButtons(extraction, 3, 'factura', true);
    expect(result).not.toBeNull();
    expect(result!.buttons).toHaveLength(2);
    expect(result!.buttons[0].title).toBe('Registrar gasto');
  });

  it('returns Cargar stock / Solo guardar for remito with items + no amount + stock', () => {
    const extraction: DocumentExtraction = {
      line_items: [
        { product: 'Semilla de trigo', quantity: 500, unit: 'kg' },
      ],
    };
    const result = buildPostExtractionButtons(extraction, 4, 'remito', true);
    expect(result).not.toBeNull();
    expect(result!.buttons).toHaveLength(2);
    expect(result!.buttons[0].id).toBe('doc_stock_yes_4');
    expect(result!.buttons[0].title).toBe('Cargar stock');
  });

  it('returns null when no structured data', () => {
    const extraction: DocumentExtraction = {
      raw_text_summary: 'Some random photo',
    };
    const result = buildPostExtractionButtons(extraction, 5, 'factura', true);
    expect(result).toBeNull();
  });

  it('returns null for remito without stock feature and no amount', () => {
    const extraction: DocumentExtraction = {
      line_items: [
        { product: 'Fertilizante', quantity: 100, unit: 'kg' },
      ],
    };
    const result = buildPostExtractionButtons(extraction, 6, 'remito', false);
    expect(result).toBeNull();
  });

  it('returns null for remito with amount (should NOT show Registrar gasto)', () => {
    const extraction: DocumentExtraction = {
      total_amount: 50000,
      line_items: [
        { product: 'Semilla de soja', total: 50000, quantity: 200, unit: 'kg', category: 'Semillas' },
      ],
    };
    const result = buildPostExtractionButtons(extraction, 7, 'remito', false);
    expect(result).toBeNull();
  });

  it('returns Cargar stock for remito with amount + line items + stock feature', () => {
    const extraction: DocumentExtraction = {
      total_amount: 50000,
      line_items: [
        { product: 'Semilla de soja', total: 50000, quantity: 200, unit: 'kg', category: 'Semillas' },
      ],
    };
    const result = buildPostExtractionButtons(extraction, 8, 'remito', true);
    expect(result).not.toBeNull();
    expect(result!.buttons).toHaveLength(2);
    expect(result!.buttons[0].id).toBe('doc_stock_yes_8');
    expect(result!.buttons[0].title).toBe('Cargar stock');
  });
});
