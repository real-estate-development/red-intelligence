# red-intelligence

Internal **Swiss building stock map** for your real estate development organization: explore buildings on a web map (pan/zoom, click for details). Complements [red-monitoring](../red-monitoring) (forced-sale opportunity alerts).

## Product snapshot

- **Audience:** people inside the organization.
- **MVP signal:** **year built** (later: renovation year and richer rules).
- **Map:** **~100 hex bins** per screen (Turf hex grid sized to the viewport); each cell shows **mean** and **standard deviation** of **year built** for buildings inside it. Buildings come from **GWR-style CSV ingest** (see below).
- **Click popup:** **EGID**, **address**, **year built**.
- **Auth:** username / password; **admins** manage users in-app (`/admin/users`).
- **Language:** English UI.
- **Deployment target:** always-on **mini PC** on your network, reachable via **SSH**; you expose it with your **static public IP** and accept **self-signed HTTPS** certificate warnings in the browser.

## Stack

- Next.js (App Router), React, TypeScript, Tailwind CSS  
- SQLite + Prisma (`User`, `Building`)  
- Sessions: [iron-session](https://github.com/vvo/iron-session) (encrypted cookie)  
- Map: [react-leaflet](https://react-leaflet.js.org/) + OpenStreetMap raster tiles (replace with a tile policy appropriate to your traffic before heavy use); **black outside Switzerland** via a polygon-with-hole mask (coarse national outline in `src/data/che-outline-hole.ts`—swap for a higher-resolution border if you need exact frontiers / lakes).  
- Aggregation: [`@turf/turf`](https://turfjs.org/) hex grid on the server (`/api/buildings/hexbins`)  
- Ingest: [`scripts/gwr-ingest.ts`](scripts/gwr-ingest.ts) — semicolon CSV, LV95 → WGS84 ([proj4](https://github.com/proj4js/proj4js))

## Quick start

```bash
cd red-intelligence
cp .env.example .env
# Edit .env: set SESSION_PASSWORD (≥32 chars), SEED_ADMIN_PASSWORD (≥8 chars).

npm install
mkdir -p data
npx prisma db push
npm run db:seed
npm run gwr:ingest
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in with `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`.

## GWR data ingest

1. **Default (no config):** `npm run gwr:ingest` downloads the **Kanton Basel-Stadt** open “Gebäude GWR” CSV from `data.bs.ch` (~32k buildings). This is **real GWR attribute data** but **not nationwide**—useful to validate the pipeline on a small canton.

2. **Your own file:** `npm run gwr:ingest -- --file /home/you/Downloads/gwr_gebaeude.csv` (use a path that exists on your machine; `/path/to/…` in docs is only a placeholder.)  
   Expected columns (BFS Merkmalskatalog / typical CKAN exports): `egid`, `gbauj`, `gkode`, `gkodn`, `ggdename`, optional `gebnr`, `gbez`. Delimiter **`;`**. `gkode`/`gkodn` are **LV95 (EPSG:2056)** easting/northing in metres.

3. **Your own URL:** set `GWR_CSV_URL` in `.env` or pass `npm run gwr:ingest -- --url 'https://…/export.csv'`.

4. **Replace vs merge:** By default the script **deletes all** `Building` rows, then loads the CSV (full refresh). To **merge** another file without wiping existing rows: `npm run gwr:ingest -- --append --file /home/you/other.csv`.

**Nationwide bulk:** Full Switzerland extracts are distributed via **BFS** (e.g. [housing-stat.ch](https://www.housing-stat.ch) / **MADD** datadownload); point `GWR_CSV_URL` or `--file` at the export you are entitled to use. Licensing and update cadence follow the publisher’s terms.

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
