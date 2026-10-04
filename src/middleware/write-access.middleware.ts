// Prueba vencida = solo lectura, también en el dashboard.
//
// El paywall de prueba vencida era solo visual (PaywallModal en el frontend):
// ninguna ruta REST consultaba el modo de acceso, así que con la prueba vencida
// se podía seguir creando campos, gastos y animales desde el dashboard
// (auditoría oct 2026, AIS-17). Este middleware corta toda escritura bajo
// /api/auth con el MISMO `getUserAccessMode` que corta el bot.
//
// Quedan abiertas las rutas que el usuario necesita justamente cuando venció:
// entrar y verificar la cuenta, pagar o cancelar, exportar y borrar sus datos,
// y salir de un campo compartido. Una ruta de escritura nueva queda cortada por
// defecto; si tiene que funcionar con la prueba vencida, se agrega acá.
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth.middleware.js';

const OPEN_WRITE_PATHS: RegExp[] = [
  /^\/(login|logout|refresh|register|forgot-password|reset-password|resend-verification|verify-email)$/,
  /^\/verify\//,
  /^\/me(\/password)?$/,          // datos de la cuenta y borrar la cuenta (DELETE /me)
  /^\/push\//,
  /^\/subscription\//,            // pagar / cancelar
  /^\/sharing\/join$/,            // el acceso lo hereda del dueño si el dueño está al día
  /^\/sharing\/fields\/[^/]+\/members\/[^/]+$/, // salir de un campo compartido
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireWriteAccess(req: Request, res: Response, next: NextFunction): void {
  if (READ_METHODS.has(req.method) || OPEN_WRITE_PATHS.some((re) => re.test(req.path))) {
    next();
    return;
  }
  // Toda escritura no abierta ya exige sesión: autenticar acá es equivalente y
  // da el userId para consultar el modo de acceso.
  requireAuth(req, res, () => {
    void (async () => {
      try {
        const { getUserAccessMode } = await import('../services/access-gate.service.js');
        if (await getUserAccessMode(Number(req.auth!.userId)) === 'trial_expired_readonly') {
          console.log(`[TRIAL_EXPIRED] user=${req.auth!.userId} escritura bloqueada en el dashboard: ${req.method} ${req.path}`);
          res.status(403).json({
            error: 'Tu prueba gratis terminó. Tus datos siguen guardados: elegí un plan para volver a cargar.',
            code: 'TRIAL_EXPIRED',
          });
          return;
        }
        next();
      } catch (err) {
        next(err);
      }
    })();
  });
}
