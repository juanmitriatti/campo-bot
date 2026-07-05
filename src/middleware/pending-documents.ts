import type { DocumentExtraction, ParsedExpense } from '../types/index.js';
import { TypedPendingStore } from './typed-pending-store.js';

export interface PendingDocumentAction {
  documentId: number;
  extraction: DocumentExtraction;
  suggestedExpenses: Array<Partial<ParsedExpense> & { field?: string; plot?: string }>;
  timestamp: number;
  /** Set after plot selection, before saving */
  resolvedFieldId?: number | null;
  resolvedPlotId?: number | null;
  /** Deferred action after plot selection */
  deferredAction?: 'expense';
  /** Products from line items not found in user's stock (for product discovery) */
  missingProducts?: Array<{ name: string; unit?: string; category?: string }>;
}

/**
 * Pending de acciones sobre documentos (registrar factura como gasto).
 * Delegado al contrato único TypedPendingStore (TTL 30 min + espejo DB) —
 * antes: Map propio con setTimeout y sin persistencia (un deploy en medio de
 * "¿a qué lote asigno la factura?" perdía la extracción entera).
 */
export class PendingDocumentStore {
  private inner = new TypedPendingStore<Omit<PendingDocumentAction, 'timestamp'>>('document_action');

  set(key: string, action: PendingDocumentAction): void {
    this.inner.set(key, action);
  }

  get(key: string): PendingDocumentAction | undefined {
    return this.inner.get(key) as PendingDocumentAction | undefined;
  }

  clear(key: string): void {
    this.inner.clear(key);
  }

  async hydrate(key: string): Promise<void> {
    return this.inner.hydrate(key);
  }
}
