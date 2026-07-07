import { test } from "node:test";
import assert from "node:assert/strict";
import { AusbildungssucheClient } from "../src/client/client.js";
import { AusbildungApiError, AusbildungValidationError } from "../src/client/errors.js";
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

test("details rejects a crafted already-encoded id that injects path traversal", () => {
  // AUS-003: an id with one valid %XX plus raw '/' used to skip encoding, letting
  // `new URL` normalise `../` and escape the intended path (here to /v2/secret).
  // The id is validated synchronously before any request is made, so no request
  // reaches the transport and the crafted path never gets built.
  const mt = constantJson({});
  assert.throws(
    () => clientWith(mt).details("x%20/../../../v2/secret"),
    (err) => err instanceof AusbildungValidationError,
  );
  assert.equal(mt.calls.length, 0);
});

test("details rejects an already-encoded id that injects a query or fragment", () => {
  const mt = constantJson({});
  assert.throws(
    () => clientWith(mt).details("a%20b?apiKey=1"),
    (err) => err instanceof AusbildungValidationError,
  );
  assert.throws(
    () => clientWith(mt).details("abc%20#frag"),
    (err) => err instanceof AusbildungValidationError,
  );
  assert.equal(mt.calls.length, 0);
});

test("details still passes a genuinely already-encoded id through unchanged", async () => {
  // A real _links id keeps its %20 (not double-encoded to %2520) and stays on path.
  const mt = constantJson({});
  await clientWith(mt).details("AB%20CD");
  assert.equal(
    new URL(mt.last().url).pathname,
    `${SERVICE}/pc/v1/ausbildungsangebot/AB%20CD`,
  );
});

test("a 404 raises AusbildungApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).details("x"),
    (err) => err instanceof AusbildungApiError && err.status === 404,
  );
});
