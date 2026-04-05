export type DocumentUploadIntent = 'factura' | 'remito' | 'ticket';

export interface PendingDocumentUpload {
  /** State A: user chose document type from menu, waiting for image */
  intent?: DocumentUploadIntent;
  /** State B: user sent unprompted image, waiting for intent selection */
  mediaRef?: {
    mediaId: string;
    mimeType: string;
    filename?: string;
    caption?: string;
  };
  timestamp: number;
}

const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory store for pending document upload actions.
 * Two states:
 *   A) User chose "Cargar factura" from menu → intent is set, waiting for image
 *   B) User sent unprompted image → mediaRef is set, waiting for intent choice
 */
export class PendingDocumentUploadStore {
  private store = new Map<string, PendingDocumentUpload>();

  set(key: string, data: PendingDocumentUpload): void {
    this.store.set(key, data);
    setTimeout(() => {
      if (this.store.get(key)?.timestamp === data.timestamp) {
        this.store.delete(key);
      }
    }, EXPIRY_MS);
  }

  get(key: string): PendingDocumentUpload | undefined {
    const data = this.store.get(key);
    if (data && Date.now() - data.timestamp > EXPIRY_MS) {
      this.store.delete(key);
      return undefined;
    }
    return data;
  }

  clear(key: string): void {
    this.store.delete(key);
  }
}
