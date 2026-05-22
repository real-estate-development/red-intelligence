"use client";

/**
 * Phase 3: PMTiles building-age overlay on geo.admin WMS basemap.
 * GBAUJ colour scale and hover outline are native MapLibre expressions / feature-state only (no per-frame JS styling).
 */

import { useEffect, useRef, useState } from "react";
import Map, { Layer, NavigationControl, Popup, Source, useMap } from "react-map-gl/maplibre";
import type { MapLayerMouseEvent, Map as MapLibreMap } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  BASEMAP_STYLE,
  BUILDINGS,
  buildingsPmtilesUrl,
  CH_VIEW,
  ensurePmtilesProtocol,
  parseBuildingFeature,
  pmtilesHttpUrl,
  type BuildingHover,
} from "@/lib/map";

// Register before MapLibre requests tiles (useEffect is too late).
ensurePmtilesProtocol();

const featureTarget = {
  source: BUILDINGS.sourceId,
  sourceLayer: BUILDINGS.sourceLayer,
} as const;

function setFeatureHover(map: MapLibreMap, id: string | number | null, hover: boolean) {
  if (id == null) return;
  try {
    map.setFeatureState({ ...featureTarget, id }, { hover });
  } catch {
    /* source removed */
  }
}

function useBuildingHover(onHover: (hover: BuildingHover | null) => void) {
  const { current: mapRef } = useMap();
  const activeId = useRef<string | number | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;

    const clear = () => {
      setFeatureHover(map, activeId.current, false);
      activeId.current = null;
      map.getCanvas().style.cursor = "";
      onHoverRef.current(null);
    };

    const onMove = (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      const id = feature?.id;
      const parsed = parseBuildingFeature(feature?.properties as Record<string, unknown>);
      if (id == null || !parsed) return;

      if (activeId.current != null && activeId.current !== id) {
        setFeatureHover(map, activeId.current, false);
      }
      activeId.current = id;
      setFeatureHover(map, id, true);
      map.getCanvas().style.cursor = "pointer";
      onHoverRef.current({ ...parsed, lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat } });
    };

    map.on("mousemove", BUILDINGS.layerId, onMove);
    map.on("mouseleave", BUILDINGS.layerId, clear);
    return () => {
      map.off("mousemove", BUILDINGS.layerId, onMove);
      map.off("mouseleave", BUILDINGS.layerId, clear);
      clear();
    };
  }, [mapRef]);
}

function BuildingOverlay({ url, onHover }: { url: string; onHover: (hover: BuildingHover | null) => void }) {
  useBuildingHover(onHover);

  return (
    <Source id={BUILDINGS.sourceId} type="vector" url={url} promoteId={BUILDINGS.promoteId}>
      <Layer
        id={BUILDINGS.layerId}
        type="fill"
        source-layer={BUILDINGS.sourceLayer}
        minzoom={BUILDINGS.minZoom}
        paint={BUILDINGS.paint}
      />
    </Source>
  );
}

export function SwissAgeMap() {
  const configuredUrl = buildingsPmtilesUrl();
  const [tileUrl, setTileUrl] = useState<string | null>(null);
  const [archiveMissing, setArchiveMissing] = useState(false);
  const [hover, setHover] = useState<BuildingHover | null>(null);

  useEffect(() => {
    if (!configuredUrl) {
      setTileUrl(null);
      setArchiveMissing(false);
      return;
    }

    let cancelled = false;
    const httpUrl = pmtilesHttpUrl(configuredUrl);

    fetch(httpUrl, { method: "HEAD" })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setTileUrl(configuredUrl);
          setArchiveMissing(false);
        } else {
          setTileUrl(null);
          setArchiveMissing(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTileUrl(null);
          setArchiveMissing(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [configuredUrl]);

  const showSetupBanner = !tileUrl && (!configuredUrl || archiveMissing);

  return (
    <div className="relative h-full w-full [&_.maplibregl-map]:h-full [&_.maplibregl-map]:w-full">
      <Map
        mapLib={maplibregl}
        initialViewState={{ longitude: CH_VIEW.lng, latitude: CH_VIEW.lat, zoom: CH_VIEW.zoom }}
        mapStyle={BASEMAP_STYLE}
        style={{ width: "100%", height: "100%" }}
        interactiveLayerIds={tileUrl ? [BUILDINGS.layerId] : []}
      >
        <NavigationControl position="top-right" />
        {tileUrl ? <BuildingOverlay url={tileUrl} onHover={setHover} /> : null}
        {hover ? (
          <Popup
            longitude={hover.lngLat.lng}
            latitude={hover.lngLat.lat}
            anchor="bottom"
            closeButton={false}
            closeOnClick={false}
            offset={12}
          >
            <div className="space-y-0.5 text-sm text-zinc-900">
              <p>
                <span className="font-medium">EGID:</span> {hover.egid}
              </p>
              <p>
                <span className="font-medium">Year built:</span>{" "}
                {hover.yearBuilt > 0 ? hover.yearBuilt : "unknown"}
              </p>
            </div>
          </Popup>
        ) : null}
      </Map>

      {showSetupBanner ? (
        <div className="absolute left-3 top-3 z-10 max-w-sm rounded-lg border border-amber-200/90 bg-amber-50/95 px-3 py-2 text-xs text-amber-900 shadow-md">
          {archiveMissing ? (
            <>
              Building tiles not found at{" "}
              <code className="font-mono">{configuredUrl ? pmtilesHttpUrl(configuredUrl) : ""}</code>. Run{" "}
              <code className="font-mono">npm run etl:process</code> and <code className="font-mono">npm run etl:pmtiles</code>{" "}
              (or remove <code className="font-mono">NEXT_PUBLIC_BUILDINGS_PMTILES_URL</code> from <code className="font-mono">.env</code>).
            </>
          ) : (
            <>
              Set <code className="font-mono">NEXT_PUBLIC_BUILDINGS_PMTILES_URL</code>, then run{" "}
              <code className="font-mono">npm run etl:process</code> and <code className="font-mono">npm run etl:pmtiles</code>.
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
