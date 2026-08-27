// src/lib/syncClient.ts
// Client-side sync layer that maintains a single WebSocket connection to the
// shared workspace backend and exposes a subscribe/send API to the DataContext.
//
// Reliability guarantees:
// - Every mutation gets a unique mutationId (UUID). The server acknowledges
//   the exact id only AFTER the change is durably persisted in SQLite.
// - Mutations sent while the socket is offline are QUEUED and flushed in
//   order on reconnect — nothing is silently dropped.
// - If an ack doesn't arrive in time, the same mutationId is retried with
//   exponential backoff. Server-side idempotency means a retry can never
//   create a duplicate record.
// - After exhausting retries the mutation is moved to a failed list that the
//   UI surfaces ("Save failed") and the user can retry manually.
// - Reconnects use exponential backoff, and are triggered on network
//   changes and when the app returns from the foreground. On reconnect the
//   server sends a fresh snapshot so the server stays the source of truth.

import type { DataStore } from "@/context/DataContext";

export type CollectionKey = keyof DataStore;

export type MutateOp =
  | { kind: "add"; collection: CollectionKey; entity: Record<string, unknown> }
  | { kind: "update"; collection: CollectionKey; id: string; patch: Record<string, unknown> }
  | { kind: "delete"; collection: CollectionKey; id: string; snapshot?: Record<string, unknown> };

export type ServerMessage =
  | { type: "snapshot"; store: DataStore }
  | { type: "patch"; op: MutateOp; actor: string }
  | { type: "recover"; historyId: string; restored: { collection: CollectionKey; entity: Record<string, unknown> } }
  | { type: "clearHistory" }
  | { type: "ack"; mutationId: string }
  | { type: "nack"; mutationId: string; error: string }
  | { type: "error"; message: string };

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";

/** Aggregate save state surfaced to the UI indicator. */
export interface SaveInfo {
  /** Mutations sent (or queued) but not yet acknowledged by the server. */
  pending: number;
  /** Mutations that permanently failed after retries — need manual retry. */
  failed: number;
  /** Last error message, safe to display. */
  lastError: string | null;
}

export type ServerMessageHandler = (msg: ServerMessage) => void;
export type StatusHandler = (status: ConnectionStatus) => void;
export type SaveInfoHandler = (info: SaveInfo) => void;

const BACKEND_URL =
  (import.meta.env.VITE_RORK_FUNCTIONS_URL as string | undefined) ??
  (import.meta.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL as string | undefined) ??
  "";

const ACK_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 6;
const MAX_RETRY_DELAY_MS = 10000;

function toWsUrl(httpUrl: string): string {
  if (!httpUrl) return "";
  return httpUrl.replace(/^http/i, "ws");
}

/** Build an absolute HTTP URL against the backend origin. */
export function backendHttpUrl(path: string): string {
  return `${BACKEND_URL}${path}`;
}

/**
 * Resolve a stored fileUrl for direct use (window.open, link href).
 * Server-stored document URLs are relative ("/documents/{id}") and must be
 * prefixed with the backend origin; legacy data:/http URLs pass through.
 */
export function resolveFileUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  if (url.startsWith("/")) return `${BACKEND_URL}${url}`;
  return url;
}

function newMutationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Generate a mutation id for HTTP uploads (shares the idempotency ledger with WS mutations). */
export function newHttpMutationId(): string {
  return newMutationId();
}

/** Generate a short random guest label, persisted in localStorage. */
export function getActorLabel(): string {
  if (typeof window === "undefined") return "Guest-local";
  const KEY = "al-namlaiti-actor";
  const existing = localStorage.getItem(KEY);
  if (existing) return existing;
  const suffix = Math.random().toString(36).slice(2, 6);
  const label = `Guest-${suffix}`;
  localStorage.setItem(KEY, label);
  return label;
}

interface PendingMutation {
  mutationId: string;
  payload: string;
  attempts: number;
  ackTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Singleton sync client. One WebSocket per browser tab. The DataContext
 * registers its message handler here; the sync client owns the socket.
 */
class SyncClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private messageHandler: ServerMessageHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private saveInfoHandler: SaveInfoHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 15000;
  private hasSubscribed = false;
  private disposed = false;
  // Ordered map: insertion order = mutation order. Used as the offline queue
  // (flushed on reconnect) and the pending-ack ledger.
  private pending = new Map<string, PendingMutation>();
  private failed = new Map<string, PendingMutation>();
  private lastError: string | null = null;
  private networkListenersBound = false;

  constructor() {
    this.wsUrl = toWsUrl(BACKEND_URL);
  }

  setMessageHandler(handler: ServerMessageHandler): void {
    this.messageHandler = handler;
  }

