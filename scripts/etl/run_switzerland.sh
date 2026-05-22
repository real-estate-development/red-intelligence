#!/usr/bin/env bash
# End-to-end Switzerland building-age tiles (GWR ch + footprint GeoJSON/GPKG → PMTiles).
#
# Prerequisites:
#   - Python ETL deps: pip install -r scripts/etl/requirements.txt
#   - Docker (tippecanoe + ogr2ogr fallbacks)
#   - Footprint geometry with EGID:
#       • data/swissbuildings3d/footprints.geojsonseq (partial), or
#       • national swissBUILDINGS3D FileGDB (~50 GB from swisstopo), set:
#         SWISSBUILDINGS_GEOMETRY=/path/to/buildings.gpkg
#
# Usage:
#   bash scripts/etl/run_switzerland.sh
#   SWISSBUILDINGS_GEOMETRY=data/national/buildings.gpkg bash scripts/etl/run_switzerland.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

GEOMETRY="${SWISSBUILDINGS_GEOMETRY:-data/swissbuildings3d/footprints.geojsonseq}"
GWR_CSV="${GWR_CH_CSV:-data/gwr/ch/gebaeude_batiment_edificio.csv}"
GPKG_OUT="${ETL_GPKG:-data/etl/processed_output.gpkg}"
PMTILES_OUT="${ETL_PMTILES:-public/tiles/swiss_buildings.pmtiles}"
SWISSBUILDINGS_MANIFEST="${SWISSBUILDINGS3D_MANIFEST:-data/swissbuildings3d/manifest.json}"
SWISSBUILDINGS_PROGRESS="${SWISSBUILDINGS3D_PROGRESS:-${GEOMETRY}.progress.jsonl}"
SWISSBUILDINGS_CONCURRENCY="${SWISSBUILDINGS3D_CONVERT_CONCURRENCY:-4}"

echo "=== 1/4 National GWR (BFS ch.zip) ==="
bash scripts/etl/fetch_gwr_ch.sh

needs_swissbuildings_resume() {
  python3 - "$SWISSBUILDINGS_MANIFEST" "$SWISSBUILDINGS_PROGRESS" "$GEOMETRY" <<'PY'
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
progress_path = Path(sys.argv[2])
geometry_path = Path(sys.argv[3])

if not manifest_path.is_file():
    sys.exit(1 if not geometry_path.is_file() else 0)

manifest = json.loads(manifest_path.read_text())
expected = len(manifest.get("items") or [])
if expected == 0:
    sys.exit(1 if not geometry_path.is_file() else 0)

completed = set()
if progress_path.is_file():
    for line in progress_path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("status") == "ok" and row.get("itemId"):
            completed.add(row["itemId"])

sys.exit(0 if len(completed) >= expected and geometry_path.is_file() else 1)
PY
}

if [[ "$GEOMETRY" == "data/swissbuildings3d/footprints.geojsonseq" && -f "$SWISSBUILDINGS_MANIFEST" ]]; then
  if ! needs_swissbuildings_resume; then
    echo "=== 2/5 swissBUILDINGS3D conversion resume → $GEOMETRY ==="
    if [[ -f "$SWISSBUILDINGS_PROGRESS" && -f "$GEOMETRY" ]]; then
      npx tsx scripts/swissbuildings3d-convert.ts --manifest "$SWISSBUILDINGS_MANIFEST" --out "$GEOMETRY" --resume --progress "$SWISSBUILDINGS_PROGRESS" --concurrency "$SWISSBUILDINGS_CONCURRENCY"
    else
      npx tsx scripts/swissbuildings3d-convert.ts --manifest "$SWISSBUILDINGS_MANIFEST" --out "$GEOMETRY" --progress "$SWISSBUILDINGS_PROGRESS" --concurrency "$SWISSBUILDINGS_CONCURRENCY"
    fi
  fi
fi

if [[ ! -f "$GEOMETRY" ]]; then
  echo "ERROR: Footprint geometry not found: $GEOMETRY" >&2
  echo "  Partial: npm run swissbuildings3d:pipeline -- --bbox 5.96,45.82,10.49,47.81 --limit 10000" >&2
  echo "  Then:    npm run swissbuildings3d:convert -- --manifest data/swissbuildings3d/manifest.json" >&2
  echo "  National (~50 GB): order swissBUILDINGS3D 3.0 FileGDB from swisstopo, set SWISSBUILDINGS_GEOMETRY." >&2
  exit 1
fi

echo "=== 3/5 EGID join → $GPKG_OUT ==="
python3 scripts/etl/process_swiss_data.py "$GEOMETRY" "$GWR_CSV" "$GPKG_OUT"

echo "=== 4/5 PMTiles → $PMTILES_OUT ==="
bash scripts/etl/build_pmtiles.sh "$GPKG_OUT" "$PMTILES_OUT"

echo "=== 5/5 Done ==="
echo 'Add to .env: NEXT_PUBLIC_BUILDINGS_PMTILES_URL="pmtiles:///tiles/swiss_buildings.pmtiles"'
echo "Restart: npm run dev"
