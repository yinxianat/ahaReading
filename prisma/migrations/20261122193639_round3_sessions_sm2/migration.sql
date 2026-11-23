-- AlterTable
ALTER TABLE "Concept" ADD COLUMN     "repetitions" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;
