import { test } from "node:test";
import assert from "node:assert/strict";
import { AusbildungssucheClient } from "../src/client/client.js";
import { AusbildungApiError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>, apiKey?: string): AusbildungssucheClient {
  return new AusbildungssucheClient({ transport: mt.transport, ...(apiKey ? { apiKey } : {}) });
}

const SERVICE = "/infosysbub/absuche";

test("search forwards the supplied X-API-Key and params", async () => {
  const mt = constantJson({ page: {} });
  await clientWith(mt, "test-key").search({ sw: "Informatik", size: 10 });
  const req = mt.last();
  assert.equal(req.headers?.["X-API-Key"], "test-key");
  const url = new URL(req.url);
  assert.equal(url.pathname, `${SERVICE}/pc/v1/ausbildungsangebot`);
  assert.equal(url.searchParams.get("sw"), "Informatik");
  assert.equal(url.searchParams.get("size"), "10");
});

test("no X-API-Key header is sent when no key is supplied (no bundled default)", async () => {
  const mt = constantJson({ page: {} });
  await clientWith(mt).search();
  assert.equal(mt.last().headers?.["X-API-Key"], undefined);
});

test("a custom apiKey sets the header", async () => {
  const mt = constantJson({});
  await clientWith(mt, "my-key").search();
  assert.equal(mt.last().headers?.["X-API-Key"], "my-key");
});

test("Accept is negotiated per endpoint (search=HAL+JSON, details=JSON)", async () => {
  // The search collection 406s on application/json, so search MUST request
  // HAL+JSON; the per-id details endpoint 406s on HAL+JSON, so details MUST
  // request application/json. This guards against a spread-order regression in
  // engine.ts that would let one default silently win for both.
  const mt = constantJson({});
  await clientWith(mt).search();
  assert.equal(mt.last().headers?.["Accept"], "application/hal+json");
  const mt2 = constantJson({});
  await clientWith(mt2).details("abc");
  assert.equal(mt2.last().headers?.["Accept"], "application/json");
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
