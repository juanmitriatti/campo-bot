import type { PendingTransaction } from '../types/index.js';
import { formatMoney } from '../utils/format-money.js';
import { PendingMirror } from './pending-persistence.js';

// 24 h (antes 30 min): una tarjeta "¿Confirmo?" que el usuario no contestó NO
// se guarda sola ni se pierde a la media hora — queda esperando (nov 2026). Cada
// tarjeta tiene su id y sus botones apuntan a ESA tarjeta, así que puede haber
// varias a la vez sin que un botón viejo confirme otra.
const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type Card = PendingTransaction & { cid?: string; plainIds?: boolean };
interface CardList { timestamp: number; cards: Card[] }

/** Se puede dejar esperando (no es un borrado ni un aviso de campo duplicado, y está completa). */
function isParkable(tx: PendingTransaction): boolean {
  const raw = tx as unknown as Record<string, unknown>;
  return !raw._destructiveCommand && !raw._fieldDuplicate && !raw.fieldDuplicate && isCompletePending(tx);
}

export class PendingTransactionStore {
  // La última de la lista es la tarjeta ACTUAL; las anteriores esperan su turno.
  private store = new Map<string, Card[]>();
  private mirror = new PendingMirror<CardList>('transaction', PENDING_TIMEOUT_MS);
  private parkNotice = new Map<string, Card>();
  private resurfaced = new Set<string>();
  // ¿La tarjeta actual es lo ÚLTIMO que el bot le mostró al usuario? Solo
  // entonces un texto suelto ("no, eran 80", "ok", un comentario) se lee como
  // respuesta a la tarjeta. Con tarjetas que viven 24 h, sin esto un mensaje de
  // otro tema horas después se tomaba como detalle del gasto.
  private awaiting = new Set<string>();
  private touched = new Set<string>();

  /** La tarjeta actual se acaba de mostrar o cambiar en este turno. */
  touch(phone: string): void {
    this.awaiting.add(phone);
    this.touched.add(phone);
  }

  /** Fin de turno: si la tarjeta no se mostró en este turno, deja de esperar respuesta por texto. */
  endTurn(phone: string): void {
    if (!this.touched.has(phone)) this.awaiting.delete(phone);
    this.touched.delete(phone);
  }

  /** ¿El próximo texto del usuario puede ser la respuesta a la tarjeta actual? */
  isAwaitingReply(phone: string): boolean {
    return this.awaiting.has(phone) && this.get(phone) !== null;
  }

  private alive(phone: string): Card[] {
    const list = this.store.get(phone);
    if (!list) return [];
    const now = Date.now();
    const live = list.filter(c => now - c.timestamp <= PENDING_TIMEOUT_MS);
    if (live.length !== list.length) {
      console.log(`[INTERCEPT] tarjeta(s) vencida(s) sin confirmar: ${list.length - live.length} (phone=${phone}) — no se guardaron`);
      this.save(phone, live);
    }
    return live;
  }

  private save(phone: string, list: Card[]): void {
    if (list.length === 0) {
      this.store.delete(phone);
      this.mirror.remove(phone);
      return;
    }
    this.store.set(phone, list);
    this.mirror.persist(phone, { timestamp: Date.now(), cards: list });
  }

  /**
   * Tarjeta NUEVA. Si había otra completa esperando, no se pisa ni se guarda:
   * queda en espera (devuelve null y deja el aviso en `takeParkNotice`). Si lo
   * que había no se puede dejar esperando (un borrado, una tarjeta incompleta),
   * se reemplaza y se devuelve para que el llamador avise.
   */
  set(phone: string, tx: PendingTransaction): PendingTransaction | null {
    const list = this.alive(phone);
    const prev = list[list.length - 1] ?? null;
    const incoming = tx as Card;
    // Misma tarjeta (corrección en el lugar): se actualiza, no se apila.
    if (prev && incoming.cid && incoming.cid === prev.cid) {
      this.update(phone, tx);
      return null;
    }
    let replaced: PendingTransaction | null = null;
    if (prev && !isParkable(prev)) {
      list.pop();
      replaced = prev;
    } else if (prev) {
      this.parkNotice.set(phone, prev);
      console.log(`[INTERCEPT] tarjeta ${prev.type} queda esperando confirmación: llegó otra (phone=${phone}, en espera=${list.length})`);
    }
    const entry: Card = { ...tx, timestamp: Date.now(), cid: Math.random().toString(36).slice(2, 10), plainIds: !list.some(c => c.plainIds) };
    list.push(entry);
    this.save(phone, list);
    this.touch(phone);
    return replaced;
  }

  /** Cambia la tarjeta actual en el lugar (corrección de monto, detalle…). */
  update(phone: string, tx: PendingTransaction): void {
    const list = this.alive(phone);
    const prev = list.pop();
    list.push({ ...(tx as Card), timestamp: Date.now(), cid: prev?.cid ?? Math.random().toString(36).slice(2, 10), plainIds: prev ? prev.plainIds : !list.some(c => c.plainIds) });
    this.save(phone, list);
    this.touch(phone);
  }

  /** La tarjeta actual (la más nueva). */
  get(phone: string): PendingTransaction | null {
    const list = this.alive(phone);
    return list[list.length - 1] ?? null;
  }

  /** Cierra la tarjeta ACTUAL. Si quedaba otra esperando, pasa a ser la actual. */
  clear(phone: string): void {
    const list = this.alive(phone);
    if (list.length === 0) return;
    list.pop();
    if (list.length > 0) this.resurfaced.add(phone);
    this.save(phone, list);
  }