  setStatusHandler(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  setSaveInfoHandler(handler: SaveInfoHandler): void {
    this.saveInfoHandler = handler;
    handler(this.getSaveInfo());
  }

  getSaveInfo(): SaveInfo {
    return { pending: this.pending.size, failed: this.failed.size, lastError: this.lastError };
  }

  private notifySaveInfo(): void {
    this.saveInfoHandler?.(this.getSaveInfo());
  }

  connect(): void {
    if (this.disposed) return;
    if (!this.wsUrl) {
      // No backend configured — run in offline/local-only mode.
      this.statusHandler?.("offline");
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.bindNetworkListeners();

    this.statusHandler?.(this.hasSubscribed ? "reconnecting" : "connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.hasSubscribed = true;
      this.statusHandler?.("connected");
      // Subscribe first to get a fresh server snapshot (server = source of
      // truth after reconnect), then flush queued mutations in order.
      this.sendRaw({ type: "subscribe" });
      this.flushPending();
      this.notifySaveInfo();
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.disposed) return;
      this.statusHandler?.("reconnecting");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow and trigger reconnect.
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === "ack") {
      const entry = this.pending.get(msg.mutationId);
      if (entry) this.clearTimers(entry);
      this.pending.delete(msg.mutationId);
      this.lastError = null;
      this.notifySaveInfo();
    } else if (msg.type === "nack") {
      const entry = this.pending.get(msg.mutationId);
      if (entry) this.clearTimers(entry);
      this.pending.delete(msg.mutationId);
      if (entry) {
        this.failed.set(msg.mutationId, entry);
        this.lastError = msg.error;
      }
      this.notifySaveInfo();
    }
    this.messageHandler?.(msg);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  /** Reconnect on network recovery / app returning to foreground. */
  private bindNetworkListeners(): void {
    if (this.networkListenersBound || typeof window === "undefined") return;
    this.networkListenersBound = true;
    window.addEventListener("online", () => {
      this.reconnectDelay = 1000;
      this.connect();
    });
    window.addEventListener("offline", () => {
      this.statusHandler?.("offline");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.reconnectDelay = 1000;
        this.connect();
      }
    });
  }

  private sendRaw(payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(payload)); } catch { /* ignore — retry timer covers it */ }
    }
  }

  private clearTimers(entry: PendingMutation): void {
    if (entry.ackTimer) { clearTimeout(entry.ackTimer); entry.ackTimer = null; }
    if (entry.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
  }

  /** (Re)send a pending mutation if the socket is open and arm the ack timer. */
  private attemptSend(entry: PendingMutation): void {
    const isOpen = this.ws && this.ws.readyState === WebSocket.OPEN;
    if (isOpen) {
      try { this.ws?.send(entry.payload); } catch { /* ignore — ack timeout retries */ }
    }
    // If offline the ack timer still runs; retries just resend once reconnected.
    if (entry.ackTimer) clearTimeout(entry.ackTimer);
    entry.ackTimer = setTimeout(() => this.handleAckTimeout(entry), ACK_TIMEOUT_MS);
  }

  private handleAckTimeout(entry: PendingMutation): void {
    entry.ackTimer = null;
    // Did an ack race the timer?
    if (!this.pending.has(entry.mutationId)) return;
    entry.attempts += 1;
    if (entry.attempts >= MAX_ATTEMPTS) {
      // Give up for now — surfaced as "Save failed" with a manual retry.
      this.pending.delete(entry.mutationId);
      this.failed.set(entry.mutationId, entry);
      this.lastError = "Could not reach the server. Please check your connection and try again.";
      this.notifySaveInfo();
      return;
    }
    const delay = Math.min(1000 * 2 ** (entry.attempts - 1), MAX_RETRY_DELAY_MS);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this.attemptSend(entry);
    }, delay);
  }

  /** Flush queued mutations in original order (called on socket open). */
  private flushPending(): void {
    for (const entry of this.pending.values()) {
      if (entry.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
      this.attemptSend(entry);
    }
  }

  private track(opPayload: unknown): void {
    const mutationId = (opPayload as { mutationId: string }).mutationId;
    const entry: PendingMutation = {
      mutationId,
      payload: JSON.stringify(opPayload),
      attempts: 0,
      ackTimer: null,
      retryTimer: null,
    };
    this.pending.set(mutationId, entry);
    this.attemptSend(entry);
    this.notifySaveInfo();
  }

  /**
   * Send a mutation to the workspace. The server persists durably, broadcasts
   * the change to all clients, then acks this exact mutationId. If offline,
   * the mutation is queued and flushed on reconnect.
   */
  sendMutate(op: MutateOp, actor: string): void {
    this.track({ type: "mutate", op, actor, mutationId: newMutationId() });
  }

  sendRecover(historyId: string, actor: string): void {
    this.track({ type: "recover", historyId, actor, mutationId: newMutationId() });
  }

  sendClearHistory(actor: string): void {
    this.track({ type: "clearHistory", actor, mutationId: newMutationId() });
  }

  /** Manually retry all permanently failed mutations (UI "retry" action). */
  retryFailedMutations(): number {
    if (this.failed.size === 0) return 0;
    const entries = [...this.failed.values()];
    this.failed.clear();
    for (const entry of entries) {
      entry.attempts = 0;
      this.pending.set(entry.mutationId, entry);
    }
    this.lastError = null;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.flushPending();
    } else {
      this.reconnectDelay = 1000;
      this.connect();
    }
    this.notifySaveInfo();
    return entries.length;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const entry of this.pending.values()) this.clearTimers(entry);
    this.pending.clear();
    this.failed.clear();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

// One shared instance per tab.
export const syncClient = new SyncClient();
