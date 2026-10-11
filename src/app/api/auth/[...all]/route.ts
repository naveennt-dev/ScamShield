import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

// CORS for auth endpoints is handled centrally in middleware.ts (CORS_ALLOWED_ORIGINS);
// better-auth additionally validates request origins against `trustedOrigins`.
export const { POST, GET } = toNextJsHandler(auth);
