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
  await clientWith(mt2).details("365241044");
  assert.equal(mt2.last().headers?.["Accept"], "application/json");
});

test("details builds the per-id path from a numeric id", async () => {
  const mt = constantJson({});
  await clientWith(mt).details("365241044");
  assert.equal(new URL(mt.last().url).pathname, `${SERVICE}/pc/v1/ausbildungsangebot/365241044`);
});

// Offer ids are digits only. Anything else rejects (a promise rejection, not a
// synchronous throw) before any request: a separator, a query or fragment, a
// percent-encoded form, or a crafted traversal id (AUS-003, `x%20/../../../v2/secret`
// used to escape the intended path to /v2/secret with the X-API-Key attached).
for (const id of ["AB/12 3", "AB%20CD", "x%20/../../../v2/secret", "a%20b?apiKey=1", "abc%20#frag", "..", " 1 "]) {
  test(`details rejects the non-numeric id ${JSON.stringify(id)} before any request`, async () => {
    const mt = constantJson({});
    await assert.rejects(
      () => clientWith(mt).details(id),
      (err) =>
        err instanceof AusbildungValidationError &&
        err.message === "Invalid id: Expected a numeric offer id (digits only).",
    );
    assert.equal(mt.calls.length, 0);
  });
}

test("details rejects a non-string id with a validation error, not a TypeError", async () => {
  const mt = constantJson({});
  await assert.rejects(
    () => clientWith(mt).details(365241044 as unknown as string),
    (err) => err instanceof AusbildungValidationError,
  );
  assert.equal(mt.calls.length, 0);
});

test("a 404 raises AusbildungApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).details("1"),
    (err) => err instanceof AusbildungApiError && err.status === 404,
  );
});
