import { auth } from "@/lib/auth";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  /** Reserved for future paid plans; everyone is "authenticated" today. */
  tier: "authenticated" | "premium";
}

/**
 * Resolves the user from the session cookie. Identity is ALWAYS derived server-side; user IDs in
 * request bodies/queries are never trusted.
 */
export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  try {
    const session = await auth.api.getSession({ headers });
    if (!session?.user) return null;
    return { id: session.user.id, email: session.user.email, name: session.user.name ?? null, tier: "authenticated" };
  } catch {
    return null;
  }
}
