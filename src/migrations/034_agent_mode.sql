-- Migration 034: Add agent mode columns to conversation_logs
-- Supports the new AI Agent with tool_use pipeline

ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS tool_calls JSONB;
ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS agent_mode VARCHAR(10);
