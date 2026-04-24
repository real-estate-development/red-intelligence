# red-intelligence

Internal **Swiss building stock map** for your real estate development organization: explore buildings on a web map (pan/zoom, click for details). Complements [red-monitoring](../red-monitoring) (forced-sale opportunity alerts).

## Product snapshot

- **Audience:** people inside the organization.
- **MVP signal:** **year built** (later: renovation year and richer rules).
- **Map:** point markers, Switzerland-wide intent; demo data is a small sample until federal **GWR** ingest exists.
- **Click popup:** **EGID**, **address**, **year built**.
- **Auth:** username / password; **admins** manage users in-app (`/admin/users`).
- **Language:** English UI.
- **Deployment target:** always-on **mini PC** on your network, reachable via **SSH**; you expose it with your **static public IP** and accept **self-signed HTTPS** certificate warnings in the browser.

## Stack

- Next.js (App Router), React, TypeScript, Tailwind CSS  
- SQLite + Prisma (`User`, `Building`)  
- Sessions: [iron-session](https://github.com/vvo/iron-session) (encrypted cookie)  
- Map: [react-leaflet](https://react-leaflet.js.org/) + OpenStreetMap raster tiles (replace with a tile policy appropriate to your traffic before heavy use)

## Quick start

```bash
cd red-intelligence
cp .env.example .env
# Edit .env: set SESSION_PASSWORD (≥32 chars), SEED_ADMIN_PASSWORD (≥8 chars).

npm install
mkdir -p data
npx prisma db push
npm run db:seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in with `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`.

## Production on the mini PC

1. Clone the repo, install Node.js **20+**, copy `.env` with strong secrets.  
2. `npm ci && npx prisma db push && npm run db:seed && npm run build`  
3. Bind to all interfaces and your port, e.g. `HOST=0.0.0.0 PORT=3000 npm run start` (put **behind HTTPS** — see below).  
4. Port-forward on your router to the mini PC’s LAN IP.  
5. **TLS:** use a **self-signed** cert and terminate HTTPS (e.g. **Caddy** or **nginx**) in front of `next start`, or use Node’s HTTPS server wrapper. Browsers will warn until users trust the cert or proceed anyway.

**Security note:** password login over plain **HTTP** on the public internet is unsafe; your plan to use HTTPS with warnings is the right minimum.

## Documentation

- [docs/PRODUCT.md](docs/PRODUCT.md) — mission, scope, non-goals  
- [AGENTS.md](AGENTS.md) — layout, boundaries, where to extend next (GWR ingest, filters, footprints)

## Federal building data (next step)

Demo **EGIDs and coordinates are placeholders**, not GWR truth. Replace `prisma/seed.ts` demo rows with an ingest pipeline (documented in `AGENTS.md`) that loads the official register into `Building`.

## Linear

Work is tracked under the **Building stock map** project in the [real-estate-development](https://linear.app/real-estate-development) Linear workspace.
