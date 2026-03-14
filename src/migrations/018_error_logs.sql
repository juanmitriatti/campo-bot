CREATE TABLE IF NOT EXISTS error_logs (
  id SERIAL PRIMARY KEY,
  service VARCHAR(50) NOT NULL,
  error_type VARCHAR(100) NOT NULL,
  message TEXT NOT NULL,
  user_id INT NULL,
  phone VARCHAR(30) NULL,
  request_context TEXT NULL,
  severity VARCHAR(20) DEFAULT 'error',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_service ON error_logs(service);
CREATE INDEX IF NOT EXISTS idx_error_created ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_user ON error_logs(user_id);
