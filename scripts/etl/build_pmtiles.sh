#!/usr/bin/env bash
# Phase 2: joined GPKG → PMTiles (tippecanoe). Buildings visible from zoom 11 (-Z 11); only EGID + GBAUP kept.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INPUT="${1:-$ROOT/data/etl/processed_output.gpkg}"
OUTPUT="${2:-$ROOT/public/tiles/swiss_buildings.pmtiles}"
GPKG_LAYER="${GPKG_LAYER:-processed_output}"
OUTPUT_LAYER="${TIPPECANOE_LAYER:-processed_output}"
TIPPECANOE_IMAGE="${TIPPECANOE_IMAGE:-red-intelligence-tippecanoe}"
GDAL_IMAGE="${GDAL_IMAGE:-ghcr.io/osgeo/gdal:ubuntu-small-latest}"

if [[ ! -f "$INPUT" ]]; then
  echo "Input not found: $INPUT (run: npm run etl:process)" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
echo "Phase 2: $INPUT ($GPKG_LAYER) → $OUTPUT (layer=$OUTPUT_LAYER)"

GEOJSONSEQ="${INPUT%.*}.geojsonseq"
if [[ "$INPUT" == *.gpkg ]]; then
  echo "Converting GPKG → GeoJSONSeq (tippecanoe input)…"
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker required to convert GPKG (ogr2ogr). Install Docker or convert manually." >&2
    exit 1
  fi
  in_rel="$(realpath --relative-to="$ROOT" "$INPUT")"
  seq_rel="$(realpath --relative-to="$ROOT" "$GEOJSONSEQ")"
  docker run --rm -v "$ROOT:/work" "$GDAL_IMAGE" \
    ogr2ogr -f GeoJSONSeq "/work/$seq_rel" "/work/$in_rel" "$GPKG_LAYER"
  TIPPECANOE_INPUT="$GEOJSONSEQ"
else
  TIPPECANOE_INPUT="$INPUT"
fi

run_tippecanoe() {
  local input_path="$1"
  tippecanoe --force -o "$OUTPUT" \
    -Z 11 -z 17 \
    --no-feature-limit \
    --maximum-tile-bytes=5000000 \
    --use-attribute-for-id=EGID \
    --attribute-type=GBAUP:int \
    --attribute-type=EGID:string \
    --named-layer="${OUTPUT_LAYER}:${input_path}" \
    -y EGID \
    -y GBAUP
}

ensure_tippecanoe_image() {
  if docker image inspect "$TIPPECANOE_IMAGE" >/dev/null 2>&1; then
    return 0
  fi
  echo "Building Docker image $TIPPECANOE_IMAGE (first run may take a few minutes)…"
  docker build -t "$TIPPECANOE_IMAGE" -f "$ROOT/scripts/etl/Dockerfile.tippecanoe" "$ROOT/scripts/etl"
}

if command -v tippecanoe >/dev/null 2>&1; then
  run_tippecanoe "$TIPPECANOE_INPUT"
elif command -v docker >/dev/null 2>&1; then
  echo "tippecanoe not on PATH — using Docker ($TIPPECANOE_IMAGE)"
  ensure_tippecanoe_image
  in_rel="$(realpath --relative-to="$ROOT" "$TIPPECANOE_INPUT")"
  out_rel="$(realpath --relative-to="$ROOT" "$OUTPUT")"
  docker run --rm -v "$ROOT:/work" -w /work "$TIPPECANOE_IMAGE" \
    --force -o "/work/$out_rel" \
    -Z 11 -z 17 \
    --no-feature-limit \
    --maximum-tile-bytes=5000000 \
    --use-attribute-for-id=EGID \
    --attribute-type=GBAUP:int \
    --attribute-type=EGID:string \
    --named-layer="${OUTPUT_LAYER}:/work/$in_rel" \
    -y EGID \
    -y GBAUP
else
  echo "Need tippecanoe or Docker." >&2
  echo "  Ubuntu 22.04 has no apt package for tippecanoe; Docker is used automatically." >&2
  exit 1
fi

echo "PMTiles written: $OUTPUT"
echo 'Set NEXT_PUBLIC_BUILDINGS_PMTILES_URL="pmtiles://http://localhost:3000/tiles/swiss_buildings.pmtiles"'
