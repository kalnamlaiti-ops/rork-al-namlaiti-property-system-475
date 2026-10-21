// src/context/AuthContext.tsx
// Sign-in gate for the whole app. Nobody reaches any data — or even the
// workspace WebSocket — without a valid session. Roles: Owner, Admin,
// Accountant, Staff. The first account ever created is the Owner.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { authApi, getToken, setToken, type AuthUser } from "@/lib/authClient";
import { syncClient } from "@/lib/syncClient";

type AuthStatus = "loading" | "signedOut" | "signedIn";

interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<AuthUser>;
  signup: (name: string, email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setUser: (user: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  const applyUser = useCallback((u: AuthUser | null) => {
    setUserState(u);
    setStatus(u ? "signedIn" : "signedOut");
  }, []);

  // Re-check the session when the backend rejects the WebSocket (token
  // expired or revoked mid-session). A 401 signs out; a network error is
  // ignored so the app keeps retrying instead of logging the user out.
  useEffect(() => {
    syncClient.setUnauthorizedHandler(() => {
      authApi
        .me()
        .then((res) => applyUser(res.user))
        .catch((err: Error) => {
          if (err.message.toLowerCase().includes("authentication")) {
            setToken(null);
            applyUser(null);
          }
        });
    });
  }, [applyUser]);

  useEffect(() => {
    let cancelled = false;
    if (!getToken()) {
      setStatus("signedOut");
      return;
    }
    authApi
      .me()
      .then((res) => {
        if (!cancelled) applyUser(res.user);
      })
      .catch(() => {
        if (!cancelled) {
          setToken(null);
          applyUser(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyUser]);

  const login = useCallback(
    async (email: string, password: string) => {
      const u = await authApi.login(email, password);
      applyUser(u);
      return u;
    },
    [applyUser],
  );

  const signup = useCallback(
    async (name: string, email: string, password: string) => {
      const u = await authApi.signup(name, email, password);
      applyUser(u);
      return u;
    },
    [applyUser],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* the token is cleared locally regardless */
    }
    setToken(null);
    applyUser(null);
  }, [applyUser]);

  const refreshUser = useCallback(async () => {
    try {
      const res = await authApi.me();
      applyUser(res.user);
    } catch {
      /* keep the current state */
    }
  }, [applyUser]);

  return (
    <AuthContext.Provider
      value={{ user, status, login, signup, logout, refreshUser, setUser: applyUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
