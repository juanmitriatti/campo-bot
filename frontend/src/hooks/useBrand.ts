import { useEffect, useState } from 'react';

/**
 * Nombre de la app desde el servidor (GET /api/brand, setting APP_NAME). Antes
 * "Campo Bot" estaba escrito a mano en cada pantalla y cambiar de marca era un
 * deploy. Un solo fetch por carga de página, compartido entre componentes; si
 * falla queda el default.
 */
export interface Brand {
  app_name: string;
  bot_name: string;
  support_contact: string;
}

export const DEFAULT_BRAND: Brand = { app_name: 'MiAgro', bot_name: 'MIA', support_contact: '' };

let cached: Brand | null = null;
let inflight: Promise<Brand> | null = null;

function loadBrand(): Promise<Brand> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch('/api/brand')
      .then((r) => (r.ok ? r.json() : DEFAULT_BRAND))
      .then((b: Partial<Brand>) => {
        cached = { ...DEFAULT_BRAND, ...b, app_name: b.app_name?.trim() || DEFAULT_BRAND.app_name };
        document.title = cached.app_name;
        return cached;
      })
      .catch(() => DEFAULT_BRAND);
  }
  return inflight;
}

export function useBrand(): Brand {
  const [brand, setBrand] = useState<Brand>(cached ?? DEFAULT_BRAND);
  useEffect(() => {
    let alive = true;
    loadBrand().then((b) => { if (alive) setBrand(b); });
    return () => { alive = false; };
  }, []);
  return brand;
}
