import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import {
  AusbildungApiError,
  AusbildungParseError,
  AusbildungNetworkError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, redirectResponse } from "./helpers.js";

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

test("the engine surfaces a transport-level network error", async () => {
  const mt = makeMockTransport(() => {
    throw new AusbildungNetworkError("connection reset");
  });
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), AusbildungNetworkError);
});
