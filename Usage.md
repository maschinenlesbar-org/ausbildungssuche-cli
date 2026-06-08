# Usage

Use-case-driven examples for `ausbildungssuche-cli`, a command-line client for the
Bundesagentur für Arbeit **Ausbildungssuche** API (the German federal
apprenticeship / vocational-training catalogue). It searches training offers and
fetches the full details of a single offer.

## Install

```bash
npm i -g @maschinenlesbar.org/ausbildungssuche-cli
```

The installed binary is **`ausbildungssuche`**. All examples below use it. The
public `X-API-Key` is sent automatically, so no credentials are needed to get
started. Output is pretty-printed JSON on stdout (`--compact` for a single line),
which makes the examples pipe cleanly into [`jq`](https://jqlang.github.io/jq/).

The two commands are:

```text
ausbildungssuche search   [filters…]   # search offers (HAL+JSON envelope)
ausbildungssuche details  <id>         # full details for one offer
```

## Use cases

### 1. Search apprenticeships by keyword

Find offers matching a free-text term (`--sw`, *Suchwort*) — the quickest way in.

```bash
ausbildungssuche search --sw Informatik --size 10
```

`search` returns a HAL+JSON envelope: `_embedded` holds the offer objects,
`_links` carries paging links, and `page` carries paging metadata
(`size`, `totalElements`, `totalPages`, `number`). Pull out just the embedded
offers with `jq`:

```bash
ausbildungssuche search --sw Informatik --size 10 | jq '._embedded'
```

### 2. See how many results a search has before fetching them all

Read the `page` block to size up a query without downloading every page.

```bash
ausbildungssuche search --sw Pflege | jq '.page'
```

This prints `{ "size": …, "totalElements": …, "totalPages": …, "number": … }`,
so you know how many pages exist before paging through them.

### 3. Search near a location within a radius

Scope a search to a place (`--orte`, a `Name_lat_lon` location string) and a
`--uk` radius in kilometres (`25`..`200`) — useful when a trainee can only
travel so far.

```bash
ausbildungssuche search --sw Mechatroniker --orte "Köln_50.938_6.957" --uk 50
```

`--uk` accepts the literal `Bundesweit` to search the whole country with no
radius limit:

```bash
ausbildungssuche search --sw Pflege --uk Bundesweit
```

### 4. Page through a large result set

Walk results in fixed-size pages with `--page` (0-based) and `--size` (`1`..`2000`).

```bash
# first page
ausbildungssuche search --sw Kaufmann --size 25 --page 0
# next page
ausbildungssuche search --sw Kaufmann --size 25 --page 1
```

Extract just the ids and self-links from a page to feed a follow-up `details`
call:

```bash
ausbildungssuche search --sw Kaufmann --size 25 --page 0 \
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
ausbildungssuche search --sw Umschulung --bg
```

`--bg` is a boolean flag (no value); include it to turn the filter on.

### 7. Filter by region, offer type and start date

Combine the structured filters: `--re` (region / Bundesland code, e.g. `iD` for
Schleswig-Holstein), `--sty` (offer type, `0`..`4`), `--bart` (training type,
*Bildungsart*) and `--bt` (start-date code, *Beginntermin*: `0`..`2`).

```bash
ausbildungssuche search --sw Industriekaufmann --re iD --sty 0 --bt 0
```

```bash
ausbildungssuche search --sw Erzieher --bart 1 --uk 100
```

### 8. Search by profession id

When you already know the occupation, scope by profession id (`--ids`) instead
of free text for a precise match.

```bash
ausbildungssuche search --ids 7150 --uk Bundesweit
```

### 9. Get compact, line-delimited output for scripting

Use `--compact` to emit single-line JSON — handy in pipelines, logs, or when
combined with `jq -c`.

```bash
ausbildungssuche --compact search --sw Informatik --size 5
```

The global option also works after the subcommand (commander hoists it):

```bash
ausbildungssuche search --sw Informatik --size 5 --compact | jq -c '._embedded'
```

### 10. Use your own API key against a custom base URL

Override the built-in public key (`--api-key`, or the
`AUSBILDUNGSSUCHE_API_KEY` env var) and/or point at an alternative host with
`--base-url` — e.g. for a proxy or a staging endpoint.

```bash
ausbildungssuche --api-key "$MY_KEY" search --sw Pflege
```

```bash
AUSBILDUNGSSUCHE_API_KEY="$MY_KEY" ausbildungssuche search --sw Pflege
```

```bash
ausbildungssuche --base-url https://proxy.internal.example search --sw Pflege
```

Precedence is `--api-key` flag > env var > built-in default key. On a redirect
that crosses an origin boundary the client strips credential headers, so a
private key is never forwarded to another host.

## Global options

These apply to every command and may be given before *or* after the subcommand:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `--base-url <url>` | API base URL (default `https://rest.arbeitsagentur.de`) |
| `--api-key <key>` | Override the `X-API-Key` (env `AUSBILDUNGSSUCHE_API_KEY`) |
| `--timeout <ms>` | Per-request timeout in milliseconds |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-h, --help` | Show help for the program or a command |

### `search` filters

| Flag | Meaning |
| --- | --- |
| `--sw <text>` | search keyword (*Suchwort*) |
| `--sty <n>` | offer type `0`..`4` (*Suchtyp*) |
| `--orte <loc>` | location as `Name_lat_lon`, e.g. `Köln_50.938_6.957` (*Ort*) |
| `--re <code>` | region / Bundesland code, e.g. `iD` (*Region*) |
| `--uk <radius>` | radius: `Bundesweit` or `25`..`200` km (*Umkreis*) |
| `--ids <id>` | profession id(s) (*Berufs-id*) |
| `--bart <type>` | training type (*Bildungsart*) |
| `--bg` | only education-voucher–eligible offers (*Bildungsgutschein*) |
| `--bt <code>` | start-date code `0`..`2` (*Beginntermin*) |
| `--page <n>` | 0-based page index |
| `--size <n>` | page size (`1`..`2000`) |

Exit codes: `0` success, `2` usage/argument errors, `3` on `401`/`403`, `4` on
`404`, `5` on `406` (Accept negotiation), `6` on a network/transport failure,
`1` for any other error.
