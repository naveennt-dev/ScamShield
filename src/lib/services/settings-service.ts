import { getEnv } from "@/lib/config/env";
import { prisma, isDatabaseConfigured } from "@/lib/db/prisma";
import type { UpdateSettingsInput } from "@/lib/schemas/api";

export interface EffectiveSettings {
  storeContentPreview: boolean;
  retentionDays: number;
  allowLlmAnalysis: boolean;
}

export async function getSettings(userId: string | null): Promise<EffectiveSettings> {
  const defaults: EffectiveSettings = {
    storeContentPreview: true,
    retentionDays: getEnv().DEFAULT_RETENTION_DAYS,
    allowLlmAnalysis: true,
  };
  if (!userId || !isDatabaseConfigured()) return defaults;
  const s = await prisma.userSettings.findUnique({ where: { userId } });
  return s
    ? { storeContentPreview: s.storeContentPreview, retentionDays: s.retentionDays, allowLlmAnalysis: s.allowLlmAnalysis }
    : defaults;
}

export async function updateSettings(userId: string, patch: UpdateSettingsInput): Promise<EffectiveSettings> {
  const current = await getSettings(userId);
  const next = { ...current, ...patch };
  await prisma.userSettings.upsert({
    where: { userId },
    create: { userId, ...next },
    update: next,
  });
  return next;
}
