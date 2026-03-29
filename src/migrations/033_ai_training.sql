-- 033: AI Training system — few-shot examples + feedback loop

CREATE TABLE IF NOT EXISTS ai_training_examples (
  id SERIAL PRIMARY KEY,
  input TEXT NOT NULL,
  expected_output JSONB NOT NULL,
  intent VARCHAR(60) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_training_intent_active ON ai_training_examples(intent, is_active);

ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS confidence FLOAT;
ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS corrected_intent VARCHAR(60);
ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS was_correct BOOLEAN;
