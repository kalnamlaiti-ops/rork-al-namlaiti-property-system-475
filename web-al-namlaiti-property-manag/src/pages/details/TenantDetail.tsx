import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useData } from "@/context/DataContext";
import TenantForm from "@/components/forms/TenantForm";
import { IndividualReportDialog } from "@/components/reports/IndividualReportDialog";
import { buildTenantDetailReport } from "@/lib/reportData";
import { downloadReportPdf } from "@/lib/reportPdf";
import type { ReportSection } from "@/lib/reportPdf";
import { openReportPrintWindow } from "@/lib/reportPrint";
import { toast } from "sonner";
import { ArrowLeft, Pencil, Mail, Phone, FileText, Building2, Printer, FileDown, Eye } from "lucide-react";

export default function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { tenants, leases, units, buildings, invoices, payments, getTenantById, getUnitById, getBuildingById } = useData();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const tenant = id ? getTenantById(id) : undefined;
  const tenantLeases = tenant ? leases.filter((l) => l.tenantId === tenant.id) : [];

  if (!tenant) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => navigate("/tenants")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <p className="text-muted-foreground">Tenant not found.</p>
      </div>
    );
  }

  // Account statement — every figure comes from the actual invoice & payment
  // records (balance invoices are mirrors of originals and are excluded to
  // avoid double-counting).
  const statementRows = invoices
    .filter((i) => i.tenantId === tenant.id && !i.originalInvoiceId && i.status !== "Cancelled")
    .map((inv) => {
      const invPayments = payments.filter((p) => p.invoiceId === inv.id);
      const paid = invPayments.reduce((s, p) => s + (p.amount || 0), 0);
      return { inv, paid, paymentsCount: invPayments.length, remaining: Math.max(0, inv.amount - paid) };
    });
  const statementOutstanding = statementRows.reduce((s, r) => s + r.remaining, 0);

  const reportTitle = `Tenant Report — ${tenant.name}`;
  const reportFileName = `tenant-report-${tenant.name.replace(/\s+/g, "-").toLowerCase()}.pdf`;
  const report = buildTenantDetailReport(tenant, { tenants, leases, units, buildings }, invoices, payments);
  const reportSections: ReportSection[] = [
    { heading: "Tenant Information", info: report.info },
    { heading: "Lease Information", columns: report.leases.columns, rows: report.leases.rows, emptyMessage: "No leases recorded for this tenant." },
    { heading: "Invoices", columns: report.invoices.columns, rows: report.invoices.rows, emptyMessage: "No invoices recorded for this tenant." },
    { heading: "Payments", columns: report.payments.columns, rows: report.payments.rows, emptyMessage: "No payments recorded for this tenant." },
    { heading: "Financial Summary", info: report.financialTotals },
  ];

  const handlePrintReport = () => {
    const ok = openReportPrintWindow({ title: reportTitle, sections: reportSections });
    if (!ok) {
      toast.error("Pop-up blocked — allow pop-ups to print, or use Download PDF.");
    }
  };

  const handleDownloadReport = () => {
    downloadReportPdf({ title: reportTitle, sections: reportSections }, reportFileName);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => navigate("/tenants")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setReportOpen(true)}>
            <Eye className="mr-2 h-4 w-4" /> View Report
          </Button>
          <Button variant="outline" onClick={handlePrintReport}>
            <Printer className="mr-2 h-4 w-4" /> Print
          </Button>
          <Button variant="outline" onClick={handleDownloadReport}>
            <FileDown className="mr-2 h-4 w-4" /> Download PDF
          </Button>
          <Button variant="outline" onClick={() => setDialogOpen(true)}>
            <Pencil className="mr-2 h-4 w-4" /> Edit
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-semibold text-lg">
          {tenant.name.charAt(0)}
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{tenant.name}</h1>
          <p className="text-sm text-muted-foreground">{tenant.type} · {tenant.crNumber ? `CPR: ${tenant.crNumber}` : "No CPR"}</p>
        </div>
        <StatusBadge status={tenant.status} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="p-6">
            <h3 className="mb-4 text-base font-semibold">Personal Information</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">Email</p>
                <p className="font-medium flex items-center gap-2"><Mail className="h-4 w-4" /> {tenant.email}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Phone</p>
                <p className="font-medium flex items-center gap-2"><Phone className="h-4 w-4" /> {tenant.phone}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Address</p>
                <p className="font-medium">{tenant.address || "—"}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Building</p>
                <p className="font-medium flex items-center gap-2"><Building2 className="h-4 w-4" /> {tenant.buildingId ? getBuildingById(tenant.buildingId)?.name : "—"}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Notes</p>
                <p className="font-medium whitespace-pre-line">{tenant.notes || "—"}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <h3 className="mb-4 text-base font-semibold">Lease Summary</h3>
            <p className="text-3xl font-bold text-foreground">{tenantLeases.length}</p>
            <p className="text-sm text-muted-foreground">Active leases</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-6">
          <h3 className="mb-4 text-base font-semibold">Leases</h3>
          {tenantLeases.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leases.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Contract #</th>
                    <th className="px-4 py-3 text-left font-medium">Unit</th>
                    <th className="px-4 py-3 text-left font-medium">Building</th>
                    <th className="px-4 py-3 text-left font-medium">Rent</th>
                    <th className="px-4 py-3 text-left font-medium">Period</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tenantLeases.map((l) => {
                    const unit = getUnitById(l.unitId);
                    const building = unit ? getBuildingById(unit.buildingId) : undefined;
                    return (
                      <tr key={l.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <Link to={`/leases/${l.id}`} className="font-medium text-primary hover:underline">{l.contractNumber}</Link>
                        </td>
                        <td className="px-4 py-3">{unit?.unitNumber}</td>
                        <td className="px-4 py-3">{building?.name}</td>
                        <td className="px-4 py-3">BHD {l.monthlyRent}</td>
                        <td className="px-4 py-3">{l.startDate} to {l.endDate}</td>
                        <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h3 className="mb-1 text-base font-semibold">Account Statement</h3>
          <p className="mb-4 text-sm text-muted-foreground">Computed from the actual invoice and payment records.</p>
          {statementRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices recorded for this tenant.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Invoice</th>
                    <th className="px-4 py-3 text-right font-medium">Invoice Total</th>
                    <th className="px-4 py-3 text-right font-medium">Payments</th>
                    <th className="px-4 py-3 text-right font-medium">Paid Amount</th>
                    <th className="px-4 py-3 text-right font-medium">Remaining Balance</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {statementRows.map(({ inv, paid, paymentsCount, remaining }) => (
                    <tr key={inv.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <Link to={`/invoices/${inv.id}`} className="font-medium text-primary hover:underline">{inv.invoiceNumber}</Link>
                      </td>
                      <td className="px-4 py-3 text-right">BHD {inv.amount.toFixed(3)}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">{paymentsCount}</td>
                      <td className="px-4 py-3 text-right text-emerald-600">BHD {paid.toFixed(3)}</td>
                      <td className="px-4 py-3 text-right font-semibold text-red-600">BHD {remaining.toFixed(3)}</td>
                      <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/50">
                    <td className="px-4 py-3 font-semibold" colSpan={4}>Total Outstanding</td>
                    <td className="px-4 py-3 text-right font-semibold text-red-600">BHD {statementOutstanding.toFixed(3)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Tenant</DialogTitle>
            <DialogDescription>Update the tenant details below.</DialogDescription>
          </DialogHeader>
          <TenantForm initialData={tenant} onClose={() => setDialogOpen(false)} />
        </DialogContent>
      </Dialog>

      <IndividualReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        title={reportTitle}
        subtitle="Individual tenant report"
        sections={reportSections}
        fileName={reportFileName}
      />
    </div>
  );
}
