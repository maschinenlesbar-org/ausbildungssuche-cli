// `obtain-key`: the command that fetches the public X-API-Key at run time.
// No key is bundled, so this path must never invent one — every failure mode
// below asserts that it fails loudly instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { AusbildungssucheClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { API_KEY_ENV_VAR, KEY_SOURCE_URL, obtainKey } from "../src/client/obtain-key.js";
import { AusbildungError, AusbildungParseError, AusbildungValidationError } from "../src/client/errors.js";
import { makeMockTransport, rawResponse, redirectResponse, untimed } from "./helpers.js";

const SOURCE_DOC = ["# ausbildungssuche-api", "", "```bash", 'curl -H "X-API-Key: infosysbub-absuche" https://rest.arbeitsagentur.de/...', "```"].join("\\n");
const EXPECTED_KEY = "infosysbub-absuche";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new AusbildungssucheClient({ ...opts, transport: mt.transport }),
    env: {},
    transport: mt.transport,
  };
  return { deps, out, err, mt };
}

test("obtainKey reads the key from the published source", async () => {
  const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/plain"));
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, EXPECTED_KEY);
  assert.equal(result.sourceUrl, KEY_SOURCE_URL);
  assert.equal(mt.last().url, KEY_SOURCE_URL);
  assert.equal(mt.last().method, "GET");
});

test("obtainKey throws when the source is unreachable", async () => {
  const mt = makeMockTransport(() => rawResponse("nope", "text/plain", 503));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), AusbildungError);
});

test("obtainKey throws when the source no longer states a key", async () => {
  const mt = makeMockTransport(() => rawResponse("# readme with no key", "text/plain"));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), AusbildungParseError);
});

