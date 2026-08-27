// src/components/LiveIndicator.tsx
// Shows the real-time connection AND save status in the header.
// States:
//   🟢 Connected — all changes saved
//   🟡 Saving… / Reconnecting…
//   ⚪ Offline — changes are not saved yet (queued, will send on reconnect)
//   🔴 Save failed — tap to retry
import { useData } from "@/context/DataContext";
import { Radio, Loader2, WifiOff, CloudUpload, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function LiveIndicator() {
  const { connectionStatus, saveInfo, retryFailedSaves } = useData();
  const pending = saveInfo?.pending ?? 0;
  const failed = saveInfo?.failed ?? 0;

  // Save-failed takes precedence so it's never hidden by "connected".
  if (connectionStatus === "connected" && failed > 0) {
    return (
      <button
        type="button"
        onClick={() => retryFailedSaves()}
        title={saveInfo?.lastError ?? "Some changes could not be saved. Click to retry."}
        className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-100"
      >
        <AlertCircle className="h-3.5 w-3.5" />
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        Save failed — click to retry ({failed})
      </button>
    );
  }

  const config = {
    connected: pending > 0
      ? {
          icon: CloudUpload,
          label: `Saving… (${pending})`,
          dot: "bg-amber-500",
          text: "text-amber-700",
          bg: "bg-amber-50 border-amber-200",
          pulse: true,
        }
      : {
          icon: Radio,
          label: "Connected — all changes saved",
          dot: "bg-emerald-500",
          text: "text-emerald-700",
          bg: "bg-emerald-50 border-emerald-200",
          pulse: true,
        },
    connecting: {
      icon: Loader2,
      label: "Connecting…",
      dot: "bg-amber-500",
      text: "text-amber-700",
      bg: "bg-amber-50 border-amber-200",
      pulse: false,
    },
    reconnecting: {
      icon: Loader2,
      label: pending > 0 ? `Reconnecting… (${pending} queued)` : "Reconnecting…",
      dot: "bg-amber-500",
      text: "text-amber-700",
      bg: "bg-amber-50 border-amber-200",
      pulse: false,
    },
    offline: {
      icon: WifiOff,
      label: pending > 0 ? `Offline — ${pending} change(s) not saved yet` : "Offline — changes are not saved",
      dot: "bg-slate-400",
      text: "text-slate-600",
      bg: "bg-slate-50 border-slate-200",
      pulse: false,
    },
  } as const;

  const c = config[connectionStatus] ?? config.offline;
  const Icon = c.icon;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium",
        c.bg,
        c.text,
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", connectionStatus === "connecting" || connectionStatus === "reconnecting" ? "animate-spin" : "")} />
      <span className={cn("h-1.5 w-1.5 rounded-full", c.dot, c.pulse && "animate-pulse")} />
      {c.label}
    </div>
  );
}
