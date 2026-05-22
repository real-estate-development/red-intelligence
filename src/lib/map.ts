import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { FillLayerSpecification, StyleSpecification } from "maplibre-gl";

/** Switzerland overview (geo.admin WMS + PMTiles overlay from z11). */
export const CH_VIEW = { lng: 8.2275, lat: 46.8182, zoom: 7.65 } as const;

const GEO_ADMIN_ATTRIBUTION =
  '&copy; <a href="https://www.geo.admin.ch/">geo.admin.ch</a> · ' +
  '<a href="https://www.swisstopo.admin.ch/">swisstopo</a>';

const WMS = "https://wms.geo.admin.ch/";

function wmsTile(layer: string): string {
  return (
    `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0` +
    `&LAYERS=${encodeURIComponent(layer)}&STYLES=default&CRS=EPSG:3857` +
    `&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=${encodeURIComponent("image/jpeg")}`
  );
}

/** geo-admin-landeskarte-farbe-10 WMS raster basemap. */
export const BASEMAP_STYLE: StyleSpecification = {
  version: 8,
  name: "geo-admin-landeskarte-10k-wms",
  sources: {
    "wms-landeskarte-farbe-10": {
      type: "raster",
      tiles: [wmsTile("ch.swisstopo.landeskarte-farbe-10")],
      tileSize: 256,
      attribution: GEO_ADMIN_ATTRIBUTION,
    },
  },
  layers: [{ id: "bg-landeskarte-farbe-10", type: "raster", source: "wms-landeskarte-farbe-10", minzoom: 0, maxzoom: 20 }],
};

/** GWR Merkmalskatalog Bauperiode codes (GBAUP). */
export const GBAUP_LABELS: Record<number, string> = {
  8001: "Unknown",
  8011: "Before 1919",
  8012: "1919–1945",
  8013: "1946–1960",
  8014: "1961–1970",
  8015: "1971–1980",
  8016: "1981–1985",
  8017: "1986–1990",
  8018: "1991–1995",
  8019: "1996–2000",
  8020: "2001–2005",
  8021: "2006–2010",
  8022: "2011–2015",
  8023: "2016 or later",
};

export function formatBuildPeriod(code: number): string {
  if (!Number.isFinite(code) || code <= 0) return "unknown";
  return GBAUP_LABELS[code] ?? `Code ${code}`;
}

/** PMTiles vector overlay (`processed_output` layer, EGID + GBAUP). Fill colour is MapLibre paint on GBAUP (GPU). */
export const BUILDINGS = {
  sourceId: "swiss-buildings-source",
  layerId: "buildings-age-layer",
  sourceLayer: "processed_output",
  promoteId: "EGID",
  minZoom: 11,
  paint: {
    "fill-color": [
      "match",
      ["get", "GBAUP"],
      8011, "#d73027",
      8012, "#f46d43",
      8013, "#fdae61",
      8014, "#fee08b",
      8015, "#fee08b",
      8016, "#d9ef8b",
      8017, "#d9ef8b",
      8018, "#a6d96a",
      8019, "#66bd63",
      8020, "#43a047",
      8021, "#1a9850",
      8022, "#16834a",
      8023, "#006837",
      "#a6a6a6",
    ],
    "fill-opacity": 0.75,
    "fill-outline-color": [
      "case",
      ["boolean", ["feature-state", "hover"], false],
      "#000000",
      "rgba(0, 0, 0, 0.1)",
    ],
  } satisfies FillLayerSpecification["paint"],
} as const;

let pmtilesReady = false;

export function ensurePmtilesProtocol(): void {
  if (pmtilesReady || typeof window === "undefined") return;
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
  pmtilesReady = true;
}

export function buildingsPmtilesUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_BUILDINGS_PMTILES_URL?.trim();
  if (!raw) return null;
  if (typeof window === "undefined") return raw;

  if (!raw.startsWith("pmtiles://")) return raw;

  const rest = raw.slice("pmtiles://".length);
  if (rest.startsWith("/")) {
    return `pmtiles://${window.location.origin}${rest}`;
  }

  try {
    const u = new URL(rest);
    // Avoid localhost vs 127.0.0.1 / WSL host mismatch (causes fetch NetworkError).
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return `pmtiles://${window.location.origin}${u.pathname}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

/** HTTP(S) URL for a `pmtiles://…` archive (for existence checks before MapLibre loads tiles). */
export function pmtilesHttpUrl(pmtilesUrl: string): string {
  if (!pmtilesUrl.startsWith("pmtiles://")) return pmtilesUrl;
  return pmtilesUrl.slice("pmtiles://".length);
}

export type BuildingHover = {
  egid: string;
  buildPeriodCode: number;
  buildPeriodLabel: string;
  lngLat: { lng: number; lat: number };
};

export function parseBuildingFeature(
  props: Record<string, unknown> | null | undefined,
): Pick<BuildingHover, "egid" | "buildPeriodCode" | "buildPeriodLabel"> | null {
  if (!props || props.EGID == null) return null;
  const buildPeriodCode = Number(props.GBAUP ?? 0);
  const code = Number.isFinite(buildPeriodCode) ? buildPeriodCode : 0;
  return {
    egid: String(props.EGID),
    buildPeriodCode: code,
    buildPeriodLabel: formatBuildPeriod(code),
  };
}
