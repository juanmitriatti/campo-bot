-- Widen varchar(100) columns that receive AI-generated or user-typed free
-- text and could plausibly exceed 100 chars. The QA "Roberto" chaos persona
-- triggered "value too long for type character varying(100)" during a spray
-- flow; without specific logs we can't pinpoint the exact column, so bump
-- the most likely-affected columns to varchar(255) defensively.

ALTER TABLE domain_events ALTER COLUMN product TYPE varchar(255);
ALTER TABLE stock_movements ALTER COLUMN reason TYPE varchar(255);
ALTER TABLE harvest_loads ALTER COLUMN driver_name TYPE varchar(255);
ALTER TABLE harvest_loads ALTER COLUMN destinatario TYPE varchar(255);
ALTER TABLE crop_scoutings ALTER COLUMN pest_species TYPE varchar(255);
ALTER TABLE plots ALTER COLUMN grupo TYPE varchar(255);
ALTER TABLE deletion_log ALTER COLUMN parent_name TYPE varchar(255);
ALTER TABLE deletion_log ALTER COLUMN entity_name TYPE varchar(255);
ALTER TABLE map_tokens ALTER COLUMN field_name TYPE varchar(255);
