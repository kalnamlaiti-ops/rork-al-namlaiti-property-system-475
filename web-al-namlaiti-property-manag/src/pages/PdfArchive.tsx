import { useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";
import {
  Archive,
  Download,
  Eye,
  FileText,
  History,
  Info,
  Loader2,
  Receipt,
  RefreshCw,
  Search,
  Zap,
  Files,
  Landmark,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useData } from "@/context/DataContext";
import { useAuth } from "@/context/AuthContext";
import { canEditPageId } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
  REPORT_CATEGORY_LABELS,
  REPORT_TYPE_LABELS,
  buildEwaReportData,
  buildExpenseReportData,
  formatBHD,
  formatFileSize,
  generateAndArchiveReport,
  monthLabel,
  reportFileUrl,
  type ReportDataContext,
} from "@/lib/pdfArchive";
import type { PdfReport, PdfReportType } from "@/types";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type GenType = Exclude<PdfReportType, "other">;
type CategoryTab = "all" | PdfReportType;

const TYPE_ICON: Record<PdfReportType, typeof Zap> = {
  ewa: Zap,
  expense: Receipt,
  "monthly-financial": Landmark,
  other: FileText,
};

const TYPE_TONE: Record<PdfReportType, string> = {
  ewa: "bg-amber-100 text-amber-800 border-amber-200",
  expense: "bg-rose-100 text-rose-800 border-rose-200",
  "monthly-financial": "bg-emerald-100 text-emerald-800 border-emerald-200",
  other: "bg-slate-100 text-slate-700 border-slate-200",
};

const selectCls =
  "h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

function fmtGenerated(iso: string): string {
  try {
    return format(parseISO(iso), "dd MMM yyyy, HH:mm");
  } catch {
    return iso;
  }
}

