/**
 * feature.middleware.ts — gate de plan para rutas HTTP.
 *
 * Vivía como función local de auth.routes.ts; el router de análisis de datos
 * lo necesita también y una segunda copia divergiría (misma historia que
 * accessible-fields.ts). Una sola instancia de FeatureGate: su cache por plan
 * (5 min) se comparte entre routers.
 */

import type { Request, Response, NextFunction } from 'express';
import { FeatureGate } from '../domain/billing/feature-gate.js';
import { asUserId, type FeatureKey } from '../types/index.js';

export const featureGate = new FeatureGate();

export function requireFeature(feature: FeatureKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const hasAccess = await featureGate.hasFeature(asUserId(req.auth!.userId), feature);
    if (!hasAccess) {
      res.status(403).json({ error: 'Feature not available in your plan' });
      return;
    }
    next();
  };
}
