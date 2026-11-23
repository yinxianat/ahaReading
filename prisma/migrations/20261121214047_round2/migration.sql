-- DropIndex
DROP INDEX "LogEntry_level_updatedAt_idx";

-- DropIndex
DROP INDEX "LogEntry_source_updatedAt_idx";

-- AlterTable
ALTER TABLE "AiCall" ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "outputTokens" INTEGER;

-- AlterTable
ALTER TABLE "LogEntry" ADD COLUMN     "alertedAt" TIMESTAMP(3),
ADD COLUMN     "firstDetail" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: until now updatedAt doubled as "last seen", and the first detail is the best we have.
UPDATE "LogEntry" SET "lastSeenAt" = "updatedAt", "firstDetail" = "detail";

-- AlterTable
ALTER TABLE "MagicToken" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeHash" TEXT,
ADD COLUMN     "next" TEXT;

-- CreateIndex
CREATE INDEX "Concept_userId_articleId_idx" ON "Concept"("userId", "articleId");

-- CreateIndex
CREATE INDEX "LogEntry_level_lastSeenAt_idx" ON "LogEntry"("level", "lastSeenAt");

-- CreateIndex
CREATE INDEX "LogEntry_source_lastSeenAt_idx" ON "LogEntry"("source", "lastSeenAt");

-- CreateIndex
CREATE INDEX "MagicToken_expiresAt_idx" ON "MagicToken"("expiresAt");
