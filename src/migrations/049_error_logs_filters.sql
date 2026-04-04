-- Migration 049: Add indexes for error_logs filtering
CREATE INDEX IF NOT EXISTS idx_error_logs_error_type ON error_logs (error_type);
CREATE INDEX IF NOT EXISTS idx_error_logs_severity ON error_logs (severity);
