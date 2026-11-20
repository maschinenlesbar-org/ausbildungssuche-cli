# ausbildungssuche-mcp

An [MCP](https://modelcontextprotocol.io/) server for the
[Ausbildungssuche](https://ausbildungssuche.api.bund.dev/) of the Bundesagentur für Arbeit (BA),
Germany's catalogue of apprenticeships, vocational training, retraining and further training: a
ranked shortlist of offers near a place or in a Bundesland, the training market for an occupation
by region, training type or funding, any offer as a clean briefing, and the occupation ids the
API filters by, as tools for AI agents. Read-only. The API needs its public key, which the server
finds by itself (see API key). The data is the BA's and not open data (see Licence).

It is the MCP side of [ausbildungssuche-cli](https://github.com/maschinenlesbar-org/ausbildungssuche-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/ausbildungssuche-mcp
```

This installs the **`ausbildungssuche-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/ausbildungssuche-mcp:latest
```

## API key

The API wants an `X-API-Key`: one public value, the same for everyone, published with the API's
community documentation. **No key is bundled.** The server takes it, at the first tool call, from:

1. `AUSBILDUNGSSUCHE_API_KEY` in its environment (what an MCP client's config sets);
2. else the key stored with `ausbildungssuche config set api-key` (the CLI's credentials file,
   `$XDG_CONFIG_HOME/ausbildungssuche/credentials`, else `~/.config/ausbildungssuche/credentials`;
   a file others can read is refused, naming the fix);
3. else it obtains the published key from the
   [bundesAPI/ausbildungssuche-api README](https://github.com/bundesAPI/ausbildungssuche-api), as
   `ausbildungssuche obtain-key` does, so a rotated key needs no new release.

One INFO record on stderr says which, never the key. The key is replaced with `***` in every log
record, result and error. The server takes no key on its command line. A lookup that fails (the
README unreachable) is that call's error, and the next call tries again. In a container without
network access to GitHub, pass the key: `docker run -i --rm -e AUSBILDUNGSSUCHE_API_KEY ghcr.io/…`.

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add ausbildungssuche -- ausbildungssuche-mcp
# or with the image:
claude mcp add ausbildungssuche -- docker run -i --rm ghcr.io/maschinenlesbar-org/ausbildungssuche-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "ausbildungssuche": { "command": "ausbildungssuche-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "ausbildungssuche": { "type": "stdio", "command": "ausbildungssuche-mcp" } } }
```

To set the key yourself, add `"env": { "AUSBILDUNGSSUCHE_API_KEY": "…" }` to the entry (the value
`ausbildungssuche obtain-key` prints).

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
ausbildungssuche-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http ausbildungssuche http://127.0.0.1:3000/mcp
```

The key is public, so HTTP needs no authentication for it. In a container, publish the port on
loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/ausbildungssuche-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/releases) instead of
`latest`: `…/ausbildungssuche-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/ausbildungssuche-mcp:<version> --repo maschinenlesbar-org/ausbildungssuche-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `findTraining` | Offers near a place or in a Bundesland, as a ranked shortlist: an occupation word resolved to its ids first, up to five pages read, the runs of one course at other towns or dates merged, nearest first with a place, else by start (rolling starts count as now). |
| `scanMarket` | The market for an occupation as counts, not offers: one request per Bundesland, training type, offer type or funding cell, optionally the Bildungsgutschein-eligible share and a provider tally; capped counts marked. |
| `getOffer` | One offer as a briefing by its id: content, entry requirements, qualification, dates in Europe/Berlin, format, cost stated honestly, funding options, the venue, the provider and how to apply. |
| `findOccupations` | The occupation ids (dkzId) for a job word, read from a sample of offers in the scope given (a place, Bundesländer, a training type). |
| `searchOffers` | Offers in the API's own order, a slice at a time (offset, limit), with the same filters. |

The tools carry the API's traps so a model doesn't have to: the API ignores its keyword filter
(any word returns the same offers), so an occupation is filtered only by its ids, and a word is
resolved to them from a sample of offers, or asked back when it may mean several occupations; a
place is coordinates with the longitude first, and the other order silently finds nothing, so
coordinates given the other way round for Germany are swapped back and the answer says so; a
place needs a radius of 10, 25, 50 or 100 km; the Bundesländer are the API's 3-letter codes, so
names and the usual 2-letter abbreviations are mapped; a count stops at 10000, so a capped count
is marked and never compared as exact; the API returns 20 offers a page in no useful order and
lists one course once per run, so runs are merged and ranked here; dates are midnights in Germany,
read in Europe/Berlin (in UTC they are the day before); a cost not stated is not free, and 0 EUR
alone is "listed as 0 EUR"; the venue is where the course takes place, not the provider's office.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A failure is a tool error that says what to change;
the gateway's bare 403 (a wrong key, a refused network, now and then a valid key) says what to
check.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--base-url <url>           API host (default https://rest.arbeitsagentur.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP. It listens on loopback by default; it checks the `Host` header
  and, from a browser, the `Origin` (only the origins given with `--allowed-origins`, matched
  exactly) against DNS rebinding and other web pages. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429, and stops a tool call after its deadline. `getOffer` makes
  one request; `findTraining`, `findOccupations` and `searchOffers` one per page of 20 they read
  (at most 10); `scanMarket` one per cell and the total (17 by Bundesland, twice that with
  `withFunding`).
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text (the providers' offers): a model can be told
  things in it. The server can't act on that (it has no tool that writes), but other tools in the
  same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio it ends at once, and when stdin ends.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/blob/main/LICENSING.md)).
Data: the offers are the Bundesagentur für Arbeit's, served live; this is **not open data**. The
BA asserts copyright and grants no general reuse licence; the offers are the training providers'
content, and an offer's contacts are named people (personal data, with GDPR obligations of their
own). Use it for a personal search; don't redistribute the data or use it commercially without the
BA's permission ([terms](https://www.arbeitsagentur.de/en/terms-of-use),
[DATA_LICENSE.md](https://github.com/maschinenlesbar-org/ausbildungssuche-cli/blob/main/DATA_LICENSE.md)).
Every result carries this note in its `licence` field. We provide the tool, not the data: running
the server as a service for others may need the BA's permission.
