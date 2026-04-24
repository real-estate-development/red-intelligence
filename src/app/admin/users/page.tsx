import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { AppHeader } from "@/components/AppHeader";
import { AdminUsersPanel } from "@/components/AdminUsersPanel";

export default async function AdminUsersPage() {
  const session = await requireAdmin();
  if (!session) {
    redirect("/map");
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <AppHeader username={session.username!} isAdmin />
      <main className="flex-1">
        <AdminUsersPanel />
      </main>
    </div>
  );
}
