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
| `src/app/api/` | JSON APIs: auth, buildings, admin users |
| `src/lib/auth.ts` | iron-session helpers (`getSession`, `requireUser`, `requireAdmin`) |
| `src/lib/session.ts` | Session cookie options (`SESSION_PASSWORD` ≥ 32 chars) |
| `src/components/BuildingMap.tsx` | react-leaflet map + markers |
| `scripts/gwr-ingest.ts` | Stream semicolon GWR CSV → LV95→WGS84 → `Building` |
| `data/app.db` | SQLite file (gitignored); path from `DATABASE_URL` |

## Boundaries

- **Secrets:** never commit `.env`; rotate `SESSION_PASSWORD` if leaked.
- **Sessions:** only mutate the session in **Route Handlers** (or Server Actions), not during arbitrary RSC render paths.
- **Buildings:** treat DB rows as **display cache** of upstream federal data; preserve **EGID** as the stable key when ingesting GWR.
- **Tiles:** OSM’s public tile servers are fine for development; for production volume, use a host-appropriate tile source per [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## GWR ingest

Implemented as **`npm run gwr:ingest`** → `scripts/gwr-ingest.ts`.

- **Input:** semicolon-separated CSV with (at minimum) `egid`, `gbauj`, `gkode`, `gkodn`, and address hints (`ggdename`, optional `gebnr`, `gbez`). Matches common **CKAN / opendatasoft** GWR building exports (e.g. `data.bs.ch` dataset `100230`).
- **Coordinates:** `gkode` / `gkodn` are interpreted as **LV95 (EPSG:2056)** and converted with **proj4** to WGS84 for the map.
- **Default URL:** Basel-Stadt export (subset of Switzerland). Set `GWR_CSV_URL` or `--file` / `--url` for your cantonal or **BFS MADD** nationwide extract when available.
- **Modes:** default run **clears** `Building` then bulk-inserts. `--append` uses **upsert** per batch to merge another file without deleting existing rows.

If a publisher adds **street columns** (e.g. `strname`, `deinr`), extend `buildAddress()` in `scripts/gwr-ingest.ts`—keep one line per building (`egid` unique).

**Cron example:** `0 3 * * * cd /path/to/red-intelligence && DATABASE_URL=file:../data/app.db /usr/bin/npm run gwr:ingest >> /var/log/gwr-ingest.log 2>&1` (the web app does not need a restart after ingest; it reads SQLite on each request).

## How we work

- Prefer **small, auditable** changes; keep the product doc honest about demo vs live data.
- **Security:** bcrypt password hashes; httpOnly session cookie; use **HTTPS** in front of `next start` on the public internet.

## Quality snapshot

- Auth + admin CRUD + map + GWR CSV ingest are in place.
- Default ingest is **canton-scale** open data; **nationwide** coverage depends on the file or URL you configure.
