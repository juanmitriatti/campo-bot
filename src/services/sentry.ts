import * as Sentry from '@sentry/node';

let initialized = false;
let enabled = false;

/**
 * Initialize Sentry. Reads from env first (synchronous boot path) and falls
 * back gracefully when SENTRY_DSN is empty — the SDK becomes a no-op so all
 * captureException/captureMessage calls are safe to leave in production code.
 *
 * Settings can also override via DB but we keep the boot path env-only to
 * avoid blocking startup on a DB query.
 */
export function initSentry(): void {
  if (initialized) return;
  initialized = true;

  const dsn = process.env.SENTRY_DSN || '';
  if (!dsn) {
    console.log('[sentry] SENTRY_DSN empty — Sentry disabled (no-op SDK).');
    return;
  }

  const environment = process.env.SENTRY_ENVIRONMENT || 'production';
  const sampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1');
  const release = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);

  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate: Number.isFinite(sampleRate) ? sampleRate : 0.1,
    // Don't auto-capture console errors — we already log structured errors via
    // logError() so this would double up.
    integrations: [],
  });
  enabled = true;
  console.log(`[sentry] Initialized (env=${environment}, sampleRate=${sampleRate}, release=${release ?? 'unknown'}).`);
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export function captureMessage(msg: string, level: 'fatal' | 'error' | 'warning' | 'info' = 'error'): void {
  if (!enabled) return;
  Sentry.captureMessage(msg, level);
}

export function setUser(userId: number | string | null): void {
  if (!enabled) return;
  Sentry.setUser(userId == null ? null : { id: String(userId) });
}

export { Sentry };