test("obtain-key prints only the key on stdout, provenance on stderr", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/plain"));
  const code = await run(["obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [EXPECTED_KEY]);
  assert.ok(cli.err.join("\n").includes(KEY_SOURCE_URL));
});

test("obtain-key --export emits a quoted, eval-safe export line", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/plain"));
  const code = await run(["obtain-key", "--export"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [`export ${API_KEY_ENV_VAR}='${EXPECTED_KEY}'`]);
});

test("obtain-key needs no configured key and sends none", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/plain"));
  const code = await run(["obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
});

test("a failing obtain-key exits non-zero rather than printing a guess", async () => {
  const cli = makeCli(() => rawResponse("", "text/plain", 404));
  const code = await run(["obtain-key"], cli.deps);
  assert.notEqual(code, 0);
  assert.deepEqual(cli.out, []);
});

test("obtainKey rejects a timeoutMs that is not an integer in 0..MAX_TIMEOUT_MS, before any request", async () => {
  for (const timeoutMs of [Number.NaN, -1, 1.5, 2_147_483_648]) {
    const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/plain"));
    await assert.rejects(
      () => obtainKey({ transport: mt.transport, timeoutMs }),
      (err) => err instanceof AusbildungValidationError && err.message.startsWith("Invalid timeoutMs: "),
      String(timeoutMs),
    );
    assert.equal(mt.calls.length, 0);
  }
});

// Finding #11 (PAT-22): the fetch goes through the engine's request policy.
test("obtainKey applies the engine's default timeout and response size cap", async () => {
  const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/plain"));
  await obtainKey({ transport: mt.transport });
  assert.equal(mt.last().timeoutMs, 30_000);
  assert.equal(mt.last().maxResponseBytes, 100 * 1024 * 1024);
});

test("obtainKey retries a 429 by default, honouring Retry-After", async () => {
  const waits: number[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    ++n === 1
      ? { status: 429, headers: { "retry-after": "1" }, body: Buffer.alloc(0) }
      : rawResponse(SOURCE_DOC, "text/plain"),
  );
  const result = await obtainKey({ transport: mt.transport, sleep: async (ms) => void waits.push(ms) });
  assert.equal(result.key, EXPECTED_KEY);
  assert.equal(mt.calls.length, 2);
  assert.deepEqual(waits, [1000]);
});

test("obtainKey follows a redirect to the moved document", async () => {
  const moved = "https://example.org/mirror/README.md";
  const mt = makeMockTransport((req) =>
    req.url === KEY_SOURCE_URL ? redirectResponse(moved, 301) : rawResponse(SOURCE_DOC, "text/plain"),
  );
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, EXPECTED_KEY);
  assert.deepEqual(mt.calls.map((c) => c.url), [KEY_SOURCE_URL, moved]);
});

test("obtainKey still reports a failed source as AusbildungError naming the status", async () => {
  const mt = makeMockTransport(() => rawResponse("nope", "text/plain", 503));
  await assert.rejects(
    () => obtainKey({ transport: mt.transport, maxRetries: 0 }),
    (err) =>
      err instanceof AusbildungError &&
      err.constructor === AusbildungError &&
      /Could not read the key source .* \(HTTP 503\)\. Retry, or copy the key/.test(err.message),
  );
  assert.equal(mt.calls.length, 1);
});

test("obtainKey rejects a sourceUrl that is not an http(s) URL, before any request", async () => {
  for (const sourceUrl of ["ftp://example.org/key", "notaurl", ""]) {
    const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/plain"));
    await assert.rejects(
      () => obtainKey({ transport: mt.transport, sourceUrl }),
      (err) => err instanceof AusbildungValidationError && err.message.startsWith("Invalid sourceUrl: "),
      sourceUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("obtainKey rejects out-of-range engine options, before any request", async () => {
  for (const options of [{ maxRetries: 11 }, { maxResponseBytes: -1 }, { maxRedirects: 1.5 }]) {
    const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/plain"));
    await assert.rejects(
      () => obtainKey({ transport: mt.transport, ...options }),
      AusbildungValidationError,
      JSON.stringify(options),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("obtainKey accepts only a value shaped like the published key, never a guess", async () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const bad = [
    "YOUR-API-KEY.",
    "YOUR-API-KEY",
    "infosysbub-absuche,",
    "<YOUR_KEY>",
    "--help",
    `k${ESC}]0;pwned${BEL}${ESC}[2Jx`,
    "schlüssel-absuche",
    "k".repeat(1_000_000),
    "short",
  ];
  for (const value of bad) {
    const doc = `curl -H "X-API-Key: ${value}" https://rest.arbeitsagentur.de/...`;
    const mt = makeMockTransport(() => rawResponse(doc, "text/plain"));
    await assert.rejects(obtainKey({ transport: mt.transport }), AusbildungParseError, JSON.stringify(value.slice(0, 40)));
    const cli = makeCli(() => rawResponse(doc, "text/plain"));
    assert.equal(await run(["obtain-key"], cli.deps), 1);
    assert.deepEqual(cli.out, [], "nothing is printed as the key");
    assert.ok(!cli.err.join("\n").includes(ESC), "no escape reaches the terminal");
  }
});

test("obtainKey fails when the source states two different keys, and accepts a repeated one", async () => {
  const two = 'X-API-Key: old-key-2019\n\ncurl -H "X-API-Key: infosysbub-absuche"';
  await assert.rejects(
    obtainKey({ transport: makeMockTransport(() => rawResponse(two, "text/plain")).transport }),
    /states 2 different X-API-Key values/,
  );
  const same = 'X-API-Key: infosysbub-absuche\n\ncurl -H "X-API-Key: infosysbub-absuche"';
  const result = await obtainKey({ transport: makeMockTransport(() => rawResponse(same, "text/plain")).transport });
  assert.equal(result.key, EXPECTED_KEY);
});

test("after a redirect, obtain-key names the document it actually read the key from", async () => {
  const moved = "https://mirror.example/key.txt";
  const responder = (req: HttpRequest): HttpResponse =>
    req.url === KEY_SOURCE_URL ? redirectResponse(moved, 302) : rawResponse(SOURCE_DOC, "text/plain");
  const result = await obtainKey({ transport: makeMockTransport(responder).transport });
  assert.equal(result.sourceUrl, moved);
  const cli = makeCli(responder);
  assert.equal(await run(["obtain-key"], cli.deps), 0);
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[ausbildungssuche\.obtain-key\] Obtained the public key from https:\/\/mirror\.example\/key\.txt/m);
  assert.ok(!cli.err.join("\n").includes("raw.githubusercontent.com"));
});
