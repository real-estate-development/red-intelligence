#!/usr/bin/env python3
"""
Phase 1: EGID attribute join (Swisstopo geometries + BFS GWR). No spatial intersections.

Memory safety: GWR loaded with usecols only. EGID cast to int64 on both sides before merge.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Iterator
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GEOMETRY = REPO_ROOT / "data/swissbuildings3d/footprints.geojsonseq"
DEFAULT_GEOMETRY_LEGACY = REPO_ROOT / "data/swissbuildings3d/footprints.geojson"
DEFAULT_GWR_CSV = REPO_ROOT / "data/gwr/ch/gebaeude_batiment_edificio.csv"
DEFAULT_OUTPUT = REPO_ROOT / "data/etl/processed_output.gpkg"

import geopandas as gpd
import pandas as pd

GWR_COLS = ["EGID", "GBAUJ", "GBAUP", "GSTAT", "GKLAS"]
EGID_CANDIDATES = ("EGID", "egid", "EIDG_GEBAEUDEIDENTIFIKATOR", "eidg_gebaeudeidentifikator")
GPKG_LAYER = "processed_output"


def gwr_column_map(path: Path, delimiter: str) -> dict[str, str]:
    header = pd.read_csv(path, sep=delimiter, nrows=0, encoding="utf-8")
    return {c.upper(): c for c in header.columns}


def load_gwr(path: Path, delimiter: str) -> pd.DataFrame:
    col_map = gwr_column_map(path, delimiter)
    usecols = [col_map[c] for c in GWR_COLS if c in col_map]
    if "EGID" not in [c.upper() for c in usecols]:
        raise ValueError(f"GWR file missing EGID. Headers (upper): {sorted(col_map)[:20]}…")
    egid_col = col_map["EGID"]
    print(f"2. Loading GWR attributes (selective columns): {', '.join(usecols)}")
    df_gwr = pd.read_csv(
        path,
        sep=delimiter,
        usecols=usecols,
        low_memory=False,
        dtype={egid_col: "Int64"},
        encoding="utf-8",
    )
    df_gwr.columns = [c.upper() for c in df_gwr.columns]
    return df_gwr


def find_egid_column(columns: list[str]) -> str:
    upper = {c: c.upper() for c in columns}
    for cand in EGID_CANDIDATES:
        for col in columns:
            if upper[col] == cand.upper():
                return col
    raise ValueError("Geometry source has no EGID column.")


def normalize_egid_column(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Single EGID column (swissBUILDINGS3D GeoJSON often has both EGID and egid)."""
    egid_col = find_egid_column(list(gdf.columns))
    gdf = gdf.copy()
    gdf["EGID"] = pd.to_numeric(gdf[egid_col], errors="coerce")
    drop = [c for c in gdf.columns if c != "EGID" and c.lower() == "egid"]
    if drop:
        gdf = gdf.drop(columns=drop)
    gdf = gdf[gdf["EGID"].notna()].copy()
    gdf["EGID"] = gdf["EGID"].astype("int64")
    return gdf[["EGID", "geometry"]]


def iter_geojsonseq_batches(path: Path, batch_size: int) -> Iterator[gpd.GeoDataFrame]:
    """Stream newline-delimited GeoJSON features in bounded batches."""
    batch: list[dict] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            batch.append(json.loads(stripped))
            if len(batch) >= batch_size:
                yield gpd.GeoDataFrame.from_features(batch, crs="EPSG:4326")
                batch = []
    if batch:
        yield gpd.GeoDataFrame.from_features(batch, crs="EPSG:4326")


def join_geojsonseq_chunked(
    geom_path: Path,
    gwr_path: Path,
    out_path: Path,
    delimiter: str,
    batch_size: int,
) -> tuple[int, int]:
    """Join large GeoJSONSeq without loading the full file into RAM."""
    df_gwr = load_gwr(gwr_path, delimiter)
    df_gwr = df_gwr.drop_duplicates(subset=["EGID"], keep="first")
    df_gwr["EGID"] = df_gwr["EGID"].astype("int64")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()

    total = 0
    matched = 0
    batch_num = 0
    print(f"1. Streaming Swisstopo geometries from {geom_path.name} (batch size {batch_size:,})…")

    for gdf in iter_geojsonseq_batches(geom_path, batch_size):
        batch_num += 1
        gdf = normalize_egid_column(gdf)
        joined_gdf = gdf.merge(df_gwr, on="EGID", how="left")
        joined_gdf = prepare_for_gpkg(joined_gdf)
        matched += int(joined_gdf["GBAUP"].gt(0).sum())
        total += len(joined_gdf)
        joined_gdf.to_file(
            out_path,
            driver="GPKG",
            layer=GPKG_LAYER,
            mode="w" if batch_num == 1 else "a",
            engine="pyogrio",
        )
        print(f"   … batch {batch_num}: {len(joined_gdf):,} features (running total {total:,})")

    if batch_num == 0:
        raise ValueError(f"No features found in {geom_path}")

    return total, matched


