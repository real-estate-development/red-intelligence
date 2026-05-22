# red-intelligence

Internal **Swiss building stock map** for your real estate development organization: explore buildings on a web map (pan/zoom, click for details). Complements [red-monitoring](../red-monitoring) (forced-sale opportunity alerts).

## Product snapshot

- **Audience:** people inside the organization.
- **MVP signal:** **construction period** (`GBAUP`; more complete than exact year in GWR).
- **Map:** **building footprints** via PMTiles overlay; colour encodes each **EGID**’s GWR **Bauperiode** (`GBAUP`). Footprints from swissBUILDINGS3D ETL; attributes from **BFS public GWR** (`npm run etl:process`).
- **Click popup:** **EGID**, **construction period** (human-readable GBAUP label).
- **Auth:** username / password; **admins** manage users in-app (`/admin/users`).
- **Language:** English UI.
- **Deployment target:** always-on **mini PC** on your network, reachable via **SSH**; you expose it with your **static public IP** and accept **self-signed HTTPS** certificate warnings in the browser.

## Stack

- Next.js (App Router), React, TypeScript, Tailwind CSS  
- SQLite + Prisma (`User`, `Building`)  
- Sessions: [iron-session](https://github.com/vvo/iron-session) (encrypted cookie)  
- Map: [MapLibre GL](https://maplibre.org/) + [react-map-gl](https://visgl.github.io/react-map-gl/) with Swiss federal WMS basemap; age-based fills per EGID. Tune tile traffic per your deployment.  
- Footprint ingest: [`@turf/turf`](https://turfjs.org/) in [`scripts/footprints-ingest.ts`](scripts/footprints-ingest.ts) for geometry union/dissolve.  
- Ingest: [`scripts/gwr-ingest.ts`](scripts/gwr-ingest.ts) — BFS MADD **public** ZIP + tab-separated `gebaeude_batiment_edificio.csv`, LV95 → WGS84 ([proj4](https://github.com/proj4js/proj4js)); see [housing-stat public data](https://www.housing-stat.ch/de/data/supply/public.html)

## Quick start

```bash
cd red-intelligence
cp .env.example .env
# Edit .env: set SESSION_PASSWORD (≥32 chars), SEED_ADMIN_PASSWORD (≥8 chars).

npm install
mkdir -p data
npx prisma db push
npm run db:seed
# First ingest: Switzerland is ~900MB ZIP — use a canton for a smaller run, e.g.:
GWR_BFS_SCOPE=tg npm run gwr:ingest
# or: npm run gwr:ingest -- --scope tg
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in with `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`.

## GWR data ingest

Buildings come from the **BFS public MADD** delivery ([housing-stat.ch — public data](https://www.housing-stat.ch/de/data/supply/public.html)): ZIPs at **`https://public.madd.bfs.admin.ch/{scope}.zip`** containing **`gebaeude_batiment_edificio.csv`** (tab-separated, LV95).

1. **Default:** `GWR_BFS_SCOPE=ch` (or unset; default is `ch`) downloads **`ch.zip`** (~900MB) then ingests all Switzerland. Ensure disk space and bandwidth.

2. **Smaller canton ZIP:** `npm run gwr:ingest -- --scope tg` (or set `GWR_BFS_SCOPE=tg` in `.env`).

3. **Local ZIP:** `npm run gwr:ingest -- --zip /path/to/tg.zip` (must contain `gebaeude_batiment_edificio.csv`).

4. **Extracted CSV only:** `npm run gwr:ingest -- --file /path/to/gebaeude_batiment_edificio.csv` (same tab-separated format as inside the ZIP).

5. **Custom ZIP URL:** `npm run gwr:ingest -- --url 'https://…/custom.zip'`.

6. **Replace vs merge:** By default the script **deletes all** `Building` rows, then loads. **`--append`** upserts by EGID (e.g. merge an extra canton file without wiping).

## Footprint ingest (for polygon rendering)

To render actual building polygons (instead of centroid points) in low-density viewports:

```bash
npm run footprints:ingest -- --file /path/to/footprints.geojson
npm run footprints:ingest -- --url https://example.invalid/footprints.geojson
```

Notes:
- Footprint features must carry an EGID property (`egid`/`EGID` supported).
- Geometry must be Polygon or MultiPolygon.
- If coordinates are LV95, pass `--srid 2056`.
- You can set `FOOTPRINTS_GEOJSON_URL` in `.env` and then run `npm run footprints:ingest` without `--file`/`--url`.

## swissBUILDINGS3D 3.0 pipeline (swisstopo STAC)

The app now includes a downloader pipeline that fetches swissBUILDINGS3D 3.0 tiles directly from swisstopo via data.geo.admin.ch STAC:

```bash
npm run swissbuildings3d:pipeline -- --bbox 7.55,47.53,7.63,47.58
```

This writes tile `.gdb.zip` files to `data/swissbuildings3d/downloads` and creates a manifest at `data/swissbuildings3d/manifest.json`.

Then convert those FileGDB tiles to a merged footprint GeoJSON and ingest:

```bash
npm run swissbuildings3d:convert -- --manifest data/swissbuildings3d/manifest.json --ingest
```

Or run the complete flow in one command:

```bash
npm run swissbuildings3d:full -- --bbox 7.55,47.53,7.63,47.58
```

Conversion notes:
- Uses local GDAL CLI tools (`ogr2ogr`, `ogrinfo`) when installed.
- If local GDAL is missing, it automatically falls back to Docker (prefers `ghcr.io/osgeo/gdal:*` images).
- Converter enforces 2D Polygon/MultiPolygon output (`-dim 2 -nlt PROMOTE_TO_MULTI`) to avoid 3D geometry/SFCGAL GeoJSON export errors.
- If the default image is unavailable, it tries multiple GDAL image tags and you can override via `SWISSBUILDINGS3D_GDAL_DOCKER_IMAGE`.
- The converter auto-selects a likely building layer from each tile; override with `--layer <name>` if needed.
- Output footprint GeoJSONSeq defaults to `data/swissbuildings3d/footprints.geojsonseq`.
- Downloader retries each failed tile up to 3 times and logs per-tile failures in the run output and manifest.
- Converter progress is resumable with `--resume`; failed tiles are retried, and partial footprint outputs require explicit `--allow-partial`.

**Licensing:** follow **`license.pdf`** inside each ZIP and [housing-stat.ch](https://www.housing-stat.ch/de/data/supply/public.html) (Level A public data; source attribution required).

Rows are skipped when `gbauj` is missing or implausible, or coordinates are missing / outside a loose CH bounding box.

## Production on the mini PC

1. Clone the repo, install Node.js **20+**, copy `.env` with strong secrets.  
2. `npm ci && npx prisma db push && npm run db:seed && npm run gwr:ingest && npm run build`  
3. Bind to all interfaces and your port, e.g. `HOST=0.0.0.0 PORT=3000 npm run start` (put **behind HTTPS** — see below).  
4. Port-forward on your router to the mini PC’s LAN IP.  
5. **TLS:** use a **self-signed** cert and terminate HTTPS (e.g. **Caddy** or **nginx**) in front of `next start`, or use Node’s HTTPS server wrapper. Browsers will warn until users trust the cert or proceed anyway.

**Security note:** password login over plain **HTTP** on the public internet is unsafe; your plan to use HTTPS with warnings is the right minimum.

## Documentation

- [docs/PRODUCT.md](docs/PRODUCT.md) — mission, scope, non-goals  
- [AGENTS.md](AGENTS.md) — layout, boundaries, ingest extension points

## Linear

Work is tracked under the **Building stock map** project in the [real-estate-development](https://linear.app/real-estate-development) Linear workspace.
