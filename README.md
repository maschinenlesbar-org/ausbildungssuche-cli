# ausbildungssuche-cli

A TypeScript **API client** and **command-line interface** for the
[Bundesagentur für Arbeit Ausbildungssuche API](https://ausbildungssuche.api.bund.dev/)
(`rest.arbeitsagentur.de/infosysbub/absuche`) — the federal **apprenticeship /
vocational-training** catalogue: search offers and fetch details.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed search params and the HAL+JSON envelope.
- **Auth handled** — sends the static, publicly-documented `X-API-Key` automatically; override with `--api-key`.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.

## Authentication

The API requires a static, publicly-documented `X-API-Key`
(`infosysbub-absuche`). This client sends it **by default**. Override it with
`--api-key`, the `AUSBILDUNGSSUCHE_API_KEY` env var, or the `apiKey` client
option. Precedence is **`--api-key` flag > env var > built-in default key**.

The client also overrides the `Accept` header to `application/hal+json`: the
service serves HAL+JSON and **responds `406` to a plain `application/json`**, so
this override is required (and is asserted by the test suite).

**Redirect safety:** when the API issues a redirect that crosses an origin
boundary (a different scheme, host, or port), the client **strips credential
headers** (`X-API-Key`, `Authorization`, `Cookie`) before following it, so your
key — including a private one passed via `--api-key`/env — is never forwarded to
another host. Same-origin redirects keep the key.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
ausbildungssuche --help
```

---

## CLI usage

Every command prints pretty JSON to stdout (`--compact` for a single line). The
search returns a HAL+JSON envelope (`_embedded` / `_links` / `page`).

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://rest.arbeitsagentur.de`) |
| `--api-key <key>` | override the `X-API-Key` (env `AUSBILDUNGSSUCHE_API_KEY`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |

Global options may be given **before** the command (e.g.
`ausbildungssuche --compact search --sw Informatik`) and, thanks to commander's
global-option hoisting, also **after** it (e.g.
`ausbildungssuche search --sw Informatik --compact`). Both take effect.

### Commands

```text
search [--sw <kw>] [--sty <n>] [--orte <id>] [--re <code>] [--uk <radius>]
       [--ids <id>] [--bart <type>] [--bg] [--bt <date>] [--page <n>] [--size <n>]
details <id>     full details for one apprenticeship offer
```

### Examples

```bash
# IT apprenticeships
ausbildungssuche search --sw Informatik --size 10

# Within a region, nationwide radius
ausbildungssuche search --sw Pflege --uk Bundesweit

# Details for one offer (id from a search result's _embedded entries)
ausbildungssuche details <id>
```

Exit codes: `0` success, `2` for usage / argument-validation errors, `3` on a
`401`/`403` (rejected request — often the API key), `4` on a `404`, `5` on a
`406` (Accept negotiation failed), `6` on a network / transport failure (DNS,
connection, timeout, response-size cap), `1` for any other error.
`--help`/`--version` return `0`.

---

## Library usage

```ts
import { AusbildungssucheClient, AusbildungApiError } from "ausbildungssuche-cli";

const client = new AusbildungssucheClient(); // sends the public X-API-Key by default

const page = await client.search({ sw: "Informatik", size: 10 });
const offers = (page._embedded ?? {}) as Record<string, unknown>;

// Override the key if you have your own:
const custom = new AusbildungssucheClient({ apiKey: "my-key" });

try {
  await client.details("does-not-exist");
} catch (err) {
  if (err instanceof AusbildungApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new AusbildungssucheClient({
  apiKey: "infosysbub-absuche",   // X-API-Key (defaults to the public key)
  baseUrl: "https://rest.arbeitsagentur.de",
  timeoutMs: 15_000,
  maxRetries: 3,
  maxResponseBytes: 50 << 20,
  userAgent: "my-app/1.0",
  transport: customTransport,
});
```

### Methods

`client.search(params)` and `client.details(id)`.

---

## Architecture

```
src/
  client/
    types.ts     # AusbildungSearchResult (HAL) + search params
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, default headers (auth), decoding, errors
    errors.ts    # AusbildungError / AusbildungApiError / AusbildungNetworkError / AusbildungParseError
    client.ts    # AusbildungssucheClient — search + details over the engine (injects X-API-Key)
  cli/
    io.ts        # injectable I/O seam (stdout/stderr) + injectable env (for AUSBILDUNGSSUCHE_API_KEY)
    shared.ts    # option parsers, global-option resolver (incl. --api-key), JSON renderer
    commands/    # search / details
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The engine accepts `defaultHeaders` merged into every request — the seam used to inject the `X-API-Key`.
  The CLI surfaces it as `--api-key` (or the `AUSBILDUNGSSUCHE_API_KEY` env var, read through the injectable `deps.env`).
- On a cross-origin redirect the engine strips credential headers (`X-API-Key`/`Authorization`/`Cookie`) so the key never leaks to another host.
- The HTTP layer is a single `Transport` function; the default uses `node:http`/`node:https` and tests inject a mock.
- The CLI is built around injectable `CliDeps`, so the whole program can be driven in-process by tests.

---

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirect following + `maxRedirects`, cross-origin credential stripping, network-error propagation, `maxResponseBytes=0` — mocked transport.
- **`client.test.ts`** — the X-API-Key header, the `Accept: application/hal+json` override, search params and the details path — mocked transport.
- **`cli.test.ts`** — command parsing, `--api-key` override, env-var precedence, 401/403/404/406 exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

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
