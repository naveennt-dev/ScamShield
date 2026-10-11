import { PrismaClient } from "@prisma/client";

/**
 * Single PrismaClient per process (prevents connection exhaustion during dev HMR and in
 * serverless warm starts). Shared by better-auth and the ScamShield services.
 */
const globalForPrisma = globalThis as unknown as { __scamshieldPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__scamshieldPrisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.__scamshieldPrisma = prisma;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
