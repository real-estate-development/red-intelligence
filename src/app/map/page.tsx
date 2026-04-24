import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { AppHeader } from "@/components/AppHeader";
import { MapShell } from "@/components/MapShell";

export default async function MapPage() {
  const session = await requireUser();
  if (!session) {
    redirect("/login");
  }

  return (
    <div className="flex h-screen flex-col">
      <AppHeader username={session.username!} isAdmin={Boolean(session.isAdmin)} />
      <MapShell />
    </div>
  );
}