  /** Borra todas (reset de usuario). */
  clearAll(phone: string): void {
    this.parkNotice.delete(phone);
    this.resurfaced.delete(phone);
    this.save(phone, []);
  }

  /**
   * Pasa al frente la tarjeta de un botón: por id, o —botón sin id— la única
   * que se mostró con botones sin id. false = esa tarjeta ya no está pendiente.
   */
  select(phone: string, cid: string | null): boolean {
    const list = this.alive(phone);
    const i = cid ? list.findIndex(c => c.cid === cid) : list.findIndex(c => c.plainIds !== false);
    if (i < 0) return false;
    if (i !== list.length - 1) {
      const [card] = list.splice(i, 1);
      list.push(card);
      this.save(phone, list);
    }
    return true;
  }

  count(phone: string): number {
    return this.alive(phone).length;
  }

  /** La tarjeta que acaba de quedar esperando porque llegó otra (se avisa una vez). */
  takeParkNotice(phone: string): PendingTransaction | null {
    const p = this.parkNotice.get(phone) ?? null;
    this.parkNotice.delete(phone);
    return p;
  }

  /** true (una vez) si al cerrar una tarjeta quedó otra esperando: hay que volver a mostrarla. */
  takeResurfaced(phone: string): boolean {
    return this.resurfaced.delete(phone);
  }

  /** Sufijo de los botones de la tarjeta actual ('' = botones sin id). */
  buttonSuffix(phone: string): string {
    const cur = this.get(phone) as Card | null;
    return cur && cur.plainIds === false && cur.cid ? `_${cur.cid}` : '';
  }

  /** Rellena desde la base tras un restart (fill-if-missing). Acepta el formato viejo (una sola tarjeta). */
  async hydrate(phone: string): Promise<void> {
    if (this.store.has(phone)) return;
    const entry = (await this.mirror.load(phone)) as unknown as (CardList & Partial<Card>) | null;
    if (!entry) return;
    const cards: Card[] = Array.isArray(entry.cards) ? entry.cards : [{ ...(entry as unknown as Card), cid: 'legacy', plainIds: true }];
    if (cards.length > 0) this.store.set(phone, cards);
  }
}

/** Una línea para nombrar una tarjeta: "gasto Combustible $50.000". */
export function describeCard(tx: PendingTransaction): string {
  const kind = tx.type === 'income' ? 'ingreso' : 'gasto';
  const data = (tx as unknown as { data?: { amount?: number; category?: string; currency?: string } }).data ?? {};
  const money = typeof data.amount === 'number' ? formatMoney(data.amount, data.currency ?? 'ARS') : '';
  return [kind, data.category, money].filter(Boolean).join(' ');
}

/**
 * Describe the replaced pending so the user sees what we cancelled.
 * Used by controllers to prepend a "🔁 Cancelé X" warning before the new
 * confirmation buttons.
 */
export function describeReplacedPending(prev: PendingTransaction): string {
  // Un borrado pendiente (o un aviso de campo duplicado) viaja en este store con
  // un "gasto" de $0 de relleno: no es un gasto que se canceló (CONV-28).
  const raw = prev as unknown as Record<string, unknown>;
  if (raw._destructiveCommand) return '🔁 Dejé sin hacer el borrado que estaba esperando tu confirmación.';
  if (raw.fieldDuplicate || raw._fieldDuplicate) return '🔁 Dejé de lado la pregunta sobre el campo duplicado.';
  const kind = prev.type === 'income' ? 'ingreso' : prev.type === 'expense' ? 'gasto' : 'registro';
  const data = (prev as unknown as { data?: { amount?: number; category?: string; currency?: string } }).data ?? {};
  const hasMoney = typeof data.amount === 'number';
  const money = hasMoney ? formatMoney(data.amount as number, data.currency ?? 'ARS') : '';
  const cat = data.category ? ` ${data.category}` : '';
  const detail = hasMoney ? ` (${cat.trim()} ${money})`.replace(/\(\s+/, '(') : (cat ? ` (${cat.trim()})` : '');
  return `🔁 Cancelé el ${kind} anterior${detail} para registrar el nuevo. Confirmá abajo o cancelá si fue un error.`;
}

/** A replaced pending is "complete" when it could be saved as-is (amount + category). */
export function isCompletePending(prev: PendingTransaction): boolean {
  const d = (prev as unknown as { data?: { amount?: number; category?: string } }).data ?? {};
  return (prev.type === 'expense' || prev.type === 'income')
    && typeof d.amount === 'number' && d.amount > 0
    && !!(d.category && String(d.category).trim());
}

function describeCommittedPending(prev: PendingTransaction): string {
  const kind = prev.type === 'income' ? 'ingreso' : 'gasto';
  const data = (prev as unknown as { data?: { amount?: number; category?: string; currency?: string } }).data ?? {};
  const money = formatMoney(data.amount as number, data.currency ?? 'ARS');
  const cat = data.category ? `${data.category} ` : '';
  return `✅ Guardé el ${kind} anterior (${cat}${money}) y registro el nuevo.`;
}

/**
 * When a new expense/income replaces an unconfirmed pending: if the old pending
 * was COMPLETE, auto-commit it (don't discard the user's data) and announce it;
 * otherwise just describe that it was cancelled. Returns the message to prepend.
 */
export async function resolveReplacedPending(
  prev: PendingTransaction,
  commit: (p: PendingTransaction) => Promise<void>,
): Promise<string> {
  if (isCompletePending(prev)) {
    try {
      await commit(prev);
      return describeCommittedPending(prev);
    } catch {
      return describeReplacedPending(prev);
    }
  }
  return describeReplacedPending(prev);
}
