-- Add contextSize field to ExternalModel for explicit context window override.
-- When set, this value is used instead of auto-discovering n_ctx from the model's /props endpoint.
ALTER TABLE "ExternalModel" ADD COLUMN IF NOT EXISTS "contextSize" INTEGER;
