"use client";

import dynamic from "next/dynamic";

const BuildingMap = dynamic(() => import("@/components/BuildingMap").then((m) => m.BuildingMap), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">Loading map…</div>
  ),
});

export function MapShell() {
  return (
    <div className="min-h-0 flex-1">
      <BuildingMap />
    </div>
  );
}
