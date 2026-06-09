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

- **Works out of the box** — no account, no API key, no configuration. Install and search.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Just two commands** — `search` and `details`.
- **Nothing to leak** — sends only the public, documented key; no personal credentials involved.

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

No setup needed — the public API key is sent automatically. Your first search:

```bash
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
- **Exit `3` / "rejected"** — the upstream service declined the request. Since the
  public key is sent automatically, this usually means the service is temporarily
  restricting access; retry later. (If you passed your own `--api-key`, check it.)
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
| `--api-key <key>` | Override the built-in public key (env `AUSBILDUNGSSUCHE_API_KEY`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

### Using your own API key (advanced)

You don't need this — the public, documented key is built in and sent
automatically. It's here only if you have your own key or need to point at a
proxy/staging host:

```bash
ausbildungssuche --api-key "$MY_KEY" search --sw Pflege
ausbildungssuche --base-url https://proxy.internal.example search --sw Pflege
```

Precedence is `--api-key` > `AUSBILDUNGSSUCHE_API_KEY` env var > built-in key. If
the API redirects across an origin boundary (different scheme/host/port), the
tool **strips your key** before following, so a private key never leaks to another
host.

## Learn more

- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every flag and domain term explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

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
