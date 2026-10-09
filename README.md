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

- **One key to supply** — pass the public, documented API key with `--api-key` or the `AUSBILDUNGSSUCHE_API_KEY` env var, or store it once with `ausbildungssuche config set api-key`. No key is bundled.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Just three commands** — `obtain-key` to get the public key once (`config` keeps it), then `search` and `details`.
- **Nothing personal to leak** — the API's documented key is a public value; no personal credentials are involved.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/blob/main/DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/ausbildungssuche-cli
```

This installs the **`ausbildungssuche`** command. Requires **Node.js 22.12+**.

Check it works:

```bash
ausbildungssuche --help
```

## Obtain key

One static key works for everyone. It is **not a secret** — it is the same value
for everyone, documented by the community project
[bundesAPI/ausbildungssuche-api](https://github.com/bundesAPI/ausbildungssuche-api)
in its README (not by the Bundesagentur für Arbeit itself) — but finding and copying
it shouldn't be your job either. `obtain-key`
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

**Or store it once**, in a credentials file of its own (the same mechanism as
[openka-cli](https://github.com/maschinenlesbar-org/openka-cli)'s `ka config`):

```bash
ausbildungssuche obtain-key | ausbildungssuche config set api-key   # the published key, piped in
ausbildungssuche config set api-key                 # or typed at a prompt, without echo
ausbildungssuche config get api-key                 # masked: **** (abcd…wxyz from 20 characters; --reveal prints it whole)
ausbildungssuche config list                        # what is stored, and where
ausbildungssuche config unset api-key
```

The value is never taken from the command line, so it reaches neither shell history
nor `ps`. The file is `$XDG_CONFIG_HOME/ausbildungssuche/credentials` (else
`~/.config/ausbildungssuche/credentials`): mode 0600 in a directory of mode 0700,
replaced atomically by one writer at a time (`credentials.lock` beside it), and not read at all while anyone else could read it. It is
consulted only when neither `--api-key` nor `AUSBILDUNGSSUCHE_API_KEY` gives a key.

Because the key is fetched rather than compiled in, a rotated key needs no
release of this CLI. If the upstream source is unreachable, stops publishing a
key, states a value that is not shaped like the published key (a placeholder such
as `YOUR-API-KEY`, trailing punctuation, control characters) or two different keys,
`obtain-key` fails loudly with a non-zero exit rather than printing a guess — it
will never invent a value. After a redirect, the note on stderr names the document
the key was actually read from. The global `--timeout`, `--user-agent`,
`--max-retries` and `--max-response-bytes` apply to it as to every request (a
`429`/`503` or a reset connection is retried, a redirect followed); `--base-url` and `--api-key` do not.

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
obtain-key [--export]  print the public API key (see Obtain key)
config     set|get|unset|list api-key  keep the API key in a credentials file
search     [filters…]  search training offers
details    <id>        full details for one offer
```

### `search` filters

| Flag | Meaning |
| --- | --- |
| `--sw <text>` | search keyword (*Suchwort*); currently ignored by the API, use `--ids` |
| `--orte <loc>` | location as `Name_lon_lat`, longitude first, e.g. `Köln_6.957_50.938`, or several places comma-separated, searched together (*Ort*); needs `--uk` |
| `--uk <radius>` | radius around `--orte`: `10`, `25`, `50`, `100` km, or `Bundesweit` (*Umkreis*); a km radius needs `--orte` |
| `--re <code>` | Bundesland code, e.g. `BAY`, `NRW`, `THÜ`; comma-separated or repeated for several (*Region*) |
| `--ids <id>` | numeric occupation id(s), comma-separated or repeated (*Berufs-id*, the `dkzId`); a non-numeric id or a trailing comma is a usage error (exit `2`) |
| `--sty <n>` | offer type `0`..`3` (*Suchtyp*) |
| `--bart <type>` | numeric training type, the `bildungsart.id`, e.g. `102` Berufsausbildung (*Bildungsart*); anything else is a usage error (exit `2`) |
| `--bg` | only education-voucher–eligible offers (*Bildungsgutschein*) |
| `--bt <code>` | start-date code(s): `2` earlier dates, `101`..`112` January..December of the following year; `0` and `1` are accepted and filter too (each keeps about half of the offers; their meaning is undocumented) (*Beginntermin*) |
| `--page <n>` | 0-based page index |
| `--size <n>` | page size, `1`..`20` (the server serves at most 20 rows per page) |

`--ids`, `--re` and `--bt` take several values, comma-separated or by repeating
the flag; repeating any other filter, or a global option (`--api-key`, `--base-url`,
`--timeout`, …), is a usage error (exit `2`) rather than silently keeping only the
last value. When a search with `--ids` or `--bart` finds nothing, a note on stderr
says so: the API answers an id or training type it doesn't know with an empty
result, not an error.

The flag names mirror the API's German abbreviations — the
**[Glossary](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/blob/main/GLOSSARY.md)** decodes every one.

## Common tasks

A few recipes to get going — see **[Usage.md](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/blob/main/Usage.md)** for the full,
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

