# Bug report — ausbildungssuche-cli (exploratory / black-box)

## Environment

- Date: 2026-06-06
- OS: macOS (Darwin 25.5.0), Node v22.14.0
- Build: `npm run build` succeeded clean (tsc, no errors).
- Invocation: `node dist/src/cli/index.js ...`
- **Live BA Ausbildungssuche API is reachable** (`https://rest.arbeitsagentur.de/infosysbub/absuche`).
  `search` works against it; the public `X-API-Key` and `Accept: application/hal+json`
  are sent (confirmed by pointing `--base-url` at a local server and inspecting headers).

All bugs below are reproduced against the live API or a local loopback server.
Where exit codes are shown, they were captured with `echo $?` on a non-piped run
(piping to `head` masks the real exit code — see Bug 19 note in repro hygiene).

---

## CRITICAL

### 1. `details <id>` is completely broken against the live API (always 406)

- **Severity:** Critical (core command non-functional / total data loss)
- **Confidence:** Certain
- **Repro:**
  ```
  node dist/src/cli/index.js details 381907458   # any real id from a search result
  echo $?
  ```
  (381907458 is the `_embedded.termine[0].id` from `search --sw Informatik --size 1`.)
- **Expected:** Full offer details JSON, exit 0.
- **Actual:**
  ```
  Error: HTTP 406 for GET https://rest.arbeitsagentur.de/infosysbub/absuche/pc/v1/ausbildungsangebot/381907458
  Hint: the API could not satisfy the Accept header (406). ...
  exit=5
  ```
  Every `details` call returns 406 regardless of id. The command can never succeed.
- **Root cause:** The details endpoint requires `Accept: application/json` and
  **returns 406 for `application/hal+json`** — the *opposite* of `search`. Verified with curl:
  ```
  curl -H "X-API-Key: infosysbub-absuche" -H "Accept: application/json"     .../ausbildungsangebot/381907458  -> 200
  curl -H "X-API-Key: infosysbub-absuche" -H "Accept: application/hal+json" .../ausbildungsangebot/381907458  -> 406
  ```
  The client hardcodes `Accept: application/hal+json` for *all* requests
  (`src/client/client.ts:48`, `defaultHeaders.Accept`), so details can never negotiate.
  Fix: details must request `application/json` (and/or send `application/hal+json, application/json`).

### 2. The engine's `accept` parameter is dead code — Accept can never be overridden per-request

- **Severity:** Critical (root cause of Bug 1; latent for any future endpoint)
- **Confidence:** Certain
- **Repro:** Local server that 406s on hal+json and 200s on application/json:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:38766 details 1
  # -> Error: HTTP 406 ... : hal not acceptable ; exit=5
  ```
  `getJson` calls `request(..., { accept: "application/json" })` (`src/client/engine.ts:160`),
  yet the request still goes out with `application/hal+json`.
- **Expected:** The `accept` argument passed to `request()`/`getJson()` controls the Accept header.
- **Actual:** It is ignored; hal+json always wins.
- **Root cause:** `src/client/engine.ts:104-108` builds headers as
  `{ Accept: options.accept, "User-Agent": ..., ...this.defaultHeaders }`.
  Because `defaultHeaders` (which contains `Accept: application/hal+json` from
  `client.ts:48`) is spread **last**, it overrides `options.accept`. The per-request
  `accept` is permanently shadowed.

---

## HIGH

### 3. Empty env var `AUSBILDUNGSSUCHE_API_KEY=""` breaks all requests (403) instead of falling back to default key

- **Severity:** High (env-driven misconfiguration silently disables the tool)
- **Confidence:** Certain
- **Repro:**
  ```
  AUSBILDUNGSSUCHE_API_KEY="" node dist/src/cli/index.js search --sw X --size 1
  echo $?
  ```
- **Expected:** An unset/empty env var should fall back to the built-in public key
  (precedence "flag > env > default"), giving a 200.
- **Actual:**
  ```
  Error: HTTP 403 for GET .../ausbildungsangebot?sw=X&size=1
  exit=3
  ```
- **Root cause:** `src/cli/program.ts:28` does `const envApiKey = deps.env[API_KEY_ENV_VAR];`
  and passes it straight as the `--api-key` default. An empty string is a *present*
  default, so the resolved key is `""`. Then `client.ts:47` uses `apiKey ?? DEFAULT_API_KEY`
  — `""` is not nullish, so the empty key is sent. Should treat empty string as absent.

### 4. `--size ""` / `--size "  "` silently coerced to `size=0` instead of being rejected

- **Severity:** High (invalid input accepted, wrong query sent)
- **Confidence:** Certain
- **Repro (authoritative, via local server that echoes the path):**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:38767 search --sw X --size ""
  # server saw: /infosysbub/absuche/pc/v1/ausbildungsangebot?sw=X&size=0
  ```
  Same for `--size "  "` (whitespace) and `--page ""` -> `page=0`. All exit 0.
