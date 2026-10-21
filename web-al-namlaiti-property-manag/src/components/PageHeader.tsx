import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { canEditPath } from "@/lib/permissions";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: {
    label: string;
    onClick?: () => void;
  };
  secondaryAction?: {
    label: string;
    onClick?: () => void;
    variant?: "outline" | "secondary" | "ghost";
  };
  className?: string;
}

export function PageHeader({ title, subtitle, action, secondaryAction, className }: PageHeaderProps) {
  const location = useLocation();
  const { user } = useAuth();
  // Hide the create/add action when the signed-in role cannot edit this page.
  const showAction = !!action && canEditPath(user?.role, location.pathname);

  return (
    <div className={cn("mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {secondaryAction && (
          <Button variant={secondaryAction.variant ?? "outline"} onClick={secondaryAction.onClick}>
            {secondaryAction.label}
          </Button>
        )}
        {showAction && (
          <Button onClick={action.onClick}>
            <Plus className="mr-2 h-4 w-4" />
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}
