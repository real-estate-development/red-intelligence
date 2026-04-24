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
| `prisma/seed.ts` | Admin user + **demo** buildings (replace with GWR pipeline) |
| `src/app/` | App Router pages: `/`, `/login`, `/map`, `/admin/users` |
| `src/app/api/` | JSON APIs: auth, buildings, admin users |
| `src/lib/auth.ts` | iron-session helpers (`getSession`, `requireUser`, `requireAdmin`) |
| `src/lib/session.ts` | Session cookie options (`SESSION_PASSWORD` ≥ 32 chars) |
| `src/components/BuildingMap.tsx` | react-leaflet map + markers |
| `data/app.db` | SQLite file (gitignored); path from `DATABASE_URL` |

## Boundaries

- **Secrets:** never commit `.env`; rotate `SESSION_PASSWORD` if leaked.
- **Sessions:** only mutate the session in **Route Handlers** (or Server Actions), not during arbitrary RSC render paths.
- **Buildings:** treat DB rows as **display cache** of upstream federal data; preserve **EGID** as the stable key when ingesting GWR.
- **Tiles:** OSM’s public tile servers are fine for development; for production volume, use a host-appropriate tile source per [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## GWR ingest (placeholder)

There is **no** federal ingest in the MVP scaffold yet. Next implementation steps typically:

1. Choose delivery format (e.g. periodic **CSV/GeoPackage** extract or API, per current BFS/GWR offerings and license terms).
2. Add an **idempotent** job (Node script, `tsx`, or small CLI) that upserts `Building` by `egid` with `address`, `yearBuilt`, `lat`, `lng`.
3. Run the job on a schedule (cron on the mini PC) and restart or revalidate the app as needed.

Document the exact source URL, extract date, and field mapping next to the ingest code when you add it.

## How we work

- Prefer **small, auditable** changes; keep the product doc honest about demo vs live data.
- **Security:** bcrypt password hashes; httpOnly session cookie; use **HTTPS** in front of `next start` on the public internet.

## Quality snapshot

- Auth + admin CRUD + map + demo buildings are in place.
- **Not** yet wired to real GWR nationwide geometry or attributes.