export default function PdfArchive() {
  const data = useData();
  const { buildings, pdfReports } = data;
  const { user } = useAuth();
  const canGenerate = canEditPageId(user?.role, "pdf-archive");

  const now = new Date();
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1);
  const [selYear, setSelYear] = useState(now.getFullYear());
  const [genBuilding, setGenBuilding] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);

  // List filters (follow the top selector; "all" opens historical browsing).
  const [category, setCategory] = useState<CategoryTab>("all");
  const [fMonth, setFMonth] = useState<string>(String(now.getMonth() + 1));
  const [fYear, setFYear] = useState<string>(String(now.getFullYear()));
  const [fBuilding, setFBuilding] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<PdfReport | null>(null);

  useEffect(() => {
    setFMonth(String(selMonth));
    setFYear(String(selYear));
  }, [selMonth, selYear]);

  const ym = `${selYear}-${String(selMonth).padStart(2, "0")}`;

  const ctx: ReportDataContext = useMemo(
    () => ({
      buildings: data.buildings,
      units: data.units,
      tenants: data.tenants,
      ewaAccounts: data.ewaAccounts,
      ewaDistributions: data.ewaDistributions,
      ewaBills: data.ewaBills,
      expenses: data.expenses,
      invoices: data.invoices,
      payments: data.payments,
    }),
    [data.buildings, data.units, data.tenants, data.ewaAccounts, data.ewaDistributions, data.ewaBills, data.expenses, data.invoices, data.payments],
  );

  const liveEwa = useMemo(() => buildEwaReportData(ctx, ym, genBuilding || undefined), [ctx, ym, genBuilding]);
  const liveExp = useMemo(() => buildExpenseReportData(ctx, ym, genBuilding || undefined), [ctx, ym, genBuilding]);

  const years = useMemo(() => {
    const set = new Set<number>([now.getFullYear(), now.getFullYear() - 1, now.getFullYear() + 1, selYear]);
    pdfReports.forEach((r) => set.add(r.year));
    return [...set].sort((a, b) => b - a);
  }, [pdfReports, selYear]); // eslint-disable-line react-hooks/exhaustive-deps

  // Latest version per reportKey + version lists.
  const { latestList, versionsByKey } = useMemo(() => {
    const byKey = new Map<string, PdfReport[]>();
    for (const r of pdfReports) {
      const arr = byKey.get(r.reportKey) ?? [];
      arr.push(r);
      byKey.set(r.reportKey, arr);
    }
    const latest: PdfReport[] = [];
    for (const arr of byKey.values()) {
      arr.sort((a, b) => b.version - a.version || b.generatedAt.localeCompare(a.generatedAt));
      latest.push(arr[0]);
    }
    latest.sort((a, b) => b.month.localeCompare(a.month) || b.generatedAt.localeCompare(a.generatedAt));
    return { latestList: latest, versionsByKey: byKey };
  }, [pdfReports]);

  const monthReports = latestList.filter((r) => r.month === ym);
  const overview = {
    ewaTotal: liveEwa.totalBill,
    expenseTotal: liveExp.total,
    ewaCount: monthReports.filter((r) => r.reportType === "ewa").length,
    expenseCount: monthReports.filter((r) => r.reportType === "expense").length,
    totalPdfs: pdfReports.filter((r) => r.month === ym).length,
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return latestList.filter((r) => {
      if (category !== "all" && r.reportType !== category) return false;
      if (fYear !== "all" && String(r.year) !== fYear) return false;
      if (fMonth !== "all" && Number(r.month.slice(5, 7)) !== Number(fMonth)) return false;
      if (fBuilding !== "all") {
        if (r.buildingId !== fBuilding && !(r.buildingIds ?? []).includes(fBuilding)) return false;
      }
      if (q) {
        const hay = [r.name, r.reportCode, r.generatedBy, r.fileName, REPORT_TYPE_LABELS[r.reportType], monthLabel(r.month)]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [latestList, category, fYear, fMonth, fBuilding, search]);

  const categoryCounts = useMemo(() => {
    const c: Record<CategoryTab, number> = { all: 0, ewa: 0, expense: 0, "monthly-financial": 0, other: 0 };
    for (const r of latestList) {
      c.all += 1;
      c[r.reportType] += 1;
    }
    return c;
  }, [latestList]);

  const runGenerate = async (type: GenType, month: string, buildingId: string | undefined, busyKey: string) => {
    if (!canGenerate) {
      toast.error("You don't have permission to generate reports.");
      return;
    }
    setBusy(busyKey);
    try {
      const rec = await generateAndArchiveReport({
        type,
        month,
        buildingId,
        ctx,
        existing: pdfReports,
        generatedBy: user?.name ?? "Unknown",
      });
      toast.success(`${rec.reportCode} saved to archive`, { description: `${rec.name} · ${formatFileSize(rec.fileSize)}` });
    } catch (err) {
      toast.error("Could not save the report", {
        description: err instanceof Error ? err.message : "Please check your connection and try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const openReport = (r: PdfReport) => {
    const url = reportFileUrl(r, false);
    if (url) window.open(url, "_blank", "noopener");
  };
  const downloadReport = (r: PdfReport) => {
    const url = reportFileUrl(r, true);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = r.fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const buildingName = (id?: string) => (id ? buildings.find((b) => b.id === id)?.name ?? "Unknown building" : "All buildings");

  const detailVersions = detail ? versionsByKey.get(detail.reportKey) ?? [detail] : [];

  return (
    <div>
      <PageHeader
        title="PDF Reports & Archive"
        subtitle="Generate monthly EWA, expense and financial PDFs. Every version is saved permanently and can be reopened anytime."
      />

      {/* ── Month selector + generation ── */}
      <Card className="mb-6 overflow-hidden border-slate-200">
        <div className="flex flex-col gap-4 bg-gradient-to-r from-slate-900 to-slate-800 p-5 text-white lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-300">Report month</p>
              <div className="flex gap-2">
                <select
                  aria-label="Month"
                  value={selMonth}
                  onChange={(e) => setSelMonth(Number(e.target.value))}
                  className={cn(selectCls, "border-slate-600 bg-slate-800 text-white")}
                >
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Year"
                  value={selYear}
                  onChange={(e) => setSelYear(Number(e.target.value))}
                  className={cn(selectCls, "border-slate-600 bg-slate-800 text-white")}
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-300">Scope</p>
              <select
                aria-label="Building scope"
                value={genBuilding}
                onChange={(e) => setGenBuilding(e.target.value)}
                className={cn(selectCls, "min-w-[180px] border-slate-600 bg-slate-800 text-white")}
              >
                <option value="">All buildings</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {canGenerate && (
            <div className="flex flex-wrap gap-2">
              {(["ewa", "expense", "monthly-financial"] as GenType[]).map((t) => {
                const Icon = TYPE_ICON[t];
                const key = `gen:${t}`;
                return (
                  <Button
                    key={t}
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => runGenerate(t, ym, genBuilding || undefined, key)}
                    className="bg-white text-slate-900 hover:bg-slate-100"
                  >
                    {busy === key ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Icon className="mr-2 h-4 w-4" />}
                    Generate {t === "monthly-financial" ? "Financial" : t === "ewa" ? "EWA" : "Expense"} PDF
                  </Button>
                );
              })}
            </div>
          )}
        </div>

        {/* Overview */}
        <CardContent className="grid grid-cols-2 gap-px bg-slate-200 p-0 md:grid-cols-5">
          {[
            { label: `Total EWA · ${monthLabel(ym)}`, value: formatBHD(overview.ewaTotal), sub: `${liveEwa.bills.length} bill(s) recorded`, icon: Zap, tone: "text-amber-600" },
            { label: `Total expenses · ${monthLabel(ym)}`, value: formatBHD(overview.expenseTotal), sub: `${liveExp.rows.length} expense(s), excl. rejected`, icon: Receipt, tone: "text-rose-600" },
            { label: "EWA reports", value: String(overview.ewaCount), sub: "in archive for this month", icon: FileText, tone: "text-amber-600" },
            { label: "Expense reports", value: String(overview.expenseCount), sub: "in archive for this month", icon: FileText, tone: "text-rose-600" },
            { label: "Total PDFs", value: String(overview.totalPdfs), sub: "incl. all versions", icon: Files, tone: "text-slate-700" },
          ].map((c) => (
            <div key={c.label} className="bg-white p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <c.icon className={cn("h-3.5 w-3.5", c.tone)} />
                {c.label}
              </div>
              <p className="mt-1.5 text-xl font-bold tabular-nums text-foreground">{c.value}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{c.sub}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── Category tabs ── */}
      <Tabs value={category} onValueChange={(v) => setCategory(v as CategoryTab)} className="mb-4">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="all">All ({categoryCounts.all})</TabsTrigger>
          {(["ewa", "expense", "monthly-financial", "other"] as PdfReportType[]).map((t) => (
            <TabsTrigger key={t} value={t}>
              {REPORT_CATEGORY_LABELS[t]} ({categoryCounts[t]})
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* ── Filters ── */}
      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, code, generated by…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <select aria-label="Filter month" value={fMonth} onChange={(e) => setFMonth(e.target.value)} className={selectCls}>
              <option value="all">All months</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={String(i + 1)}>
                  {m}
                </option>
              ))}
            </select>
            <select aria-label="Filter year" value={fYear} onChange={(e) => setFYear(e.target.value)} className={selectCls}>
              <option value="all">All years</option>
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter type"
              value={category}
              onChange={(e) => setCategory(e.target.value as CategoryTab)}
              className={selectCls}
            >
              <option value="all">All types</option>
              {(["ewa", "expense", "monthly-financial", "other"] as PdfReportType[]).map((t) => (
                <option key={t} value={t}>
                  {REPORT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <select aria-label="Filter building" value={fBuilding} onChange={(e) => setFBuilding(e.target.value)} className={selectCls}>
              <option value="all">All buildings</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {/* ── Report list ── */}
      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
                <Archive className="h-7 w-7 text-slate-400" />
              </div>
              <h3 className="text-base font-semibold text-foreground">
                {category === "other" ? "No other reports yet" : "No reports for these filters"}
              </h3>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {pdfReports.length === 0
                  ? "Nothing has been archived yet. Choose a month above and generate an EWA, Expense or Financial PDF — it will be saved here automatically."
                  : "Try another month, year, type or building — or set the filters to “All” to browse the full history."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Report</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Month</th>
                    <th className="px-4 py-3 font-medium">Year</th>
                    <th className="px-4 py-3 font-medium">Generated</th>
                    <th className="px-4 py-3 font-medium">By</th>
                    <th className="px-4 py-3 text-right font-medium">Size</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const Icon = TYPE_ICON[r.reportType];
                    const regenKey = `regen:${r.id}`;
                    const versions = versionsByKey.get(r.reportKey)?.length ?? 1;
                    return (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <div className="flex items-start gap-3">
                            <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border", TYPE_TONE[r.reportType])}>
                              <Icon className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-foreground">{r.name}</p>
                              <p className="font-mono text-xs text-muted-foreground">
                                {r.reportCode}
                                {versions > 1 && <span className="ml-2 font-sans">· {versions} versions</span>}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={cn("whitespace-nowrap", TYPE_TONE[r.reportType])}>
                            {REPORT_TYPE_LABELS[r.reportType]}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">{MONTHS[Number(r.month.slice(5, 7)) - 1]}</td>
                        <td className="px-4 py-3">{r.year}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{fmtGenerated(r.generatedAt)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">{r.generatedBy}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{formatFileSize(r.fileSize)}</td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" title="View" onClick={() => openReport(r)}>
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" title="Download" onClick={() => downloadReport(r)}>
                              <Download className="h-4 w-4" />
                            </Button>
                            {canGenerate && r.reportType !== "other" && (
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Regenerate (creates a new version)"
                                disabled={busy !== null}
                                onClick={() => runGenerate(r.reportType as GenType, r.month, r.buildingId, regenKey)}
                              >
                                <RefreshCw className={cn("h-4 w-4", busy === regenKey && "animate-spin")} />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" title="Details" onClick={() => setDetail(r)}>
                              <Info className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Details dialog ── */}
      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>{detail.name}</DialogTitle>
                <DialogDescription className="font-mono">{detail.reportCode}</DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {[
                  ["Type", REPORT_TYPE_LABELS[detail.reportType]],
                  ["Billing month", monthLabel(detail.month)],
                  ["Scope", buildingName(detail.buildingId)],
                  ["Version", `v${detail.version}`],
                  ["Generated", fmtGenerated(detail.generatedAt)],
                  ["Generated by", detail.generatedBy],
                  ["File name", detail.fileName],
                  ["File size", formatFileSize(detail.fileSize)],
                  [
                    detail.reportType === "monthly-financial" ? "Net (collected − expenses)" : "Report total",
                    formatBHD(detail.totals?.total),
                  ],
                  ...(detail.totals?.allocated !== undefined ? [["Total allocated", formatBHD(detail.totals.allocated)]] : []),
                  ["Records", String(detail.totals?.count ?? 0)],
                  ["Report ID", detail.id],
                ].map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="truncate font-medium text-foreground" title={v}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="mt-2">
                <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <History className="h-4 w-4" /> Version history ({detailVersions.length})
                </h4>
                <div className="max-h-64 divide-y overflow-y-auto rounded-md border">
                  {detailVersions.map((v) => (
                    <div key={v.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium">
                          v{v.version}
                          {v.id === detailVersions[0]?.id && (
                            <Badge variant="secondary" className="ml-2">
                              Latest
                            </Badge>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {fmtGenerated(v.generatedAt)} · {v.generatedBy} · {formatBHD(v.totals?.total)} · {formatFileSize(v.fileSize)}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button size="icon" variant="ghost" title="View" onClick={() => openReport(v)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" title="Download" onClick={() => downloadReport(v)}>
                          <Download className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Older versions are never deleted or overwritten. Regenerating always creates a new version.
                </p>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
