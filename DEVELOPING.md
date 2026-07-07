# Developing & integrating

This document covers `ausbildungssuche-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`ausbildungssuche`) and a typed API client
(`AusbildungssucheClient`) for the
[Bundesagentur für Arbeit Ausbildungssuche API](https://ausbildungssuche.api.bund.dev/)
(`rest.arbeitsagentur.de/infosysbub/absuche`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed search params and the HAL+JSON envelope.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
ausbildungssuche --help
```

## Library usage

```ts
import { AusbildungssucheClient, AusbildungApiError } from "@maschinenlesbar.org/ausbildungssuche-cli";

// No key is bundled — pass the public, documented X-API-Key (or your own):
const client = new AusbildungssucheClient({ apiKey: "my-key" });

const page = await client.search({ sw: "Informatik", size: 10 });
const offers = (page._embedded ?? {}) as Record<string, unknown>;

// With no apiKey the X-API-Key header is omitted and the API answers 401/403:
const keyless = new AusbildungssucheClient();

try {
  await client.details("does-not-exist");
} catch (err) {
  if (err instanceof AusbildungApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new AusbildungssucheClient({
  apiKey: "the-public-key",       // X-API-Key; no key is bundled (omitted when unset)
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

## Authentication internals

The API requires a static, publicly-documented `X-API-Key` on every request. **No
key is bundled** with this client — supply it via `apiKey` (library), `--api-key`,
or the `AUSBILDUNGSSUCHE_API_KEY` env var. Precedence is **`--api-key` flag > env
var > no key**; an empty/whitespace key is treated as absent (header omitted), and
the API then answers `401`/`403`. The env value is seeded onto the option after
parse (not as a commander default), so it never appears in `--help` output.

Because the key is publicly documented, you can fetch it out-of-band (for CI or
local live testing — never from production) with the bundled script:

```bash
npm run fetch-key                                       # prints the current public key
AUSBILDUNGSSUCHE_API_KEY="$(npm run --silent fetch-key)" ausbildungssuche search --sw Informatik
```

The script scrapes the key from the upstream
[bundesAPI README](https://github.com/bundesAPI/ausbildungssuche-api); it is a
dev/CI tool only and is not part of the published package.

**Accept negotiation.** The search endpoint serves `application/hal+json` and
**responds `406` to a plain `application/json`**, while the details endpoint
serves `application/json` (and `406`s on HAL). The client therefore picks the
`Accept` header per endpoint; this is asserted by the test suite.

**Redirect safety.** When the API issues a redirect that crosses an origin
boundary (a different scheme, host, or port), the client **strips credential
headers** (`X-API-Key`, `Authorization`, `Cookie`) before following it, so your
key — including a private one passed via `--api-key`/env — is never forwarded to
another host. Same-origin redirects keep the key.

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

### Library / technical terms

**API client.** [`AusbildungssucheClient`](src/client/client.ts) — the typed
wrapper over the API. Sends the supplied `X-API-Key` (none is bundled) and exposes
`search()` and `details()`. Usable as a library independently of the CLI.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON and
maps errors. Sits between the client and the transport. `DEFAULT_BASE_URL` is
`https://rest.arbeitsagentur.de`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default (`nodeHttpTransport`) uses Node's
built-in `http`/`https`; tests inject a mock. This is the only HTTP seam.

**Default headers / Accept negotiation.** The engine merges `defaultHeaders` into
every request — the seam that injects `X-API-Key`. The `Accept` header is chosen
per endpoint (`application/hal+json` for search, `application/json` for details)
because each endpoint `406`s on the other media type.

**Cross-origin credential stripping.** When the API issues a redirect that
crosses an origin boundary (different scheme, host, or port), the engine strips
credential headers (`X-API-Key`, `Authorization`, `Cookie`) before following it,
so a private key is never forwarded to another host. Same-origin redirects keep
the key.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically with backoff, up to `--max-retries`. `AusbildungApiError`
exposes `isRetryable` (true for `429`/`503`).

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses.

**RawResponse.** The engine's raw-response shape (`data`/`contentType`/`status`)
— exported for completeness; the offer endpoints return decoded JSON.

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, dates as ISO-8601, and encodes spaces as `%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`) and
an injectable `env` (for `AUSBILDUNGSSUCHE_API_KEY`). Lets the whole CLI run in
tests with a mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `AusbildungApiError`
(non-2xx, carries `status`/`detail`), `AusbildungNetworkError` (transport
failure/timeout), `AusbildungParseError` (bad JSON), `AusbildungValidationError`
(invalid argument, e.g. an empty id — no request made), all extending
`AusbildungError`.

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

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