Each line on stderr is a **log record**: a timestamp (UTC), a level (`ERROR`, `WARN`,
`INFO`) and a topic, the program and the area it comes from (`ausbildungssuche.cli` for usage
errors, `ausbildungssuche.api` for the API's answers (a malformed one included) and the hints after them, `ausbildungssuche.http` for
the connection, `ausbildungssuche.config`, `ausbildungssuche.obtain-key`, `ausbildungssuche.output`
for a failed write to stdout). By default it is written log4j
style; `--log-format jsonl` writes one JSON object per line instead. A record is always
one line: a line break, a control character or a bidi control in a message (a server's
text, a value you typed) is written as an escape (`\n`, `\u001b`, `\u202e`), so it can
neither split a record nor forge another one, nor steer the terminal; a message longer
than 4000 characters is cut and ends in `… (N more characters)`:

```text
2026-10-09T14:03:12.481Z WARN  [ausbildungssuche.http] requests to mirror.example are sent unencrypted (http:, not https:)
2026-10-09T14:03:12.902Z ERROR [ausbildungssuche.api] HTTP 404 for GET https://rest.arbeitsagentur.de/infosysbub/absuche/pc/v1/ausbildungsangebot/1
```

```bash
ausbildungssuche --log-format jsonl details 1 2>log.jsonl   # {"ts":"…","level":"ERROR","topic":"ausbildungssuche.api","msg":"HTTP 404 …"}
```

```bash
# How many results does a query have? Read the page block. totalElements is capped
# at 10000: a reading of exactly 10000 means "10000 or more".
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
| `3` | request rejected (`401`/`403`); a `401`/`403` after a redirect to another origin, which never received the key, is `1` and the message names the redirect |
| `4` | offer not found (`404`) |
| `5` | server content-type negotiation failed (`406`) |
| `6` | network/transport failure (DNS, connection, timeout, oversized response) |
| `1` | any other error (also a `200` answer that is not the documented search envelope or offer array) |

A reader that stops early (`… | head`) ends the run quietly with exit `0`; a failed run
keeps its own code even when its stderr's reader has gone (`2>&1 | head -c 5`).

## Troubleshooting

- **`command not found: ausbildungssuche`** — the global npm bin directory isn't on
  your `PATH`. Run `npm prefix -g` and add its `bin/` subdirectory (on Windows, the
  directory itself), or run via
  `npx @maschinenlesbar.org/ausbildungssuche-cli …`.
- **Exit `3` / "rejected"** — the upstream service declined the request (401/403).
  Most often no key was supplied, or the key is wrong: run
  `eval "$(ausbildungssuche obtain-key --export)"`, or pass `--api-key`. It can also mean the
  service is temporarily restricting access; retry later. When no key was set at all,
  the hint on stderr says so and points at `obtain-key`.
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

These apply to every command and may be given before *or* after it, once each:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--log-format <format>` | How errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [ausbildungssuche.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `--base-url <url>` | API base URL (default `https://rest.arbeitsagentur.de`). A `user:password@` part is sent but shown as `***@` in everything the CLI prints, usage errors included; write a literal `%` in it as `%25` (an unescaped `%` is a usage error, exit `2`) |
| `--api-key <key>` | `X-API-Key` header value (env `AUSBILDUNGSSUCHE_API_KEY`); no key is bundled. A rejected key is never repeated in the error, and a key typed without `--api-key` (as a command or an extra argument) is not echoed either |
| `--timeout <ms>` | Time limit per request, reading the whole response included (default `30000`; at most `2147483647`; `0` = no limit, so a hanging server blocks forever) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections (`0`..`10`, default `2`); each waits at least the linear backoff, longer when the server's `Retry-After` asks (up to 30 s; a longer one is not retried, and the error names the requested wait). Each retry logs one WARN record of `ausbildungssuche.http` before it waits (`HTTP 503 from host: retry 1 of 3 in 2 s`). |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

### Supplying the API key

No key is bundled. Get the public one with `ausbildungssuche obtain-key` (see
[Obtain key](#obtain-key)), or supply your own via the env var, or override it
per-invocation with `--api-key`, or store it once with `ausbildungssuche config set
api-key` (see [Obtain key](#obtain-key)). You can also point at a proxy/staging host with
`--base-url`:

```bash
export AUSBILDUNGSSUCHE_API_KEY="$MY_KEY"
ausbildungssuche search --ids 9162

ausbildungssuche --api-key "$MY_KEY" search --ids 9162
ausbildungssuche --base-url https://proxy.internal.example search --ids 9162
```

Prefer the env var for a private key — an `--api-key` argument is visible in the
process table and shell history. Precedence is `--api-key` flag >
`AUSBILDUNGSSUCHE_API_KEY` env var > the credentials file > no key. If the API redirects across an origin
boundary (different scheme/host/port), the tool **strips your key** before
following, so a private key never leaks to another host.

A base URL on plain `http:` to a host other than loopback (`localhost`, `127.0.0.0/8`,
`::1`) works, but the CLI writes one warning record to stderr before the first request, naming the
host and what travels unencrypted without printing it, e.g.
`… WARN  [ausbildungssuche.http] the API key is sent unencrypted to proxy.internal.example (http:, not https:)`
(or `requests to … are sent unencrypted` with no key, or `the base URL's credentials` for a
`user:password@` part). stdout and the exit code are unchanged.

## Learn more

- **[SKILLS.md](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/blob/main/SKILLS.md)** — Claude Code Agent Skills that drive this CLI.
- **[Usage.md](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/blob/main/Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/blob/main/GLOSSARY.md)** — every flag and domain term explained.
- **[DEVELOPING.md](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/blob/main/DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

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
