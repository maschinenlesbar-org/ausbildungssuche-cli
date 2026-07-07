# ausbildungssuche-cli

[![CI](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/ausbildungssuche-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/ausbildungssuche-cli)

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

## Quickstart

Supply the public, documented API key (no key is bundled) — pass `--api-key` or
set the `AUSBILDUNGSSUCHE_API_KEY` env var. Your first search:

```bash
export AUSBILDUNGSSUCHE_API_KEY=<the public key>
ausbildungssuche search --sw Informatik --size 10
```

`--sw` is the search keyword (*Suchwort*). The result is a JSON envelope: the
offers live under `_embedded`, paging info under `page`. Pull out just the
offers with `jq`:

```bash
ausbildungssuche search --sw Informatik --size 10 | jq '._embedded'
```

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
| `--sw <text>` | search keyword (*Suchwort*) |
| `--orte <loc>` | location as `Name_lat_lon`, e.g. `Köln_50.938_6.957` (*Ort*) |
| `--uk <radius>` | radius: `Bundesweit` or `25`..`200` km (*Umkreis*) |
| `--re <code>` | region / Bundesland code, e.g. `iD` (*Region*) |
| `--ids <id>` | profession id(s) (*Berufs-id*) |
| `--sty <n>` | offer type `0`..`4` (*Suchtyp*) |
| `--bart <type>` | training type (*Bildungsart*) |
| `--bg` | only education-voucher–eligible offers (*Bildungsgutschein*) |
| `--bt <code>` | start-date code `0`..`2` (*Beginntermin*) |
| `--page <n>` | 0-based page index |
| `--size <n>` | page size (`1`..`2000`) |

The flag names mirror the API's German abbreviations — the
**[Glossary](GLOSSARY.md)** decodes every one.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Apprenticeships near a place, within 50 km
ausbildungssuche search --sw Mechatroniker --orte "Köln_50.938_6.957" --uk 50

# Search the whole country (no radius limit)
ausbildungssuche search --sw Pflege --uk Bundesweit

# Only offers eligible for an education voucher (Bildungsgutschein)
ausbildungssuche search --sw Umschulung --bg

# Page through a large result set (0-based pages)
ausbildungssuche search --sw Kaufmann --size 25 --page 0
ausbildungssuche search --sw Kaufmann --size 25 --page 1

# Search by profession id instead of free text
ausbildungssuche search --ids 7150 --uk Bundesweit
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

```bash
# How many results does a query have? Read the page block.
ausbildungssuche search --sw Pflege | jq '.page'

# Reshape a detail record (title + provider)
ausbildungssuche details 365241044 \
  | jq '.[0] | {titel: .angebot.titel, anbieter: .angebot.bildungsanbieter.name}'
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
ausbildungssuche --compact search --sw Informatik --size 5 | jq -c '._embedded'
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
  Most often no key was supplied, or the key is wrong: pass `--api-key` or set
  `AUSBILDUNGSSUCHE_API_KEY` to the public, documented key. It can also mean the
  service is temporarily restricting access; retry later.
- **Exit `4` / "not found"** — the offer id doesn't exist. Re-fetch it from a fresh
  `search` result; ids can change as the catalogue updates.
- **Exit `6` / network error** — connectivity, DNS, or a timeout. Try again, or raise
  the limit with `--timeout 60000`.
- **Empty `_embedded`** — the search simply matched nothing; broaden the keyword,
  widen `--uk`, or drop filters.

## Global options

These apply to every command and may be given before *or* after it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://rest.arbeitsagentur.de`) |
| `--api-key <key>` | `X-API-Key` header value (env `AUSBILDUNGSSUCHE_API_KEY`); no key is bundled |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

### Supplying the API key

No key is bundled. Supply the public, documented key (or your own) via the env
var, or override it per-invocation with `--api-key`. You can also point at a
proxy/staging host with `--base-url`:

```bash
export AUSBILDUNGSSUCHE_API_KEY="$MY_KEY"
ausbildungssuche search --sw Pflege

ausbildungssuche --api-key "$MY_KEY" search --sw Pflege
ausbildungssuche --base-url https://proxy.internal.example search --sw Pflege
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
