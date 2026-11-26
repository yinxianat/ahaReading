-- CreateTable
CREATE TABLE "AudioSeries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "articleId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceTitle" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "partMinutes" INTEGER NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastListenedAt" TIMESTAMP(3),

    CONSTRAINT "AudioSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioPart" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "focus" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "chapters" JSONB,
    "words" INTEGER NOT NULL DEFAULT 0,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "generatedAt" TIMESTAMP(3),
    "audioKey" TEXT,
    "positionChapter" INTEGER NOT NULL DEFAULT 0,
    "positionSentence" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioPart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AudioSeries_userId_updatedAt_idx" ON "AudioSeries"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AudioPart_generatedAt_idx" ON "AudioPart"("generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AudioPart_seriesId_order_key" ON "AudioPart"("seriesId", "order");

-- AddForeignKey
ALTER TABLE "AudioSeries" ADD CONSTRAINT "AudioSeries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioSeries" ADD CONSTRAINT "AudioSeries_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioPart" ADD CONSTRAINT "AudioPart_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "AudioSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
