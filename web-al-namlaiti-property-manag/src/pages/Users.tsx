import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { authApi, type AuthUser, type Role } from "@/lib/authClient";
import { useAuth } from "@/context/AuthContext";
import { Shield, Mail, KeyRound, Trash2, UserPlus, Lock, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const ROLES: Role[] = ["Owner", "Admin", "Accountant", "Staff"];

const ROLE_HINTS: Record<Role, string> = {
  Owner: "Full control, including user management",
  Admin: "Everything except user management",
  Accountant: "Finance (invoices, payments, expenses, EWA, accounting) + view-only portfolio",
  Staff: "Payments, maintenance & complaints + view-only dashboards",
};

export default function Users() {
  const { user: me, setUser } = useAuth();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Add-user dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<Role>("Staff");
  const [saving, setSaving] = useState(false);

  // Reset-password dialog state
  const [resetTarget, setResetTarget] = useState<AuthUser | undefined>();
  const [resetPassword, setResetPassword] = useState("");

  const [deletingUser, setDeletingUser] = useState<AuthUser | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authApi.listUsers();
      setUsers(res.users);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.role.toLowerCase().includes(search.toLowerCase()),
  );

  const isBootstrapOwner = (u: AuthUser) => u.isBootstrapOwner;
  const isSelf = (u: AuthUser) => me?.id === u.id;

  const openAdd = () => {
    setNewName("");
    setNewEmail("");
    setNewPassword("");
    setNewRole("Staff");
    setAddOpen(true);
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newEmail.trim() || newPassword.length < 6) {
      toast.error("Name, email and a password of at least 6 characters are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await authApi.createUser({
        name: newName.trim(),
        email: newEmail.trim(),
        password: newPassword,
        role: newRole,
      });
      setUsers((prev) => [...prev, res.user]);
      toast.success(`${res.user.name} added as ${res.user.role}`);
      setAddOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the user.");
    } finally {
      setSaving(false);
    }
  };

  const handleRoleChange = async (u: AuthUser, role: Role) => {
    if (role === u.role) return;
    try {
      const res = await authApi.updateUser(u.id, { role });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? res.user : x)));
      if (isSelf(u)) setUser(res.user);
      toast.success(`${u.name} is now ${role}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the role.");
    }
  };

  const handleStatusToggle = async (u: AuthUser) => {
    const next = u.status === "Active" ? "Deactivated" : "Active";
    try {
      const res = await authApi.updateUser(u.id, { status: next });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? res.user : x)));
      toast.success(
        next === "Deactivated"
          ? `${u.name} deactivated — their sign-in is blocked immediately.`
          : `${u.name} reactivated.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the status.");
    }
  };

  const handleResetPassword = async () => {
    if (!resetTarget || resetPassword.length < 6) {
      toast.error("New password must be at least 6 characters.");
      return;
    }
    try {
      await authApi.updateUser(resetTarget.id, { password: resetPassword });
      toast.success(`Password reset for ${resetTarget.name}. Their other sessions are signed out.`);
      setResetTarget(undefined);
      setResetPassword("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reset the password.");
    }
  };

  const handleDelete = async (u: AuthUser) => {
    try {
      await authApi.deleteUser(u.id);
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
      toast.success(`${u.name} removed.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the user.");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        subtitle={`${users.length} user(s) · roles control who sees and changes what`}
        action={{ label: "Add User", onClick: openAdd }}
      />

      <div className="relative max-w-md">
        <Shield className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name, email, or role..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" /> Loading users…
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((u) => {
            const locked = isBootstrapOwner(u);
            return (
              <Card key={u.id}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-white">
                        {u.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate font-semibold text-foreground">
                          {u.name}
                          {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                        </p>
                        <p className="truncate text-sm text-muted-foreground">{u.email}</p>
                      </div>
                    </div>
                    <Badge
                      className={
                        u.status === "Active"
                          ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-100"
                      }
                    >
                      {u.status}
                    </Badge>
                  </div>

                  <div className="mt-4 space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Shield className="h-4 w-4 text-muted-foreground" />
                      {locked || isSelf(u) ? (
                        <span className="font-medium">{u.role}</span>
                      ) : (
                        <Select value={u.role} onValueChange={(v) => void handleRoleChange(u, v as Role)}>
                          <SelectTrigger className="h-8 w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {r}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                    <p className="pl-6 text-xs text-muted-foreground">{ROLE_HINTS[u.role]}</p>
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => {
                        setResetTarget(u);
                        setResetPassword("");
                      }}
                    >
                      <KeyRound className="mr-2 h-4 w-4" /> Reset Password
                    </Button>
                    {locked || isSelf(u) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 opacity-50"
                        disabled
                        title={locked ? "The main Owner account cannot be deactivated" : "You cannot deactivate yourself"}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {u.status === "Active" ? "Deactivate" : "Activate"}
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" className="flex-1" onClick={() => void handleStatusToggle(u)}>
                        <Trash2 className="mr-2 h-4 w-4" />
                        {u.status === "Active" ? "Deactivate" : "Activate"}
                      </Button>
                    )}
                    {locked ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="opacity-50"
                        disabled
                        title="The main Owner account cannot be removed"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-600 hover:bg-red-50 hover:text-red-700"
                        onClick={() => setDeletingUser(u)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add user */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" /> Add User
            </DialogTitle>
            <DialogDescription>Create a sign-in and choose the role. They can change the password after signing in.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-name">Name</Label>
              <Input id="new-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Fatima Ahmed" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-email">Email</Label>
              <Input
                id="new-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password">Temporary password</Label>
              <Input
                id="new-password"
                type="text"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 6 characters"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as Role)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{ROLE_HINTS[newRole]}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void handleCreate()} disabled={saving}>
                {saving ? "Creating…" : "Create User"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reset password */}
      <Dialog open={Boolean(resetTarget)} onOpenChange={(o) => !o && setResetTarget(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a new password for {resetTarget?.name}. Their other sessions are signed out immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="reset-password">New password</Label>
              <Input
                id="reset-password"
                type="text"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="At least 6 characters"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setResetTarget(undefined)}>
                Cancel
              </Button>
              <Button onClick={() => void handleResetPassword()}>Reset Password</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <DeleteConfirmDialog
        open={Boolean(deletingUser)}
        onOpenChange={(o) => !o && setDeletingUser(undefined)}
        itemName={deletingUser?.name}
        onConfirm={() => deletingUser && void handleDelete(deletingUser)}
      />

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Mail className="h-3.5 w-3.5" />
        Deactivated users cannot sign in; the main Owner account is protected and cannot be changed or removed.
      </div>
    </div>
  );
}
