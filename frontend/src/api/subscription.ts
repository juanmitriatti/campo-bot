import { apiRequest } from './client';

/**
 * Tipos y helpers de suscripción — UNA definición para los tres lugares que
 * la miran: el banner del Resumen, la tarjeta de Mi cuenta y el paywall.
 * Estaban duplicados en dos componentes y ya diferían (el banner no conocía
 * `id` ni `billing_period`).
 */

export type SubscriptionStatusName = 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired';

export interface SubscriptionRow {
  id: number;
  status: SubscriptionStatusName;
  billing_period: 'monthly' | 'yearly';
  trial_ends_at: string | null;
  current_period_end: string | null;
  provider: string;
}

/** Plan del catálogo comercial. Lo sirve el backend, no se hardcodea acá. */
export interface PublicPlan {
  name: string;
  display_name: string;
  /** null cuando `custom_pricing` — se cotiza a mano. */
  price_ars: number | null;
  price_ars_yearly: number | null;
  daily_ai_limit: number | null;
  daily_document_limit: number | null;
  featured: boolean;
  custom_pricing: boolean;
}

export interface SubscriptionStatus {
  subscription: SubscriptionRow | null;
  plan: {
    id: number;
    name: string;
    display_name: string;
    price_ars: number;
    price_ars_yearly: number | null;
  } | null;
  payments_enabled: boolean;
  /** El mismo gate que corta el bot: 'trial_expired_readonly' levanta el paywall. */
  access_mode: 'full' | 'trial_expired_readonly';
  plans: PublicPlan[];
  /** `SUPPORT_CONTACT` — texto libre (mail o teléfono). '' = sin dato. */
  support_contact: string;
}

export type BillingPeriod = 'monthly' | 'yearly';

export function fetchSubscription(): Promise<SubscriptionStatus> {
  return apiRequest<SubscriptionStatus>('/subscription');
}

export async function startCheckout(plan: string, period: BillingPeriod): Promise<string> {
  const r = await apiRequest<{ init_point: string }>('/subscription/checkout', {
    method: 'POST',
    body: { plan, period },
  });
  return r.init_point;
}

export function formatArs(n: number): string {
  return `$${n.toLocaleString('es-AR')}`;
}

export function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

/** % de ahorro del anual contra 12 mensuales. 0 = no hay anual o no ahorra. */
export function yearlySavings(plan: PublicPlan): number {
  if (!plan.price_ars || !plan.price_ars_yearly) return 0;
  return Math.round((1 - plan.price_ars_yearly / (plan.price_ars * 12)) * 100);
}

/**
 * `SUPPORT_CONTACT` es texto libre: puede ser un mail o un teléfono. Devuelve
 * un href solo cuando es un mail; si no, el llamador lo muestra como texto
 * (un `mailto:+54 9 11...` no lleva a ninguna parte).
 */
export function supportMailto(contact: string, subject: string): string | null {
  const trimmed = contact.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return `mailto:${trimmed}?subject=${encodeURIComponent(subject)}`;
}
