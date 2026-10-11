-- CreateEnum
CREATE TYPE "ContributionStatus" AS ENUM ('QUARANTINED', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "Contribution" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "contributorHash" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "label" TEXT,
    "systemLevel" "RiskLevel" NOT NULL,
    "systemScore" INTEGER NOT NULL,
    "category" TEXT,
    "appVersion" TEXT NOT NULL,
    "modelBuild" TEXT,
    "flags" TEXT[],
    "status" "ContributionStatus" NOT NULL DEFAULT 'QUARANTINED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contribution_fingerprint_idx" ON "Contribution"("fingerprint");

-- CreateIndex
CREATE INDEX "Contribution_status_idx" ON "Contribution"("status");

-- CreateIndex
CREATE INDEX "Contribution_contributorHash_idx" ON "Contribution"("contributorHash");

-- CreateIndex
CREATE UNIQUE INDEX "Contribution_fingerprint_contributorHash_key" ON "Contribution"("fingerprint", "contributorHash");
