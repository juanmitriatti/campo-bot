-- farmer_vocabulary: stores learned words/phrases per farmer
CREATE TABLE IF NOT EXISTS farmer_vocabulary (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  phrase TEXT NOT NULL,
  normalized_phrase TEXT NOT NULL,
  resolved_value TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence FLOAT NOT NULL DEFAULT 0.5,
  hit_count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, normalized_phrase, category)
);

CREATE INDEX IF NOT EXISTS idx_farmer_vocab_user ON farmer_vocabulary(user_id);
CREATE INDEX IF NOT EXISTS idx_farmer_vocab_lookup ON farmer_vocabulary(user_id, category, confidence);

-- message_patterns: stores successful message → intent mappings
CREATE TABLE IF NOT EXISTS message_patterns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  normalized_message TEXT NOT NULL,
  intent TEXT NOT NULL,
  entities JSONB NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'parser',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_patterns_user ON message_patterns(user_id);
CREATE INDEX IF NOT EXISTS idx_message_patterns_intent ON message_patterns(user_id, intent);
