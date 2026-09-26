# ausbildungssuche-cli

[![CI](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/ausbildungssuche-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/ausbildungssuche-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/ausbildungssuche-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/ausbildungssuche-cli/de/) — command reference, guides and API docs

Search Germany's federal **apprenticeship and vocational-training** catalogue from
your terminal. `ausbildungssuche` is a small command-line tool over the
[Bundesagentur für Arbeit Ausbildungssuche API](https://ausbildungssuche.api.bund.dev/):
find training offers by keyword, location, profession or region, and fetch the
full record for any offer — as clean JSON you can pipe straight into
[`jq`](https://jqlang.github.io/jq/).

- **One key to supply** — pass the public, documented API key with `--api-key` or the `AUSBILDUNGSSUCHE_API_KEY` env var. No key is bundled.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Just two commands** — `search` and `details`.
- **Nothing personal to leak** — the API's documented key is a public value; no personal credentials are involved.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/ausbildungssuche-cli
```

This installs the **`ausbildungssuche`** command. Requires **Node.js 20+**.

Check it works:

```bash
ausbildungssuche --help
```

## Obtain key

The Bundesagentur für Arbeit publishes one static key for public use. It is
**not a secret** — it is the same value for everyone, printed in the upstream
[bundesAPI/ausbildungssuche-api](https://github.com/bundesAPI/ausbildungssuche-api)
README — but finding and copying it shouldn't be your job either. `obtain-key`
reads it from that published source at run time and prints it:

```bash
ausbildungssuche obtain-key        # -> infosysbub-absuche  (provenance note on stderr)
```

**From obtaining the key to having it where it is used, in one line:**

```bash
# this shell only
eval "$(ausbildungssuche obtain-key --export)"

# or keep it for later — appends one `export …` line to your shell profile
ausbildungssuche obtain-key --export >> ~/.zshrc     # ~/.bashrc on bash
```

`--export` prints a single shell-quoted `export AUSBILDUNGSSUCHE_API_KEY='…'`
line on stdout (the "obtained from …" note goes to stderr, so it never lands in
your profile). The plain form composes too:

```bash
export AUSBILDUNGSSUCHE_API_KEY="$(ausbildungssuche obtain-key)"
```

Because the key is fetched rather than compiled in, a rotated key needs no
release of this CLI. If the upstream source is unreachable or stops publishing a
key, `obtain-key` fails loudly with a non-zero exit rather than printing a guess
— it will never invent a value.

## Quickstart

The API needs a key on every request and **none is bundled**; get it with
`obtain-key` (above), then search:

```bash
eval "$(ausbildungssuche obtain-key --export)"
ausbildungssuche search --orte "Köln_6.957_50.938" --uk 25 --size 10
```

`--orte` is the place (*Ort*) as `Name_lon_lat`, longitude first, and `--uk` the
radius (*Umkreis*). The two only filter together, so each needs the other
(`--uk Bundesweit` on its own is fine: it is the nationwide default). The result is a JSON envelope: the offers live under
`_embedded`, paging info under `page`. Pull out just the offers with `jq`:

```bash
ausbildungssuche search --orte "Köln_6.957_50.938" --uk 25 --size 10 | jq '._embedded'
```

To narrow to one occupation, pass its id with `--ids` (see
[Common tasks](#common-tasks)). The keyword flag `--sw` is sent, but the API
currently ignores it.

Take an offer's id from those results and fetch its full record:

```bash
ausbildungssuche details 365241044
```

## Commands

```text
search   [filters…]   search training offers
details  <id>         full details for one offer
```

### `search` filters

| Flag | Meaning |
| --- | --- |
| `--sw <text>` | search keyword (*Suchwort*); currently ignored by the API, use `--ids` |
| `--orte <loc>` | location as `Name_lon_lat`, longitude first, e.g. `Köln_6.957_50.938` (*Ort*); needs `--uk` |
| `--uk <radius>` | radius around `--orte`: `10`, `25`, `50`, `100` km, or `Bundesweit` (*Umkreis*); a km radius needs `--orte` |
| `--re <code>` | Bundesland code, e.g. `BAY`, `NRW`, `THÜ`; comma-separated or repeated for several (*Region*) |
| `--ids <id>` | occupation id(s), comma-separated or repeated (*Berufs-id*, the `dkzId`) |
| `--sty <n>` | offer type `0`..`3` (*Suchtyp*) |
| `--bart <type>` | training type (*Bildungsart*) |
| `--bg` | only education-voucher–eligible offers (*Bildungsgutschein*) |
| `--bt <code>` | start-date code(s): `2` earlier dates, `101`..`112` January..December of the following year; `0`, `1` also accepted (*Beginntermin*) |
| `--page <n>` | 0-based page index |
| `--size <n>` | page size (`1`..`2000`; the server returns at most 20) |

`--ids`, `--re` and `--bt` take several values, comma-separated or by repeating
the flag; repeating any other filter is a usage error (exit `2`) rather than
silently keeping only the last value.

The flag names mirror the API's German abbreviations — the
**[Glossary](GLOSSARY.md)** decodes every one.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Offers near a place, within 50 km (longitude first in --orte)
ausbildungssuche search --orte "Köln_6.957_50.938" --uk 50

# One occupation nationwide, by id (9162 = Staatlich anerkannter Erzieher)
ausbildungssuche search --ids 9162 --uk Bundesweit

# Only offers eligible for an education voucher (Bildungsgutschein)
ausbildungssuche search --ids 9162 --bg

# Page through a large result set (0-based pages, at most 20 rows each)
ausbildungssuche search --ids 9162 --size 20 --page 0
ausbildungssuche search --ids 9162 --size 20 --page 1
```

The occupation id is the `dkzId` in an offer's `angebot.systematiken[]`; read it
from a search result.

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

```bash
# How many results does a query have? Read the page block.
ausbildungssuche search --ids 9162 | jq '.page'

# Reshape a detail record (title + provider)
ausbildungssuche details 365241044 \
  | jq '.[0] | {titel: .angebot.titel, anbieter: .angebot.bildungsanbieter.name}'
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
ausbildungssuche --compact search --ids 9162 --size 5 | jq -c '._embedded'
```

`--compact` (and every global option) works **before or after** the command —
both `ausbildungssuche --compact search …` and `ausbildungssuche search … --compact`
do the same thing.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `2` | bad usage / invalid argument (nothing was sent) |
| `3` | request rejected (`401`/`403`) |
| `4` | offer not found (`404`) |
| `5` | server content-type negotiation failed (`406`) |
| `6` | network/transport failure (DNS, connection, timeout, oversized response) |
| `1` | any other error |

## Troubleshooting

- **`command not found: ausbildungssuche`** — the global npm bin directory isn't on
  your `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/ausbildungssuche-cli …`.
- **Exit `3` / "rejected"** — the upstream service declined the request (401/403).
  Most often no key was supplied, or the key is wrong: run
  `eval "$(ausbildungssuche obtain-key --export)"`, or pass `--api-key`. It can also mean the
  service is temporarily restricting access; retry later.
- **Exit `4` / "not found"** — the offer id doesn't exist. Re-fetch it from a fresh
  `search` result; ids can change as the catalogue updates.
- **Exit `6` / network error** — connectivity, DNS, or a timeout. Try again, or raise
  the limit with `--timeout 60000`.
- **Empty `_embedded`** — the search matched nothing. Check that `--orte` has the
  longitude first (`Name_lon_lat`); the other order silently returns 0 results.
  Otherwise widen `--uk` or drop filters.
- **Every keyword gives the same results** — the API ignores `--sw`. Filter by
  occupation with `--ids`.

## Global options

These apply to every command and may be given before *or* after it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://rest.arbeitsagentur.de`) |
| `--api-key <key>` | `X-API-Key` header value (env `AUSBILDUNGSSUCHE_API_KEY`); no key is bundled |
| `--timeout <ms>` | Time limit per request, reading the whole response included (default `30000`; at most `2147483647`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (`0`..`10`, default `2`); each waits the server's `Retry-After`, up to 30 s |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

### Supplying the API key

No key is bundled. Get the public one with `ausbildungssuche obtain-key` (see
[Obtain key](#obtain-key)), or supply your own via the env var, or override it
per-invocation with `--api-key`. You can also point at a proxy/staging host with
`--base-url`:

```bash
export AUSBILDUNGSSUCHE_API_KEY="$MY_KEY"
ausbildungssuche search --ids 9162

ausbildungssuche --api-key "$MY_KEY" search --ids 9162
ausbildungssuche --base-url https://proxy.internal.example search --ids 9162
```

Prefer the env var for a private key — an `--api-key` argument is visible in the
process table and shell history. Precedence is `--api-key` flag >
`AUSBILDUNGSSUCHE_API_KEY` env var > no key. If the API redirects across an origin
boundary (different scheme/host/port), the tool **strips your key** before
following, so a private key never leaks to another host.

## Learn more

- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills that drive this CLI.
- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every flag and domain term explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is © its provider and licensed **separately from this tool's code**.
See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> [!WARNING]
> **Not open data.** Bundesagentur für Arbeit — full copyright, no reuse license.
> Suitable for personal lookup only; no redistribution or commercial use without
> the BA's permission.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
