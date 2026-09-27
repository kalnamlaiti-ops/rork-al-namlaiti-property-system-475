// src/components/reports/IndividualReportDialog.tsx
// "View Report" dialog for a single tenant / lease with print & PDF actions.
// The dialog body doubles as the print area (see global print stylesheet),
// and Print opens a clean print window containing only the report.

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ReportPrintBlock } from "./ReportPrintBlock";
import { downloadReportPdf } from "@/lib/reportPdf";
import type { ReportSection } from "@/lib/reportPdf";
import { openReportPrintWindow } from "@/lib/reportPrint";
import { Printer, FileDown } from "lucide-react";
import { toast } from "sonner";

interface IndividualReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  sections: ReportSection[];
  fileName: string;
}

export function IndividualReportDialog({
  open,
  onOpenChange,
  title,
  subtitle,
  sections,
  fileName,
}: IndividualReportDialogProps) {
  const handlePrint = () => {
    const ok = openReportPrintWindow({ title, subtitle, sections });
    if (!ok) {
      toast.error("Pop-up blocked — allow pop-ups to print, or use Download PDF.");
    }
  };

  const handleDownload = () => {
    downloadReportPdf(
      { title: title.toUpperCase(), subtitle, sections },
      fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Preview the report, then print it or download it as a PDF.</DialogDescription>
        </DialogHeader>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handlePrint}>
            <Printer className="mr-2 h-4 w-4" /> Print
          </Button>
          <Button size="sm" onClick={handleDownload}>
            <FileDown className="mr-2 h-4 w-4" /> Download PDF
          </Button>
        </div>

        <ReportPrintBlock title={title} subtitle={subtitle} sections={sections} />
      </DialogContent>
    </Dialog>
  );
}
