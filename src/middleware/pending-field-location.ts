import { TypedPendingStore } from './typed-pending-store.js';

export interface PendingFieldLocation {
  fieldId: number;
  fieldName: string;
  timestamp: number;
}

/**
 * Espera de ubicación de campo (ciudad/mapa/compartir). Delegado al contrato
 * único TypedPendingStore (TTL 30 min + espejo DB) — antes era Map propio sin
 * persistencia: un deploy en medio de la pregunta perdía el pending.
 */
export class PendingFieldLocationStore {
  private inner = new TypedPendingStore<Omit<PendingFieldLocation, 'timestamp'>>('field_location');

  set(key: string, data: Omit<PendingFieldLocation, 'timestamp'>): void {
    this.inner.set(key, data);
  }

  get(key: string): PendingFieldLocation | null {
    return (this.inner.get(key) as PendingFieldLocation | undefined) ?? null;
  }

  clear(key: string): void {
    this.inner.clear(key);
  }

  async hydrate(key: string): Promise<void> {
    return this.inner.hydrate(key);
  }
}
