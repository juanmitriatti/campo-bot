import express from 'express';
import type { Request, Response } from 'express';
import { MapTokenService } from '../services/map-token.service.js';
import { pool } from '../config/db.js';
import { sendMessage } from '../services/whatsapp.js';
import { sendTelegramMessage } from '../services/telegram.js';

const router = express.Router();
const mapTokenService = new MapTokenService();

// GET /api/map/:token — validate token and return field info
router.get('/:token', async (req: Request, res: Response) => {
  try {
    const tokenRow = await mapTokenService.validateToken(req.params.token);
    if (!tokenRow) {
      res.status(404).json({ error: 'Token inválido o expirado' });
      return;
    }
    // Centro inicial del mapa: coords del campo (mapa/GPS previo) o centroide del
    // censo para su ciudad — el productor arranca viendo SU zona, no Argentina entera.
    let center: { lat: number; lon: number } | null = null;
    try {
      const { pool } = await import('../config/db.js');
      const fr = await pool.query(
        `SELECT latitude, longitude, city, province FROM fields WHERE id = $1`,
        [tokenRow.field_id],
      );
      const f = fr.rows[0];
      if (f) {
        if (f.latitude != null && f.longitude != null) {
          center = { lat: Number(f.latitude), lon: Number(f.longitude) };
        } else if (f.city) {
          const { localidadLookup } = await import('../services/localidad-lookup.service.js');
          center = localidadLookup.coordsFor(f.city, f.province);
        }
      }
    } catch { /* sin centro: la página cae al default nacional */ }
    res.json({
      fieldName: tokenRow.field_name,
      expiresAt: tokenRow.expires_at,
      center,
    });
  } catch (err) {
    console.error('[map] GET token error:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/map/:token — save polygon
router.post('/:token', async (req: Request, res: Response) => {
  try {
    const tokenRow = await mapTokenService.validateToken(req.params.token);
    if (!tokenRow) {
      res.status(404).json({ error: 'Token inválido o expirado' });
      return;
    }

    const { polygon } = req.body;
    if (!Array.isArray(polygon) || polygon.length < 3) {
      res.status(400).json({ error: 'El polígono necesita al menos 3 puntos' });
      return;
    }

    // Validate each point is [lat, lng]
    for (const point of polygon) {
      if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number') {
        res.status(400).json({ error: 'Cada punto debe ser [lat, lng]' });
        return;
      }
    }

    // Compute centroid
    let latSum = 0;
    let lngSum = 0;
    for (const [lat, lng] of polygon) {
      latSum += lat;
      lngSum += lng;
    }
    const centroidLat = latSum / polygon.length;
    const centroidLng = lngSum / polygon.length;

    // Reverse geocode centroid
    let city: string | null = null;
    let province: string | null = null;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${centroidLat}&lon=${centroidLng}&zoom=10&addressdetails=1`;
      const geoRes = await fetch(url, {
        headers: { 'User-Agent': 'campo-bot/1.0' },
        signal: AbortSignal.timeout(5000),
      });
      if (geoRes.ok) {
        const data = await geoRes.json();
        const address = data?.address;
        if (address) {
          city = address.city || address.town || address.village || address.municipality || null;
          province = address.state || null;
        }
      }
    } catch {
      // Non-blocking — polygon still saved
    }

    // Save to field
    const fieldId = tokenRow.field_id;
    if (fieldId) {
      await pool.query(
        `UPDATE fields SET polygon = $1, latitude = $2, longitude = $3, location_method = 'map',
         city = COALESCE(city, $4), province = COALESCE(province, $5)
         WHERE id = $6`,
        [JSON.stringify(polygon), centroidLat, centroidLng, city, province, fieldId],
      );
    }

    // Mark token as used
    await mapTokenService.markUsed(req.params.token);

    // Send proactive message to user
    const locationStr = city
      ? (province ? `${city}, ${province}` : city)
      : `${centroidLat.toFixed(4)}, ${centroidLng.toFixed(4)}`;

    const message = `✅ Contorno guardado para *${tokenRow.field_name}*.\nUbicación: ${locationStr}`;

    try {
      if (tokenRow.channel === 'telegram') {
        const chatId = tokenRow.channel_id.replace(/^tg_/, '');
        await sendTelegramMessage(chatId, message);
      } else {
        await sendMessage(tokenRow.channel_id, message);
      }
    } catch (sendErr) {
      console.error('[map] Failed to send proactive message:', sendErr);
    }

    res.json({ ok: true, city, province });
  } catch (err) {
    console.error('[map] POST token error:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
