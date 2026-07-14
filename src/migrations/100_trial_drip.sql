-- Drip de descubrimiento del trial (Jul 2026): mensajes proactivos en días
-- configurables del trial mostrando capacidades del bot. Tracking de qué
-- pasos ya se enviaron a cada usuario (índices del schedule), para no repetir.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS trial_drips_sent JSONB NOT NULL DEFAULT '[]';
