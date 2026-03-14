CREATE TABLE IF NOT EXISTS audio_transcription_logs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  audio_duration_seconds NUMERIC,
  provider VARCHAR(50),
  model VARCHAR(50),
  tokens_used INT,
  cost_usd NUMERIC,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audio_transcription_logs_user_id ON audio_transcription_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audio_transcription_logs_created_at ON audio_transcription_logs(created_at);
