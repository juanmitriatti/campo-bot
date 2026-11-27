-- Id de cada mensaje de WhatsApp ya recibido. La deduplicación vivía solo en
-- memoria: un reintento de Meta después de un deploy o reinicio se procesaba de
-- nuevo y duplicaba el registro. Las filas se purgan a los 7 días.
CREATE TABLE IF NOT EXISTS wa_inbound_messages (
  message_id  text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_wa_inbound_messages_received ON wa_inbound_messages (received_at);