def prepare_for_gpkg(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Keep tile-relevant attributes only; coerce ints for GeoPackage/pyogrio."""
    keep = ["EGID", "GBAUJ", "GBAUP", "GSTAT", "GKLAS", "geometry"]
    out = gdf[[c for c in keep if c in gdf.columns]].copy()
    for col in ("EGID", "GBAUJ", "GBAUP", "GSTAT", "GKLAS"):
        if col in out.columns:
            out[col] = pd.to_numeric(out[col], errors="coerce").fillna(0).astype("int64")
    return out


def clean_and_join_datasets(
    geometry_path: str,
    gwr_csv_path: str,
    output_path: str,
    delimiter: str = "\t",
    batch_size: int = 50_000,
) -> gpd.GeoDataFrame:
    geom_path = Path(geometry_path)
    gwr_path = Path(gwr_csv_path)
    out_path = Path(output_path)

    if not geom_path.exists():
        raise FileNotFoundError(f"Geometry not found: {geom_path}")
    if not gwr_path.exists():
        raise FileNotFoundError(f"GWR CSV not found: {gwr_path}")

    if geom_path.suffix.lower() == ".geojsonseq":
        total, matched = join_geojsonseq_chunked(geom_path, gwr_path, out_path, delimiter, batch_size)
        print(f"ETL complete successfully. Features: {total:,}, with GBAUP>0: {matched:,}")
        return gpd.GeoDataFrame()

    print("1. Loading Swisstopo building geometries...")
    gdf = gpd.read_file(geom_path)
    if gdf.crs is None:
        gdf = gdf.set_crs(4326)
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(4326)

    print("3. Normalizing data types...")
    gdf = normalize_egid_column(gdf)

    df_gwr = load_gwr(gwr_path, delimiter)
    df_gwr = df_gwr.drop_duplicates(subset=["EGID"], keep="first")
    df_gwr["EGID"] = df_gwr["EGID"].astype("int64")

    print("4. Executing left join via EGID...")
    joined_gdf = gdf.merge(df_gwr, on="EGID", how="left")

    print("5. Handling missing values...")
    joined_gdf = prepare_for_gpkg(joined_gdf)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"6. Saving optimized output to {out_path}...")
    joined_gdf.to_file(out_path, driver="GPKG", layer=GPKG_LAYER)
    matched = joined_gdf["GBAUP"].gt(0).sum()
    print(f"ETL complete successfully. Features: {len(joined_gdf):,}, with GBAUP>0: {matched:,}")
    return joined_gdf


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Join Swisstopo geometries to GWR via EGID (no spatial join).")
    p.add_argument("geometry", nargs="?", help=f"GPKG/GeoJSON with EGID (default: {DEFAULT_GEOMETRY.relative_to(REPO_ROOT)})")
    p.add_argument("gwr_csv", nargs="?", help=f"gebaeude_batiment_edificio.csv (default: {DEFAULT_GWR_CSV.relative_to(REPO_ROOT)})")
    p.add_argument("output", nargs="?", help=f"Output GPKG (default: {DEFAULT_OUTPUT.relative_to(REPO_ROOT)})")
    p.add_argument("--geometry", dest="geometry_flag", help="Geometry path (flag form)")
    p.add_argument("--gwr-csv", dest="gwr_flag", help="GWR CSV path (flag form)")
    p.add_argument("--output", dest="output_flag", help="Output GPKG (flag form)")
    p.add_argument("--delimiter", default="\t", help="GWR delimiter (BFS public = tab)")
    p.add_argument(
        "--batch-size",
        type=int,
        default=int(os.environ.get("ETL_GEOJSONSEQ_BATCH_SIZE", "50000")),
        help="GeoJSONSeq batch size (default 50000; lower if RAM is tight)",
    )
    return p.parse_args()


def resolve_geometry_path(path: Path) -> Path:
    if path.is_file():
        return path
    if path == DEFAULT_GEOMETRY and DEFAULT_GEOMETRY_LEGACY.is_file():
        return DEFAULT_GEOMETRY_LEGACY
    return path


def require_input_files(geometry: Path, gwr_csv: Path) -> None:
    geometry = resolve_geometry_path(geometry)
    missing: list[tuple[str, Path, str]] = []
    if not geometry.is_file():
        missing.append(
            (
                "Footprint geometry",
                geometry,
                "npm run swissbuildings3d:pipeline:ch && npm run swissbuildings3d:convert\n"
                "  or set SWISSBUILDINGS_GEOMETRY=/path/to/footprints.geojsonseq",
            )
        )
    if not gwr_csv.is_file():
        missing.append(
            (
                "GWR CSV",
                gwr_csv,
                "npm run etl:gwr-ch\n"
                "  or npm run gwr:ingest -- --scope tg  (smaller canton ZIP)\n"
                "  or set GWR_CH_CSV=/path/to/gebaeude_batiment_edificio.csv",
            )
        )
    if not missing:
        return
    print("ETL inputs missing:", file=sys.stderr)
    for label, path, hint in missing:
        print(f"\n  {label}: {path}", file=sys.stderr)
        print(f"    → {hint}", file=sys.stderr)
    print("\nFull pipeline (fetch GWR + join + PMTiles): npm run etl:switzerland", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    args = parse_args()
    geometry = Path(args.geometry_flag or args.geometry or os.environ.get("SWISSBUILDINGS_GEOMETRY", DEFAULT_GEOMETRY))
    gwr_csv = Path(args.gwr_flag or args.gwr_csv or os.environ.get("GWR_CH_CSV", DEFAULT_GWR_CSV))
    output = Path(args.output_flag or args.output or os.environ.get("ETL_GPKG", DEFAULT_OUTPUT))
    if not geometry.is_absolute():
        geometry = REPO_ROOT / geometry
    if not gwr_csv.is_absolute():
        gwr_csv = REPO_ROOT / gwr_csv
    if not output.is_absolute():
        output = REPO_ROOT / output
    geometry = resolve_geometry_path(geometry)
    require_input_files(geometry, gwr_csv)
    clean_and_join_datasets(str(geometry), str(gwr_csv), str(output), delimiter=args.delimiter, batch_size=args.batch_size)


if __name__ == "__main__":
    main()
