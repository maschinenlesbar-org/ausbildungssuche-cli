---
name: ausbildung-finder
description: >
  Find German apprenticeships / vocational-training offers near a place and turn
  the raw catalogue into a ranked, deduplicated shortlist using the
  ausbildungssuche-cli. Trigger when the user asks "Ausbildung als X near
  <city>", "apprenticeships for <job> within 50 km of <place>", "Umschulung /
  Weiterbildung in <region>", "training with a Bildungsgutschein near me", or
  wants vocational offers filtered by location, profession, funding, or start
  date. Handles the location-string and radius traps the bare CLI does not.
version: 1.0.0
userInvocable: true
---

# Ausbildung Finder

Turn a vague "what apprenticeships can I do near <place>?" into a **ranked, deduplicated
shortlist** — provider, town, start date, funding — out of the deeply nested
Bundesagentur für Arbeit catalogue. The whole value here is the location handling, the
de-duplication, and the enrichment the raw `search` JSON does not give you.

## Tooling

This skill drives the `ausbildungssuche` command. **Before anything else, validate it is available** — run `command -v ausbildungssuche` (or `ausbildungssuche --version`). If it is not on your PATH, STOP and inform the user that the `ausbildungssuche` CLI (`@maschinenlesbar.org/ausbildungssuche-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**An API key is required and is NOT bundled.** The upstream service answers `403` (CLI
exit `3`) without it. The key is a static, publicly-documented value — `infosysbub-absuche`
— supply it via the `AUSBILDUNGSSUCHE_API_KEY` env var (preferred) or `--api-key`:

```bash
export AUSBILDUNGSSUCHE_API_KEY=infosysbub-absuche
```

Always pass `--compact` so each result is one line for `jq`.

## Step 1 — Build the search query

Map the request to `search` flags. The fields that matter most:

| Flag | Use | Trap |
|---|---|---|
| `--sw <text>` | free-text keyword (job, e.g. `Mechatroniker`, `Pflege`) | matching is **very fuzzy** — even gibberish returns ~10000 hits. Use a precise job word and lean on location/type filters. |
| `--orte <Name_lon_lat>` | location anchor | **order is `Name_lon_lat` (longitude FIRST), not `Name_lat_lon`** despite what the README/help say (see Step 2). |
| `--uk <radius>` | radius in km, or `Bundesweit` | **only `10`, `25`, `50`, `100`, `Bundesweit` are valid.** `30`, `75`, `150`, `200` return HTTP 400 (exit `1`). |
| `--sty <0..3>` | offer/search type | `0`,`1`,`2`,`3` only — **`4` returns HTTP 400.** `1` narrows hard (e.g. school-based), `3` is small/specialised. |
| `--bart <id>` | training type | filter by `bildungsart.id`: `101` Berufliche Grundqualifikation, `102` Berufsausbildung, `104` Fortbildung/Qualifizierung. |
| `--re <code>` | Bundesland code | use the API's **3-letter `land.code`**, not the common 2-letter abbreviation: `BAW` Baden-Württ., `BAY` Bayern, `BER` Berlin, `BRA` Brandenburg, `HAM` Hamburg, `NDS` Niedersachsen, `NRW`, `RPF` Rheinl.-Pfalz, `SAA` Saarland, `SAC` Sachsen, `SLH` Schl.-Holst., `THÜ` Thüringen. Wrong codes (`BW`, `BY`, `SH`) return **HTTP 400**. |
| `--bg` | only Bildungsgutschein-eligible offers | boolean flag, no value. |
| `--bt <0..2>` | start-date window | start-date code. |
| `--ids <id>` | profession id | precise but brittle — many ids return 0; prefer `--sw` unless you have a confirmed id. |
| `--size <n>` / `--page <n>` | paging | `size` 1..2000; `page` is 0-based. |

## Step 2 — The location trap (read this before any geo search)

The `--orte` value is `Name_lon_lat` — **longitude first, latitude second** — even though
the CLI help and README say `Name_lat_lon`. Getting it backwards silently returns **0
results** (the response has *no* `_embedded` block), which looks like "nothing nearby" but
is really a wrong query.

```bash
# CORRECT — Köln, lon 6.957 then lat 50.938:
ausbildungssuche --compact search --sw Pflege --orte "Köln_6.957_50.938" --uk 25
#   → ~3900 hits in Sankt Augustin, Siegburg, Bonn, Brühl … (real Cologne-area towns)

# WRONG — lat first → silently 0 results:
ausbildungssuche --compact search --sw Pflege --orte "Köln_50.938_6.957" --uk 25   # total 0
```

Rules:
- For German cities, **longitude is the smaller number (~6–15), latitude the larger
  (~47–55).** If you only have one ordering, put the smaller value first.
- Don't invent coordinates wildly. Out-of-range values (e.g. `99_99`) make the server
  return **HTTP 500**, not an empty result.
- A bare city name or PLZ as `--orte` (no coords) returns **HTTP 400** — coords are
  mandatory when you scope by place.
- For a nationwide search, skip `--orte` and use `--uk Bundesweit`.

## Step 3 — Fetch and read the envelope

```bash
ausbildungssuche --compact search --sw Mechatroniker --orte "Köln_6.957_50.938" --uk 50 --size 50
```

The result is a HAL+JSON envelope:
- `page` → `{ number, size, totalElements, totalPages }`. **`totalElements` caps at
  10000** — a broad query reports `10000` even when more exist, and you cannot page past
  that window. Treat 10000 as "≥10000, narrow your filters".
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
| `adresse.ortStrasse.breitengrad` / `.laengengrad` | venue lat / lon (numbers) |
| `adresse.ortStrasse.land.name` | Bundesland |
| `beginn` / `ende` | **epoch milliseconds** (e.g. `1791928800000` → 2026-10-13). Often `null`. |
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
   - distance from the requested place (compute from `breitengrad`/`laengengrad` vs the
     query coords) when a place was given;
   - then earliest concrete `beginn` (rolling-entry / `individuellerEinstieg` offers are
     "start anytime" — surface them as such, don't sort them to the bottom);
   - then funding-eligible (`foerderung === true`) if the user cares about cost.
3. **Present** a compact table, lead with the count and the (possibly capped) total:

```
Apprenticeships near Köln (≤50 km) for "Mechatroniker" — showing 8 of ~9800

  Title                                  Provider              Town          Start        Funding
  Berufsausbildung Mechatroniker         COMCAVE.COLLEGE       Sankt Augustin 2026-10-13   ✓ BG   (+4 locations)
  Vorbereitung IT-Umschulung             IBB                   Papenburg     rolling       –
  …
```

Rules:
- Convert `beginn`/`ende` epoch ms to a date (`new Date(ms)`); show "rolling" when
  `individuellerEinstieg === true` or `beginn` is null.
- Show town + Bundesland, not raw coordinates; offer a map link from
  `breitengrad`/`laengengrad` only on request.
- Mark `foerderung === true` offers (Bildungsgutschein / state-funded) — that's decisive
  for many trainees.
- If `_embedded` is absent, say plainly "no offers matched" and suggest widening `--uk`,
  switching to `--uk Bundesweit`, or loosening `--sw`. **First double-check the `--orte`
  order (lon_lat) before declaring nothing nearby** — a backwards location is the #1 cause
  of a false empty result.
- Don't dump the giant `angebot.systematiken[].suchworte` list (a single offer can carry
  150+ synonym strings) — it's noise for a shortlist.
- For full detail on any one row, hand off to `details <id>` / the ausbildung-offer-brief
  skill rather than dumping raw JSON.
