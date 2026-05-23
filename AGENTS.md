# AGENTS.md

This repository is the **red-intelligence** app: internal **building stock map** (Next.js + SQLite). Read this file before extending ingest, auth, or map behavior.

## Start here

1. [README.md](README.md) — install, env vars, deploy on the mini PC.
2. [docs/PRODUCT.md](docs/PRODUCT.md) — mission, MVP scope, non-goals.
3. This file — code map and extension points.

## Repository layout

| Path | Role |
|------|------|
| `prisma/schema.prisma` | `User`, `Building` models |
| `prisma/seed.ts` | Admin user only; buildings come from `scripts/gwr-ingest.ts` |
| `src/app/` | App Router pages: `/`, `/login`, `/map`, `/admin/users` |
| `src/app/api/` | JSON APIs: auth, admin users |
| `src/lib/auth.ts` | iron-session helpers (`getSession`, `requireUser`, `requireAdmin`) |
| `src/lib/session.ts` | Session cookie options (`SESSION_PASSWORD` ≥ 32 chars) |
| `src/lib/map.ts` | geo.admin WMS basemap, PMTiles protocol, `BUILDINGS` paint (WebGL `step` on `GBAUP`) |
| `src/components/SwissAgeMap.tsx` | Phase 3 map: PMTiles fill overlay + hover popup (`NEXT_PUBLIC_BUILDINGS_PMTILES_URL`) |
| `scripts/etl/process_swiss_data.py` | Phase 1: EGID join (usecols, int EGID), output `data/etl/processed_output.gpkg` |
| `scripts/etl/build_pmtiles.sh` | Phase 2: tippecanoe → `public/tiles/swiss_buildings.pmtiles` (layer `processed_output`, z11–17, EGID+GBAUP only) |
| `scripts/gwr-ingest.ts` | BFS MADD **public** ZIP (`gebaeude_batiment_edificio.csv`, tab) → LV95→WGS84 → `Building` |
| `scripts/footprints-ingest.ts` | GeoJSON Polygon/MultiPolygon footprints → `BuildingFootprint` (WGS84 + bbox cache) |
| `scripts/tlmregio-footprints-join.ts` | swissTLMRegio Product GPKG (`tlmregio_buildings_building`) + point-in-polygon join → `BuildingFootprint` |
| `scripts/tlm3d-footprints-join.ts` | swissTLM3D Product GPKG (STAC `ch.swisstopo.swisstlm3d`) + tiled spatial join → `BuildingFootprint` |
| `data/app.db` | SQLite file (gitignored); path from `DATABASE_URL` |

## Boundaries

