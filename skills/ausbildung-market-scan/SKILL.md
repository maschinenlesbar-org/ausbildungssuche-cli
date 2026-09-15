---
name: ausbildung-market-scan
description: >
  Profile the German apprenticeship/training market for an occupation by aggregating
  catalogue counts across regions, training types, providers and funding using the
  ausbildungssuche-cli. Trigger when the user asks "how much Pflege training is
  out there?", "which Bundesland has the most apprenticeships for X?", "compare
  the IT training market across regions", "what share is Bildungsgutschein-funded?",
  "who are the biggest providers for a field?", or wants market-size / availability
  numbers rather than a single offer. Uses the `page.totalElements` count and
  filter sweeps to build a comparison, working around the 10000 result cap.
version: 1.0.0
userInvocable: true
---

# Ausbildung Market Scan

Answer "how big is the training market for X, and where is it?" by sweeping the same
occupation filter (`--ids`) across regions, training types and the funding filter and
reading the **`page.totalElements`** count from each — a quick market profile the single
`search` command never assembles.

## Tooling

This skill drives the `ausbildungssuche` command. **Before anything else, validate it is available** — run `command -v ausbildungssuche` (or `ausbildungssuche --version`). If it is not on your PATH, STOP and inform the user that the `ausbildungssuche` CLI (`@maschinenlesbar.org/ausbildungssuche-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**An API key is required and NOT bundled** (no key → `403`, exit `3`). Static public key
`infosysbub-absuche`:

```bash
export AUSBILDUNGSSUCHE_API_KEY=infosysbub-absuche
```

Always `--compact`.

## Step 0 — Pin the occupation to ids, never a keyword

**The API ignores `--sw`.** `--sw Pflege`, `--sw Qwxzy` and no `--sw` return the same count,
so a per-keyword sweep only measures the whole catalogue per region. The occupation filter
that works is `--ids`, the `dkzId` from `angebot.systematiken[]`.

The CLI has no occupation lookup, so read the ids from a sample of offers (a large Land and
`--bart 102` Berufsausbildung give a broad sample) and match the job word:

```bash
for p in 0 1 2 3 4; do
  ausbildungssuche --compact search --re NRW --bart 102 --size 20 --page "$p"
done | jq -s -c '[.[]._embedded.termine[]?.angebot.systematiken[]?
    | select(.dkzId != 0 and ((.kurzbezeichnung // "") | test("pflege"; "i")))
    | {dkzId, kurzbezeichnung}] | unique'
```

A word like "Pflege" matches several occupations (Pflegefachmann `132173`, Pflegeassistent
`135349`, Altenpflegehelfer `9063`, and also Kinderpfleger `9170`). Confirm the set with the
user, pass it comma-separated (`--ids 132173,135349`), and name the ids in the result. The
sample only shows occupations present in the pages fetched; if the one you need is missing,
fetch more pages or ask the user for the id.

## The core trick: count, don't download

You don't need the offers — you need the **`page.totalElements`** of each filtered query.
So fetch with `--size 1` (cheapest) and read only the `page` block:

```bash
ausbildungssuche --compact search --ids 132173 --re NRW --size 1 | jq '.page.totalElements'
```

> **The hard cap: `totalElements` maxes out at exactly `10000`.** Any broad query returns
> `10000`, which means "≥10000" — you **cannot** distinguish 10001 from a million, and
> can't page past that window. When a cell reads `10000`, label it `10000+` (capped) and,
> if the comparison needs real resolution, narrow it (add `--re`, `--bart`, fewer ids)
> until counts drop below 10000.

## Step 1 — Fix the dimension to compare

Pick what the user is comparing and sweep one filter while holding the occupation ids constant:

- **By region** — sweep `--re` over the API's **3-letter `land.code`** values (NOT the
  common 2-letter abbreviation — `BW`/`BY`/`SH` return **HTTP 400**). The 16 codes:
  `BAW` Baden-Württ., `BAY` Bayern, `BER` Berlin, `BRA` Brandenburg, `BRE` Bremen,
  `HAM` Hamburg, `HES` Hessen, `MBV` Mecklenb.-Vorp., `NDS` Niedersachsen, `NRW`,
  `RPF` Rheinl.-Pfalz, `SAA` Saarland, `SAC` Sachsen, `SAN` Sachsen-Anhalt,
  `SLH` Schl.-Holst., `THÜ` Thüringen. The per-Land counts need not add up to the
  unfiltered total (some offers match no Land code), so report the national figure from a
  run without `--re`. Avoid `--orte`/`--uk` for market sizing: those need
  the `Name_lon_lat` coord string (longitude first — see ausbildung-finder) and radii are
  limited to `10/25/50/100/Bundesweit`. `--re` is the clean per-state axis.
- **By training type** — sweep `--bart`: `101` Berufliche Grundqualifikation, `102`
  Berufsausbildung, `104` Fortbildung/Qualifizierung.
- **By offer type** — sweep `--sty` over `0,1,2,3` (**`4` returns HTTP 400 — skip it**).
- **By funding** — run the query with and without `--bg` to get the
  Bildungsgutschein-eligible share.

## Step 2 — Sweep and collect counts

Loop the chosen dimension, reading `page.totalElements` each time. Example (regions):

```bash
IDS=132173
for re in BAW BAY BER BRA BRE HAM HES MBV NDS NRW RPF SAA SAC SAN SLH THÜ; do
  n=$(ausbildungssuche --compact search --ids "$IDS" --re "$re" --size 1 | jq '.page.totalElements')
  printf '%s\t%s\n' "$re" "$n"
done
```

For provider concentration in a field, tally
`_embedded.termine[].angebot.bildungsanbieter.name` across pages. **The server returns at
most 20 offers per page** (a larger `--size` still comes back as 20), so one page is a
20-offer sample. Page through a small set:

```bash
IDS=132173 RE=BER
n=$(ausbildungssuche --compact search --ids "$IDS" --re "$RE" --size 1 | jq '.page.totalElements')
p=0
while [ $((p * 20)) -lt "$n" ]; do
  ausbildungssuche --compact search --ids "$IDS" --re "$RE" --size 20 --page "$p"
  p=$((p + 1))
done | jq -r '._embedded.termine[]?.angebot.bildungsanbieter.name' | sort | uniq -c | sort -rn
```

That is one request per 20 offers; for a few hundred, narrow first or tally a sample and
say so.

> Quirks to respect:
> - `--sw` is **ignored** — a keyword count is the whole catalogue for that filter. Only
>   `--ids` narrows by occupation.
> - A 0-result query has **no `_embedded`** block (only `page`); guard for it.
> - Out-of-range `--orte` coordinates make the server return **HTTP 500** — another reason
>   to size the market with `--re`, not coordinates.

## Step 3 — Build the comparison

Present a ranked table, flagging capped cells, and a one-line read of the market:

```
Pflegefachmann/-frau (dkzId 132173) offers by Bundesland — example run, 2026-09-15

  Bundesland               Offers    Bildungsgutschein-eligible
  Nordrhein-Westfalen        169       104 (≈62%)
  Bayern (BAY)               103        79 (≈77%)
  Baden-Württemberg (BAW)    103        46 (≈45%)
  Hessen (HES)                58        31 (≈53%)
  …
  Germany (no --re)          656

Read: supply is concentrated in the large western states; NRW alone lists about a quarter
of all offers.
```

Rules:
- **Always mark `10000` as `10000+` (capped)** and never present it as an exact figure or
  compare two capped cells as if precise. If two top regions both cap, say "both ≥10000,
  not separable at this granularity" and offer to narrow.
- Name the occupation ids the counts cover, and say that the id set came from a sample.
- For a funding share, report eligible vs total (`--bg` count ÷ baseline count) per cell —
  but only where neither side is capped.
- For provider rankings, note they reflect a sample (20 offers per page) unless you paged
  through the whole set; say which.
- Keep it to the counts and a short interpretation — this skill profiles the market, it
  doesn't list offers (hand off to ausbildung-finder for the actual shortlist, or
  ausbildung-offer-brief for one record).
