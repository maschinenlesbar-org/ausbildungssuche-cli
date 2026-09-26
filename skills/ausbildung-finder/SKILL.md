---
name: ausbildung-finder
description: >
  Find German apprenticeships / vocational-training offers near a place and turn
  the raw catalogue into a ranked, deduplicated shortlist using the
  ausbildungssuche-cli. Trigger when the user asks "Ausbildung als X near
  a city", "apprenticeships for a job within 50 km of a place", "Umschulung /
  Weiterbildung in a region", "training with a Bildungsgutschein near me", or
  wants vocational offers filtered by location, profession, funding, or start
  date. Handles the occupation-id, location-string and radius traps the bare CLI
  does not.
compatibility: >
  Requires the `ausbildungssuche` CLI (npm package
  @maschinenlesbar.org/ausbildungssuche-cli) on PATH, installed by the user; the
  skill never installs it. Uses jq for JSON filtering. Network access to
  rest.arbeitsagentur.de. Needs the public API key via --api-key or
  AUSBILDUNGSSUCHE_API_KEY (`ausbildungssuche obtain-key` prints it).
---

# Ausbildung Finder

Turn a vague "what apprenticeships can I do near <place>?" into a **ranked, deduplicated
shortlist** — provider, town, start date, funding — out of the deeply nested
Bundesagentur für Arbeit catalogue. The whole value here is the location handling, the
de-duplication, and the enrichment the raw `search` JSON does not give you.

## Tooling

