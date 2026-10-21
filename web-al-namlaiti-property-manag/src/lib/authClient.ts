// src/lib/authClient.ts
// Sign-in client for the 4-role user system (Owner / Admin / Accountant /
// Staff). Talks to the workspace backend's /auth/* endpoints. The session
// token lives in localStorage and is attached to every backend call — the
// workspace WebSocket and document endpoints refuse connections without it.

import { backendHttpUrl } from "./syncClient";

export type Role = "Owner" | "Admin" | "Accountant" | "Staff";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: string;
  isBootstrapOwner: boolean;
  createdAt: string;
}

const TOKEN_KEY = "al-namlaiti-session-token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

async function api<T>(path: string, init?: Omit<RequestInit, "body"> & { body?: unknown }): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(backendHttpUrl(path), {
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
  return data;
}

export const authApi = {
  hasUsers: () => api<{ ok: boolean; hasUsers: boolean }>("/auth/has-users"),

  signup: async (name: string, email: string, password: string) => {
    const res = await api<{ ok: boolean; token: string; user: AuthUser }>("/auth/signup", {
      method: "POST",
      body: { name, email, password },
    });
    setToken(res.token);
    return res.user;
  },

  login: async (email: string, password: string) => {
    const res = await api<{ ok: boolean; token: string; user: AuthUser }>("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    setToken(res.token);
    return res.user;
  },

  me: () => api<{ ok: boolean; user: AuthUser }>("/auth/me"),

  logout: () => api<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  listUsers: () => api<{ ok: boolean; users: AuthUser[] }>("/auth/users"),

  createUser: (input: { name: string; email: string; password: string; role: Role }) =>
    api<{ ok: boolean; user: AuthUser }>("/auth/users", { method: "POST", body: input }),

  updateUser: (
    id: string,
    patch: { name?: string; role?: Role; status?: "Active" | "Deactivated"; password?: string },
  ) => api<{ ok: boolean; user: AuthUser }>(`/auth/users/${id}`, { method: "PATCH", body: patch }),

  deleteUser: (id: string) => api<{ ok: boolean }>(`/auth/users/${id}`, { method: "DELETE" }),

  changePassword: (currentPassword: string, newPassword: string) =>
    api<{ ok: boolean }>("/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword },
    }),
};
