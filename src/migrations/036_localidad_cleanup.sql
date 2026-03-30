-- Migration 036: Remove ghost columns + add province to fields
-- Ghost features: plots.lat/lng, fields.location, users.address/postal_code

ALTER TABLE plots DROP COLUMN IF EXISTS lat;
ALTER TABLE plots DROP COLUMN IF EXISTS lng;
ALTER TABLE fields DROP COLUMN IF EXISTS location;
ALTER TABLE users DROP COLUMN IF EXISTS address;
ALTER TABLE users DROP COLUMN IF EXISTS postal_code;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS province VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS province VARCHAR(100);
