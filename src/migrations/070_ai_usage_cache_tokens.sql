-- Track cache_read_input_tokens and cache_creation_input_tokens from Anthropic
-- responses so the dashboard can show the real cost (cache writes cost 125% of
-- normal input, cache reads only 10% — hiding them underestimates the bill).
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cache_read_tokens INT DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cache_write_tokens INT DEFAULT 0;
