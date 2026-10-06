import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/StatusBadge";
import { useData } from "@/context/DataContext";
import { computeInvoiceSettlement } from "@/lib/invoiceSettlement";
import { Building2, Home, Users, FileText, AlertTriangle, CheckCircle2, Clock, MessageSquareWarning, ArrowRight, Receipt, Bookmark } from "lucide-react";
import { Link } from "react-router-dom";
import { format } from "date-fns";

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-BH", {
    style: "currency",
    currency: "BHD",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(amount);
}

export default function Dashboard() {
  const { buildings, units, leases, tenants, invoices, payments, complaints, getTenantById, getUnitById, getBuildingById } = useData();
  const totalUnits = units.length;
  const occupied = units.filter((u) => u.status === "Occupied").length;
  const vacant = units.filter((u) => u.status === "Vacant").length;
  const reserved = units.filter((u) => u.status === "Reserved").length;
  const occupancyRate = Math.round((occupied / totalUnits) * 100);
  const activeLeases = leases.filter((l) => l.status === "Active").length;
  const activeTenants = tenants.filter((t) => t.status === "Active").length;
  const expiringSoon = leases.filter((l) => {
    const end = new Date(l.endDate);
    const diff = Math.ceil((end.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
    return l.status === "Active" && diff <= 60 && diff > 0;
  }).length;
  // Unresolved tickets (Open or In Progress) — real count from live data.
  const openComplaints = complaints.filter((c) => c.status === "Open" || c.status === "In Progress").length;

  // Cancelled invoices are void documents (balance forced to 0 on void) —
  // counting them would treat their original amount as "collected". Balance
  // invoices are mirrors of an original's remaining amount — counting them
  // too would double-count the outstanding balance. Every figure below
  // derives from the ACTUAL payment records, never a stored balance.
  const billableInvoices = invoices.filter((i) => i.status !== "Cancelled" && !i.originalInvoiceId);
  const outstanding = billableInvoices.reduce(
    (sum, i) => sum + computeInvoiceSettlement(i, payments).remainingBalance,
    0,
  );
  const totalBilled = billableInvoices.reduce((sum, i) => sum + i.amount, 0);
  const totalCollected = totalBilled - outstanding;
  const partiallyPaidOutstanding = billableInvoices
    .filter((i) => computeInvoiceSettlement(i, payments).paymentStatus === "Partially Paid")
    .reduce((sum, i) => sum + computeInvoiceSettlement(i, payments).remainingBalance, 0);
  const overdueInvoices = invoices.filter((i) => i.status === "Overdue").length;
  const overdueAmount = invoices
    .filter((i) => i.status === "Overdue")
    .reduce((sum, i) => sum + computeInvoiceSettlement(i, payments).remainingBalance, 0);

  // Finance cards — one consistent, minimal style with a subtle color accent.
  const financeCards: { label: string; value: string; accent: string; sub?: string }[] = [
    { label: "Total Invoiced", value: formatCurrency(totalBilled), accent: "border-l-slate-400" },
    { label: "Total Collected", value: formatCurrency(totalCollected), accent: "border-l-emerald-500" },
    { label: "Outstanding", value: formatCurrency(outstanding), accent: "border-l-orange-500" },
    { label: "Partially Paid", value: formatCurrency(partiallyPaidOutstanding), accent: "border-l-amber-500" },
    {
      label: "Overdue",
      value: formatCurrency(overdueAmount),
      sub: `${overdueInvoices} invoice${overdueInvoices === 1 ? "" : "s"}`,
      accent: "border-l-red-500",
    },
  ];

  const kpiCards = [
    { title: "Total Buildings", value: buildings.length, icon: Building2, color: "bg-indigo-100 text-indigo-600" },
    { title: "Total Units", value: totalUnits, icon: Home, color: "bg-blue-100 text-blue-600" },
    { title: "Occupied", value: occupied, subtitle: `${occupancyRate}% occupancy`, icon: CheckCircle2, color: "bg-emerald-100 text-emerald-600" },
    { title: "Vacant", value: vacant, icon: Clock, color: "bg-slate-100 text-slate-600" },
    { title: "Reserved", value: reserved, subtitle: "Flats on hold", icon: Bookmark, color: "bg-violet-100 text-violet-600" },
    { title: "Active Tenants", value: activeTenants, icon: Users, color: "bg-purple-100 text-purple-600" },
    { title: "Active Leases", value: activeLeases, icon: FileText, color: "bg-cyan-100 text-cyan-600" },
    { title: "Expiring (60d)", value: expiringSoon, icon: Clock, color: "bg-orange-100 text-orange-600" },
    { title: "Open Complaints", value: openComplaints, icon: MessageSquareWarning, color: "bg-red-100 text-red-600" },
  ];

  const buildingOccupancy = buildings.map((b) => {
    const bUnits = units.filter((u) => u.buildingId === b.id);
    const bOccupied = bUnits.filter((u) => u.status === "Occupied").length;
    return { ...b, total: bUnits.length, occupied: bOccupied, rate: Math.round((bOccupied / bUnits.length) * 100) };
  });

  const tenantsByBuilding = buildings.map((b) => {
    const bTenants = tenants.filter((t) => t.buildingId === b.id && t.status === "Active");
    return { id: b.id, name: b.name, count: bTenants.length, tenants: bTenants };
  });
  const unassignedTenants = tenants.filter((t) => !t.buildingId && t.status === "Active").length;

  const recentInvoices = [...invoices].sort((a, b) => new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime()).slice(0, 5);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Overview of your property portfolio and financials</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpiCards.map((kpi) => (
          <Card key={kpi.title}>
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">{kpi.title}</p>
                  <p className="mt-2 text-3xl font-bold text-foreground">{kpi.value}</p>
                  {kpi.subtitle && <p className="mt-1 text-xs text-muted-foreground">{kpi.subtitle}</p>}
                </div>
                <div className={`rounded-lg p-2 ${kpi.color}`}>
                  <kpi.icon className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-red-200 bg-red-50/50">
        <CardContent className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-red-100 p-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold text-red-700">{overdueInvoices} overdue invoice(s)</p>
              <p className="text-sm text-red-600">Total outstanding: {formatCurrency(overdueAmount)}</p>
            </div>
          </div>
          <Link to="/invoices" className="flex items-center text-sm font-medium text-red-700 hover:underline">
            View <ArrowRight className="ml-1 h-4 w-4" />
          </Link>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base font-semibold">Occupancy by Building</CardTitle>
            <Link to="/buildings" className="flex items-center text-sm font-medium text-primary hover:underline">
              Full report <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-5 pt-2">
            {buildingOccupancy.map((b) => (
              <div key={b.id}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">{b.name}</span>
                  <span className="text-muted-foreground">
                    {b.occupied}/{b.total} ({b.rate}%)
                  </span>
                </div>
                <Progress value={b.rate} className="h-2" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base font-semibold">Tenants by Building</CardTitle>
            <Link to="/tenants" className="flex items-center text-sm font-medium text-primary hover:underline">
              View all <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-3 pt-2">
            {tenantsByBuilding.map((b) => (
              <div key={b.id} className="flex items-center justify-between text-sm">
                <span className="font-medium text-foreground">{b.name}</span>
                <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">{b.count} tenant{b.count === 1 ? "" : "s"}</span>
              </div>
            ))}
            {unassignedTenants > 0 && (
              <div className="flex items-center justify-between text-sm border-t pt-2">
                <span className="font-medium text-muted-foreground">Unassigned</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">{unassignedTenants}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base font-semibold">Recent Invoices</CardTitle>
            <Link to="/invoices" className="flex items-center text-sm font-medium text-primary hover:underline">
              View all <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="space-y-4">
              {recentInvoices.map((invoice) => {
                const tenant = getTenantById(invoice.tenantId);
                const unit = getUnitById(invoice.unitId);
                const building = unit ? getBuildingById(unit.buildingId) : undefined;
                return (
                  <div key={invoice.id} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">{tenant?.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {invoice.invoiceNumber} · {unit?.unitNumber} / {building?.name}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-foreground">{formatCurrency(invoice.amount)}</p>
                      <StatusBadge status={invoice.status} />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {financeCards.map((c) => (
          <Card key={c.label} className={`border-l-4 ${c.accent} shadow-sm`}>
            <CardContent className="p-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{c.label}</p>
              <p className="mt-2 text-xl font-semibold tabular-nums text-foreground">{c.value}</p>
              {c.sub && <p className="mt-1 text-xs text-muted-foreground">{c.sub}</p>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