- **Secrets:** never commit `.env`; rotate `SESSION_PASSWORD` if leaked.
- **Sessions:** only mutate the session in **Route Handlers** (or Server Actions), not during arbitrary RSC render paths.
- **Buildings:** treat DB rows as **display cache** of upstream federal data; preserve **EGID** as the stable key when ingesting GWR.
- **Tiles:** OSM’s public tile servers are fine for development; for production volume, use a host-appropriate tile source per [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## GWR ingest

Implemented as **`npm run gwr:ingest`** → `scripts/gwr-ingest.ts`.

- **Source:** BFS **Level A** public supply described at [housing-stat.ch — Daten herunterladen](https://www.housing-stat.ch/de/data/supply/public.html). ZIPs are served from **`https://public.madd.bfs.admin.ch/{scope}.zip`** (`ch` = Switzerland, or a two-letter canton code, e.g. `tg`).
- **Inside each ZIP:** tab-separated `gebaeude_batiment_edificio.csv` (UTF-8, no BOM per BFS spec), same logical attributes as the GWR Merkmalskatalog (`EGID`, `GBAUJ`, `GKODE`, `GKODN`, `GDEKT`, …). Headers are normalized to lowercase before mapping.
- **Coordinates:** `gkode` / `gkodn` are **LV95 (EPSG:2056)** → WGS84 with **proj4**.
- **Env:** `GWR_BFS_SCOPE` (default `ch`; use a canton for smaller downloads in dev), optional `GWR_BFS_PUBLIC_BASE` (default `https://public.madd.bfs.admin.ch`).
- **CLI:** `--scope`, `--zip` (local ZIP), `--url` (full ZIP URL), `--file` (extracted `gebaeude_batiment_edificio.csv` only), `--base`, `--append`.
- **Modes:** default **replaces** all `Building` rows. **`--append`** upserts per EGID (merge).

If BFS adds **address columns** under other names, extend `buildAddress()` in `scripts/gwr-ingest-core.ts`—keep one row per **EGID**.

**Cron example:** `0 3 * * * cd /path/to/red-intelligence && DATABASE_URL=file:../data/app.db /usr/bin/npm run gwr:ingest >> /var/log/gwr-ingest.log 2>&1` (the web app does not need a restart after ingest; it reads SQLite on each request).

## swissTLM3D footprints

Implemented as **`npm run footprints:tlm3d-join`** → `scripts/tlm3d-footprints-join.ts`.

- **Source:** BGDI STAC [`ch.swisstopo.swisstlm3d`](https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisstlm3d) (item id e.g. `swisstlm3d_2025-03`), asset **`<release>_2056_5728.gpkg.zip`** (~4.5 GB). The script streams **one** `.gpkg` from the zip (prefers a *Product* member, not *BOUNDARIES*). Product info: [swissTLM3D](https://www.swisstopo.admin.ch/en/geodata/landscape/tlm3d.html).
- **Join:** GWR `Building` points carry **EGID**; TLM3D polygons do not. The script uses **point-in-polygon** (smallest containing polygon wins). Optional **`--snap-m`** uses nearest-polygon distance for points just outside walls (metres; default 2, `0` disables).
- **Tiling:** the national GeoPackage is not loaded whole into RAM. Space is split into WGS84 **grid tiles** (`--grid-deg`, default `0.15`); each tile queries the GeoPackage R-tree with an expanded bbox (`--buffer-deg`, default `0.002`).
- **CLI:** `--gpkg`, `--zip`, `--release swisstlm3d_2025-03`, `--table` (override auto-detect `*buildings_building*`), `--append`. Env: `SWISSTLM3D_RELEASE`, `SWISSTLM3D_DATA_DIR`, `SWISSTLM3D_GRID_DEG`, `SWISSTLM3D_BUFFER_DEG`, `SWISSTLM3D_SNAP_M`.

## swissTLMRegio footprints

Implemented as **`npm run footprints:tlmregio-join`** → `scripts/tlmregio-footprints-join.ts`.

- **Source:** BGDI STAC collection [`ch.swisstopo.swisstlmregio`](https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisstlmregio) (item `swisstlmregio_<YEAR>`), asset `swisstlmregio_<YEAR>_2056.gpkg.zip`, file **`swissTLMRegio_Product_LV95.gpkg`**, layer **`tlmregio_buildings_building`**. GeoJSON geometries from the reader are WGS84. The model is intended for **overview scales around 1:100,000** (swisstopo product documentation).
- **Join:** each `Building` row’s `lat`/`lng` is tested point-in-polygon against an in-memory R-tree of TLMRegio polygons (no EGID on polygons). Default mode **replaces** all `BuildingFootprint` rows; **`--append`** upserts without clearing.
- **CLI:** `--gpkg /path/to/swissTLMRegio_Product_LV95.gpkg`, or **`--year 2025`** to download into `SWISSTLMREGIO_DATA_DIR` (default `data/swisstlmregio`), or **`--zip`** for a local zip. Env defaults: `SWISSTLMREGIO_YEAR`, `SWISSTLMREGIO_DATA_DIR`.

## Building-age PMTiles pipeline (Phases 1–3)

**Recommended (full Switzerland):** `bash scripts/etl/run_switzerland.sh` — national GWR CSV + **swissTLM3D** footprints (`tlm_bauten_gebaeude_footprint`) joined to **GBAUP** via point-in-polygon (`npm run etl:tlm3d-bauperiode`), then PMTiles.

**Legacy (swissBUILDINGS3D STAC tiles):** can have **internal gaps** (e.g. Winterthur, Altdorf missing in partial extracts).

1. **`npm run etl:tlm3d-bauperiode`** — `scripts/etl/tlm3d_bauperiode_join.py`: GWR points → TLM3D polygons → GeoJSONSeq with **EGID + GBAUP** (default snap 10 m).
2. **`npm run etl:pmtiles`** — tippecanoe **-Z 11**, **-y EGID -y GBAUP** only; **`--use-attribute-for-id=EGID`**.
3. **`SwissAgeMap`** — client colours footprints with MapLibre **`step`/`case` expressions** on **GBAUP**; hover uses **`feature-state` only** (no JS colour loops).

**Do not:** spatial-intersection joins for GWR attributes; load full GWR CSV without `usecols`; compute fill colours in React from GBAUP on mousemove.

## How we work

- Prefer **small, auditable** changes; keep the product doc honest about demo vs live data.
- **Security:** bcrypt password hashes; httpOnly session cookie; use **HTTPS** in front of `next start` on the public internet.

## Quality snapshot

- Auth + admin CRUD + map + GWR CSV ingest are in place.
- Default ingest uses the **national public ZIP** (`GWR_BFS_SCOPE=ch`, large download); use a **canton scope** or `--file` for lighter runs.
