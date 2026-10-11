-- CreateEnum
CREATE TYPE "IntelKind" AS ENUM ('DOMAIN', 'URL');

-- CreateEnum
CREATE TYPE "IntelStatus" AS ENUM ('UNKNOWN', 'SUSPICIOUS', 'CONFIRMED_MALICIOUS', 'BENIGN');

-- CreateEnum
CREATE TYPE "IntelSource" AS ENUM ('USER_REPORT', 'LOCAL_RULE', 'IMPORTED_PUBLIC', 'VERIFIED');

-- CreateTable
CREATE TABLE "scam_intel" (
    "id" TEXT NOT NULL,
    "kind" "IntelKind" NOT NULL,
    "key" TEXT NOT NULL,
    "sourceType" "IntelSource" NOT NULL,
    "status" "IntelStatus" NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "observations" INTEGER NOT NULL DEFAULT 1,
    "explanation" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "updateMethod" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "scam_intel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scam_intel_kind_key_idx" ON "scam_intel"("kind", "key");

-- CreateIndex
CREATE INDEX "scam_intel_expiresAt_idx" ON "scam_intel"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "scam_intel_kind_key_sourceType_key" ON "scam_intel"("kind", "key", "sourceType");
