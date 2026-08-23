export type Currency = 'ARS' | 'USD';

const nf = new Intl.NumberFormat('es-AR');

/** "$1.600.000" / "USD 8.500" — always the full number, never abbreviated. */
export function money(n: number, currency: Currency): string {
  const sign = n < 0 ? '−' : '';
  const symbol = currency === 'USD' ? 'USD ' : '$';
  return `${sign}${symbol}${nf.format(Math.round(Math.abs(n)))}`;
}

/** Same, with an explicit + for positives — for results, where the sign is the point. */
export function signedMoney(n: number, currency: Currency): string {
  if (Math.round(n) === 0) return money(0, currency);
  const symbol = currency === 'USD' ? 'USD ' : '$';
  return `${n > 0 ? '+ ' : '− '}${symbol}${nf.format(Math.round(Math.abs(n)))}`;
}

/** Compact form for tight spots: "$20,0 M", "$1.799 k". */
export function compactMoney(n: number, currency: Currency): string {
  const sign = n < 0 ? '−' : '';
  const symbol = currency === 'USD' ? 'USD ' : '$';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${symbol}${(abs / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (abs >= 10_000) return `${sign}${symbol}${nf.format(Math.round(abs / 1000))} k`;
  return `${sign}${symbol}${nf.format(Math.round(abs))}`;
}

export function number(n: number): string {
  return nf.format(Math.round(n));
}

export function hectares(n: number | null): string {
  return n == null ? 'sin superficie' : `${nf.format(n)} ha`;
}

export function percent(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

const MONTH_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "2026-03-18" → "18 mar". Parsed as plain Y-M-D so no timezone can shift the day. */
export function dayMonth(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${parseInt(m[3], 10)} ${MONTH_SHORT[parseInt(m[2], 10) - 1]}`;
}

/** "20 nov 2025 – 19 jul 2026", or a single date when both ends match. */
export function dateRange(from: string | null, to: string | null): string {
  if (!from && !to) return '';
  const year = (iso: string) => iso.slice(0, 4);
  if (!to || from === to) return `${dayMonth(from)} ${year(from!)}`;
  return `${dayMonth(from)} ${year(from!)} – ${dayMonth(to)} ${year(to)}`;
}
