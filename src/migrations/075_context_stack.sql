-- Migration 075: Add context_stack to conversation_state
-- Stores last 3 field/plot references for multi-slot pronoun resolution
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS context_stack JSONB DEFAULT '[]';
