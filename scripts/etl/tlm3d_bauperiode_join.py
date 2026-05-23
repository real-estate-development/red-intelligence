#!/usr/bin/env python3
"""
Join national swissTLM3D building polygons to GWR bauperiode by point-in-polygon.

swissTLM3D polygons do not carry EGID. GWR has EGID, GBAUP, and LV95 building
points, so this streams the national GeoPackage by grid tile, matches points to
the smallest containing polygon, and writes GeoJSONSeq features with EGID/GBAUP.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

import geopandas as gpd
import pandas as pd
import pyogrio
from pyproj import Transformer
from shapely.geometry import Point, mapping

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GWR_CSV = REPO_ROOT / "data/gwr/ch/gebaeude_batiment_edificio.csv"
DEFAULT_OUTPUT = REPO_ROOT / "data/etl/tlm3d_bauperiode.geojsonseq"
DEFAULT_DATA_DIR = REPO_ROOT / "data/swisstlm3d"
DEFAULT_RELEASE = "swisstlm3d_2025-03"
STAC_ITEM = (
    "https://data.geo.admin.ch/api/stac/v1/collections/"
    "ch.swisstopo.swisstlm3d/items/{release}"
)
USER_AGENT = "red-intelligence/tlm3d-bauperiode-join"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build full-country TLM3D footprints with GWR EGID/GBAUP."
    )
    parser.add_argument("--gpkg", help="Existing extracted swissTLM3D GeoPackage.")
    parser.add_argument("--zip", dest="zip_path", help="Existing swissTLM3D .gpkg.zip.")
    parser.add_argument("--release", default=os.environ.get("SWISSTLM3D_RELEASE", DEFAULT_RELEASE))
    parser.add_argument("--data-dir", default=os.environ.get("SWISSTLM3D_DATA_DIR", str(DEFAULT_DATA_DIR)))
    parser.add_argument("--gwr-csv", default=os.environ.get("GWR_CH_CSV", str(DEFAULT_GWR_CSV)))
    parser.add_argument("--output", default=os.environ.get("TLM3D_BAUPERIODE_OUTPUT", str(DEFAULT_OUTPUT)))
    parser.add_argument("--layer", help="Override swissTLM3D building polygon layer.")
    parser.add_argument("--grid-m", type=float, default=float(os.environ.get("TLM3D_JOIN_GRID_M", "20000")))
    parser.add_argument("--buffer-m", type=float, default=float(os.environ.get("TLM3D_JOIN_BUFFER_M", "250")))
    parser.add_argument(
        "--snap-m",
        type=float,
        default=float(os.environ.get("TLM3D_JOIN_SNAP_M", "10")),
        help="Assign nearest footprint within n metres when point is not inside (default 10).",
    )
    parser.add_argument("--chunk-size", type=int, default=250_000)
    return parser.parse_args()


def fetch_json(url: str) -> dict:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req) as response:
        return json.load(response)


def download(url: str, destination: Path) -> None:
    if destination.is_file():
        print(f"Using existing zip: {destination}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(destination.suffix + ".part")
    req = Request(url, headers={"User-Agent": USER_AGENT})
    print(f"Downloading {url} -> {destination}")
    with urlopen(req) as response, tmp.open("wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        next_log = 512 * 1024 * 1024
        while True:
            chunk = response.read(8 * 1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if done >= next_log:
                if total:
                    print(f"  downloaded {done / 1024**3:.1f}/{total / 1024**3:.1f} GiB")
                else:
                    print(f"  downloaded {done / 1024**3:.1f} GiB")
                next_log += 512 * 1024 * 1024
    tmp.replace(destination)


def resolve_gpkg(args: argparse.Namespace) -> Path:
    if args.gpkg:
        gpkg = Path(args.gpkg)
        if not gpkg.is_absolute():
            gpkg = REPO_ROOT / gpkg
        if not gpkg.is_file():
            raise FileNotFoundError(gpkg)
        return gpkg

    data_dir = Path(args.data_dir)
    if not data_dir.is_absolute():
        data_dir = REPO_ROOT / data_dir
    data_dir.mkdir(parents=True, exist_ok=True)

    asset = f"{args.release}_2056_5728.gpkg.zip"
    zip_path = Path(args.zip_path) if args.zip_path else data_dir / asset
    if not zip_path.is_absolute():
        zip_path = REPO_ROOT / zip_path

    if not args.zip_path:
        meta = fetch_json(STAC_ITEM.format(release=args.release))
        href = ((meta.get("assets") or {}).get(asset) or {}).get("href")
        if not href:
            raise ValueError(f"STAC asset not found: {asset}")
        download(href, zip_path)
    elif not zip_path.is_file():
        raise FileNotFoundError(zip_path)

    out_gpkg = data_dir / f"{args.release}_Product.gpkg"
    if out_gpkg.is_file():
        print(f"Using existing extracted GeoPackage: {out_gpkg}")
        return out_gpkg

    with zipfile.ZipFile(zip_path) as archive:
        gpkg_members = [m for m in archive.namelist() if m.lower().endswith(".gpkg")]
        if not gpkg_members:
            raise ValueError(f"No .gpkg member found in {zip_path}")
        product = next((m for m in gpkg_members if "product" in m.lower() and "boundar" not in m.lower()), gpkg_members[0])
        print(f"Extracting {product} -> {out_gpkg}")
        with archive.open(product) as src, out_gpkg.open("wb") as dst:
            while True:
                chunk = src.read(16 * 1024 * 1024)
                if not chunk:
                    break
                dst.write(chunk)
    return out_gpkg


def pick_layer(gpkg: Path, explicit: str | None) -> str:
    layers = pyogrio.list_layers(gpkg)
    names = [row[0] for row in layers]
    if explicit:
        if explicit not in names:
            raise ValueError(f"Layer {explicit!r} not found. Available: {names}")
        return explicit
    for name in names:
        lower = name.lower()
        if lower.endswith("buildings_building") or lower.endswith("gebaeude_footprint"):
            return name
    for name in names:
        lower = name.lower()
        if "tlm3d" in lower and "building" in lower and "named" not in lower:
            return name
    raise ValueError(f"Could not detect building layer. Available: {names}")


def gwr_column_map(path: Path) -> dict[str, str]:
    header = pd.read_csv(path, sep="\t", nrows=0, encoding="utf-8")
    return {c.upper(): c for c in header.columns}


def load_gwr(path: Path, chunk_size: int) -> pd.DataFrame:
    cols = gwr_column_map(path)
    required = ["EGID", "GBAUP", "GKODE", "GKODN"]
    missing = [c for c in required if c not in cols]
    if missing:
        raise ValueError(f"GWR CSV missing required columns: {missing}")

    frames: list[pd.DataFrame] = []
    usecols = [cols[c] for c in required]
    print(f"Loading GWR points: {path}")
    for chunk in pd.read_csv(path, sep="\t", usecols=usecols, chunksize=chunk_size, encoding="utf-8"):
        chunk.columns = [c.upper() for c in chunk.columns]
        chunk["EGID"] = chunk["EGID"].astype("string")
        chunk["GBAUP"] = pd.to_numeric(chunk["GBAUP"], errors="coerce").fillna(0).astype("int64")
        chunk["x"] = pd.to_numeric(chunk["GKODE"].astype("string").str.replace(",", "."), errors="coerce")
        chunk["y"] = pd.to_numeric(chunk["GKODN"].astype("string").str.replace(",", "."), errors="coerce")
        chunk = chunk[["EGID", "GBAUP", "x", "y"]]
        chunk = chunk[chunk["EGID"].notna() & chunk["x"].notna() & chunk["y"].notna()]
        chunk = chunk[(chunk["x"].between(2_400_000, 2_900_000)) & (chunk["y"].between(1_000_000, 1_350_000))]
        frames.append(chunk)
    df = pd.concat(frames, ignore_index=True)
    df = df.drop_duplicates(subset=["EGID"], keep="first")
    print(f"Loaded {len(df):,} GWR points with coordinates.")
    return df


def tile_ranges(df: pd.DataFrame, step: float):
    minx = math.floor(df["x"].min() / step) * step
    maxx = math.ceil(df["x"].max() / step) * step
    miny = math.floor(df["y"].min() / step) * step
    maxy = math.ceil(df["y"].max() / step) * step
    y = miny
    while y < maxy:
        x = minx
        while x < maxx:
            yield (x, y, min(x + step, maxx), min(y + step, maxy))
            x += step
        y += step


def choose_one(joined: gpd.GeoDataFrame) -> pd.DataFrame:
    if joined.empty:
        return pd.DataFrame(columns=["point_index", "index_right"])
    rows = joined.reset_index(names="point_index")
    rows = rows.sort_values(["point_index", "distance", "poly_area"] if "distance" in rows else ["point_index", "poly_area"])
    return rows.drop_duplicates(subset=["point_index"], keep="first")[["point_index", "index_right"]]


def write_features(out, points: pd.DataFrame, polygons_wgs84: gpd.GeoSeries, matches: pd.DataFrame) -> int:
    written = 0
    for row in matches.itertuples(index=False):
        point_row = points.loc[row.point_index]
        geom = polygons_wgs84.loc[row.index_right]
        feature = {
            "type": "Feature",
            "properties": {
                "EGID": str(point_row["EGID"]),
                "GBAUP": int(point_row["GBAUP"]),
            },
            "geometry": mapping(geom),
        }
        out.write(json.dumps(feature, separators=(",", ":")) + "\n")
        written += 1
    return written


def main() -> None:
    args = parse_args()
    if args.grid_m <= 0:
        raise ValueError("--grid-m must be > 0")

    gpkg = resolve_gpkg(args)
    layer = pick_layer(gpkg, args.layer)
    gwr_csv = Path(args.gwr_csv)
    if not gwr_csv.is_absolute():
        gwr_csv = REPO_ROOT / gwr_csv
    output = Path(args.output)
    if not output.is_absolute():
        output = REPO_ROOT / output
    output.parent.mkdir(parents=True, exist_ok=True)

    print(f"GeoPackage: {gpkg}")
    print(f"Building layer: {layer}")
    print(f"Output: {output}")

    gwr = load_gwr(gwr_csv, args.chunk_size)
    to_wgs84 = Transformer.from_crs("EPSG:2056", "EPSG:4326", always_xy=True)

    matched = 0
    unmatched = 0
    tiles_with_points = 0
    tiles_done = 0

    if output.exists():
        output.unlink()

    with output.open("w", encoding="utf-8") as out:
        for tile in tile_ranges(gwr, args.grid_m):
            minx, miny, maxx, maxy = tile
            points_df = gwr[(gwr["x"] >= minx) & (gwr["x"] < maxx) & (gwr["y"] >= miny) & (gwr["y"] < maxy)]
            if points_df.empty:
                continue
            tiles_with_points += 1

            bbox = (minx - args.buffer_m, miny - args.buffer_m, maxx + args.buffer_m, maxy + args.buffer_m)
            polygons = pyogrio.read_dataframe(gpkg, layer=layer, bbox=bbox, columns=[])
            if polygons.empty:
                unmatched += len(points_df)
                continue
            if polygons.crs is None:
                polygons = polygons.set_crs("EPSG:2056")
            polygons = polygons[polygons.geometry.notna() & ~polygons.geometry.is_empty].copy()
            polygons = polygons[polygons.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
            if polygons.empty:
                unmatched += len(points_df)
                continue
            polygons["poly_area"] = polygons.geometry.area

            points = gpd.GeoDataFrame(
                points_df.copy(),
                geometry=[Point(xy) for xy in zip(points_df["x"], points_df["y"])],
                crs="EPSG:2056",
            )
            joined = gpd.sjoin(points, polygons[["geometry", "poly_area"]], predicate="within", how="inner")
            chosen = choose_one(joined)

            if args.snap_m > 0:
                missing_idx = points.index.difference(chosen["point_index"] if not chosen.empty else [])
                if len(missing_idx):
                    nearest = gpd.sjoin_nearest(
                        points.loc[missing_idx],
                        polygons[["geometry", "poly_area"]],
                        how="inner",
                        max_distance=args.snap_m,
                        distance_col="distance",
                    )
                    nearest_chosen = choose_one(nearest)
                    if not nearest_chosen.empty:
                        chosen = pd.concat([chosen, nearest_chosen], ignore_index=True)

            if chosen.empty:
                unmatched += len(points)
                continue

            polygon_ids = chosen["index_right"].drop_duplicates()
            polygons_wgs84 = polygons.loc[polygon_ids, "geometry"].to_crs("EPSG:4326")
            written = write_features(out, points, polygons_wgs84, chosen)
            matched += written
            unmatched += len(points) - written
            tiles_done += 1

            if tiles_done % 20 == 0:
                print(
                    f"... tiles with matches {tiles_done}; "
                    f"matched {matched:,}; unmatched {unmatched:,}"
                )

    print(
        f"Done. Tiles with points: {tiles_with_points:,}; "
        f"features written: {matched:,}; unmatched: {unmatched:,}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
