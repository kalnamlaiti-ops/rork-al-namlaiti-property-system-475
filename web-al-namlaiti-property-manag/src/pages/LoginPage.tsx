// src/pages/LoginPage.tsx
// Sign-in gate — everyone with the app link must sign in. On first ever run
// (no accounts exist) it offers to create the single bootstrap Owner account.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authApi, type AuthUser } from "@/lib/authClient";
import { useAuth } from "@/context/AuthContext";
import { Building2, Lock, Mail, ShieldCheck, User } from "lucide-react";

type Mode =
  | { kind: "checking" }
  | { kind: "signin" }
  | { kind: "bootstrap" };

export default function LoginPage() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<Mode>({ kind: "checking" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authApi
      .hasUsers()
      .then((res) => setMode({ kind: res.hasUsers ? "signin" : "bootstrap" }))
      .catch(() => setMode({ kind: "signin" }));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      let user: AuthUser;
      if (mode.kind === "bootstrap") {
        user = await signup(name.trim(), email.trim(), password);
      } else {
        user = await login(email.trim(), password);
      }
      void user; // AuthProvider picks the session up from the token
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const inputClasses = "h-11 bg-white";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-indigo-50 to-slate-200 p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30">
            <Building2 className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Al Namlaiti Property Management
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode.kind === "bootstrap"
              ? "Create the Owner account to set up your system."
              : "Sign in with your account to continue."}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-900/5 backdrop-blur sm:p-8">
          {mode.kind === "checking" ? (
            <p className="py-8 text-center text-sm text-slate-500">Checking your session…</p>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {mode.kind === "bootstrap" && (
                <div className="space-y-2">
                  <Label htmlFor="name">Full name</Label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      id="name"
                      className={`${inputClasses} pl-9`}
                      placeholder="Your name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
                      required
                    />
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="email"
                    type="email"
                    className={`${inputClasses} pl-9`}
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="password"
                    type="password"
                    className={`${inputClasses} pl-9`}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode.kind === "bootstrap" ? "new-password" : "current-password"}
                    required
                  />
                </div>
              </div>

              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                  {error}
                </p>
              )}

              <Button type="submit" className="h-11 w-full" disabled={busy}>
                {busy
                  ? "Please wait…"
                  : mode.kind === "bootstrap"
                    ? "Create Owner account"
                    : "Sign in"}
              </Button>

              {mode.kind === "bootstrap" && (
                <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  The first account created becomes the Owner — the only role that
                  can manage users and roles. Keep this password safe.
                </p>
              )}
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Access is limited to invited users of Al Namlaiti Property Management.
        </p>
      </div>
    </div>
  );
}
