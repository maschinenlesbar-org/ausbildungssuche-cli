import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_AFTER_MS, RequestEngine, parseRetryAfter } from "../src/client/engine.js";
import {
  AusbildungApiError,
  AusbildungParseError,
  AusbildungNetworkError,
  AusbildungValidationError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, redirectResponse } from "./helpers.js";

// Control chars built via char codes so no raw control byte appears in this file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b); // a C1 control

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("infosysbub/"), "https://example.test/infosysbub/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws AusbildungParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), AusbildungParseError);
});

test("a 503 is retried up to maxRetries then surfaces as AusbildungApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof AusbildungApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("a redirect is followed to the Location target", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(new URL(req.url).pathname, "/start");
      return redirectResponse("/moved");
    }
    assert.equal(new URL(req.url).pathname, "/moved");
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  assert.deepEqual(await e.getJson("/start"), { ok: 1 });
  assert.equal(calls, 2);
});

test("maxRedirects is honoured (stops following and surfaces the 3xx)", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return redirectResponse("/loop");
  });
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    maxRedirects: 2,
  });
  await assert.rejects(
    () => e.getJson("/start"),
    (err) => err instanceof AusbildungApiError && err.status === 302,
  );
  assert.equal(calls, 3); // initial + 2 redirects, then the 3xx surfaces
});

test("a same-origin redirect KEEPS the X-API-Key header", async () => {
  let lastHeaders: Record<string, string> | undefined;
  const mt = makeMockTransport((req) => {
    lastHeaders = req.headers;
    return req.url.includes("/moved")
      ? jsonResponse({ ok: 1 })
      : redirectResponse("https://example.test/moved");
  });
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    defaultHeaders: { "X-API-Key": "secret-key" },
  });
  await e.getJson("/start");
  assert.equal(lastHeaders?.["X-API-Key"], "secret-key");
});

test("a cross-origin redirect STRIPS credential headers", async () => {
  let lastHeaders: Record<string, string> | undefined;
  const mt = makeMockTransport((req) => {
    lastHeaders = req.headers;
    return req.url.startsWith("https://evil.test")
      ? jsonResponse({ ok: 1 })
      : redirectResponse("https://evil.test/grab");
  });
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    defaultHeaders: {
      "X-API-Key": "secret-key",
      Authorization: "Bearer t0ken",
      Cookie: "sid=abc",
    },
  });
  await e.getJson("/start");
  assert.equal(lastHeaders?.["X-API-Key"], undefined);
  assert.equal(lastHeaders?.["Authorization"], undefined);
  assert.equal(lastHeaders?.["Cookie"], undefined);
  // Non-credential headers still travel along.
  assert.equal(lastHeaders?.["Accept"], "application/json");
});

test("maxResponseBytes=0 disables the cap (no field sent to the transport)", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: 1 }));
  const e = new RequestEngine({ transport: mt.transport, maxResponseBytes: 0 });
  await e.getJson("/x");
  assert.equal("maxResponseBytes" in mt.last(), false);
});

test("error detail is stripped of terminal control characters", async () => {
  // A hostile endpoint escapes ESC/BEL/C1 controls in the JSON error `detail`;
  // JSON.parse decodes them to real control bytes. run.ts prints the resulting
  // error message raw to stderr, so they must be stripped at the source.
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  const mt = makeMockTransport(() =>
    rawResponse(JSON.stringify({ detail: evil }), "application/json", 500),
  );
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => {
      assert.ok(err instanceof AusbildungApiError);
      // Control bytes gone from both the structured detail and the printed message...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters survive.
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("the engine surfaces a transport-level network error", async () => {
  const mt = makeMockTransport(() => {
    throw new AusbildungNetworkError("connection reset");
  });
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), AusbildungNetworkError);
});

test("a non-http(s) base URL is rejected at construction, before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      AusbildungNetworkError,
    );
    assert.equal(mt.calls.length, 0);
  }
});

// ---- Retry-After ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from(JSON.stringify({ detail: "slow down" })),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("1");
  await assert.rejects(
    () => engine.getJson("/x"),
    (e: unknown) => e instanceof AusbildungApiError && e.status === 429,
  );
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(
      () => engine.getJson("/x"),
      (e: unknown) => e instanceof AusbildungApiError && e.status === 429,
    );
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("a . or .. path segment (percent-encoded forms included) is rejected without a request", async () => {
  for (const seg of [".", "..", "%2e", "%2e%2e", ".%2e", "%2E.", "%2E%2E"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.getJson(`/infosysbub/absuche/pc/v1/ausbildungsangebot/${seg}`),
      (err: unknown) =>
        err instanceof AusbildungValidationError &&
        err.message ===
          `Invalid path segment "${seg}" in /infosysbub/absuche/pc/v1/ausbildungsangebot/${seg}: "." and ".." cannot be used as an id.`,
      seg,
    );
    assert.equal(mt.calls.length, 0, seg);
  }
  // Longer dot runs and dotted ids are ordinary segments.
  const e = new RequestEngine({ baseUrl: "https://example.test" });
  assert.equal(e.buildUrl("/x/..."), "https://example.test/x/...");
  assert.equal(e.buildUrl("/x/1.0.0"), "https://example.test/x/1.0.0");
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://example.test/x?y=1", "https://example.test/x#f"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (e: unknown) => e instanceof AusbildungNetworkError && /query or fragment/.test((e as Error).message),
      baseUrl,
    );
  }
});
