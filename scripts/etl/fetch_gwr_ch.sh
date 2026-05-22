#!/usr/bin/env bash
# Download BFS MADD national GWR (all Switzerland) → data/gwr/ch/gebaeude_batiment_edificio.csv
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${GWR_CH_DIR:-$ROOT/data/gwr/ch}"
ZIP="$OUT_DIR/ch.zip"
CSV="$OUT_DIR/gebaeude_batiment_edificio.csv"
URL="${GWR_BFS_PUBLIC_BASE:-https://public.madd.bfs.admin.ch}/ch.zip"

mkdir -p "$OUT_DIR"

if [[ -f "$CSV" ]]; then
  echo "National GWR CSV already present: $CSV ($(du -h "$CSV" | cut -f1))"
  exit 0
fi

if [[ ! -f "$ZIP" ]]; then
  echo "Downloading Switzerland GWR (~900 MB ZIP)…"
  echo "  $URL"
  curl -fL --retry 3 --continue-at - -o "$ZIP" "$URL"
fi

echo "Extracting gebaeude_batiment_edificio.csv…"
unzip -j -o "$ZIP" gebaeude_batiment_edificio.csv -d "$OUT_DIR"
echo "Done: $CSV ($(du -h "$CSV" | cut -f1))"
