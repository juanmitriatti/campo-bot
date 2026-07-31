-- 103_user_alerts_optout.sql
-- Opt-out por usuario de alertas proactivas (clima, monitoreo, plagas, stock bajo, fenología).
-- Default TRUE: el usuario recibe alertas salvo que diga "no más alertas".
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN DEFAULT TRUE;