This skill drives the `ausbildungssuche` command. **Before anything else, validate it is available** — run `command -v ausbildungssuche` (or `ausbildungssuche --version`). If it is not on your PATH, STOP and inform the user that the `ausbildungssuche` CLI (`@maschinenlesbar.org/ausbildungssuche-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**API key — obtain it once, then reuse it.** The API needs a static `X-API-Key`. **None is
bundled**, and it is **not a secret**: one public value, the same for everyone. Finding it is
not the user's job either. If `AUSBILDUNGSSUCHE_API_KEY` is already set in the environment,
use that; otherwise obtain it with the CLI's own command:

```bash
ausbildungssuche obtain-key
```

It prints the key on stdout (the "obtained from …" note goes to stderr) and reads it from the
published upstream source, so a rotated key needs no new release. **Keep that value for the
rest of the session** and put it on every later call — a shell `export` does not survive
between separate commands:

```bash
AUSBILDUNGSSUCHE_API_KEY="<the key obtain-key printed>" ausbildungssuche --compact search --size 1
```

Say which key you used when you report back — it is public, not a credential to hide. If
`obtain-key` exits non-zero, stop and tell the user; never guess a key or hard-code one.

Always pass `--compact` so each result is one line for `jq`.

## Step 1 — Build the search query

Map the request to `search` flags. The fields that matter most:

| Flag | Use | Trap |
|---|---|---|
| `--ids <dkzId>` | occupation filter | **the only filter that narrows by occupation.** Takes the `dkzId` from `angebot.systematiken[]`; comma-separate several (`--ids 132173,135349`). Resolve it first (Step 1b). |
| `--sw <text>` | free-text keyword | **ignored by the API** — `--sw Pflege`, `--sw Qwxzy` and no `--sw` return the same offers in the same order. Never use it to filter; a "keyword" shortlist would just be the unfiltered catalogue. |
| `--orte <Name_lon_lat>` | location anchor | **order is `Name_lon_lat` (longitude FIRST)**, not `Name_lat_lon` (see Step 2). **Needs `--uk`** — alone it does not restrict (the CLI rejects it, exit `2`). |
| `--uk <radius>` | radius in km, or `Bundesweit` | **a km radius needs `--orte`** (the API ignores it alone; the CLI rejects it, exit `2`). **Only `10`, `25`, `50`, `100`, `Bundesweit` are valid.** `30`, `75`, `150`, `200` are rejected by the CLI (exit `2`; the API would answer HTTP 400). |
| `--sty <0..3>` | offer/search type | `0`,`1`,`2`,`3` only — **`4` is rejected (exit `2`).** `1` narrows hard (e.g. school-based), `3` is small/specialised. |
| `--bart <id>` | training type | filter by `bildungsart.id`: `101` Berufliche Grundqualifikation, `102` Berufsausbildung, `104` Fortbildung/Qualifizierung. |
| `--re <code>` | Bundesland code | use the API's **3-letter `land.code`**, not the common 2-letter abbreviation: `BAW` Baden-Württ., `BAY` Bayern, `BER` Berlin, `BRA` Brandenburg, `BRE` Bremen, `HAM` Hamburg, `HES` Hessen, `MBV` Mecklenb.-Vorp., `NDS` Niedersachsen, `NRW`, `RPF` Rheinl.-Pfalz, `SAA` Saarland, `SAC` Sachsen, `SAN` Sachsen-Anhalt, `SLH` Schl.-Holst., `THÜ` Thüringen. Comma-separate several. Wrong codes (`BW`, `BY`, `SH`) are rejected (exit `2`); lowercase is uppercased for you. |
| `--bg` | only Bildungsgutschein-eligible offers | boolean flag, no value. |
| `--bt <0..2>` | start-date window | start-date code. |
| `--size <n>` / `--page <n>` | paging | the CLI accepts `size` 1..2000, but **the server returns at most 20 rows per page** (`page.size` comes back as 20); `page` is 0-based. |

## Step 1b — Resolve the occupation to a `dkzId`

`--ids` needs the occupation's `dkzId`, and the CLI has no occupation lookup. Read the ids
from offers near the place: every offer lists its occupations in `angebot.systematiken[]` as
`{dkzId, kurzbezeichnung, …}`. Sample a few pages without `--ids` and match the job word:

```bash
for p in 0 1 2 3 4; do
  ausbildungssuche --compact search --orte "Köln_6.957_50.938" --uk 50 --size 20 --page "$p"
done | jq -s -c '[.[]._embedded.termine[]?.angebot.systematiken[]?
    | select(.dkzId != 0 and ((.kurzbezeichnung // "") | test("pflege"; "i")))
    | {dkzId, kurzbezeichnung}] | unique'
```

- This is a **sample**: it finds only occupations that appear in the pages you fetched. Fetch
  more pages, add `--bart 102` to sample only Berufsausbildung offers, or ask the user.
- One job word often maps to several ids (Pflegefachmann, Pflegeassistent, Altenpflegehelfer
  …). Show the candidates and confirm which the user means, then pass them comma-separated.
- Skip `dkzId` `0`; some offers carry it next to a name, and it is not a usable id.
- If no id turns up, say so and ask. **Don't fall back to `--sw`** — it filters nothing.

## Step 2 — The location trap (read this before any geo search)

The `--orte` value is `Name_lon_lat` — **longitude first, latitude second**. Getting it
backwards silently returns **0 results** (the response has *no* `_embedded` block), which
looks like "nothing nearby" but is really a wrong query.

```bash
# CORRECT — Köln, lon 6.957 then lat 50.938:
ausbildungssuche --compact search --orte "Köln_6.957_50.938" --uk 25 --size 1
#   → thousands of offers in Köln-area towns (check .page.totalElements)

# WRONG — lat first → silently 0 results:
ausbildungssuche --compact search --orte "Köln_50.938_6.957" --uk 25 --size 1   # total 0
```

Rules:
- For German cities, **longitude is the smaller number (~6–15), latitude the larger
  (~47–55).** If you only have one ordering, put the smaller value first.
- Don't invent coordinates wildly. Out-of-range values (longitude beyond ±180, latitude
  beyond ±90) are rejected by the CLI (exit `2`); the server would answer HTTP 500.
- A bare city name or PLZ as `--orte` (no coords) is rejected (exit `2`) — coords are
  mandatory when you scope by place.
- For a nationwide search, skip `--orte` and use `--uk Bundesweit`.

## Step 3 — Fetch and read the envelope

```bash
ausbildungssuche --compact search --ids 9162 --orte "Köln_6.957_50.938" --uk 50 --size 20 --page 0
```

The result is a HAL+JSON envelope:
- `page` → `{ number, size, totalElements, totalPages }`. **`totalElements` caps at
  10000** — a broad query reports `10000` even when more exist, and you cannot page past
  that window. Treat 10000 as "≥10000, narrow your filters".
- **At most 20 offers per page**, and they are **not sorted by distance or date**. To rank
  the whole result, fetch every page (`--page 0` … `totalPages - 1`) when `totalElements`
  is small (an occupation near a place usually is); otherwise narrow first, or say you
  ranked a sample.
- `_embedded.termine[]` → the offers. **Missing entirely when 0 results** — check for it
  before indexing.

Each item in `termine[]` is a *Termin* (a scheduled run) wrapping an *Angebot* (the
offer). Fields that matter for a shortlist:

| Path | Meaning |
|---|---|
| `id` | the offer id → pass to `details <id>` / ausbildung-offer-brief |
| `angebot.titel` | course/offer title |
| `angebot.bildungsanbieter.name` | provider |
| `angebot.bildungsart.bezeichnung` | type (Berufsausbildung / Fortbildung …) |
| `adresse.ortStrasse.name` / `.plz` | venue town & postcode |
| `abstaende[0].abstandInKm` | distance in km from the `--orte` place, computed by the API per venue. Only on place searches (`[]` without `--orte` and on `details`). |
| `adresse.ortStrasse.breitengrad` / `.laengengrad` | lat / lon of the **town centroid**, not the venue: every Leipzig offer has the same pair whatever the street. Don't compute distances from it. |
| `adresse.ortStrasse.land.name` | Bundesland |
| `beginn` / `ende` | **epoch milliseconds** at local midnight — convert in **Europe/Berlin** (`1791928800000` → 2026-10-14; in UTC it reads as the day before). Often `null`. |
| `individuellerEinstieg` | boolean — `true` = rolling enrollment (start anytime) |
| `foerderung` | boolean on the Termin — `true` = funding-eligible (e.g. Bildungsgutschein) |
| `unterrichtsform.bezeichnung` | format (presence / online / blended) |
| `dauer.bezeichnung` | duration band |

## Step 4 — Rank, dedupe, present

The catalogue is full of **near-duplicates** — the same provider lists the identical
course at many towns/dates. So:

1. **Deduplicate** on (`angebot.titel` + `bildungsanbieter.name`), or by `angebot.id` if
   present and stable. Collapse duplicates into one row and note "+N more locations/dates".
2. **Rank** by what the user asked for, in this order:
   - distance from the requested place (`abstaende[0].abstandInKm`) when a place was given;
   - then earliest concrete `beginn` (rolling-entry / `individuellerEinstieg` offers are
     "start anytime" — surface them as such, don't sort them to the bottom);
   - then funding-eligible (`foerderung === true`) if the user cares about cost.
3. **Present** a compact table, lead with the count and the (possibly capped) total:

```
Erzieher/in offers near Köln (≤50 km, dkzId 9162) — showing 8 of 17

  Title                                  Provider                  Town (km)                Start        Funding
  Staatlich anerkannte*r Erzieher*in     IWK Institut für …        Köln (1.7)               2027-08-01   ✓ BG   (+1 location)
  Erzieher/in - Fachschule               St. Ursula Berufskolleg   Düsseldorf (34.2)        2027-08-01   –
  Fachschule für Sozialpädagogik         Bischöfliche …            Mönchengladbach (46.3)   rolling      –
  …
```

Rules:
- Convert `beginn`/`ende` epoch ms to a date **in Europe/Berlin** — e.g.
  `new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" })`, or in jq
  `TZ=Europe/Berlin jq '.beginn / 1000 | strflocaltime("%Y-%m-%d")'`. A plain UTC rendering
  shows the day before. Show "rolling" when `individuellerEinstieg === true` or `beginn` is
  null.
- Show town + Bundesland (and the distance), not raw coordinates. The coordinates are the
  town centroid, so a map link from them points at the town, not the venue; build one
  from `adresse.strasse` + `adresse.ortStrasse.plz`/`.name` instead, and only on request.
- Mark `foerderung === true` offers (Bildungsgutschein / state-funded) — that's decisive
  for many trainees.
- If `_embedded` is absent, say plainly "no offers matched" and suggest widening `--uk`,
  switching to `--uk Bundesweit`, or adding related occupation ids. **First double-check
  the `--orte` order (lon_lat) before declaring nothing nearby** — a backwards location is
  the #1 cause of a false empty result.
- Don't dump the giant `angebot.systematiken[].suchworte` list (a single offer can carry
  150+ synonym strings) — it's noise for a shortlist.
- For full detail on any one row, hand off to `details <id>` / the ausbildung-offer-brief
  skill rather than dumping raw JSON.
