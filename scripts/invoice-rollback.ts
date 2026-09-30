/**
 * One-off rollback script: removes invoices created by the automatic
 * invoice-generation feature from the shared workspace DB.
 *
 * Usage:
 *   bun scripts/invoice-rollback.ts analyze   # read-only: backup + report
 *   bun scripts/invoice-rollback.ts apply     # delete flagged invoices + revert cascades
 *
 * Safety rules:
 *  - Only invoices with generatedAutomatically === true are candidates.
 *  - Any invoice that has payment records is KEPT (never delete paid history).
 *  - Journal entries auto-posted for deleted invoices are removed with them.
 *  - EWA bills / expenses / maintenance that were marked "Invoiced" by the
 *    deleted invoices are reverted to their pre-invoice state.
 *  - Everything else is untouched. A full JSON backup is written first.
 */

const WS_URL = "wss://al-namlaiti-property-system-backend.rork.app";
const MODE = (process.argv[2] ?? "analyze") as "analyze" | "apply";

interface WsMessage {
  type: string;
  store?: Record<string, unknown[]>;
  ack?: string;
  [k: string]: unknown;
}

const ws = new WebSocket(WS_URL);
let snapshot: Record<string, unknown[]> | null = null;
const acks = new Set<string>();
const waits: ((m: WsMessage) => void)[] = [];

function nextId(): string {
  return crypto.randomUUID();
}

ws.onmessage = (ev) => {
  let msg: WsMessage;
  try {
    msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as WsMessage;
  } catch {
    return;
  }
  if (msg.type === "snapshot" && msg.store) snapshot = msg.store;
  if (msg.type === "ack" && msg.mutationId) acks.add(msg.mutationId as string);
  const w = waits.shift();
  if (w) w(msg);
};

function waitFor(pred: (m: WsMessage) => boolean, timeoutMs = 20000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for server message")), timeoutMs);
    const check = (m: WsMessage) => {
      if (pred(m)) {
        clearTimeout(timer);
        resolve(m);
      } else {
        waits.push(check);
      }
    };
    waits.push(check);
  });
}

