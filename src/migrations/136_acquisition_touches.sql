-- De dónde llega cada usuario (oct 2026, antes de pautar). Sin esto no se
-- puede saber qué anuncio trae gente que paga.
--   - whatsapp: el `referral` que Meta adjunta al primer mensaje que llega
--     desde un anuncio Click-to-WhatsApp (o una publicación con botón de WA).
--     Se guarda con el HASH del teléfono (sha256 del canónico 549…, nunca el
--     número): el que llega del anuncio puede no tener cuenta todavía; se cruza
--     con sha256(users.phone_number) al reportar; una cuenta borrada (número NULL)
--     deja de cruzar sola.
--   - web: utm_* / fbclid / gclid de la primera visita (cookie first-party que
--     pone el servidor) y se ata al user_id al registrarse.
-- Una fila por toque; el reporte toma el primero de cada usuario.
CREATE TABLE IF NOT EXISTS acquisition_touches (
  id            BIGSERIAL PRIMARY KEY,
  channel       TEXT NOT NULL CHECK (channel IN ('whatsapp', 'web')),
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone_hash    TEXT,
  source        TEXT,          -- utm_source, o 'meta_ad' / 'meta_post' para WhatsApp
  medium        TEXT,
  campaign      TEXT,
  content       TEXT,
  term          TEXT,
  ad_id         TEXT,          -- referral.source_id (id del anuncio o la publicación)
  ad_headline   TEXT,
  click_id      TEXT,          -- ctwa_clid / fbclid / gclid
  landing_path  TEXT,
  referrer      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_acquisition_touches_user  ON acquisition_touches (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acquisition_touches_phone ON acquisition_touches (phone_hash) WHERE phone_hash IS NOT NULL;
