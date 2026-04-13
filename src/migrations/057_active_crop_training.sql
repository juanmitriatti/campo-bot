-- Add training examples for active_crop tool to teach the AI model
-- that "donde hay soja" type queries should use active_crop, not query_plot_history

INSERT INTO ai_training_examples (input, intent, expected_output, is_active)
VALUES
  ('donde hay soja', 'active_crop', '{"intent": "active_crop", "crop": "Soja", "confidence": 0.95}', true),
  ('qué tengo sembrado', 'active_crop', '{"intent": "active_crop", "confidence": 0.95}', true),
  ('en qué lotes hay trigo', 'active_crop', '{"intent": "active_crop", "crop": "Trigo", "confidence": 0.95}', true)
ON CONFLICT DO NOTHING;
