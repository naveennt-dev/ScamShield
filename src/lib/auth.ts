import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/db/prisma";

/**
 * better-auth configuration (Google OAuth, unchanged behaviour) using the shared Prisma client.
 *
 * Email/password sign-in is OFF by default and exists for local development and automated E2E
 * tests (AUTH_ENABLE_EMAIL_PASSWORD=true). Do not enable it in production without adding email
 * verification and password policies.
 */

const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const emailPasswordEnabled = process.env.AUTH_ENABLE_EMAIL_PASSWORD === "true";

if (process.env.NODE_ENV === "production" && emailPasswordEnabled && process.env.NEXT_PHASE !== "phase-production-build") {
  console.warn(JSON.stringify({ level: "warn", event: "auth_email_password_enabled_in_production" }));
}

const trustedOrigins = [
  process.env.BETTER_AUTH_URL,
  process.env.APP_URL,
  ...(process.env.CORS_ALLOWED_ORIGINS ?? "").split(","),
]
  .map((s) => s?.trim())
  .filter((s): s is string => Boolean(s));

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: emailPasswordEnabled,
    minPasswordLength: 10,
  },
  socialProviders: googleConfigured
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
      }
    : {},
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
  plugins: [
    // Make sure this is the last plugin
    nextCookies(),
  ],
});

export const authFeatures = { google: googleConfigured, emailPassword: emailPasswordEnabled };
