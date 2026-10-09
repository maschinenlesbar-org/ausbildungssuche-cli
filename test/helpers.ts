// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/client/http.js";
import { run } from "../src/cli/run.js";
import { AusbildungssucheClient } from "../src/client/client.js";

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

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [ausbildungssuche.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

/** One request as the parity helper records it. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string> | undefined;
}

/** What `run()` did with one argv. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: RecordedRequest[];
}

/** What one library call did. */
export interface LibOutcome {
  ok: boolean;
  value?: unknown;
  /** The thrown error, when `ok` is false. */
  error?: unknown;
  requests: RecordedRequest[];
}

export interface ParityOptions {
  /** Answers every request (both sides); defaults to `okResponse`. */
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
  /** The CLI's environment (AUSBILDUNGSSUCHE_API_KEY); defaults to none. */
  env?: Record<string, string | undefined>;
}

function recorded(calls: readonly HttpRequest[]): RecordedRequest[] {
  return calls.map((c) => ({ method: c.method, url: c.url, headers: c.headers }));
}

/**
 * Drive one input through the CLI and through the library on ONE recording mock
 * transport, and return both outcomes so a test can assert they agree: either both
 * reject and send nothing, or both send the identical request.
 *
 * The CLI side runs `run(argv)` in-process with the real program; its client
 * factory and its `deps.transport` (obtain-key) both use the recording transport.
 * The library side gets the same transport and returns the call's promise, e.g.
 * `(transport) => new AusbildungssucheClient({ transport }).search({ ids: " " })`.
 * A synchronous throw from the library call counts as a rejection too.
 */
export async function parity(
  argv: string[],
  libCall: (transport: Transport) => unknown,
  options: ParityOptions = {},
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  const mt = makeMockTransport(options.responder ?? okResponse);
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new AusbildungssucheClient({ ...opts, transport: mt.transport }),
    env: options.env ?? {},
    transport: mt.transport,
  });
  const cliCalls = mt.calls.length;
  const cli: CliOutcome = {
    code,
    out: out.join("\n"),
    err: untimed(err.join("\n")),
    requests: recorded(mt.calls.slice(0, cliCalls)),
  };

  let lib: LibOutcome;
  try {
    const value = await libCall(mt.transport);
    lib = { ok: true, value, requests: recorded(mt.calls.slice(cliCalls)) };
  } catch (error) {
    lib = { ok: false, error, requests: recorded(mt.calls.slice(cliCalls)) };
  }
  return { cli, lib };
}
