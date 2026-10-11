import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authFeatures } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth/session";
import { AuthForm } from "./AuthForm";

function safeNext(next: string | string[] | undefined): string {
  const n = Array.isArray(next) ? next[0] : next;
  // Only same-site relative paths (prevents open redirects like //evil.com or /\evil.com).
  return n && /^\/(?![/\\])[\w\-/[\]]*$/.test(n) ? n : "/";
}

export default async function AuthPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeNext((await searchParams).next);
  if (await getSessionUser(await headers())) redirect(next);
  return <AuthForm next={next} google={authFeatures.google} emailPassword={authFeatures.emailPassword} />;
}
