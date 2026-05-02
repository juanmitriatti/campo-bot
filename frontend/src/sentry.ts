import * as Sentry from '@sentry/react';

let initialized = false;

interface PublicConfig {
  sentry?: { dsn: string | null; environment: string; tracesSampleRate: number };
}

/**
 * Fetch the public-config endpoint and initialize Sentry when a DSN is
 * present. Backend is the source of truth so we don't hardcode the DSN in
 * the bundle. Failures are swallowed — Sentry just stays a no-op.
 */
export async function initSentry(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await fetch('/api/auth/public-config', { method: 'GET' });
    if (!res.ok) return;
    const cfg = (await res.json()) as PublicConfig;
    const dsn = cfg.sentry?.dsn;
    if (!dsn) return;

    Sentry.init({
      dsn,
      environment: cfg.sentry?.environment ?? 'production',
      tracesSampleRate: cfg.sentry?.tracesSampleRate ?? 0.1,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    });
  } catch {
    // Network or parse error — leave Sentry disabled.
  }
}

export { Sentry };
