import type { DocumentExtraction, ParsedExpense } from '../types/index.js';

export interface PendingDocumentAction {
  documentId: number;
  extraction: DocumentExtraction;
  suggestedExpenses: Array<Partial<ParsedExpense> & { field?: string; plot?: string }>;
  timestamp: number;
}

const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory store for pending document actions (register as expense).
 * Same pattern as pendingStockEntryStore.
 */
export class PendingDocumentStore {
  private store = new Map<string, PendingDocumentAction>();

  set(key: string, action: PendingDocumentAction): void {
    this.store.set(key, action);
    // Auto-expire
    setTimeout(() => {
      if (this.store.get(key)?.timestamp === action.timestamp) {
        this.store.delete(key);
      }
    }, EXPIRY_MS);
  }

  get(key: string): PendingDocumentAction | undefined {
    const action = this.store.get(key);
    if (action && Date.now() - action.timestamp > EXPIRY_MS) {
      this.store.delete(key);
      return undefined;
    }
    return action;
  }

  clear(key: string): void {
    this.store.delete(key);
  }
}
