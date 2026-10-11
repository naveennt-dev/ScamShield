"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  FileWarning,
  History,
  Image as ImageIcon,
  LayoutDashboard,
  Link2,
  LogOut,
  Mail,
  Menu,
  MessageSquareText,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/scan/message", label: "Scan Message", icon: MessageSquareText },
  { href: "/scan/url", label: "Scan URL", icon: Link2 },
  { href: "/scan/screenshot", label: "Scan Screenshot", icon: ImageIcon },
  { href: "/scan/email", label: "Scan Email", icon: Mail },
  { href: "/history", label: "History", icon: History },
  { href: "/reports", label: "Scam Reports", icon: FileWarning },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ user, children }: { user: { name: string | null; email: string }; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  const signOut = async () => {
    await authClient.signOut();
    router.replace("/auth");
  };

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          onClick={() => setOpen(false)}
          aria-current={isActive(href) ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            isActive(href) ? "bg-sky-100 text-sky-900" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <aside className="hidden md:flex md:flex-col md:justify-between border-r border-slate-200 bg-white p-4 md:sticky md:top-0 md:h-screen">
        <div className="flex flex-col gap-6">
          <Link href="/" className="flex items-center gap-2 px-2 text-lg font-semibold text-sky-900">
            <ShieldCheck className="size-6 text-sky-700" aria-hidden /> ScamShield
          </Link>
          {nav}
        </div>
        <UserBox user={user} onSignOut={signOut} />
      </aside>

      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold text-sky-900">
          <ShieldCheck className="size-5 text-sky-700" aria-hidden /> ScamShield
        </Link>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          className="rounded-md p-2 text-slate-700 hover:bg-slate-100"
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </header>
      {open && (
        <div className="md:hidden fixed inset-x-0 top-[57px] bottom-0 z-20 flex flex-col justify-between bg-white p-4">
          {nav}
          <UserBox user={user} onSignOut={signOut} />
        </div>
      )}

      <main className="min-w-0 px-4 py-6 md:px-10 md:py-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}

function UserBox({ user, onSignOut }: { user: { name: string | null; email: string }; onSignOut: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{user.name ?? "Signed in"}</p>
        <p className="truncate text-xs text-slate-500">{user.email}</p>
      </div>
      <button type="button" onClick={onSignOut} aria-label="Sign out" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
        <LogOut className="size-4" />
      </button>
    </div>
  );
}
