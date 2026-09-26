# Usage

Use-case-driven examples for `ausbildungssuche-cli`, a command-line client for the
Bundesagentur für Arbeit **Ausbildungssuche** API (the German federal
apprenticeship / vocational-training catalogue). It searches training offers and
fetches the full details of a single offer.

## Install

```bash
npm i -g @maschinenlesbar.org/ausbildungssuche-cli
```

The installed binary is **`ausbildungssuche`**. All examples below use it. No key
is bundled: supply the public, documented `X-API-Key` via `--api-key` or the
`AUSBILDUNGSSUCHE_API_KEY` env var before running (see the API-key section below).
Output is pretty-printed JSON on stdout (`--compact` for a single line), which
makes the examples pipe cleanly into [`jq`](https://jqlang.github.io/jq/).

The two commands are:

```text
ausbildungssuche search   [filters…]   # search offers (HAL+JSON envelope)
ausbildungssuche details  <id>         # full details for one offer
```

## Use cases

### 1. Search apprenticeships for one occupation

Filter by occupation id (`--ids`, *Berufs-id*) — the quickest way in. `9162` is
*Staatlich anerkannter Erzieher*.

```bash
ausbildungssuche search --ids 9162 --size 10
```

The CLI also has a free-text flag (`--sw`, *Suchwort*), but the API currently
ignores it: any keyword returns the same offers as none. Use `--ids` to filter
by occupation (see use case 8).

`search` returns a HAL+JSON envelope: `_embedded` holds the offer objects,
`_links` carries paging links, and `page` carries paging metadata
(`size`, `totalElements`, `totalPages`, `number`). Pull out just the embedded
offers with `jq`:

```bash
ausbildungssuche search --ids 9162 --size 10 | jq '._embedded'
```

### 2. See how many results a search has before fetching them all

Read the `page` block to size up a query without downloading every page.

```bash
ausbildungssuche search --ids 9162 | jq '.page'
```

This prints `{ "size": …, "totalElements": …, "totalPages": …, "number": … }`,
so you know how many pages exist before paging through them.

### 3. Search near a location within a radius

Scope a search to a place (`--orte`, a `Name_lon_lat` location string with the
**longitude first**) and a `--uk` radius in kilometres (`10`, `25`, `50` or
`100`; other values get HTTP 400) — useful when a trainee can only travel so far.
The two only filter together: the API ignores a km radius without a place, and a
place without a radius does not restrict the search at all, so the CLI rejects
either one alone (exit `2`).

```bash
ausbildungssuche search --ids 9162 --orte "Köln_6.957_50.938" --uk 50
```

With the latitude first (`Köln_50.938_6.957`) the API silently returns 0
results. On a place search each offer carries its distance from the place in
`abstaende[].abstandInKm`.

`--uk` accepts the literal `Bundesweit` to search the whole country with no
radius limit — on its own it is the same as leaving `--uk` out, and next to
`--orte` it keeps each offer's distance from the place:

```bash
ausbildungssuche search --ids 9162 --uk Bundesweit
ausbildungssuche search --ids 9162 --orte "Köln_6.957_50.938" --uk Bundesweit
```

### 4. Page through a large result set

Walk results in fixed-size pages with `--page` (0-based) and `--size`. The CLI
accepts `1`..`2000`, but the server returns at most 20 rows per page (it reports
`page.size` 20 for anything larger).

```bash
# first page
ausbildungssuche search --ids 9162 --size 20 --page 0
# next page
ausbildungssuche search --ids 9162 --size 20 --page 1
```

Extract just the ids and self-links from a page to feed a follow-up `details`
call:

```bash
ausbildungssuche search --ids 9162 --size 20 --page 0 \
  | jq '._embedded'
```

### 5. Fetch full details for one offer

After a search, take an offer id (a numeric id, as returned under
`._embedded.termine[].id`) and get its complete record. The `details` endpoint
returns plain JSON (a JSON array of matching records, not the HAL envelope).

```bash
ausbildungssuche details 365241044
```

Pipe to `jq` to inspect or reshape the detail object — the title lives at
`angebot.titel` and the provider at `angebot.bildungsanbieter.name`:

```bash
ausbildungssuche details 365241044 | jq '.[0] | {titel: .angebot.titel, anbieter: .angebot.bildungsanbieter.name}'
```

The id must be non-empty; an empty id is rejected client-side as a validation
error before any request is made.

### 6. Filter to education-voucher–eligible offers

Restrict results to offers eligible for a *Bildungsgutschein* (`--bg`) — a
state-issued voucher that funds an approved training measure.

```bash
ausbildungssuche search --ids 9162 --bg
```

`--bg` is a boolean flag (no value); include it to turn the filter on.

### 7. Filter by region, offer type and start date

Combine the structured filters: `--re` (Bundesland code, e.g. `SLH` for
Schleswig-Holstein), `--sty` (offer type, `0`..`3`), `--bart` (training type,
*Bildungsart*) and `--bt` (start-date code, *Beginntermin*: `0`..`2`).

The `--re` codes are `BAW`, `BAY`, `BER`, `BRA`, `BRE`, `HAM`, `HES`, `MBV`,
`NDS`, `NRW`, `RPF`, `SAA`, `SAC`, `SAN`, `SLH` and `THÜ`; several can be
comma-separated (`--re NRW,BAY`). An offer's code is in
`adresse.ortStrasse.land.code`.

```bash
ausbildungssuche search --re SLH --sty 0 --bt 0
```

```bash
ausbildungssuche search --ids 9162 --bart 102 --re SAC
```

### 8. Search by profession id

Scope by occupation id (`--ids`). The id is the `dkzId` in an offer's
`angebot.systematiken[]`, next to the occupation name (`kurzbezeichnung`), so
you can read it from any search result:

```bash
ausbildungssuche search --re SAC --size 20 \
  | jq -c '[._embedded.termine[].angebot.systematiken[] | {dkzId, kurzbezeichnung}] | unique'
```

Then filter on it; several ids can be comma-separated:

```bash
ausbildungssuche search --ids 9162 --uk Bundesweit
ausbildungssuche search --ids 9162,9106 --uk Bundesweit
```

### 9. Get compact, line-delimited output for scripting

Use `--compact` to emit single-line JSON — handy in pipelines, logs, or when
combined with `jq -c`.

```bash
ausbildungssuche --compact search --ids 9162 --size 5
```

The global option also works after the subcommand (commander hoists it):

```bash
ausbildungssuche search --ids 9162 --size 5 --compact | jq -c '._embedded'
```

### 10. Supply the API key against a custom base URL

No key is bundled: supply the public, documented key (or your own) via `--api-key`
or the `AUSBILDUNGSSUCHE_API_KEY` env var, and/or point at an alternative host with
`--base-url` — e.g. for a proxy or a staging endpoint. Prefer the env var for a
private key (an `--api-key` argument is visible in `ps`/shell history).

```bash
ausbildungssuche --api-key "$MY_KEY" search --ids 9162
```

```bash
AUSBILDUNGSSUCHE_API_KEY="$MY_KEY" ausbildungssuche search --ids 9162
```

```bash
ausbildungssuche --base-url https://proxy.internal.example search --ids 9162
```

Precedence is `--api-key` flag > `AUSBILDUNGSSUCHE_API_KEY` env var > no key. On a
redirect that crosses an origin boundary the client strips credential headers, so
a private key is never forwarded to another host.

## Global options

These apply to every command and may be given before *or* after the subcommand:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `--base-url <url>` | API base URL (default `https://rest.arbeitsagentur.de`) |
| `--api-key <key>` | `X-API-Key` header value (env `AUSBILDUNGSSUCHE_API_KEY`); no key is bundled |
| `--timeout <ms>` | Time limit per request in milliseconds, reading the whole response included (at most `2147483647`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (`0`..`10`); each waits the server's `Retry-After`, up to 30 s |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-h, --help` | Show help for the program or a command |

### `search` filters

| Flag | Meaning |
| --- | --- |
| `--sw <text>` | search keyword (*Suchwort*); currently ignored by the API, use `--ids` |
| `--sty <n>` | offer type `0`..`3` (*Suchtyp*) |
| `--orte <loc>` | location as `Name_lon_lat`, longitude first, e.g. `Köln_6.957_50.938` (*Ort*) |
| `--re <code>` | Bundesland code, e.g. `BAY`, `NRW`, `THÜ` (*Region*) |
| `--uk <radius>` | radius around `--orte`: `10`, `25`, `50`, `100` km, or `Bundesweit` (*Umkreis*); a km radius needs `--orte` |
| `--ids <id>` | occupation id(s), comma-separated (*Berufs-id*, the `dkzId`) |
| `--bart <type>` | training type (*Bildungsart*) |
| `--bg` | only education-voucher–eligible offers (*Bildungsgutschein*) |
| `--bt <code>` | start-date code `0`..`2` (*Beginntermin*) |
| `--page <n>` | 0-based page index |
| `--size <n>` | page size (`1`..`2000`; the server returns at most 20) |

Exit codes: `0` success, `2` usage/argument errors, `3` on `401`/`403`, `4` on
`404`, `5` on `406` (Accept negotiation), `6` on a network/transport failure,
`1` for any other error.
