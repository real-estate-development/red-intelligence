"use client";

import dynamic from "next/dynamic";

export const MapView = dynamic(() => import("./SwissAgeMap").then((m) => m.SwissAgeMap), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
      Loading map…
    </div>
  ),
});
