import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app/AppShell";
import { getSessionUser } from "@/lib/auth/session";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Authoritative server-side session check (middleware only checks cookie presence).
  const user = await getSessionUser(await headers());
  if (!user) redirect("/auth");
  return <AppShell user={{ name: user.name, email: user.email }}>{children}</AppShell>;
}
