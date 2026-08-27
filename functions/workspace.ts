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
  }

  // ─────────────────────────── HTTP entry ───────────────────────────

  override async fetch(request: Request): Promise<Response> {
    // ── HTTP endpoint for WhatsApp webhook status updates ──
    // The Worker parses Meta's webhook payload and forwards status updates here.
    if (request.headers.get("Upgrade") !== "websocket") {
      if (request.method === "POST") {
        return this.handleWebhookStatus(request);
      }
      return new Response("expected websocket", { status: 426 });
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
        return;
      } catch {
        // fall through to empty store
      }
    }
    this.store = { ...EMPTY_STORE };
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
