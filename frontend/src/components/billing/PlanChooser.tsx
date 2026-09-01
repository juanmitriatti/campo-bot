import { useState } from 'react';
import type { BillingPeriod, PublicPlan } from '../../api/subscription';
import { formatArs, supportMailto, yearlySavings } from '../../api/subscription';

/**
 * Grilla de planes con toggle mensual/anual. La usan el paywall de prueba
 * vencida y la tarjeta de Mi cuenta: si cada uno armara su propia grilla,
 * el precio del modal y el de la tarjeta se irían separando solos.
 *
 * Los planes llegan del backend (`/subscription` → catálogo comercial), que es
 * la misma fuente que alimenta la landing. Acá NO se hardcodea ni un precio ni
 * un nombre de plan.
 */

interface Props {
  plans: PublicPlan[];
  /** Plan actual del usuario, para marcarlo y no ofrecerle comprar lo mismo. */
  currentPlanName?: string | null;
  supportContact?: string;
  busy?: boolean;
  onCheckout: (planName: string, period: BillingPeriod) => void;
}

/**
 * Qué gana el usuario en cada plan. Es copy comercial corto; la lista completa
 * vive en la landing. Se indexa por `name`: un plan nuevo sin entrada acá
 * muestra sus límites igual, nunca rompe la grilla.
 */
const BLURB: Record<string, string> = {
  pro: 'Todo el bot para tu campo: labores, hacienda, stock, audios y fotos de facturas.',
  pro_plus: 'Todo lo de Pro y además compartís tus campos con socios, tu ingeniero o tu contador.',
  enterprise: 'Para empresas y administradoras: multi-usuario, permisos por campo e integraciones.',
};

export default function PlanChooser({ plans, currentPlanName, supportContact, busy, onCheckout }: Props) {
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const anyYearly = plans.some(p => p.price_ars_yearly != null);

  if (plans.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No hay planes disponibles en este momento. Escribinos y lo resolvemos.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {anyYearly && (
        <div className="flex justify-center">
          <div className="inline-flex rounded-full border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 p-1">
            {([['monthly', 'Mensual'], ['yearly', 'Anual']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setPeriod(value)}
                aria-pressed={period === value}
                className={`min-h-[44px] rounded-full px-5 text-sm font-semibold transition-colors ${
                  period === value
                    ? 'bg-campo-600 text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map(plan => {
          const savings = yearlySavings(plan);
          const showYearly = period === 'yearly' && plan.price_ars_yearly != null;
          const price = plan.custom_pricing
            ? null
            : showYearly
              ? plan.price_ars_yearly!
              : plan.price_ars ?? 0;
          const isCurrent = currentPlanName === plan.name;
          const mailto = plan.custom_pricing && supportContact
            ? supportMailto(supportContact, `Consulta plan ${plan.display_name} — Campo Bot`)
            : null;

          return (
            <div
              key={plan.name}
              className={`relative flex flex-col rounded-xl border-2 p-5 ${
                plan.featured
                  ? 'border-campo-600 bg-campo-50/60 dark:bg-campo-900/20'
                  : 'border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800'
              }`}
            >
              {plan.featured && (
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-campo-600 px-2.5 py-0.5 text-[11px] font-bold text-white">
                  MÁS ELEGIDO
                </span>
              )}

              <div className="flex items-baseline justify-between gap-2">
                <h4 className="font-semibold text-gray-900 dark:text-gray-100">{plan.display_name}</h4>
                {isCurrent && (
                  <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">tu plan</span>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-baseline gap-1.5">
                <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {price == null ? 'A medida' : formatArs(price)}
                </span>
                {price != null && (
                  <span className="text-sm text-gray-500 dark:text-gray-400">{showYearly ? '/año' : '/mes'}</span>
                )}
                {showYearly && savings > 0 && (
                  <span className="rounded-full bg-campo-100 dark:bg-campo-900/50 px-1.5 py-0.5 text-[11px] font-semibold text-campo-700 dark:text-campo-300">
                    {savings}% off
                  </span>
                )}
              </div>
              {showYearly && plan.price_ars_yearly != null && (
                <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                  equivale a {formatArs(Math.round(plan.price_ars_yearly / 12))}/mes
                </p>
              )}

              <p className="mt-3 flex-1 text-sm text-gray-600 dark:text-gray-300">{BLURB[plan.name] ?? ''}</p>

              {(plan.daily_ai_limit != null || plan.daily_document_limit != null) && (
                <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
                  {plan.daily_ai_limit != null && <>{plan.daily_ai_limit} consultas con IA por día</>}
                  {plan.daily_ai_limit != null && plan.daily_document_limit != null && ' · '}
                  {plan.daily_document_limit != null && <>{plan.daily_document_limit} documentos por día</>}
                </p>
              )}

              {plan.custom_pricing ? (
                mailto ? (
                  <a
                    href={mailto}
                    className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-lg border border-campo-600 px-4 text-sm font-semibold text-campo-700 dark:text-campo-300 hover:bg-campo-50 dark:hover:bg-campo-900/30 transition-colors"
                  >
                    Escribinos
                  </a>
                ) : (
                  <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                    Escribinos{supportContact ? `: ${supportContact}` : ''} y lo armamos a tu medida.
                  </p>
                )
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onCheckout(plan.name, showYearly ? 'yearly' : 'monthly')}
                  className={`mt-4 min-h-[44px] rounded-lg px-4 text-sm font-semibold transition-colors disabled:opacity-50 ${
                    plan.featured
                      ? 'bg-campo-600 text-white hover:bg-campo-700 active:bg-campo-800'
                      : 'border border-campo-600 text-campo-700 dark:text-campo-300 hover:bg-campo-50 dark:hover:bg-campo-900/30'
                  }`}
                >
                  {busy ? 'Redirigiendo…' : `Pagar ${plan.display_name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-center text-xs text-gray-400 dark:text-gray-500">
        Pago seguro procesado por MercadoPago. Cancelás cuando quieras.
      </p>
    </div>
  );
}
