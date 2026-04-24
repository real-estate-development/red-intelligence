# Product — red-intelligence (building stock map)

## Mission

Give everyone inside the organization a **single web map** to **explore the Swiss building stock geographically**, starting with **year built** as the age signal, to support thinking about **which buildings might warrant rebuild** due to age. **Ordering and shortlists** are secondary to pan/zoom exploration in the first version.

## Scope (MVP)

- **Switzerland-wide** product intent; data is expected to come from a **federal register** (GWR) once ingest is implemented.
- **Web application** in English: map + login + **in-app admin** for usernames/passwords.
- **Point markers** for buildings; **all buildings** in the database are shown (no age filter in v1).
- **Building click** shows at minimum: **EGID**, **address**, **year built**.
- **Access:** reachable from the **public internet** at a **static IP**; **HTTPS** with a **self-signed** certificate (users accept browser warnings); **username/password** authentication.

## Intended outcomes

- Shared geographic mental model of where **older stock** concentrates.
- Traceable, repeatable data path from official identifiers (**EGID**) to what the map shows (once GWR ingest ships).

## Non-goals (current phase)

- Footprints / 3D models (points only for now).
- Age or year filters on the map (may come later).
- Multi-language UI.
- SSO / social login (simple credentials only).
- Paid DNS or domain requirement (IP access is acceptable for now).
- Legal, cadastral, or investment advice; the map is a **working tool**, not a recommendation engine.

## Demo vs production data

The repository ships with **seeded demo buildings** so the stack runs end-to-end before GWR ingestion exists. **Do not** treat demo EGIDs or locations as authoritative.
