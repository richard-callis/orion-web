-- Migration: add token tracking columns to chat_rooms
-- tokenCount: rolling prompt_tokens from the last LLM turn (used for context utilisation tracking)
-- tokenLimit: optional override for the context window size; null = auto-discover from model /props

ALTER TABLE "chat_rooms" ADD COLUMN IF NOT EXISTS "tokenCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "chat_rooms" ADD COLUMN IF NOT EXISTS "tokenLimit" INTEGER;
