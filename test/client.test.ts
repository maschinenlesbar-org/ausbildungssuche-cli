import { test } from "node:test";
import assert from "node:assert/strict";
import { AusbildungssucheClient, DEFAULT_API_KEY } from "../src/client/client.js";
import { AusbildungApiError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>, apiKey?: string): AusbildungssucheClient {
  return new AusbildungssucheClient({ transport: mt.transport, ...(apiKey ? { apiKey } : {}) });
}

const SERVICE = "/infosysbub/absuche";

test("search sends the default X-API-Key and params", async () => {
  const mt = constantJson({ page: {} });
  await clientWith(mt).search({ sw: "Informatik", size: 10 });
  const req = mt.last();
  assert.equal(req.headers?.["X-API-Key"], DEFAULT_API_KEY);
  const url = new URL(req.url);
  assert.equal(url.pathname, `${SERVICE}/pc/v1/ausbildungsangebot`);
  assert.equal(url.searchParams.get("sw"), "Informatik");
  assert.equal(url.searchParams.get("size"), "10");
});

test("a custom apiKey overrides the default header", async () => {
  const mt = constantJson({});
  await clientWith(mt, "my-key").search();
  assert.equal(mt.last().headers?.["X-API-Key"], "my-key");
});

test("the client sends Accept: application/hal+json (the load-bearing override)", async () => {
  // The API 406s on application/json, so the client MUST request HAL+JSON. This
  // guards against a spread-order regression in engine.ts that would silently
  // let the engine's application/json default win.
  const mt = constantJson({});
  await clientWith(mt).search();
  assert.equal(mt.last().headers?.["Accept"], "application/hal+json");
  // ...and on the details path too.
  const mt2 = constantJson({});
  await clientWith(mt2).details("abc");
  assert.equal(mt2.last().headers?.["Accept"], "application/hal+json");
});

test("details builds the per-id path and url-encodes the id", async () => {
  const mt = constantJson({});
  await clientWith(mt).details("AB/12 3");
  assert.equal(
    new URL(mt.last().url).pathname,
    `${SERVICE}/pc/v1/ausbildungsangebot/AB%2F12%203`,
  );
});

test("a 404 raises AusbildungApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).details("x"),
    (err) => err instanceof AusbildungApiError && err.status === 404,
  );
});
