# Product — red-intelligence (building stock map)

## Mission

Give everyone inside the organization a **single web map** to **explore the Swiss building stock geographically**, starting with **year built** as the age signal, to support thinking about **which buildings might warrant rebuild** due to age. **Ordering and shortlists** are secondary to pan/zoom exploration in the first version.

## Scope (MVP)

- **Switzerland-wide** product intent; buildings are loaded from **GWR-style** official extracts (default sample: one canton’s open CSV; nationwide when you supply that file or URL).
- **Web application** in English: map + login + **in-app admin** for usernames/passwords.
- **Map:** viewport buildings as **footprints** (when ingested) or **centroid points**; colour encodes each **EGID**’s stock age from **year built**. Pan/zoom refetches the viewport.
- **Click popup:** **EGID**, **year built**, **age** (reference year − year built).
- **Access:** reachable from the **public internet** at a **static IP**; **HTTPS** with a **self-signed** certificate (users accept browser warnings); **username/password** authentication.

## Intended outcomes

- Shared geographic mental model of where **older stock** concentrates.
- Traceable, repeatable data path from official **GWR** extracts to what the map shows (per-building **EGID** remains in the database for future drill-down).

## Non-goals (current phase)

- 3D models and advanced styling beyond footprint + centroid display.
- Age or year filters on the map (may come later).
- Multi-language UI.
- SSO / social login (simple credentials only).
- Paid DNS or domain requirement (IP access is acceptable for now).
- Legal, cadastral, or investment advice; the map is a **working tool**, not a recommendation engine.

## Data loading

Buildings are **not** created by `prisma db seed`. After seeding the admin user, run **`npm run gwr:ingest`** (see [README.md](../README.md)). Ingest reads the **BFS MADD public** ZIP delivery ([housing-stat.ch](https://www.housing-stat.ch/de/data/supply/public.html)); default scope is **all Switzerland** (`ch`, large download)—use a **canton scope** or `--file` for smaller loads.

Treat upstream **EGID** and geometry as authoritative; this app stores a **cache** for the map.
