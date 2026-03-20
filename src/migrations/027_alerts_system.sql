-- Alert history table
CREATE TABLE IF NOT EXISTS alert_history (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  alert_type VARCHAR(50) NOT NULL,  -- 'weather', 'budget_80', 'budget_100', 'monitoring_reminder', 'pest_escalation'
  field_id INT REFERENCES fields(id),
  plot_id INT REFERENCES plots(id),
  message TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'sent',  -- 'sent', 'failed', 'retrying', 'deduped'
  retry_count INT DEFAULT 0,
  dedup_key VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alert_history_user ON alert_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_type ON alert_history(alert_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_dedup ON alert_history(dedup_key, created_at DESC);
