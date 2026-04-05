-- Document processing: invoices, receipts, tickets
-- Stores metadata + extracted data; files stored on disk

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  document_type VARCHAR(20) NOT NULL DEFAULT 'otro',
  original_filename VARCHAR(255),
  mime_type VARCHAR(100) NOT NULL,
  file_size_bytes INT NOT NULL,
  compressed_path VARCHAR(500),
  file_hash VARCHAR(64),
  extracted_data JSONB,
  processing_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  processing_error TEXT,
  linked_expense_id INT REFERENCES expenses(id) ON DELETE SET NULL,
  source_channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  processing_time_ms INT,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_user_date ON documents(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_file_hash ON documents(file_hash);
CREATE INDEX IF NOT EXISTS idx_documents_linked_expense ON documents(linked_expense_id);

CREATE TABLE IF NOT EXISTS document_usage (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  document_id INT REFERENCES documents(id),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_usage_user_date ON document_usage(user_id, created_at);

-- Daily limits per plan
ALTER TABLE plans ADD COLUMN IF NOT EXISTS daily_document_limit INT DEFAULT 1;
UPDATE plans SET daily_document_limit = 1 WHERE name = 'free';
UPDATE plans SET daily_document_limit = 10 WHERE name = 'pro';
UPDATE plans SET daily_document_limit = 25 WHERE name = 'pro_plus';
UPDATE plans SET daily_document_limit = 100 WHERE name = 'enterprise';

-- Feature flag
INSERT INTO features (key, description) VALUES ('documents', 'Procesamiento de facturas y comprobantes') ON CONFLICT (key) DO NOTHING;
INSERT INTO plan_features (plan_id, feature_id) SELECT p.id, f.id FROM plans p, features f WHERE f.key = 'documents' ON CONFLICT DO NOTHING;