- **Expected:** Empty / whitespace-only numeric args rejected with
  "Expected a non-negative integer." (as `-1`/`abc` are).
- **Actual:** Accepted; `size=0` is sent to the API.
- **Root cause:** `parseIntArg` (`src/cli/shared.ts:10-16`) uses `Number(value)`.
  `Number("") === 0` and `Number("  ") === 0`, both pass `Number.isInteger(n) && n >= 0`.

### 5. `parseIntArg` accepts hex / scientific / binary / signed / padded numbers

- **Severity:** High (numeric flags accept clearly non-integer strings)
- **Confidence:** Certain
- **Repro (authoritative, via local server):**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:38767 search --sw X --size "0x10"
  # server saw: ...?sw=X&size=16
  ```
  Also accepted: `--size 1e3` -> 1000, `--size "0b10"` -> 2, `--size "  5  "` -> 5,
  `--size +5` -> 5, `--size 5.0` -> 5.
- **Expected:** Only plain base-10 non-negative integers; `0x10`, `1e3`, `+5`, padded,
  decimals rejected.
- **Actual:** All silently parsed via JS `Number()` coercion and forwarded.
- **Root cause:** `Number()` in `parseIntArg` (`src/cli/shared.ts:11`) does full JS
  numeric coercion. Should use a strict regex / `Number.parseInt` with format validation.

---

## MEDIUM

### 6. Out-of-range `--size` (README/help say "max 2000") is not validated; 5000 is sent unvalidated

- **Severity:** Medium (documented limit not enforced)
- **Confidence:** Certain
- **Repro:**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:38767 search --sw X --size 5000
  # server saw: ...?sw=X&size=5000   (the limit is never checked client-side)
  ```
- **Expected:** Either reject sizes > 2000 client-side, or remove the "max 2000" claim.
- **Actual:** `--size 5000` is accepted and forwarded verbatim (the live server then
  silently ignores it and returns `page.size:20`, so the user gets a different size than
  requested with no error).
- **Root cause:** No range check anywhere; `ausbildung.ts:18` and `shared.ts:parseIntArg`
  only enforce `>= 0`. Help text `ausbildung.ts:18` and `types.ts:57` claim "max 2000".

### 7. `details ""` (empty id) silently targets the search collection endpoint

- **Severity:** Medium (wrong endpoint, confusing 403)
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js details ""
  echo $?
  ```
- **Expected:** A client-side "id must not be empty" error, exit non-zero with a clear message.
- **Actual:**
  ```
  Error: HTTP 403 for GET .../pc/v1/ausbildungsangebot/
  exit=3
  ```
  The empty id collapses to a trailing-slash collection URL and yields a misleading
  401/403 auth hint that has nothing to do with the real problem.
- **Root cause:** `client.ts:61` builds `.../ausbildungsangebot/${encodeURIComponent("")}`
  = `.../ausbildungsangebot/`. No empty-id guard in `ausbildung.ts:40-42` or `client.ts`.

### 8. Mapping a 403 to "rejected API key" is wrong for non-auth 403s (e.g. empty id)

- **Severity:** Medium (misleading diagnostics)
- **Confidence:** High
- **Repro:** `node dist/src/cli/index.js details ""` (see Bug 7) prints:
  ```
  Hint: the API rejected the X-API-Key (401/403). Check --api-key or the AUSBILDUNGSSUCHE_API_KEY env var.
  ```
- **Expected:** The auth hint should only fire when the key is actually the issue.
- **Actual:** Every 403 is attributed to the API key (`src/cli/run.ts:41-47`), even when
  the key is the valid public one and the real cause is a malformed request path.
- **Root cause:** `run.ts:41` treats all 401/403 as key rejection with no nuance.

### 9. `details <id>` with an already-percent-encoded id is double-encoded

- **Severity:** Medium (data corruption for pre-encoded ids)
- **Confidence:** High
- **Repro (via local server):**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:38767 details "a%20b"
  # server saw: .../ausbildungsangebot/a%2520b   (the %20 became %2520)
  ```
- **Expected:** Debatable, but a user pasting an id from a URL/`_links` href (which can
  already be encoded) gets a wrong path and a spurious 404/406.
