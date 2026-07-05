import { TypedPendingStore } from './typed-pending-store.js';

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

/**
 * Pending de subida de documentos (dos estados: intent elegido esperando
 * imagen, o imagen recibida esperando intent). Delegado al contrato único
 * TypedPendingStore (TTL 30 min + espejo DB).
 */
export class PendingDocumentUploadStore {
  private inner = new TypedPendingStore<Omit<PendingDocumentUpload, 'timestamp'>>('document_upload');

  set(key: string, data: PendingDocumentUpload): void {
    this.inner.set(key, data);
  }

  get(key: string): PendingDocumentUpload | undefined {
    return this.inner.get(key) as PendingDocumentUpload | undefined;
  }

  clear(key: string): void {
    this.inner.clear(key);
  }

  async hydrate(key: string): Promise<void> {
    return this.inner.hydrate(key);
  }
}
