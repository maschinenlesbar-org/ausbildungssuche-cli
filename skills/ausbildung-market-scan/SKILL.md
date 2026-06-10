---
name: ausbildung-market-scan
description: >
  Profile the German apprenticeship/training market for a topic by aggregating
  catalogue counts across regions, training types, providers and funding using the
  ausbildungssuche-cli. Trigger when the user asks "how much Pflege training is
  out there?", "which Bundesland has the most apprenticeships for X?", "compare
  the IT training market across regions", "what share is Bildungsgutschein-funded?",
  "who are the biggest providers for <field>?", or wants market-size / availability
  numbers rather than a single offer. Uses the `page.totalElements` count and
  filter sweeps to build a comparison, working around the 10000 result cap.
version: 1.0.0
userInvocable: true
---

# Ausbildung Market Scan

Answer "how big is the training market for X, and where is it?" by sweeping the same
keyword across regions, training types and the funding filter and reading the
**`page.totalElements`** count from each — a quick market profile the single `search`
command never assembles.

## Tooling

This skill drives the `ausbildungssuche` command. **Before anything else, validate it is available** — run `command -v ausbildungssuche` (or `ausbildungssuche --version`). If it is not on your PATH, STOP and inform the user that the `ausbildungssuche` CLI (`@maschinenlesbar.org/ausbildungssuche-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**An API key is required and NOT bundled** (no key → `403`, exit `3`). Static public key
`infosysbub-absuche`:

```bash
export AUSBILDUNGSSUCHE_API_KEY=infosysbub-absuche
```

Always `--compact`.

## The core trick: count, don't download

You don't need the offers — you need the **`page.totalElements`** of each filtered query.
So fetch with `--size 1` (cheapest) and read only the `page` block:

```bash
ausbildungssuche --compact search --sw Pflege --re NRW --size 1 | jq '.page.totalElements'
```

> **The hard cap: `totalElements` maxes out at exactly `10000`.** Any broad query returns
> `10000`, which means "≥10000" — you **cannot** distinguish 10001 from a million, and
> can't page past that window. When a cell reads `10000`, label it `10000+` (capped) and,
> if the comparison needs real resolution, narrow it (add `--re`, `--bart`, tighter `--sw`)
> until counts drop below 10000.

## Step 1 — Fix the dimension to compare

Pick what the user is comparing and sweep one filter while holding the keyword constant:

- **By region** — sweep `--re` over the API's **3-letter `land.code`** values (NOT the
  common 2-letter abbreviation — `BW`/`BY`/`SH` return **HTTP 400**). The 12 valid codes:
  `BAW` Baden-Württ., `BAY` Bayern, `BER` Berlin, `BRA` Brandenburg, `HAM` Hamburg,
  `NDS` Niedersachsen, `NRW`, `RPF` Rheinl.-Pfalz, `SAA` Saarland, `SAC` Sachsen,
  `SLH` Schl.-Holst., `THÜ` Thüringen. Avoid `--orte`/`--uk` for market sizing: those need
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
for re in BER NRW NDS BAY BAW SAC; do
  n=$(ausbildungssuche --compact search --sw Pflege --re "$re" --size 1 | jq '.page.totalElements')
  printf '%s\t%s\n' "$re" "$n"
done
```

For provider concentration in a field, instead pull one larger page and tally
`_embedded.termine[].angebot.bildungsanbieter.name`:

```bash
ausbildungssuche --compact search --sw Pflege --re BER --size 200 \
  | jq -r '._embedded.termine[].angebot.bildungsanbieter.name' | sort | uniq -c | sort -rn
```

> Quirks to respect:
> - The keyword match is **very fuzzy** — even a nonsense `--sw` returns ~10000. So a raw
>   `--sw Pflege` count is inflated by loose matches; for a defensible market number,
>   tighten the keyword and say the figure is an upper bound.
> - A 0-result query has **no `_embedded`** block (only `page`); guard for it.
> - Out-of-range `--orte` coordinates make the server return **HTTP 500** — another reason
>   to size the market with `--re`, not coordinates.

## Step 3 — Build the comparison

Present a ranked table, flagging capped cells, and a one-line read of the market:

```
"Pflege" training availability by Bundesland (offers, capped at 10000+)

  Bundesland          Offers    Bildungsgutschein-eligible
  NRW                 10000+     ~ (capped — narrow to resolve)
  Niedersachsen       10000+
  Sachsen (SAC)        6906
  Berlin (BER)         3663       2726 (≈74%)
  Saarland (SAA)       1271
  …

Read: supply is concentrated in the large western states; Berlin alone has ~3.7k offers,
about three-quarters Bildungsgutschein-eligible.
```

Rules:
- **Always mark `10000` as `10000+` (capped)** and never present it as an exact figure or
  compare two capped cells as if precise. If two top regions both cap, say "both ≥10000,
  not separable at this granularity" and offer to narrow.
- State the keyword fuzziness caveat once: counts are upper bounds on loose matching.
- For a funding share, report eligible vs total (`--bg` count ÷ baseline count) per cell —
  but only where neither side is capped.
- For provider rankings, note they reflect a sample page unless you summed across pages;
  say which.
- Keep it to the counts and a short interpretation — this skill profiles the market, it
  doesn't list offers (hand off to ausbildung-finder for the actual shortlist, or
  ausbildung-offer-brief for one record).
