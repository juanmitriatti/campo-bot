/**
 * Format an amount with its currency for user-facing text. Argentina convention:
 *   ARS  → "$50.000"   (peso sign prefix)
 *   USD  → "USD 50.000" (NEVER "$50.000 USD" — that conflates peso symbol with dollar suffix)
 *
 * The `$` symbol in Argentina is reserved for pesos. Prefixing a USD amount
 * with `$` creates an ambiguous/incorrect string like "$50.000 USD" — user
 * reads "fifty pesos? thousand? million USD?". Use this helper everywhere we
 * render `amount + currency` to avoid the drift across handlers.
 */
export function formatMoney(amount: number, currency: 'ARS' | 'USD' | string | null | undefined): string {
  const formatted = Number(amount).toLocaleString('es-AR');
  if (currency === 'USD') return `USD ${formatted}`;
  return `$${formatted}`;
}
