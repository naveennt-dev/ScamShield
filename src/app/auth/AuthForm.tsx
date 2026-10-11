"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { FcGoogle } from "react-icons/fc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { authClient } from "@/lib/auth-client";

export function AuthForm({ next, google, emailPassword }: { next: string; google: boolean; emailPassword: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState<"google" | "email" | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  const handleGoogle = async () => {
    setLoading("google");
    try {
      await authClient.signIn.social({ provider: "google", callbackURL: next });
    } catch {
      toast.error("Could not start Google sign-in. Please try again.");
      setLoading(null);
    }
  };

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading("email");
    const res =
      mode === "signup"
        ? await authClient.signUp.email({ email, password, name: name || email.split("@")[0] })
        : await authClient.signIn.email({ email, password });
    setLoading(null);
    if (res.error) {
      toast.error(res.error.message ?? "Sign-in failed.");
      return;
    }
    router.replace(next);
    router.refresh();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader>
          <CardTitle className="flex items-center justify-center gap-2 text-center text-2xl font-semibold">
            <ShieldCheck className="size-7 text-sky-700" aria-hidden /> ScamShield
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-center text-sm text-slate-600">Check suspicious messages, links, screenshots and emails before you act on them.</p>
          <Separator />
          {google && (
            <Button onClick={handleGoogle} disabled={loading !== null} className="w-full">
              {loading === "google" ? <Loader2 className="animate-spin" /> : <FcGoogle className="size-5" />}
              {loading === "google" ? "Signing you in…" : "Sign in with Google"}
            </Button>
          )}
          {emailPassword && (
            <form onSubmit={handleEmail} className="flex flex-col gap-2" aria-label="Email sign-in">
              {mode === "signup" && <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
              <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              <Input
                type="password"
                placeholder="Password (min 10 characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={10}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
              <Button type="submit" variant="outline" disabled={loading !== null}>
                {loading === "email" && <Loader2 className="animate-spin" />}
                {mode === "signup" ? "Create account" : "Sign in with email"}
              </Button>
              <button type="button" className="text-xs text-sky-700 hover:underline" onClick={() => setMode((m) => (m === "signin" ? "signup" : "signin"))}>
                {mode === "signin" ? "No account? Create one" : "Have an account? Sign in"}
              </button>
            </form>
          )}
          {!google && !emailPassword && (
            <p className="text-center text-sm text-red-700">No sign-in method is configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
