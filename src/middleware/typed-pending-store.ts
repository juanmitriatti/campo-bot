/**
 * TypedPendingStore — contrato ÚNICO para pendings simples (una entrada por
 * phone): Map síncrono + TTL + espejo en DB (pending_states, migración 097)
 * + hidratación fill-if-missing tras un restart.
 *
 * Por qué existe: había 11 stores de pending con 4 contratos distintos —
 * clases con TTL y mirror (4), clases con TTL sin mirror (4), Maps PELADOS
 * sin TTL ni mirror (3). Los Maps pelados causaron el bug "📤 Stock
 * descontado." falso (restart → store vacío → confirmación mentirosa) y un
 * pending de campaña que vivía para siempre. Todo pending simple nuevo se
 * crea con ESTA clase — no con un Map suelto ni con otra clase ad-hoc.
 *
 * API: get/set/clear (+ delete como alias, para drop-in de los Maps) +
 * hydrate. set() SIEMPRE pisa timestamp (lección del PendingActivityStore:
 * los callers lo omitían → Date.now() - undefined = NaN → TTL nunca corría).
 */
import { PendingMirror } from './pending-persistence.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min — coherente con pending-activities

export class TypedPendingStore<T extends object> {
  private store = new Map<string, T & { timestamp: number }>();
  private mirror: PendingMirror<T & { timestamp: number }>;

  constructor(kind: string, private ttlMs: number = DEFAULT_TTL_MS) {
    this.mirror = new PendingMirror(kind, ttlMs);
  }

  set(key: string, value: T): void {
    const entry = { ...value, timestamp: Date.now() };
    this.store.set(key, entry);
    this.mirror.persist(key, entry);
  }

  get(key: string): (T & { timestamp: number }) | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.clear(key);
      return undefined;
    }
    return entry;
  }

  clear(key: string): void {
    this.store.delete(key);
    this.mirror.remove(key);
  }

  /** Alias de clear() — permite migrar los Maps pelados sin tocar call sites. */
  delete(key: string): void {
    this.clear(key);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Rellena el Map desde DB tras un restart (fill-if-missing). */
  async hydrate(key: string): Promise<void> {
    if (this.store.has(key)) return;
    const entry = await this.mirror.load(key);
    if (entry) this.store.set(key, entry);
  }
}
