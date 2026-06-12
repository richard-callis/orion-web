-- AlterTable: add selfHosted flag and pricing fields to ExternalModel
ALTER TABLE "ExternalModel"
  ADD COLUMN "selfHosted"       BOOLEAN          NOT NULL DEFAULT false,
  ADD COLUMN "inputPricePer1M"  DECIMAL(10,6),
  ADD COLUMN "outputPricePer1M" DECIMAL(10,6);
