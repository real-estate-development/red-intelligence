#!/usr/bin/env bash
# End-to-end Switzerland building-age tiles:
# BFS GWR points + national swissTLM3D footprints -> EGID/GBAUP GeoJSONSeq -> PMTiles.
#
# Prerequisites:
#   - Python ETL deps: pip install -r scripts/etl/requirements.txt
#   - Docker or tippecanoe for PMTiles generation
#   - swissTLM3D is downloaded/extracted automatically unless --gpkg/--zip env paths are used.
#
# Usage:
#   bash scripts/etl/run_switzerland.sh
#   SWISSTLM3D_RELEASE=swisstlm3d_2025-03 bash scripts/etl/run_switzerland.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

GWR_CSV="${GWR_CH_CSV:-data/gwr/ch/gebaeude_batiment_edificio.csv}"
JOINED_OUT="${ETL_JOINED_GEOJSONSEQ:-data/etl/tlm3d_bauperiode.geojsonseq}"
PMTILES_OUT="${ETL_PMTILES:-public/tiles/swiss_buildings.pmtiles}"

mkdir -p "$(dirname "$JOINED_OUT")" "$(dirname "$PMTILES_OUT")"

echo "=== 1/4 National GWR (BFS ch.zip) ==="
bash scripts/etl/fetch_gwr_ch.sh

echo "=== 2/4 swissTLM3D spatial join + GBAUP -> $JOINED_OUT ==="
TLM3D_GPKG="${SWISSTLM3D_GPKG:-data/swisstlm3d/swisstlm3d_2025-03_Product.gpkg}"
TLM3D_ARGS=(--gwr-csv "$GWR_CSV" --output "$JOINED_OUT")
if [[ -f "$TLM3D_GPKG" ]]; then
  TLM3D_ARGS+=(--gpkg "$TLM3D_GPKG")
fi
npm run etl:tlm3d-bauperiode -- "${TLM3D_ARGS[@]}"

echo "=== 3/4 PMTiles -> $PMTILES_OUT ==="
bash scripts/etl/build_pmtiles.sh "$JOINED_OUT" "$PMTILES_OUT"

echo "=== 4/4 Done ==="
echo 'Add to .env: NEXT_PUBLIC_BUILDINGS_PMTILES_URL="pmtiles:///tiles/swiss_buildings.pmtiles"'
echo "Restart: npm run dev"
