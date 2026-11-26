-- CreateTable
CREATE TABLE "AudioUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AudioUsage_userId_createdAt_idx" ON "AudioUsage"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "AudioUsage" ADD CONSTRAINT "AudioUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
