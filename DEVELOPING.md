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

// Filter by occupation id (`ids`, the dkzId); the API ignores the keyword `sw`.
const page = await client.search({ ids: "9162", size: 10 });
const offers = (page._embedded ?? {}) as Record<string, unknown>;

// With no apiKey the X-API-Key header is omitted and the API answers 401/403:
const keyless = new AusbildungssucheClient();

try {
  await client.details("1");             // offer ids are numeric
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

A custom transport passes `redirect` and `signal` on and reports the URL that
answered, so the engine can follow redirects and keep the key on its origin
(see "Transports must not follow redirects" below):

```ts
const customTransport: Transport = async (req) => {
  const r = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    redirect: req.redirect, // "manual": the engine follows redirects itself
    signal: req.signal,     // aborted at timeoutMs
  });
  // The engine reads a Headers object and a Uint8Array body as they come.
  const body = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, body, url: r.url } as unknown as HttpResponse;
};
```

### Methods

`client.search(params)` and `client.details(id)`. `search()` resolves with the HAL
envelope (`page`, and `_embedded.termine` when there are hits); `details()` with a
JSON **array** of offer records (`AusbildungDetails`, one record for one id — read
`[0]`).

A 2xx answer without that shape is an `AusbildungParseError` (`Unexpected response
from <path>: …`, CLI exit `1`), never data: `searchResultProblem` requires an object
with a `page` whose `totalElements` is a non-negative integer and, if present,
`_embedded.termine` as an array of objects; `detailsProblem` a non-empty array of
objects with an `id`. A proxy, captive portal or mirror answering `null`, `{}`, `[]`
or `{"error": "rate limited"}` with HTTP 200 would otherwise read as "0 offers".

### What the library rejects

Both methods check their input before any request and reject with an
`AusbildungValidationError` (`Invalid <name>: <reason>`); the CLI applies the same
rules (exit `2`). The checks are exported from the package root, so a caller can
run them up front.

- **Blank search filters.** `search()` rejects any string parameter (`sw`, `ids`,
  `orte`, `re`, `uk`, `bart`, `bt`) that is empty or only whitespace
  (`validateSearchParams`, `nonEmptyProblem`): the API treats an empty parameter as
  no filter and would answer with the unfiltered set. Leave a filter out
  (`undefined`) to not filter by it.
- **Values outside the API's closed value sets.** `sty` must be an integer
  `STY_MIN`..`STY_MAX` (0..3), `re` one or more comma-separated `REGION_CODES`
  (uppercase, as listed), `uk` one of `RADII`, `bt` one or more comma-separated
  `START_CODES` (0, 1, 2, 101..112), and `orte` must be `Name_lon_lat` with the
  coordinates in range (`styProblem`, `regionsProblem`, `radiusProblem`,
  `startCodesProblem`, `placeProblem`). The API answers these with a bare HTTP
  400/500.
- **`orte` or a km `uk` alone.** A kilometre radius without a place is ignored by
  the API, and a place without a radius does not narrow the search; either alone
  would return the nationwide set, so `search()` rejects it
  (`placeAndRadiusProblem`). `uk: "Bundesweit"` alone stays allowed.
- **Canonical forms first.** Before these checks `search()` puts `re` and `uk` into
  the form the API accepts (`normalizeSearchParams`): each `re` code is trimmed,
  NFC-normalised and uppercased (`normalizeRegions`, `" bay, nrw"` → `BAY,NRW`),
  and `bundesweit` in any case becomes `Bundesweit` (`normalizeRadius`). The API
  answers the lowercase forms with HTTP 400; the CLI's `--re`/`--uk` parsers call
  the same functions, so both send the same request.
- **Engine options out of range** (constructor): see *Engine option ranges* below.
- **A malformed base URL** (constructor): see *`--base-url` scheme allowlist* below.
- **Header values that cannot be sent** (constructor, and `obtainKey()`). `apiKey`,
  `userAgent` and every `defaultHeaders` value must be non-blank, free of C0 control
  characters (tab allowed) and DEL, and within Latin-1 (`headerValueProblem`);
  header names must be HTTP tokens (`headerNameProblem`). `apiKey` is trimmed
  first and sent trimmed (`apiKeyProblem`), so `--api-key`, the env var and the
  option send the same header. A blank `apiKey` still means "no key"; a blank
  `userAgent` is rejected (only `undefined` selects
  `DEFAULT_USER_AGENT`). The default transport also turns Node's synchronous
  "Invalid character in header content" into an `AusbildungNetworkError`.
- **Paging outside the server's bounds.** `page` must be a non-negative integer,
  `size` an integer `1`..`MAX_PAGE_SIZE` (20; the server silently clamps a larger
  size and overrides `0`), and `(page + 1) × size` (size defaulting to
  `DEFAULT_PAGE_SIZE`) at most `MAX_RESULT_WINDOW` (10000), past which the API
  answers HTTP 500 (`pageProblem`, `sizeProblem`, `resultWindowProblem`).
- **Non-numeric offer ids.** `details()` accepts an id of digits only
  (`offerIdProblem`); a blank, padded, signed, decimal, percent-encoded or
  separator-bearing id (`" 123 "`, `"12/34"`, `"%31%32"`, `".."`) is rejected
  rather than put into the path with the API key attached.

## Authentication internals

The API requires a static, publicly-documented `X-API-Key` on every request. **No
key is bundled** with this client — supply it via `apiKey` (library), `--api-key`,
or the `AUSBILDUNGSSUCHE_API_KEY` env var. Precedence is **`--api-key` flag > env
var > no key**; an empty/whitespace key is treated as absent (header omitted), and
the API then answers `401`/`403`. The client sends the key trimmed, whichever way it
came; the CLI passes the flag or env value through unchanged. The env value is seeded onto the option after
parse (not as a commander default), so it never appears in `--help` output.

Because the key is publicly documented, you can fetch it out-of-band (for CI or
local live testing — never from production) with the bundled script:

```bash
npm run obtain-key                                      # prints the current public key
AUSBILDUNGSSUCHE_API_KEY="$(npm run --silent obtain-key)" ausbildungssuche search --ids 9162
```

`obtainKey()` (and so `obtain-key`) fetches the source through
`RequestEngine.getAbsolute`, an absolute-URL GET with the engine's request policy:
the default timeout (`DEFAULT_TIMEOUT_MS`) and size cap
(`DEFAULT_MAX_RESPONSE_BYTES`), 429/503 retries and redirects. `ObtainKeyOptions`
takes the engine's `transport`, `timeoutMs`, `userAgent`, `maxRetries`,
`retryDelayMs`, `maxRedirects`, `maxResponseBytes` and `sleep`, with the same
defaults and range checks; `sourceUrl` must be an absolute http(s) URL
(`httpUrlProblem`). No base URL and no API key are used. A non-2xx answer becomes an
`AusbildungError` naming the status; the CLI forwards every global option except
`--base-url` and `--api-key`.

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
    validate.ts  # input rules (Problem functions) + assertValid, shared by library and CLI
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

**`--base-url` scheme allowlist.** A non-http(s) or malformed base URL
(`file:`, `ftp:`, `notaurl`), and one with surrounding whitespace, inner whitespace
or control characters, a query or a fragment, is rejected by one rule,
`baseUrlProblem` ([`validate.ts`](src/client/validate.ts)), checked on the raw value
(`new URL()` would silently trim it). The `RequestEngine` constructor applies it
through `validateBaseUrl` and throws an `AusbildungValidationError`, so a library
consumer's custom transport never receives a bad base URL; the CLI's `parseBaseUrl`
([`shared.ts`](src/cli/shared.ts)) calls the same rule and makes it a usage error
(exit `2`) before any client is built. Only `undefined` selects `DEFAULT_BASE_URL`.
The default transport additionally rejects any non-http(s) URL on every request with
an `AusbildungNetworkError`, and the engine never hands a non-http(s) redirect target
(`file:`, `data:`, `javascript:`) to any transport: such a redirect is not followed
and surfaces as an `AusbildungApiError` naming it. No user-supplied URL ever reaches a
non-http(s) scheme. Userinfo (`https://user:pass@host`) is allowed and redacted
from every message; a `%` in it must start a valid escape (write a literal `%` as
`%25`), since Node decodes the userinfo for the `Authorization` header — anything
else is a usage error (exit `2`) instead of a late network error.

**Secrets in the CLI's output** (`withRedactedOutput` in [`run.ts`](src/cli/run.ts)).
Commander echoes a rejected value in its usage error and names an unknown command or
option as typed, so `run()` wraps `deps.io` first. The userinfo of every URL-like
argument (`credentialsIn`, which finds it whether the value parses or not, then
`redactCredentials`) becomes `***@` on stdout and stderr; the `--api-key` value and
the `AUSBILDUNGSSUCHE_API_KEY` value become `***` on stderr (`redactSecrets`). Not on
stdout, where `obtain-key` prints the key. A private key has no fixed shape, so a key
typed without its flag is kept out by not echoing the value at all
(`withoutStrayValues`): `unknown command` shows the value only when it reads like a
command name, `too many arguments` drops the values, `unknown option '--x=…'` drops
what follows `=`, and a numeric option shows its rejected value only when it reads
like a number. `test/conformance-p1-cli-redaction.test.ts` is the shared check (ten
passwords, seven URL shapes, every echo path, plus the key by flag, by environment
and typed without its flag).

**Charset.** `getJson()` and `obtainKey()` decode a body by the charset its
`Content-Type` declares (UTF-8 when none; `decodeBody`, built on `TextDecoder`), so an
`iso-8859-1` answer keeps its umlauts and a byte order mark added by a proxy does not
break `JSON.parse`. An unknown charset label is an `AusbildungParseError` naming it.

**Closed pipes** (`handleOutputErrors` in [`io.ts`](src/cli/io.ts), installed by the
bin shim before `run()`). An EPIPE on stdout (`| head` stopped reading) exits `0`
quietly; an EPIPE on stderr is ignored, so a failed run keeps its exit code (a usage
error piped through `2>&1 | head -c 5` still exits `2`). Any other write error exits
`1`. `test/conformance-p7-pipes-exit-codes.test.ts` runs the built bin.

**Secrets in the library.** The engine keeps the base URL and the default headers
(the `X-API-Key`) in real `#private` fields, so `console.log(client)`,
`util.inspect` and `JSON.stringify` never show them. It scrubs the base URL's
userinfo (raw and percent-decoded) and the key from error bodies and details,
transport error text and the `cause` chain (`scrub`, `scrubCause`), and `obtainKey()`
names a source behind Basic auth as `***@` in its errors and in
`ObtainedKey.sourceUrl`. `test/conformance-p2-library-redaction.test.ts` is the
shared check.

**Default headers / Accept negotiation.** The engine merges `defaultHeaders` into
every request — the seam that injects `X-API-Key`. The `Accept` header is chosen
per endpoint (`application/hal+json` for search, `application/json` for details)
because each endpoint `406`s on the other media type.

**Credentials per origin, hop by hop.** The engine attaches the credentials itself
on every hop — the credential headers (`X-API-Key`, `Authorization`, `Cookie`) and
the base URL's userinfo, sent as `Authorization: Basic` — and never puts userinfo in
the URL a transport sees. They go to the base URL's origin only: a same-origin
redirect (relative or absolute `Location`) keeps them, a redirect to another
scheme, host or port drops them for the rest of the chain (`http:`→`https:` on the
same host included), and `RawResponse.credentialsDropped` /
`AusbildungApiError.credentialsDropped` say so. A `401`/`403` after such a hop names
the redirect instead of blaming the key ("use an https base URL" for http→https,
`credentialsDroppedHint`), and the CLI exits `1` there without its key hint. A
`Location`'s own userinfo is never used.

**Transports must not follow redirects.** `HttpRequest.redirect` is always
`"manual"`: a custom transport returns the 3xx as it came
(`fetch(req.url, { redirect: req.redirect, signal: req.signal, … })`) and reports
the URL that answered in `HttpResponse.url` (fetch's `r.url`). A response whose `url`
is on another origin than the request's is rejected as an `AusbildungNetworkError`
("the transport followed a redirect to …"). The engine can only detect that after
the fact: a transport that ignores `redirect: "manual"` has already sent the
request, `X-API-Key` included (fetch strips only `Authorization` across origins), so
pass `req.redirect` on. `obtainKey()` names the document the key was really read
from (`ObtainedKey.sourceUrl`, also in the CLI's provenance note) when the key
source redirected. `test/conformance-p3-redirect-credentials.test.ts` is the shared
check (two local origins, a fetch transport, a transport-reported final URL, the
http→https hint).

**Retry / backoff.** Transient `429` (rate limit) and `503` responses, and reset
connections, are retried automatically, up to `maxRetries` / `--max-retries` (`0`..`MAX_RETRIES`, 10). Each retry waits the
linear backoff (`retryDelayMs * attempt`), or the response's `Retry-After`
(delay-seconds or an IMF-fixdate HTTP-date, parsed by the exported
`parseRetryAfter`) when that is longer: a `Retry-After: 0` or a date in the past
never makes a zero-delay burst. A `Retry-After` above `MAX_RETRY_AFTER_MS` (30 s) is
not retried at all: the error surfaces at once and names the requested wait
("retrying sooner won't help"). `test/conformance-p6-retry-policy.test.ts` is the
shared check. `AusbildungApiError`
exposes `isRetryable` (true for `429`/`503`).

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses.

**The transport contract, enforced by the engine.** A custom transport (a `fetch`
wrapper, a test double) gets the same guarantees as the built-in one, because the
engine checks them itself: every call runs under the `timeoutMs` deadline (the
request carries an `AbortSignal` that fires then, which the built-in transport
honours and `fetch(url, { signal })` takes; the engine rejects at the deadline
either way), the body it gets back is checked against `maxResponseBytes`
(`sizeLimitMessage` names the option and `--max-response-bytes`), response headers
are read case-insensitively from a plain record, a `Headers` object or a `Map`, the
body may be a Buffer, any `ArrayBuffer` view (a `Uint8Array` from fetch), an
`ArrayBuffer` or a string, and anything a transport throws or returns malformed
becomes an `AusbildungNetworkError` naming the request (CLI exit `6`). A connection
reset (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in
the `cause` chain; `isTransientNetworkError`) is retried like a `503`, for GET only.
`test/conformance-p5-transport-contract.test.ts` is the shared check.

**Engine option ranges.** The `RequestEngine` constructor (and so
`new AusbildungssucheClient(...)`) throws an `AusbildungValidationError` for a
numeric option that is not an integer in its range: `timeoutMs` `0`..`MAX_TIMEOUT_MS`,
`maxRetries` `0`..`MAX_RETRIES` (10), `maxRedirects` `0`..`MAX_REDIRECTS` (10),
`retryDelayMs` `0`..`MAX_RETRY_AFTER_MS` (30 000), `maxResponseBytes` any
non-negative integer (`intOption`,
`intRangeProblem`). `obtainKey()` builds a `RequestEngine` from the same options,
so the same ranges apply there. A NaN,
negative or fractional value would otherwise silently disable the timeout or the
size cap. The CLI's `--timeout`/`--max-retries` parsers use the same constants.

**RawResponse.** The engine's raw-response shape (`data`/`contentType`/`status`)
— exported for completeness; the offer endpoints return decoded JSON.

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, dates as ISO-8601, and encodes spaces as `%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`) and
an injectable `env` (for `AUSBILDUNGSSUCHE_API_KEY`). Lets the whole CLI run in
tests with a mocked client and captured output — no subprocess.

**Input validation.** [`validate.ts`](src/client/validate.ts) — the library owns
every rule about what a request may contain. A rule is a pure, exported
`…Problem(value)` function that returns the reason a value is invalid (or
`undefined`); `assertValid(name, value, problem)` turns a reason into an
`AusbildungValidationError` with the message `Invalid <name>: <reason>`. Client
methods check their input before any request, and a method that returns a promise
rejects rather than throwing synchronously. The CLI's value-parsers call the same
functions, and `run.ts` maps an `AusbildungValidationError` to exit `2`
(`Error: <message>`), so CLI and library accept and reject the same inputs.

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
- **`validate.test.ts`** — `assertValid`, the exit-2 mapping of `AusbildungValidationError`, and the CLI ↔ library parity tests. `parity()` in `test/helpers.ts` runs one input through `run()` and through the library on one recording mock transport; a parity test asserts both reject without a request, or both send the identical request.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/ausbildungssuche-cli/> in English
and <https://maschinenlesbar-org.github.io/ausbildungssuche-cli/de/> in German — is built from
`site/` with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web
components and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the
TypeDoc API reference under `/api/`. Its content comes from this repository: the README intro
and quick start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`),
`Usage.md`, `GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill
examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are
`site/_config.yml` and `site/_data/project.yml` (the German intro and the access requirements);
the rest of `site/` is identical in every maschinenlesbar.org CLI, so change it in all of them
together. When the README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/ausbildungssuche-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
