import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { MapView } from "@/components/MapView";
import { requireUser } from "@/lib/auth";

export default async function MapPage() {
  const session = await requireUser();
  if (!session) redirect("/login");

  return (
    <div className="flex h-screen flex-col">
      <AppHeader username={session.username!} isAdmin={Boolean(session.isAdmin)} />
      <div className="min-h-0 flex-1">
        <MapView />
      </div>
    </div>
  );
}