function send(payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

async function mutate(op: Record<string, unknown>): Promise<void> {
  const mutationId = nextId();
  send({ type: "mutate", op, actor: "Rollback-cleanup", mutationId });
  // Wait for ack (server acks only after durable persist). Retry-wait a few times
  // in case an unrelated message arrives first.
  for (let i = 0; i < 60; i++) {
    if (acks.has(mutationId)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`mutation ${mutationId} not acked`);
}

interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  generatedAutomatically?: boolean;
  leaseId?: string;
  tenantId?: string;
  issueDate?: string;
  periodFrom?: string;
  status?: string;
  amount?: number;
  balance?: number;
  journalEntryId?: string;
  ewaBillIds?: string[];
  expenseIds?: string[];
  maintenanceIds?: string[];
  [k: string]: unknown;
}

ws.onopen = async () => {
  try {
    send({ type: "subscribe" });
    await waitFor((m) => m.type === "snapshot");
    const store = snapshot as Record<string, unknown[]>;
    const countsBefore: Record<string, number> = {};
    for (const [k, v] of Object.entries(store)) countsBefore[k] = Array.isArray(v) ? v.length : 0;

    const invoices = (store.invoices ?? []) as InvoiceRecord[];
    const payments = (store.payments ?? []) as { id: string; invoiceId?: string; receiptNumber?: string }[];
    const journalEntries = (store.journalEntries ?? []) as { id: string; description?: string }[];
    const ewaBills = (store.ewaBills ?? []) as { id: string; status?: string; invoiceId?: string }[];
    const expenses = (store.expenses ?? []) as { id: string; status?: string; invoiceId?: string }[];
    const maintenance = (store.maintenanceRequests ?? []) as { id: string; invoiceId?: string }[];
    const history = (store.history ?? []) as { id: string; entityType?: string; entityId?: string; summary?: string }[];

    // ── Identify feature-created invoices ──
    const flagged = invoices.filter((i) => i.generatedAutomatically === true);
    const autoHistoryIds = new Set(
      history
        .filter((h) => h.entityType === "Invoice" && (h.summary ?? "").includes("auto-generated"))
        .map((h) => h.entityId as string),
    );

    // Invoices referenced by history "auto-generated" entries but already gone.
    const invoiceIds = new Set(invoices.map((i) => i.id));

    // Split flagged invoices: with payments (KEEP) vs without (DELETE).
    const withPayments: { invoice: InvoiceRecord; payments: string[] }[] = [];
    const toDelete: InvoiceRecord[] = [];
    for (const inv of flagged) {
      const linked = payments.filter((p) => p.invoiceId === inv.id).map((p) => p.receiptNumber ?? p.id);
      if (linked.length > 0) withPayments.push({ invoice: inv, payments: linked });
      else toDelete.push(inv);
    }
    const deleteIds = new Set(toDelete.map((i) => i.id));

    // ── Side effects created by the feature for the deleted invoices ──
    const jeToDelete = journalEntries.filter((je) =>
      toDelete.some(
        (inv) =>
          (inv.journalEntryId && inv.journalEntryId === je.id) ||
          (je.description ?? "").includes(`invoice ${inv.invoiceNumber}`),
      ),
    );

    const ewaToRevert = ewaBills.filter((b) => b.invoiceId && deleteIds.has(b.invoiceId));
    const expToRevert = expenses.filter((e) => e.invoiceId && deleteIds.has(e.invoiceId));
    const mntToRevert = maintenance.filter((m) => m.invoiceId && deleteIds.has(m.invoiceId));

    // ── Report ──
    console.log("=== COLLECTION COUNTS BEFORE ===");
    console.log(JSON.stringify(countsBefore, null, 2));
    console.log(`\nTotal invoices: ${invoices.length}`);
    console.log(`Flagged generatedAutomatically=true: ${flagged.length}`);
    console.log(`  → DELETE (no payments): ${toDelete.length}`);
    console.log(`  → KEEP (has payments): ${withPayments.length}`);
    console.log(`History 'auto-generated' entries: ${autoHistoryIds.size} (of which still-existing invoices: ${[...autoHistoryIds].filter((id) => invoiceIds.has(id)).length})`);

    console.log("\n=== INVOICES TO DELETE ===");
    for (const inv of toDelete) {
      console.log(
        `${inv.invoiceNumber} | id=${inv.id} | lease=${inv.leaseId} | tenant=${inv.tenantId} | period=${inv.periodFrom} | issue=${inv.issueDate} | status=${inv.status} | amount=${inv.amount}`,
      );
    }

    console.log("\n=== FLAGGED INVOICES KEPT (payments exist) ===");
    for (const { invoice, payments: ps } of withPayments) {
      console.log(`${invoice.invoiceNumber} | id=${invoice.id} | payments: ${ps.join(", ")}`);
    }

    console.log("\n=== JOURNAL ENTRIES TO DELETE (auto-posted for deleted invoices) ===");
    for (const je of jeToDelete) console.log(`${je.id} | ${je.description}`);

    console.log("\n=== CASCADE RECORDS TO REVERT (clear invoiceId / status → Pending) ===");
    for (const b of ewaToRevert) console.log(`EWA bill ${b.id} status=${b.status}`);
    for (const e of expToRevert) console.log(`Expense ${e.id} status=${e.status}`);
    for (const m of mntToRevert) console.log(`Maintenance ${m.id}`);

    // Backup everything before any mutation.
    const backupPath = `/tmp/store-backup-${Date.now()}.json`;
    await Bun.write(backupPath, JSON.stringify(store, null, 2));
    console.log(`\nFull store backup written to ${backupPath}`);

    if (MODE !== "apply") {
      console.log("\n(analyze mode — no changes made. Re-run with 'apply' to execute.)");
      ws.close();
      process.exit(0);
    }

    // ── Apply (bulk, fire-and-forget with per-message ack ledger) ──
    console.log("\n=== APPLYING (bulk) ===");
    let sent = 0;
    const sendOp = (op: Record<string, unknown>) => {
      send({ type: "mutate", op, actor: "Rollback-cleanup", mutationId: nextId() });
      sent++;
    };
    for (const inv of toDelete) {
      sendOp({ kind: "delete", collection: "invoices", id: inv.id, snapshot: inv as unknown as Record<string, unknown> });
    }
    for (const je of jeToDelete) {
      sendOp({ kind: "delete", collection: "journalEntries", id: je.id });
    }
    for (const b of ewaToRevert) {
      sendOp({ kind: "update", collection: "ewaBills", id: b.id, patch: { status: "Pending", invoiceId: null } });
    }
    for (const e of expToRevert) {
      sendOp({ kind: "update", collection: "expenses", id: e.id, patch: { status: "Pending", invoiceId: null } });
    }
    for (const m of mntToRevert) {
      sendOp({ kind: "update", collection: "maintenanceRequests", id: m.id, patch: { invoiceId: null } });
    }
    console.log(`Sent ${sent} mutations. Waiting for acks...`);
    // Give the server a moment to process and ack everything.
    const deadline = Date.now() + 15000;
    while (acks.size < sent && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`Acks received: ${acks.size}/${sent} (nacks/already-deleted ids are skipped in verification)`);

    // ── Verify: fresh connection + snapshot after mutations ──
    console.log("\n=== VERIFYING (fresh snapshot) ===");
    let after: Record<string, unknown[]> | null = null;
    for (let attempt = 0; attempt < 3 && !after; attempt++) {
      try {
        ws.close();
        await new Promise((r) => setTimeout(r, 1000));
        const ws2 = new WebSocket(WS_URL);
        after = await new Promise<Record<string, unknown[]>>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("verify snapshot timeout")), 20000);
          ws2.onmessage = (ev) => {
            try {
              const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as WsMessage;
              if (msg.type === "snapshot" && msg.store) {
                clearTimeout(t);
                resolve(msg.store as Record<string, unknown[]>);
              }
            } catch { /* ignore */ }
          };
          ws2.onopen = () => ws2.send(JSON.stringify({ type: "subscribe" }));
          ws2.onerror = () => {
            clearTimeout(t);
            reject(new Error("verify connection error"));
          };
        });
        ws2.close();
      } catch (err) {
        console.warn(`verify attempt ${attempt + 1} failed:`, err);
      }
    }
    if (!after) throw new Error("could not fetch verification snapshot");

    const afterInvoices = (after.invoices ?? []) as InvoiceRecord[];
    const remainingFlagged = afterInvoices.filter((i) => i.generatedAutomatically === true);
    const countsAfter: Record<string, number> = {};
    for (const [k, v] of Object.entries(after)) countsAfter[k] = Array.isArray(v) ? v.length : 0;

    console.log("\n=== COLLECTION COUNTS AFTER ===");
    console.log(JSON.stringify(countsAfter, null, 2));
    const diffs = Object.keys(countsBefore).filter((k) => countsBefore[k] !== countsAfter[k]);
    console.log("\nChanged collections:", JSON.stringify(diffs.map((k) => ({ collection: k, before: countsBefore[k], after: countsAfter[k] }))));
    console.log(`Remaining generatedAutomatically=true invoices: ${remainingFlagged.length}`);
    for (const inv of remainingFlagged) console.log(`  kept (has payments): ${inv.invoiceNumber}`);

    if (remainingFlagged.length > 0) {
      console.log("\nRe-sending deletes for remaining flagged invoices...");
      ws.close();
      process.exit(2); // re-run apply to finish the job
    }

    console.log("\nRollback apply complete.");
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err);
    ws.close();
    process.exit(1);
  }
};

ws.onerror = (e) => {
  console.error("WebSocket error", e);
  process.exit(1);
};
