import { pool } from '../../config/db.js';
import { getSetting, getSettingNumber } from '../../services/settings.service.js';

/**
 * Catálogo COMERCIAL de planes — la única fuente de "qué se vende y a cuánto".
 *
 * Lo consumen dos lugares que antes tenían cada uno su propia lista:
 *   - la sección Planes de la landing, vía `GET /api/plans/public`
 *   - el paywall del dashboard cuando se vence la prueba, vía `/subscription`
 * Si divergieran, la landing prometería un precio y el modal cobraría otro.
 *
 * Qué aparece acá lo decide el admin por plan (migración 108): `is_public`
 * (se muestra), `is_featured` (badge) y `custom_pricing` (cotización a mano).
 * `free` queda fuera: dejó de venderse, hoy es solo el destino del downgrade.
 */

export interface PublicPlan {
  name: string;
  display_name: string;
  /** null cuando `custom_pricing`: un "$0" en la card se lee como gratis. */
  price_ars: number | null;
  price_ars_yearly: number | null;
  daily_ai_limit: number | null;
  daily_document_limit: number | null;
  featured: boolean;
  custom_pricing: boolean;
}

export interface PublicPlanCatalog {
  trial_days: number;
  plans: PublicPlan[];
  /**
   * Contacto de soporte (`SUPPORT_CONTACT`, el mismo que usa el bot). Va acá
   * porque el plan a medida se vende por contacto, y el CTA necesita a dónde
   * mandar. Formato libre: puede ser un mail o un teléfono, así que quien lo
   * renderiza decide si arma un mailto o lo muestra como texto. '' = sin dato.
   */
  support_contact: string;
}

const DEFAULT_TRIAL_DAYS = 14;
/** La landing pega en cada visita: cacheamos para no ir a la DB por visitante. */
const CACHE_TTL_MS = 60_000;
let cache: { at: number; payload: PublicPlanCatalog } | null = null;

/** La llama el admin al editar un plan — sin esto el cambio tarda hasta 60s. */
export function invalidatePlanCatalogCache(): void {
  cache = null;
}

export async function getPlanCatalog(): Promise<PublicPlanCatalog> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;

  const { rows } = await pool.query(
    `SELECT name, display_name, price_ars, price_ars_yearly,
            daily_ai_limit, daily_document_limit, is_featured, custom_pricing
       FROM plans
      WHERE is_active AND is_public
      ORDER BY custom_pricing ASC, price_ars ASC, id ASC`,
  );

  const trialDays = (await getSettingNumber('TRIAL_DAYS')) ?? DEFAULT_TRIAL_DAYS;
  const supportContact = ((await getSetting('SUPPORT_CONTACT')) ?? '').trim();

  const payload: PublicPlanCatalog = {
    trial_days: trialDays,
    support_contact: supportContact,
    plans: rows.map((p): PublicPlan => ({
      name: p.name,
      display_name: p.display_name,
      price_ars: p.custom_pricing ? null : Number(p.price_ars ?? 0),
      price_ars_yearly: p.price_ars_yearly != null ? Number(p.price_ars_yearly) : null,
      daily_ai_limit: p.daily_ai_limit != null ? Number(p.daily_ai_limit) : null,
      daily_document_limit: p.daily_document_limit != null ? Number(p.daily_document_limit) : null,
      featured: Boolean(p.is_featured),
      custom_pricing: Boolean(p.custom_pricing),
    })),
  };
  cache = { at: Date.now(), payload };
  return payload;
}
