import { pool } from '../config/db.js';
import type { PendingFieldLocation } from './pending-field-location.js';
import type { UserId } from '../types/index.js';

export interface PendingLocationResult {
  messages: string[];
  clearPending: boolean;
}

interface NominatimResult {
  city?: string;
  province?: string;
}

async function reverseGeocode(lat: number, lng: number): Promise<NominatimResult> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'campo-bot/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return {};
    const data = await response.json();
    const address = data?.address;
    if (!address) return {};

    const city = address.city || address.town || address.village || address.municipality || null;
    const province = address.state || null;
    return { city: city ?? undefined, province: province ?? undefined };
  } catch {
    return {};
  }
}

export async function handlePendingLocation(
  lat: number,
  lng: number,
  pending: PendingFieldLocation,
  _userId: UserId,
): Promise<PendingLocationResult> {
  // Save coordinates to field
  await pool.query(
    `UPDATE fields SET latitude = $1, longitude = $2, location_method = 'coordinates' WHERE id = $3`,
    [lat, lng, pending.fieldId],
  );

  // Reverse geocode (non-blocking — coordinates already saved)
  const geo = await reverseGeocode(lat, lng);

  if (geo.city) {
    await pool.query(
      `UPDATE fields SET city = COALESCE(city, $1), province = COALESCE(province, $2) WHERE id = $3`,
      [geo.city, geo.province ?? null, pending.fieldId],
    );
    const location = geo.province ? `${geo.city}, ${geo.province}` : geo.city;
    return {
      messages: [`📍 Ubicación guardada para *${pending.fieldName}*.\nLocalidad detectada: *${location}*`],
      clearPending: true,
    };
  }

  return {
    messages: [`📍 Ubicación guardada para *${pending.fieldName}* (${lat.toFixed(4)}, ${lng.toFixed(4)}).`],
    clearPending: true,
  };
}