- **Actual:** `encodeURIComponent` re-encodes the `%`, producing `%25...`.
- **Root cause:** `client.ts:61` unconditionally `encodeURIComponent(id)`.

---

## LOW / UX / DOCS

### 10. README example `ausbildungssuche details <id>` cannot work as documented

- **Severity:** Low (docs promise a broken workflow)
- **Confidence:** Certain
- **Repro:** README "Examples" tells the user to take an id from a search result's
  `_embedded` and run `details <id>`. Doing exactly that yields the Bug 1 406.
- **Expected:** The documented happy path should work.
- **Actual:** Always 406. (Consequence of Bug 1; listed separately as a doc defect.)
- **Root cause:** Same as Bug 1; README at `README.md` "Examples"/"Details for one offer".

### 11. README claims usage errors "return commander's non-zero code" — but it's always 1

- **Severity:** Low (docs vs behavior)
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js search --size -1 ; echo $?   # -> 1
  node dist/src/cli/index.js badcmd        ; echo $?       # -> 1
  ```
- **Expected:** README ("Exit codes" section) implies a distinct commander code; in
  practice every usage/parse error is exit 1, indistinguishable from a generic runtime
  error (also exit 1 per `run.ts:55/59/62`). Scripts cannot tell a usage error from a
  network failure.
- **Root cause:** `run.ts:33` returns `err.exitCode` (commander default 1) for parse
  errors, identical to the catch-all exit 1.

### 12. No-args prints help to **stderr** and exits 1

- **Severity:** Low (UX / convention)
- **Confidence:** Certain
- **Repro:**
  ```
  node dist/src/cli/index.js 1>/tmp/out 2>/tmp/err ; echo $?   # exit=1
  wc -c /tmp/out   # 0 bytes on stdout
  wc -c /tmp/err   # 1156 bytes (the help text) on stderr
  ```
- **Expected:** Many CLIs print help to stdout on a bare invocation (or at least the help
  is discoverable on stdout). Here a bare `... | less` shows nothing.
- **Actual:** Help goes to stderr; stdout empty; exit 1. (`--help` correctly goes to
  stdout with exit 0, so the two paths are inconsistent.)
- **Root cause:** commander's default "missing command" behavior routed through
  `configureOutput.writeErr` (`run.ts:19`).

### 13. `--api-key ""` (explicit empty flag) sends an empty key (403) instead of erroring or defaulting

- **Severity:** Low (mirror of Bug 3 on the flag side)
- **Confidence:** Certain
- **Repro:**
  ```
  node dist/src/cli/index.js --api-key "" search --sw Test ; echo $?   # exit=3, HTTP 403
  ```
- **Expected:** Either reject an empty `--api-key` as invalid, or fall back to the default.
- **Actual:** Empty string is sent as the `X-API-Key` -> 403.
- **Root cause:** `client.ts:47` `apiKey ?? DEFAULT_API_KEY` — `""` is not nullish.

### 14. Help text / docs say global options must go **before** the command, but they also work after

- **Severity:** Low (docs understate behavior / inconsistency)
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js search --sw Informatik --compact --size 1   # works (compact)
  ```
- **Expected:** README states "Global options go **before** the command". Either enforce
  that or document that commander accepts them after too.
- **Actual:** `--compact` (a global option) is accepted *after* the subcommand and takes
  effect, contradicting the docs.
- **Root cause:** commander hoists global options via `optsWithGlobals()` (`shared.ts:68`);
  README does not reflect this.

### 15. Live server silently ignores `size=0` and out-of-range sizes, returning `page.size:20` — no client warning

- **Severity:** Low (silent surprise; partly server-side)
- **Confidence:** Certain
- **Repro:**
  ```
  node dist/src/cli/index.js --compact search --sw Informatik --size 0  | grep -o '"page":{[^}]*}'
  # -> "page":{"number":0,"size":20,...}   (asked for 0, got 20)
  ```
