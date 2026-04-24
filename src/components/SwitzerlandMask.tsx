"use client";

import type { LatLngExpression } from "leaflet";
import { Polygon } from "react-leaflet";
import { CHE_OUTLINE_RING_LL } from "@/data/che-outline-hole";

/** Large outer ring (no antimeridian crossing); hole is Switzerland so tiles show only inside CH. */
const OUTER_LL: LatLngExpression[] = [
  [39.5, -11],
  [39.5, 24],
  [55.5, 24],
  [55.5, -11],
  [39.5, -11],
];

/* Opposite winding from outer ring so SVG treats this as a hole (tiles visible inside). */
const holeRing: LatLngExpression[] = [...CHE_OUTLINE_RING_LL]
  .reverse()
  .map(([lat, lng]) => [lat, lng] as LatLngExpression);

/**
 * Black fill for all territory outside the Switzerland hole. Renders above the
 * basemap; holes are transparent so OSM tiles remain visible inside CH.
 */
export function SwitzerlandMask() {
  return (
    <Polygon
      positions={[OUTER_LL, holeRing]}
      pathOptions={{
        stroke: false,
        fillColor: "#000000",
        fillOpacity: 1,
        interactive: false,
      }}
    />
  );
}
