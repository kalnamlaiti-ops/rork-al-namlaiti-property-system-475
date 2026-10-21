// functions/workspace.ts
// Shared workspace Durable Object for Al Namlaiti Property Management.
// Holds the canonical data store (all entities + history) in SQLite and
// broadcasts every mutation to all connected clients over WebSocket.
//
// Persistence guarantees:
// - Every mutation is written to SQLite and durably committed
//   (`storage.sync()`) BEFORE the server broadcasts or acknowledges it.
// - Every client mutation carries a unique `mutationId`; the server
//   acknowledges the exact id and stores processed ids so retrying the same
//   mutation can never create duplicate records (idempotency).
// - Failures are logged (mutation id, collection, entity id, operation,
//   error, timestamp) WITHOUT any sensitive entity payloads.
//
// Uses the classic event-listener WebSocket pattern (not hibernation) for
// maximum reliability across hosting environments.

import { DurableObject } from "cloudflare:workers";

// ─────────────────────────── Users & sessions ───────────────────────────
// User accounts live in their OWN SQLite tables — deliberately OUTSIDE the
// broadcast JSON store — so password hashes and sessions are never included
// in workspace snapshots or WebSocket messages sent to clients.

export type UserRole = "Owner" | "Admin" | "Accountant" | "Staff";

const ROLES: UserRole[] = ["Owner", "Admin", "Accountant", "Staff"];

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  salt: string;
  hash: string;
  isBootstrapOwner: number;
  createdAt: string;
}

/** Public shape sent to clients — never includes salt/hash. */
function publicUser(u: UserRow): {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  isBootstrapOwner: boolean;
  createdAt: string;
} {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    isBootstrapOwner: u.isBootstrapOwner === 1,
    createdAt: u.createdAt,
  };
}

function randomSaltHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PBKDF2-SHA256, 100k iterations — computed server-side only. */
async function hashPassword(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    keyMaterial,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SESSION_TTL_DAYS = 30;

export interface DataStore {
  owners: unknown[];
  buildings: unknown[];
  units: unknown[];
  tenants: unknown[];
  leases: unknown[];
  invoices: unknown[];
  payments: unknown[];
  expenses: unknown[];
  chartOfAccounts: unknown[];
  journalEntries: unknown[];
  distributions: unknown[];
  ewaBills: unknown[];
  ewaAccounts: unknown[];
  ewaDistributions: unknown[];
  complaints: unknown[];
  maintenanceRequests: unknown[];
  vendors: unknown[];
  assets: unknown[];
  documents: unknown[];
  leaseAgreements: unknown[];
  whatsappLogs: unknown[];
  whatsappSettings: unknown[];
  leaseTemplateFields: unknown[];
  history: unknown[];
}

const COLLECTION_KEYS: (keyof DataStore)[] = [
  "owners",
  "buildings",
  "units",
  "tenants",
  "leases",
  "invoices",
  "payments",
  "expenses",
  "chartOfAccounts",
  "journalEntries",
  "distributions",
  "ewaBills",
  "ewaAccounts",
  "ewaDistributions",
  "complaints",
  "maintenanceRequests",
  "vendors",
  "assets",
  "documents",
  "leaseAgreements",
  "whatsappLogs",
  "whatsappSettings",
  "leaseTemplateFields",
  "history",
];

const EMPTY_STORE: DataStore = {
  owners: [],
  buildings: [],
  units: [],
  tenants: [],
  leases: [],
  invoices: [],
  payments: [],
  expenses: [],
  chartOfAccounts: [],
  journalEntries: [],
  distributions: [],
  ewaBills: [],
  ewaAccounts: [],
  ewaDistributions: [],
  complaints: [],
  maintenanceRequests: [],
  vendors: [],
  assets: [],
  documents: [],
  leaseAgreements: [],
  whatsappLogs: [],
  whatsappSettings: [],
  leaseTemplateFields: [],
  history: [],
};

// Message shapes exchanged with the client.
// `mutationId` is optional so older clients keep working, but the web client
// always sends it; it is echoed back in the ack/nack.
type ClientMessage =
  | { type: "subscribe" }
  | { type: "mutate"; op: MutateOp; actor: string; mutationId?: string }
  | { type: "recover"; historyId: string; actor: string; mutationId?: string }
  | { type: "clearHistory"; actor: string; mutationId?: string };

type MutateOp =
  | { kind: "add"; collection: keyof DataStore; entity: Record<string, unknown> }
  | { kind: "update"; collection: keyof DataStore; id: string; patch: Record<string, unknown> }
  | { kind: "delete"; collection: keyof DataStore; id: string; snapshot?: Record<string, unknown> }
  | { kind: "replaceCollection"; collection: keyof DataStore; rows: unknown[] };

type ServerMessage =
  | { type: "snapshot"; store: DataStore }
  | { type: "patch"; op: MutateOp; actor: string }
  | { type: "recover"; historyId: string; restored: { collection: keyof DataStore; entity: Record<string, unknown> } }
  | { type: "clearHistory" }
  | { type: "ack"; mutationId: string }
  | { type: "nack"; mutationId: string; error: string }
  | { type: "error"; message: string };

type Env = { DO: Fetcher };

/** Extract the entity id from an op for logging (never logs the payload). */
function entityIdOf(op: MutateOp): string {
  if (op.kind === "add") return String((op.entity as { id?: unknown }).id ?? "unknown");
  if (op.kind === "update" || op.kind === "delete") return op.id;
  return "collection";
}

/** Structured, PII-free persistence error log. */
function logPersistError(info: {
  mutationId: string;
  operation: string;
  collection: string;
  entityId: string;
  error: string;
}): void {
  console.error(
    JSON.stringify({
      level: "error",
      scope: "persist",
      mutationId: info.mutationId,
      operation: info.operation,
      collection: info.collection,
      entityId: info.entityId,
      error: info.error,
      timestamp: new Date().toISOString(),
    }),
  );
}

export class Workspace extends DurableObject<Env> {
  // In-memory cache of the full store; hydrated lazily on first access.
  private store: DataStore | null = null;
  private hydrated = false;
  // Track connected sockets so we can broadcast.
  private sockets: Set<WebSocket> = new Set();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    // Idempotency ledger: every processed mutation id is recorded so retries
    // of the same mutation never apply twice (no duplicate records).
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS processed_mutations (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL
      )
    `);
    // Document binaries (PDFs etc.) are stored OUTSIDE the JSON store so
    // multi-megabyte base64 payloads never flow through WebSocket messages
    // (Cloudflare limits WS messages to 1 MiB) and never bloat snapshots.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS document_blobs (
        id    TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        ts    TEXT NOT NULL
      )
    `);
    // User accounts — separate from the broadcast store (hashes never sync).
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id                TEXT PRIMARY KEY,
        email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name              TEXT NOT NULL,
        role              TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'Active',
        salt              TEXT NOT NULL,
        hash              TEXT NOT NULL,
        isBootstrapOwner  INTEGER NOT NULL DEFAULT 0,
        createdAt         TEXT NOT NULL
      )
    `);
    // Server-side sessions: random tokens, 30-day expiry.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token     TEXT PRIMARY KEY,
        userId    TEXT NOT NULL,
        expiresAt TEXT NOT NULL
      )
    `);
  }

  // ─────────────────────────── HTTP entry ───────────────────────────

  override async fetch(request: Request): Promise<Response> {
    // WebSocket upgrades bypass CORS handling entirely.
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    // ── CORS: the web app calls this worker cross-origin from the browser ──
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: this.corsHeaders(origin) });
    }
    const res = await this.handleHttpRequest(request, new URL(request.url));
    if (!origin) return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(this.corsHeaders(origin))) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  private corsHeaders(origin: string | null): Record<string, string> {
    return {
      "Access-Control-Allow-Origin": origin ?? "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }

  private async handleHttpRequest(request: Request, url: URL): Promise<Response> {
    // ── HTTP document endpoints ──
    // Document binaries travel over HTTP (they can be megabytes — far above
    // the 1 MiB WebSocket message limit). Only lightweight Document records
    // live in the shared store / WebSocket broadcast.
    if (request.headers.get("Upgrade") !== "websocket") {
      // ── Auth endpoints (user accounts + sessions live outside the store) ──
      if (url.pathname.startsWith("/auth/")) {
        return this.handleAuthRequest(request, url);
      }
      // Document endpoints require a signed-in session.
      if (url.pathname === "/documents/upload" && request.method === "POST") {
        const user = await this.getUserFromRequest(request);
        if (!user) return Response.json({ ok: false, error: "authentication required" }, { status: 401 });
        return this.handleDocumentUpload(request);
      }
      const docMatch = url.pathname.match(/^\/documents\/([^/]+)$/);
      if (request.method === "GET" && docMatch) {
        const user = await this.getUserFromRequest(request);
        if (!user) return new Response("authentication required", { status: 401 });
        return this.serveDocument(docMatch[1], url.searchParams.get("download") === "1");
      }
      // ── HTTP endpoint for WhatsApp webhook status updates (open — Meta calls it) ──
      if (request.method === "POST") {
        return this.handleWebhookStatus(request);
      }
      return new Response("expected websocket", { status: 426 });
    }
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    // ── WebSocket upgrades require a signed-in session ──
    // No valid token → the data snapshot is never sent to this client.
    const wsUser = await this.getUserFromRequest(request);
    if (!wsUser) {
      return new Response("authentication required", { status: 401 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Attach event listeners BEFORE returning so messages are never missed.
    server.accept();
    this.sockets.add(server);

    server.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(server, event.data);
    });
    server.addEventListener("close", () => {
      this.sockets.delete(server);
    });
    server.addEventListener("error", () => {
      this.sockets.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─────────────────────────── Auth: users & sessions ───────────────────────────

  /** Extract the session user from a Bearer header or ?token= query param. */
  private getUserFromRequest(request: Request): UserRow | null {
    const url = new URL(request.url);
    let token = url.searchParams.get("token") ?? "";
    const auth = request.headers.get("Authorization");
    if (auth && auth.startsWith("Bearer ")) token = auth.slice(7).trim();
    if (!token) return null;
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        email: string;
        name: string;
        role: string;
        status: string;
        isBootstrapOwner: number;
        createdAt: string;
        expiresAt: string;
      }>(
        `SELECT u.id, u.email, u.name, u.role, u.status, u.isBootstrapOwner, u.createdAt, s.expiresAt
           FROM sessions s JOIN users u ON u.id = s.userId
          WHERE s.token = ?`,
        token,
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt < new Date().toISOString()) {
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token = ?", token);
      return null;
    }
    if (row.status !== "Active") return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      salt: "",
      hash: "",
      isBootstrapOwner: row.isBootstrapOwner,
      createdAt: row.createdAt,
    };
  }

  private async createSession(userId: string): Promise<{ token: string; expiresAt: string }> {
    const token = `${crypto.randomUUID()}${randomSaltHex()}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions (token, userId, expiresAt) VALUES (?, ?, ?)",
      token,
      userId,
      expiresAt,
    );
    // Housekeeping: drop expired sessions.
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE expiresAt < ?", new Date().toISOString());
    return { token, expiresAt };
  }

  private countActiveOwners(excludeUserId: string): number {
    const rows = this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'Owner' AND status = 'Active' AND id != ?",
        excludeUserId,
      )
      .toArray();
    return rows[0]?.n ?? 0;
  }

  private async handleAuthRequest(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    try {
      if (path === "/auth/has-users" && request.method === "GET") {
        const rows = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM users").toArray();
        return Response.json({ ok: true, hasUsers: (rows[0]?.n ?? 0) > 0 });
      }

      if (path === "/auth/signup" && request.method === "POST") {
        return this.handleSignup(request);
      }

      if (path === "/auth/login" && request.method === "POST") {
        return this.handleLogin(request);
      }

      if (path === "/auth/logout" && request.method === "POST") {
        const url2 = new URL(request.url);
        let token = url2.searchParams.get("token") ?? "";
        const auth = request.headers.get("Authorization");
        if (auth && auth.startsWith("Bearer ")) token = auth.slice(7).trim();
        if (token) this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token = ?", token);
        return Response.json({ ok: true });
      }

      // Everything below requires a signed-in session.
      const user = await this.getUserFromRequest(request);
      if (!user) return Response.json({ ok: false, error: "authentication required" }, { status: 401 });

      if (path === "/auth/me" && request.method === "GET") {
        return Response.json({ ok: true, user: publicUser(user) });
      }

      if (path === "/auth/change-password" && request.method === "POST") {
        return this.handleChangePassword(request, user);
      }

      // ── User management — Owner only ──
      if (user.role !== "Owner") {
        return Response.json({ ok: false, error: "Only the Owner can manage user accounts." }, { status: 403 });
      }

      if (path === "/auth/users" && request.method === "GET") {
        const rows = this.ctx.storage.sql
          .exec<UserRow>("SELECT * FROM users ORDER BY createdAt ASC")
          .toArray()
          .map(publicUser);
        return Response.json({ ok: true, users: rows });
      }

      if (path === "/auth/users" && request.method === "POST") {
        return this.handleCreateUser(request);
      }

      const idMatch = path.match(/^\/auth\/users\/([^/]+)$/);
      if (idMatch && request.method === "PATCH") {
        return this.handleUpdateUser(request, idMatch[1], user);
      }
      if (idMatch && request.method === "DELETE") {
        return this.handleDeleteUser(idMatch[1], user);
      }

      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    } catch (err) {
      console.error("[auth] request failed", err instanceof Error ? err.message : String(err));
      return Response.json({ ok: false, error: "authentication service error" }, { status: 500 });
    }
  }

  /** First-run bootstrap: the ONLY time signup is open. Creates the Owner. */
  private async handleSignup(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      email?: string;
      password?: string;
    };
    const name = (body.name ?? "").trim();
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    if (!name || !email || !email.includes("@")) {
      return Response.json({ ok: false, error: "Name and a valid email are required." }, { status: 400 });
    }
    if (password.length < 6) {
      return Response.json({ ok: false, error: "Password must be at least 6 characters." }, { status: 400 });
    }
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM users").toArray()[0]?.n ?? 0;
    if (count > 0) {
      return Response.json(
        { ok: false, error: "Accounts already exist. Ask the Owner to create your user." },
        { status: 403 },
      );
    }
    const salt = randomSaltHex();
    const hash = await hashPassword(password, salt);
    const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, email, name, role, status, salt, hash, isBootstrapOwner, createdAt)
       VALUES (?, ?, ?, 'Owner', 'Active', ?, ?, 1, ?)`,
      id,
      email,
      name,
      salt,
      hash,
      new Date().toISOString(),
    );
    const created = this.ctx.storage.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", id).toArray()[0];
    const session = await this.createSession(id);
    return Response.json({ ok: true, token: session.token, user: publicUser(created) });
  }

  private async handleLogin(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    if (!email || !password) {
      return Response.json({ ok: false, error: "Email and password are required." }, { status: 400 });
    }
    const rows = this.ctx.storage.sql.exec<UserRow>("SELECT * FROM users WHERE email = ?", email).toArray();
    const user = rows[0];
    if (!user) return Response.json({ ok: false, error: "Incorrect email or password." }, { status: 401 });
    if (user.status !== "Active") {
      return Response.json({ ok: false, error: "This account has been deactivated." }, { status: 403 });
    }
    const hash = await hashPassword(password, user.salt);
    if (hash !== user.hash) {
      return Response.json({ ok: false, error: "Incorrect email or password." }, { status: 401 });
    }
    const session = await this.createSession(user.id);
    return Response.json({ ok: true, token: session.token, user: publicUser(user) });
  }

  private async handleCreateUser(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      email?: string;
      password?: string;
      role?: string;
    };
    const name = (body.name ?? "").trim();
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    const role = body.role ?? "";
    if (!name || !email.includes("@")) {
      return Response.json({ ok: false, error: "Name and a valid email are required." }, { status: 400 });
    }
    if (password.length < 6) {
      return Response.json({ ok: false, error: "Password must be at least 6 characters." }, { status: 400 });
    }
    if (!ROLES.includes(role as UserRole)) {
      return Response.json({ ok: false, error: "Role must be Owner, Admin, Accountant, or Staff." }, { status: 400 });
    }
    const existing = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = ?", email)
      .toArray()[0]?.n ?? 0;
    if (existing > 0) {
      return Response.json({ ok: false, error: "A user with this email already exists." }, { status: 409 });
    }
    const salt = randomSaltHex();
    const hash = await hashPassword(password, salt);
    const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO users (id, email, name, role, status, salt, hash, isBootstrapOwner, createdAt)
         VALUES (?, ?, ?, ?, 'Active', ?, ?, 0, ?)`,
        id,
        email,
        name,
        role,
        salt,
        hash,
        new Date().toISOString(),
      );
    } catch {
      return Response.json({ ok: false, error: "A user with this email already exists." }, { status: 409 });
    }
    const created = this.ctx.storage.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", id).toArray()[0];
    return Response.json({ ok: true, user: publicUser(created) });
  }

  private async handleUpdateUser(request: Request, targetId: string, actor: UserRow): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      role?: string;
      status?: string;
      password?: string;
    };
    const rows = this.ctx.storage.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", targetId).toArray();
    const target = rows[0];
    if (!target) return Response.json({ ok: false, error: "User not found." }, { status: 404 });

    const roleChange = body.role !== undefined && body.role !== target.role;
    const statusChange = body.status !== undefined && body.status !== target.status;

    if (body.role !== undefined && !ROLES.includes(body.role as UserRole)) {
      return Response.json({ ok: false, error: "Role must be Owner, Admin, Accountant, or Staff." }, { status: 400 });
    }
    if (body.status !== undefined && body.status !== "Active" && body.status !== "Deactivated") {
      return Response.json({ ok: false, error: "Status must be Active or Deactivated." }, { status: 400 });
    }

    // ── Security rules ──
    // 1. The bootstrap Owner's role/status can never be changed by anyone.
    if (target.isBootstrapOwner === 1 && (roleChange || statusChange)) {
      return Response.json({ ok: false, error: "The Owner account's role cannot be changed." }, { status: 403 });
    }
    // 2. Nobody changes their own role or status (no self-promotion / self-demotion).
    if (targetId === actor.id && (roleChange || statusChange)) {
      return Response.json({ ok: false, error: "You cannot change your own role or status." }, { status: 403 });
    }
    // 3. Demoting/deactivating an Owner requires at least one other active Owner.
    const wouldLoseOwner =
      target.role === "Owner" &&
      target.status === "Active" &&
      ((body.role !== undefined && body.role !== "Owner") || (body.status !== undefined && body.status !== "Active"));
    if (wouldLoseOwner && this.countActiveOwners(targetId) === 0) {
      return Response.json({ ok: false, error: "At least one active Owner is required." }, { status: 403 });
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (body.name !== undefined && body.name.trim()) {
      sets.push("name = ?");
      vals.push(body.name.trim());
    }
    if (body.role !== undefined) {
      sets.push("role = ?");
      vals.push(body.role);
    }
    if (body.status !== undefined) {
      sets.push("status = ?");
      vals.push(body.status);
    }
    if (body.password !== undefined) {
      if (body.password.length < 6) {
        return Response.json({ ok: false, error: "Password must be at least 6 characters." }, { status: 400 });
      }
      const salt = randomSaltHex();
      sets.push("salt = ?", "hash = ?");
      vals.push(salt, await hashPassword(body.password, salt));
      // Resetting a password ends all of that user's sessions.
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE userId = ?", targetId);
    }
    if (sets.length > 0) {
      vals.push(targetId);
      this.ctx.storage.sql.exec(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, ...(vals as string[]));
      // Deactivating a user ends their sessions immediately.
      if (body.status === "Deactivated") {
        this.ctx.storage.sql.exec("DELETE FROM sessions WHERE userId = ?", targetId);
      }
    }
    const updated = this.ctx.storage.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", targetId).toArray()[0];
    return Response.json({ ok: true, user: publicUser(updated) });
  }

  private handleDeleteUser(targetId: string, actor: UserRow): Response {
    if (targetId === actor.id) {
      return Response.json({ ok: false, error: "You cannot delete your own account." }, { status: 403 });
    }
    const rows = this.ctx.storage.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", targetId).toArray();
    const target = rows[0];
    if (!target) return Response.json({ ok: false, error: "User not found." }, { status: 404 });
    if (target.isBootstrapOwner === 1) {
      return Response.json({ ok: false, error: "The Owner account cannot be removed." }, { status: 403 });
    }
    if (target.role === "Owner" && target.status === "Active" && this.countActiveOwners(targetId) === 0) {
      return Response.json({ ok: false, error: "At least one active Owner is required." }, { status: 403 });
    }
    this.ctx.storage.sql.exec("DELETE FROM users WHERE id = ?", targetId);
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE userId = ?", targetId);
    return Response.json({ ok: true });
  }

  private async handleChangePassword(request: Request, user: UserRow): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!body.currentPassword || !body.newPassword) {
      return Response.json({ ok: false, error: "Current and new passwords are required." }, { status: 400 });
    }
    if (body.newPassword.length < 6) {
      return Response.json({ ok: false, error: "New password must be at least 6 characters." }, { status: 400 });
    }
    const rows = this.ctx.storage.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", user.id).toArray();
    const full = rows[0];
    if (!full) return Response.json({ ok: false, error: "User not found." }, { status: 404 });
    const currentHash = await hashPassword(body.currentPassword, full.salt);
    if (currentHash !== full.hash) {
      return Response.json({ ok: false, error: "Current password is incorrect." }, { status: 403 });
    }
    const salt = randomSaltHex();
    const hash = await hashPassword(body.newPassword, salt);
    this.ctx.storage.sql.exec("UPDATE users SET salt = ?, hash = ? WHERE id = ?", salt, hash, user.id);
    return Response.json({ ok: true });
  }

  // ─────────────────────────── Document blob endpoints ───────────────────────────

  /**
   * Store a document's binary (data URI) in the dedicated SQLite blob table
   * and upsert the lightweight Document record into the shared store.
   * Durable before responding; idempotent via mutationId; broadcasts the
   * small record to all connected clients over WebSocket.
   */
  private async handleDocumentUpload(request: Request): Promise<Response> {
    let body: { mutationId?: string; record?: { id?: string; [k: string]: unknown }; dataUri?: string };
    try {
      body = (await request.json()) as { mutationId?: string; record?: { id?: string; [k: string]: unknown }; dataUri?: string };
    } catch {
      return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
    }
    const mutationId = body.mutationId ?? crypto.randomUUID();
    const record = body.record;
    const dataUri = body.dataUri;
    const docId = String(record?.id ?? "");
    if (!docId || !dataUri || typeof dataUri !== "string" || !dataUri.startsWith("data:")) {
      logPersistError({ mutationId, operation: "documentUpload", collection: "documents", entityId: docId || "unknown", error: "missing id or dataUri" });
      return Response.json({ ok: false, error: "missing document id or data" }, { status: 400 });
    }
    try {
      await this.ensureHydrated();
      // Idempotency: re-uploading the same mutation must not duplicate work.
      if (this.isMutationProcessed(mutationId)) {
        return Response.json({ ok: true, mutationId });
      }
      // 1. Blob goes to its own table.
      this.ctx.storage.sql.exec(
        "INSERT INTO document_blobs (id, value, ts) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, ts = excluded.ts",
        docId,
        dataUri,
        new Date().toISOString(),
      );
      // 2. Lightweight record into the shared store (fileUrl is relative;
      // the client resolves it against the backend origin).
      const store = this.store as DataStore;
      const documents = store.documents as Array<Record<string, unknown>>;
      const cleanRecord: Record<string, unknown> = { ...record, fileUrl: `/documents/${docId}` };
      const idx = documents.findIndex((d) => d.id === docId);
      if (idx >= 0) documents[idx] = cleanRecord;
      else documents.push(cleanRecord);
      // 3. Durable persistence of BOTH blob and store before acknowledging.
      await this.persistNow();
      await this.recordMutationProcessed(mutationId);
      // 4. Broadcast the small record to every connected client.
      this.broadcast({
        type: "patch",
        op: { kind: "add", collection: "documents", entity: cleanRecord },
        actor: "document-upload",
      });
      return Response.json({ ok: true, mutationId });
    } catch (err) {
      logPersistError({
        mutationId,
        operation: "documentUpload",
        collection: "documents",
        entityId: docId,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ ok: false, error: "could not save document" }, { status: 500 });
    }
  }

  /** Serve a stored document blob as a binary response (inline or download). */
  private serveDocument(docId: string, download: boolean): Response {
    try {
      const rows = this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM document_blobs WHERE id = ?", docId)
        .toArray();
      if (rows.length === 0) return new Response("document not found", { status: 404 });
      const dataUri = rows[0].value;
      const match = dataUri.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (!match) return new Response("document data unreadable", { status: 500 });
      const mime = match[1] ?? "application/octet-stream";
      const isBase64 = Boolean(match[2]);
      const payload = isBase64 ? atob(match[3]) : decodeURIComponent(match[3]);
      const bytes = new Uint8Array(payload.length);
      for (let i = 0; i < payload.length; i++) bytes[i] = payload.charCodeAt(i);
      const headers: Record<string, string> = { "Content-Type": mime };
      if (download) headers["Content-Disposition"] = `attachment; filename="document-${docId}"`;
      return new Response(bytes, { headers });
    } catch (err) {
      console.error("[do] serve document failed", err);
      return new Response("could not read document", { status: 500 });
    }
  }

  // ─────────────────────────── Message handling ───────────────────────────

  private async handleMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ClientMessage;
    } catch {
      console.warn("[ws] invalid json");
      this.sendTo(ws, { type: "error", message: "invalid json" });
      return;
    }

    try {
      await this.ensureHydrated();
    } catch (err) {
      console.error("[ws] hydrate failed", err);
      this.sendTo(ws, { type: "error", message: "hydrate failed" });
      return;
    }

    try {
      switch (msg.type) {
        case "subscribe":
          this.sendTo(ws, { type: "snapshot", store: this.store as DataStore });
          return;

        case "mutate":
          await this.handleMutate(ws, msg);
          return;

        case "recover":
          await this.handleRecover(ws, msg);
          return;

        case "clearHistory":
          await this.handleClearHistory(ws, msg);
          return;

        default:
          this.sendTo(ws, { type: "error", message: "unknown message type" });
      }
    } catch (err) {
      const mutationId = (msg as { mutationId?: string }).mutationId ?? "unknown";
      logPersistError({
        mutationId,
        operation: msg.type,
        collection: "-",
        entityId: "-",
        error: err instanceof Error ? err.message : String(err),
      });
      this.sendTo(ws, {
        type: "nack",
        mutationId,
        error: "internal error while saving",
      });
    }
  }

  /**
   * Apply a mutation durably, then broadcast + acknowledge.
   * Order matters: SQLite write → storage.sync() → broadcast → ack.
   * The client only treats data as saved after the matching ack.
   */
  private async handleMutate(ws: WebSocket, msg: Extract<ClientMessage, { type: "mutate" }>): Promise<void> {
    const mutationId = msg.mutationId ?? crypto.randomUUID();

    // Idempotency: if this exact mutation was already applied, just re-ack.
    if (this.isMutationProcessed(mutationId)) {
      this.sendTo(ws, { type: "ack", mutationId });
      return;
    }

    const result = this.applyMutate(msg.op);
    if (!result.ok) {
      logPersistError({
        mutationId,
        operation: msg.op.kind,
        collection: String(msg.op.collection),
        entityId: entityIdOf(msg.op),
        error: result.error,
      });
      this.sendTo(ws, { type: "nack", mutationId, error: result.error });
      return;
    }

    // Durability first: commit to SQLite and wait for the write to be
    // durable BEFORE broadcasting or acknowledging. Multiple rapid mutations
    // each go through here in order — an older snapshot can never overwrite
    // a newer one because every write serializes on the DO input gate.
    await this.persistNow();
    await this.recordMutationProcessed(mutationId);

    this.broadcast({ type: "patch", op: msg.op, actor: msg.actor });
    this.sendTo(ws, { type: "ack", mutationId });
  }

  private async handleRecover(ws: WebSocket, msg: Extract<ClientMessage, { type: "recover" }>): Promise<void> {
    const mutationId = msg.mutationId ?? crypto.randomUUID();
    if (this.isMutationProcessed(mutationId)) {
      this.sendTo(ws, { type: "ack", mutationId });
      return;
    }
    const recovered = this.applyRecover(msg.historyId);
    if (!recovered.ok) {
      logPersistError({
        mutationId,
        operation: "recover",
        collection: "-",
        entityId: msg.historyId,
        error: recovered.error,
      });
      this.sendTo(ws, { type: "nack", mutationId, error: recovered.error });
      return;
    }
    await this.persistNow();
    await this.recordMutationProcessed(mutationId);
    this.broadcast({ type: "recover", historyId: msg.historyId, restored: recovered.value });
    this.sendTo(ws, { type: "ack", mutationId });
  }

  private async handleClearHistory(ws: WebSocket, msg: Extract<ClientMessage, { type: "clearHistory" }>): Promise<void> {
    const mutationId = msg.mutationId ?? crypto.randomUUID();
    if (this.isMutationProcessed(mutationId)) {
      this.sendTo(ws, { type: "ack", mutationId });
      return;
    }
    this.store = { ...(this.store as DataStore), history: [] };
    await this.persistNow();
    await this.recordMutationProcessed(mutationId);
    this.broadcast({ type: "clearHistory" });
    this.sendTo(ws, { type: "ack", mutationId });
  }

  // ─────────────────────────── Mutation logic ───────────────────────────

  private applyMutate(op: MutateOp): { ok: true } | { ok: false; error: string } {
    const store = this.store as DataStore;
    if (!COLLECTION_KEYS.includes(op.collection)) {
      return { ok: false, error: `unknown collection: ${String(op.collection)}` };
    }

    switch (op.kind) {
      case "add": {
        const arr = store[op.collection] as unknown[];
        if (!Array.isArray(arr)) return { ok: false, error: "not an array collection" };
        const idx = arr.findIndex((r) => (r as { id?: string }).id === (op.entity as { id?: string }).id);
        if (idx >= 0) arr[idx] = op.entity;
        else arr.push(op.entity);
        return { ok: true };
      }

      case "update": {
        const arr = store[op.collection] as { id: string }[];
        const idx = arr.findIndex((r) => r.id === op.id);
        if (idx < 0) return { ok: false, error: "entity not found" };
        arr[idx] = { ...arr[idx], ...op.patch, id: op.id };
        return { ok: true };
      }

      case "delete": {
        const arr = store[op.collection] as { id: string }[];
        const idx = arr.findIndex((r) => r.id === op.id);
        if (idx < 0) return { ok: false, error: "entity not found" };
        arr.splice(idx, 1);
        return { ok: true };
      }

      case "replaceCollection": {
        if (!COLLECTION_KEYS.includes(op.collection)) {
          return { ok: false, error: `unknown collection: ${String(op.collection)}` };
        }
        (store as Record<string, unknown[]>)[op.collection as string] = op.rows;
        return { ok: true };
      }
    }
  }

  private applyRecover(historyId: string): { ok: true; value: { collection: keyof DataStore; entity: Record<string, unknown> } } | { ok: false; error: string } {
    const store = this.store as DataStore;
    const history = store.history as Array<{
      id: string;
      action: string;
      entityType: string;
      entityId: string;
      entityName: string;
      snapshot?: unknown;
      recovered?: boolean;
    }>;
    const entry = history.find((h) => h.id === historyId);
    if (!entry || entry.action !== "Deleted" || entry.recovered || !entry.snapshot) {
      return { ok: false, error: "no recoverable snapshot" };
    }
    const map: Record<string, keyof DataStore> = {
      Owner: "owners",
      Building: "buildings",
      Unit: "units",
      Tenant: "tenants",
      Lease: "leases",
      Invoice: "invoices",
      Payment: "payments",
      Expense: "expenses",
      "EWA Bill": "ewaBills",
      "EWA Account": "ewaAccounts",
      "EWA Distribution": "ewaDistributions",
      "Chart of Account": "chartOfAccounts",
      "Journal Entry": "journalEntries",
      Distribution: "distributions",
      Vendor: "vendors",
      Asset: "assets",
      Complaint: "complaints",
      "Maintenance Request": "maintenanceRequests",
      Document: "documents",
      "WhatsApp Log": "whatsappLogs",
      "WhatsApp Settings": "whatsappSettings",
      "Lease Template Field": "leaseTemplateFields",
    };
    const collection = map[entry.entityType];
    if (!collection) return { ok: false, error: `unknown entity type: ${entry.entityType}` };
    const snapshot = entry.snapshot as Record<string, unknown>;
    const arr = store[collection] as { id: string }[];
    if (!arr.some((r) => r.id === (snapshot.id as string))) {
      arr.push(snapshot as { id: string });
    }
    entry.recovered = true;
    return { ok: true, value: { collection, entity: snapshot } };
  }

  // ─────────────────────────── Persistence ───────────────────────────

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", "store").toArray()[0];
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as Partial<DataStore>;
        this.store = { ...EMPTY_STORE, ...parsed };
        for (const k of COLLECTION_KEYS) {
          if (!Array.isArray((this.store as DataStore)[k])) (this.store as DataStore)[k] = [];
        }
        await this.migrateInlineDocuments();
        return;
      } catch {
        // fall through to empty store
      }
    }
    this.store = { ...EMPTY_STORE };
  }

  /**
   * One-time safety migration: older versions embedded the whole document
   * (base64 data URI) inside the Document record in the JSON store, which
   * bloated snapshots/persists to multiple megabytes and broke WebSocket
   * messages (1 MiB limit). Move any inline payloads into the document_blobs
   * table and rewrite fileUrl to the HTTP endpoint. Data is preserved
   * verbatim — nothing is deleted.
   */
  private async migrateInlineDocuments(): Promise<void> {
    const store = this.store as DataStore;
    const documents = store.documents as Array<Record<string, unknown>>;
    if (!Array.isArray(documents)) return;
    let changed = false;
    for (const doc of documents) {
      const fileUrl = typeof doc.fileUrl === "string" ? doc.fileUrl : "";
      if (fileUrl.startsWith("data:")) {
        const docId = String(doc.id ?? "");
        if (!docId) continue;
        this.ctx.storage.sql.exec(
          "INSERT INTO document_blobs (id, value, ts) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, ts = excluded.ts",
          docId,
          fileUrl,
          new Date().toISOString(),
        );
        doc.fileUrl = `/documents/${docId}`;
        changed = true;
      }
    }
    if (changed) await this.persistNow();
  }

  /**
   * Durably commit the current store to SQLite.
   * `storage.sql.exec` runs synchronously; `storage.sync()` guarantees the
   * write is durable before we proceed. No throttling — every mutation is
   * committed before its ack, so rapid mutations can never be lost and an
   * older snapshot can never overwrite a newer one (writes serialize on the
   * Durable Object input gate).
   */
  private async persistNow(): Promise<void> {
    const snapshot = JSON.stringify(this.store);
    this.ctx.storage.sql.exec(
      `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      "store",
      snapshot,
    );
    await this.ctx.storage.sync();
  }

  /** True if this mutation id was already applied (retry → no-op). */
  private isMutationProcessed(mutationId: string): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM processed_mutations WHERE id = ?", mutationId)
      .toArray();
    return rows.length > 0;
  }

  /** Record a processed mutation id so retries are idempotent. */
  private async recordMutationProcessed(mutationId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO processed_mutations (id, ts) VALUES (?, ?)",
      mutationId,
      new Date().toISOString(),
    );
    // Keep the ledger small: prune entries older than 7 days.
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.ctx.storage.sql.exec("DELETE FROM processed_mutations WHERE ts < ?", cutoff);
    await this.ctx.storage.sync();
  }

  // ─────────────────────────── WhatsApp webhook status ───────────────────────────

  /**
   * Handle a WhatsApp webhook status update from the Worker.
   * The Worker parses Meta's payload and sends a simplified JSON body:
   *   { messageId: string, status: string, timestamp?: string }
   * We find the matching WhatsAppLog, update its status, and broadcast.
   */
  private async handleWebhookStatus(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as {
        messageId?: string;
        status?: string;
        timestamp?: string;
        errorCode?: number;
        errorMessage?: string;
      };

      if (!body.messageId || !body.status) {
        return new Response("missing messageId or status", { status: 400 });
      }

      await this.ensureHydrated();
      const store = this.store as DataStore;
      const logs = store.whatsappLogs as Array<Record<string, unknown>>;

      // Find the log entry by messageId (Meta's wamid)
      const idx = logs.findIndex(
        (log) => log.messageId === body.messageId,
      );

      if (idx < 0) {
        // No matching log — acknowledge so Meta doesn't retry
        return new Response("OK", { status: 200 });
      }

      // Map Meta status to our WhatsAppLog status
      const statusMap: Record<string, string> = {
        sent: "Sent",
        delivered: "Delivered",
        read: "Read",
        failed: "Failed",
      };
      const mappedStatus = statusMap[body.status] ?? body.status;

      const patch: Record<string, unknown> = {
        status: mappedStatus,
        deliveredAt: body.timestamp ?? new Date().toISOString(),
      };
      if (body.status === "failed") {
        patch.error = body.errorMessage ?? "Delivery failed";
        patch.errorCode = body.errorCode;
      }

      logs[idx] = { ...logs[idx], ...patch };

      const op: MutateOp = {
        kind: "update",
        collection: "whatsappLogs",
        id: logs[idx].id as string,
        patch,
      };

      await this.persistNow();
      this.broadcast({ type: "patch", op, actor: "whatsapp-webhook" });

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("[do] webhook status failed", err);
      return new Response("OK", { status: 200 });
    }
  }

  // ─────────────────────────── Broadcast helpers ───────────────────────────

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket may be closed */ }
  }

  private broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const peer of this.sockets) {
      try { peer.send(payload); } catch { /* ignore */ }
    }
  }
}
