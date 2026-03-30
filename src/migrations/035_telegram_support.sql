-- 035: Telegram support
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id VARCHAR(30);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users (telegram_id) WHERE telegram_id IS NOT NULL;

ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'whatsapp';