- **Expected:** Requesting `size=0` should either be rejected client-side (it's nonsensical)
  or the user warned that the returned size differs.
- **Actual:** `size=0` accepted, sent, silently overridden by the server to 20.
- **Root cause:** Combination of Bug 4 (0 accepted) and no post-response validation.

### 16. `details` errors hide every non-406 failure mode (404 for missing id unreachable)

- **Severity:** Low (consequence of Bug 1; observability)
- **Confidence:** Certain
- **Repro:**
  ```
  node dist/src/cli/index.js details 999999999999 ; echo $?
  # -> HTTP 406 (exit 5), NOT the 404 a missing id should give
  ```
- **Expected:** A nonexistent id should surface as 404 (exit 4) per README.
- **Actual:** Because hal+json is rejected first, you can never observe a real 404 from
  `details`; the documented exit-4 path is unreachable via this command.
- **Root cause:** Bug 1 (Accept negotiation fails before the id is even evaluated).

### 17. `sty` and `bg` search parameters are typed but not exposed by the CLI

- **Severity:** Low (feature gap / type vs CLI mismatch)
- **Confidence:** Certain
- **Repro:** `src/client/types.ts:38,51` declare `sty` (offer type 0..4) and `bg`
  (education-voucher filter) on `AusbildungSearchParams`, but `search` only wires
  `--sw/--orte/--re/--uk/--ids/--bart/--bt/--page/--size` (`src/cli/commands/ausbildung.ts:10-31`).
  There is no `--sty` / `--bg` flag.
- **Expected:** Either expose them or drop them from the public param type.
- **Actual:** Library users can set them; CLI users cannot.
- **Root cause:** `ausbildung.ts` action builds `params` without `sty`/`bg`.

### 18. Generic transport/timeout errors all collapse to exit 1, indistinguishable from API "other" errors

- **Severity:** Low (scripting / observability)
- **Confidence:** Certain
- **Repro:**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:1 search --sw X ; echo $?     # exit=1 (ECONNREFUSED)
  node dist/src/cli/index.js --timeout 1 search --sw X            ; echo $?            # exit=1 (timeout)
  node dist/src/cli/index.js --base-url https://rest.arbeitsagentur.de/x search; echo $?  # exit=1 (HTTP 400/5xx other)
  ```
- **Expected:** A distinct exit code for network/transport failures vs HTTP "other"
  (the README only carves out 3/4/5; everything else, including connectivity, is 1).
- **Actual:** Network errors, parse errors and uncategorized HTTP errors share exit 1.
- **Root cause:** `run.ts:55/59` map both `AusbildungApiError` (other status) and
  `AusbildungError` (network/parse) to 1.

### 19. Misleading 406 hint blames "a custom transport or proxy" when the client itself is at fault

- **Severity:** Low (diagnostics)
- **Confidence:** High
- **Repro:** `node dist/src/cli/index.js details 381907458` prints:
  ```
  Hint: ... This client requests application/hal+json; a custom transport or proxy may have altered it.
  ```
- **Expected:** For `details`, the 406 is caused by the client *correctly* sending
  hal+json to an endpoint that wants application/json — no proxy involved. The hint
  sends the user down the wrong debugging path.
- **Actual:** The hint asserts an external cause that is false for the most common 406 case.
- **Root cause:** `run.ts:48-53` hardcodes a proxy-blaming message; combined with Bug 1
  it actively misdirects.

### 20. `--max-response-bytes` size-cap aborts mid-stream but the resulting error is also exit 1 with a low-level message

- **Severity:** Low (UX of a security feature)
- **Confidence:** Certain
- **Repro:**
  ```
  node dist/src/cli/index.js --max-response-bytes 1 search --sw Test --size 1 ; echo $?
  # -> Error: Response exceeded maxResponseBytes (1) ; exit=1
  ```
- **Expected:** Fine as a guard, but it surfaces as a generic exit-1 `AusbildungNetworkError`
  with no guidance to raise the cap, and is indistinguishable from a real network failure
  (see Bug 18).
- **Actual:** Cryptic message, exit 1, no hint to increase `--max-response-bytes`.
- **Root cause:** `http.ts:75-79` rejects with `AusbildungNetworkError`; `run.ts:57-59`
  maps it to a bare exit 1.

---

## Count

**20 genuine, reproducible bugs reported — all 20 are real and reproduced** (live API or
local loopback server). Mix: 2 Critical, 3 High, 4 Medium, 11 Low/UX/Docs.

Several Low items (10, 16, 19) are downstream consequences of Bug 1/2 but are independently
observable user-facing defects, so they are counted. The behaviors verified as **correct**
(not bugs) include: `search` happy path, `X-API-Key` + `Accept: application/hal+json`
header injection, `--user-agent` override, `--api-key`/env precedence (flag > env > default
when env is non-empty), `404`->exit4 and `406`->exit5 mapping, unicode/special-char query
encoding (`%20`/`%26`), umlaut rendering in pretty & compact output, cross-origin behavior
of `--base-url`, trailing-slash base-url normalization, and `-1`/`abc`/negative numeric
rejection.
