-- CreateEnum
CREATE TYPE "InputType" AS ENUM ('MESSAGE', 'URL', 'IMAGE', 'EMAIL');

-- CreateEnum
CREATE TYPE "Classification" AS ENUM ('SAFE', 'SUSPICIOUS', 'SCAM');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('SAFE', 'SUSPICIOUS', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PatternType" AS ENUM ('MESSAGE_FINGERPRINT', 'DOMAIN');

-- CreateEnum
CREATE TYPE "PatternStatus" AS ENUM ('UNVERIFIED', 'TRUSTED', 'REJECTED');

-- CreateTable
CREATE TABLE "user_settings" (
    "userId" TEXT NOT NULL,
    "storeContentPreview" BOOLEAN NOT NULL DEFAULT true,
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "allowLlmAnalysis" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "scam_analysis" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "requestId" TEXT NOT NULL,
    "inputType" "InputType" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "simhash" TEXT,
    "contentPreview" TEXT,
    "contentLength" INTEGER NOT NULL,
    "classification" "Classification" NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL,
    "riskScore" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "category" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "aiSummary" TEXT,
    "reasons" JSONB NOT NULL,
    "recommendedActions" JSONB NOT NULL,
    "signals" JSONB NOT NULL,
    "adjustments" JSONB NOT NULL,
    "llmProvider" TEXT,
    "llmModel" TEXT,
    "llmStatus" TEXT NOT NULL,
    "mlModelVersion" TEXT,
    "processingTimeMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scam_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scam_indicator" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "category" TEXT,

    CONSTRAINT "scam_indicator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "url_analysis" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT,
    "urlHash" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "domain" TEXT,
    "riskScore" INTEGER NOT NULL,
    "flags" JSONB NOT NULL,
    "redirectCount" INTEGER NOT NULL DEFAULT 0,
    "finalDomain" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "url_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scam_report" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "analysisId" TEXT,
    "reportType" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "domain" TEXT,
    "contentPreview" TEXT NOT NULL,
    "note" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scam_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scam_pattern" (
    "id" TEXT NOT NULL,
    "patternType" "PatternType" NOT NULL,
    "value" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "simhash" TEXT,
    "simhashBand0" INTEGER,
    "simhashBand1" INTEGER,
    "simhashBand2" INTEGER,
    "simhashBand3" INTEGER,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "distinctReporters" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "PatternStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scam_pattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_event" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT,
    "analysisId" TEXT,
    "eventType" TEXT NOT NULL,
    "inputType" TEXT,
    "latencyMs" INTEGER,
    "errorCode" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scam_analysis_userId_createdAt_idx" ON "scam_analysis"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "scam_analysis_createdAt_idx" ON "scam_analysis"("createdAt");

-- CreateIndex
CREATE INDEX "scam_analysis_classification_idx" ON "scam_analysis"("classification");

-- CreateIndex
CREATE INDEX "scam_analysis_category_idx" ON "scam_analysis"("category");

-- CreateIndex
CREATE INDEX "scam_analysis_riskScore_idx" ON "scam_analysis"("riskScore");

-- CreateIndex
CREATE INDEX "scam_analysis_fingerprint_idx" ON "scam_analysis"("fingerprint");

-- CreateIndex
CREATE INDEX "scam_analysis_expiresAt_idx" ON "scam_analysis"("expiresAt");

-- CreateIndex
CREATE INDEX "scam_indicator_analysisId_idx" ON "scam_indicator"("analysisId");

-- CreateIndex
CREATE INDEX "scam_indicator_type_idx" ON "scam_indicator"("type");

-- CreateIndex
CREATE INDEX "url_analysis_analysisId_idx" ON "url_analysis"("analysisId");

-- CreateIndex
CREATE INDEX "url_analysis_domain_idx" ON "url_analysis"("domain");

-- CreateIndex
CREATE INDEX "url_analysis_urlHash_idx" ON "url_analysis"("urlHash");

-- CreateIndex
CREATE INDEX "url_analysis_createdAt_idx" ON "url_analysis"("createdAt");

-- CreateIndex
CREATE INDEX "scam_report_userId_createdAt_idx" ON "scam_report"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "scam_report_fingerprint_idx" ON "scam_report"("fingerprint");

-- CreateIndex
CREATE INDEX "scam_report_domain_idx" ON "scam_report"("domain");

-- CreateIndex
CREATE INDEX "scam_report_category_idx" ON "scam_report"("category");

-- CreateIndex
CREATE UNIQUE INDEX "scam_report_userId_fingerprint_key" ON "scam_report"("userId", "fingerprint");

-- CreateIndex
CREATE INDEX "scam_pattern_simhashBand0_idx" ON "scam_pattern"("simhashBand0");

-- CreateIndex
CREATE INDEX "scam_pattern_simhashBand1_idx" ON "scam_pattern"("simhashBand1");

-- CreateIndex
CREATE INDEX "scam_pattern_simhashBand2_idx" ON "scam_pattern"("simhashBand2");

-- CreateIndex
CREATE INDEX "scam_pattern_simhashBand3_idx" ON "scam_pattern"("simhashBand3");

-- CreateIndex
CREATE INDEX "scam_pattern_category_idx" ON "scam_pattern"("category");

-- CreateIndex
CREATE INDEX "scam_pattern_lastSeen_idx" ON "scam_pattern"("lastSeen");

-- CreateIndex
CREATE UNIQUE INDEX "scam_pattern_patternType_value_key" ON "scam_pattern"("patternType", "value");

-- CreateIndex
CREATE INDEX "analysis_event_userId_createdAt_idx" ON "analysis_event"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "analysis_event_eventType_createdAt_idx" ON "analysis_event"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "analysis_event_createdAt_idx" ON "analysis_event"("createdAt");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scam_analysis" ADD CONSTRAINT "scam_analysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scam_indicator" ADD CONSTRAINT "scam_indicator_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "scam_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_analysis" ADD CONSTRAINT "url_analysis_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "scam_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scam_report" ADD CONSTRAINT "scam_report_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scam_report" ADD CONSTRAINT "scam_report_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "scam_analysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_event" ADD CONSTRAINT "analysis_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_event" ADD CONSTRAINT "analysis_event_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "scam_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
