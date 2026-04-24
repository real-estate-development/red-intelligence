"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MapContainer, Polygon, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";

type HexBinApi = {
  id: string;
  ring: [number, number][];
  count: number;
  yearMean: number | null;
  yearStdDev: number | null;
};

const CH_CENTER: LatLngExpression = [46.8, 8.2275];
const DEFAULT_ZOOM = 8;
const TARGET_CELLS = 100;

function yearMeanToStyle(mean: number | null, count: number): { color: string; fillColor: string; fillOpacity: number } {
  if (count === 0) {
    return { color: "#a1a1aa", fillColor: "#e4e4e7", fillOpacity: 0.22 };
  }
  if (mean == null) {
    return { color: "#a1a1aa", fillColor: "#e4e4e7", fillOpacity: 0.32 };
  }
  const t = (mean - 1880) / (2025 - 1880);
  const u = Math.max(0, Math.min(1, t));
  const hue = 215 - u * 175;
  return { color: "#334155", fillColor: `hsl(${hue} 62% 46%)`, fillOpacity: 0.58 };
}

type HexBinsLayerProps = {
  onStatus: (s: { loading: boolean; error: string | null }) => void;
};

function HexBinsLayer({ onStatus }: HexBinsLayerProps) {
  const map = useMap();
  const [hexbins, setHexbins] = useState<HexBinApi[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchBins = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const b = map.getBounds();
      const params = new URLSearchParams({
        south: String(b.getSouth()),
        west: String(b.getWest()),
        north: String(b.getNorth()),
        east: String(b.getEast()),
        cells: String(TARGET_CELLS),
      });
      onStatus({ loading: true, error: null });
      try {
        const res = await fetch(`/api/buildings/hexbins?${params.toString()}`, { credentials: "include" });
        const data = (await res.json()) as { hexbins?: HexBinApi[]; error?: string };
        if (!res.ok) {
          onStatus({ loading: false, error: data.error ?? "Failed to load hex bins" });
          setHexbins([]);
          return;
        }
        setHexbins(data.hexbins ?? []);
        onStatus({ loading: false, error: null });
      } catch {
        onStatus({ loading: false, error: "Failed to load hex bins" });
        setHexbins([]);
      }
    }, 260);
  }, [map, onStatus]);

  useEffect(() => {
    const start = () => fetchBins();
    map.whenReady(start);
    map.on("moveend", fetchBins);
    map.on("zoomend", fetchBins);
    return () => {
      map.off("moveend", fetchBins);
      map.off("zoomend", fetchBins);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [map, fetchBins]);

  return (
    <>
      {hexbins.map((h) => {
        const positions = h.ring.map(([lng, lat]) => [lat, lng] as LatLngExpression);
        const style = yearMeanToStyle(h.yearMean, h.count);
        return (
          <Polygon key={h.id} positions={positions} pathOptions={{ weight: 1, ...style }}>
            <Tooltip sticky>
              {h.count === 0 ? "No buildings" : `n=${h.count}, mean year ${h.yearMean?.toFixed(1)}`}
            </Tooltip>
            <Popup>
              <div className="min-w-[10rem] text-sm text-zinc-900">
                <div>
                  <span className="font-medium">Buildings:</span> {h.count}
                </div>
                {h.count > 0 ? (
                  <>
                    <div>
                      <span className="font-medium">Mean year built:</span> {h.yearMean?.toFixed(1)}
                    </div>
                    <div>
                      <span className="font-medium">Std. dev. (years):</span> {h.yearStdDev?.toFixed(2)}
                    </div>
                  </>
                ) : null}
              </div>
            </Popup>
          </Polygon>
        );
      })}
    </>
  );
}

export function BuildingMap() {
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const onStatus = useCallback((s: { loading: boolean; error: string | null }) => {
    setStatus(s);
  }, []);

  return (
    <div className="relative h-full w-full">
      <MapContainer center={CH_CENTER} zoom={DEFAULT_ZOOM} className="h-full w-full" scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <HexBinsLayer onStatus={onStatus} />
      </MapContainer>
      {status.loading ? (
        <div className="pointer-events-none absolute bottom-3 left-3 z-[1000] rounded bg-white/90 px-2 py-1 text-xs text-zinc-600 shadow dark:bg-zinc-900/90 dark:text-zinc-300">
          Updating hex bins…
        </div>
      ) : null}
      {status.error ? (
        <div className="pointer-events-none absolute bottom-3 left-3 z-[1000] max-w-sm rounded bg-red-50 px-2 py-1 text-xs text-red-700 shadow dark:bg-red-950/90 dark:text-red-200">
          {status.error}
        </div>
      ) : null}
    </div>
  );
}
