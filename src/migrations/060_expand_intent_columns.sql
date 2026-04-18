-- Expand intent-related VARCHAR(60) columns to VARCHAR(200).
-- The admin UI lets users paste full tool-call signatures like:
--   set_plot_grupo(plotNames=["11c","9b","11a"], grupo="lio aure")
-- which exceed 60 chars and produce a PG error → 500.

ALTER TABLE conversation_logs ALTER COLUMN corrected_intent TYPE VARCHAR(200);
ALTER TABLE ai_training_examples ALTER COLUMN intent TYPE VARCHAR(200);
