// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/http.js";

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function rawResponse(
  data: string | Buffer,
  contentType: string,
  status = 200,
): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

/** A redirect (3xx) response pointing at `location`. */
export function redirectResponse(location: string, status = 302): HttpResponse {
  return {
    status,
    headers: { location },
    body: Buffer.alloc(0),
  };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/** A search result with no hits, as the API answers it (no `_embedded`). */
export const EMPTY_SEARCH = { _links: {}, page: { size: 20, totalElements: 0, totalPages: 0, number: 0 } };

/** A details answer: an array with one offer record. */
export const ONE_OFFER = [{ id: 1, angebot: { titel: "Angebot" } }];

/**
 * A 200 answer in the shape the client accepts for the request's endpoint: the
 * search envelope for the collection, an array with one offer for `/{id}`, and `{}`
 * for anything else (the engine's own tests).
 */
export function okResponse(req: HttpRequest): HttpResponse {
  const path = new URL(req.url).pathname;
  if (/\/ausbildungsangebot\/[^/]+$/.test(path)) return jsonResponse(ONE_OFFER);
  if (/\/ausbildungsangebot$/.test(path)) return jsonResponse(EMPTY_SEARCH);
  return jsonResponse({});
}

/** A transport that always returns the same JSON body. */
export function constantJson(body: unknown, status = 200): MockTransport {
  return makeMockTransport(() => jsonResponse(body, status));
}
