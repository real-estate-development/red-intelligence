"use client";

import { useEffect, useState } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip } from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";

type Building = {
  id: string;
  egid: string;
  address: string;
  yearBuilt: number;
  lat: number;
  lng: number;
};

const CH_CENTER: LatLngExpression = [46.8, 8.2275];
const DEFAULT_ZOOM = 8;

export function BuildingMap() {
  const [buildings, setBuildings] = useState<Building[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/buildings", { credentials: "include" });
        const data = (await res.json()) as { buildings?: Building[]; error?: string };
        if (!res.ok) {
          if (!cancelled) setError(data.error ?? "Failed to load buildings");
          return;
        }
        if (!cancelled) setBuildings(data.buildings ?? []);
      } catch {
        if (!cancelled) setError("Failed to load buildings");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-red-600 dark:text-red-400">{error}</div>
    );
  }

  if (!buildings) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-zinc-500 dark:text-zinc-400">
        Loading map…
      </div>
    );
  }

  return (
    <MapContainer center={CH_CENTER} zoom={DEFAULT_ZOOM} className="h-full w-full" scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {buildings.map((b) => (
        <CircleMarker key={b.id} center={[b.lat, b.lng]} radius={6} pathOptions={{ color: "#2563eb", fillColor: "#3b82f6", fillOpacity: 0.7 }}>
          <Tooltip direction="top" offset={[0, -4]} opacity={1} permanent={false}>
            EGID {b.egid}
          </Tooltip>
          <Popup>
            <div className="min-w-[12rem] text-sm text-zinc-900">
              <div>
                <span className="font-medium">EGID:</span> {b.egid}
              </div>
              <div>
                <span className="font-medium">Address:</span> {b.address}
              </div>
              <div>
                <span className="font-medium">Year built:</span> {b.yearBuilt}
              </div>
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
