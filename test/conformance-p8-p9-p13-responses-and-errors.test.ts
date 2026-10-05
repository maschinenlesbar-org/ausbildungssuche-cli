// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { AusbildungssucheClient as Client } from "../src/client/client.js";
import {
  AusbildungError as BaseError,
  AusbildungParseError as ParseError,
  AusbildungValidationError as ValidationError,
} from "../src/client/errors.js";
import { obtainKey } from "../src/client/obtain-key.js";
import type { AusbildungSearchParams as Params } from "../src/client/types.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.search();
const page = { size: 20, totalElements: 1, totalPages: 1, number: 0 };
const textBody = (text: string): unknown => ({ _embedded: { termine: [{ id: 1, angebot: { titel: text } }] }, page });
const readText = (result: unknown): string =>
  (result as { _embedded: { termine: Array<{ angebot: { titel: string } }> } })._embedded.termine[0]!.angebot.titel;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  null,
  {},
  [],
  "text",
  42,
  { message: "maintenance" },
  { error: "rate limited" },
  { _embedded: { termine: [] } },
  { page: {} },
  { page: { totalElements: "1" } },
  { page, _embedded: [] },
  { page, _embedded: { termine: [null] } },
];
/**
 * A transport that never reaches the network: a call that slips past validation must
 * fail here (as a network error, which the test reports) rather than hit the live API.
 */
const offline = async (): Promise<never> => {
  throw new Error("this test makes no request");
};
const C = (options: Record<string, unknown> = {}): Client =>
  new Client({ transport: offline, maxRetries: 0, ...options } as ConstructorParameters<typeof Client>[0]);
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["search(5)", () => C().search(5 as unknown as Params)],
  ["search('ids=9162')", () => C().search("ids=9162" as unknown as Params)],
  ["search({ ids: {} })", () => C().search({ ids: {} as unknown as string })],
  ["search({ ids: NaN })", () => C().search({ ids: Number.NaN as unknown as string })],
  ["search({ sty: NaN })", () => C().search({ sty: Number.NaN })],
  ["search({ sty: '1' })", () => C().search({ sty: "1" as unknown as number })],
  ["search({ page: -1 })", () => C().search({ page: -1 })],
  ["search({ size: 1.5 })", () => C().search({ size: 1.5 })],
  ["search({ bg: 'yes' })", () => C().search({ bg: "yes" as unknown as boolean })],
  ["search({ orte: new Date() })", () => C().search({ orte: new Date() as unknown as string, uk: "10" })],
  ["details({})", () => C().details({} as unknown as string)],
  ["details(-1)", () => C().details(-1 as unknown as string)],
  ["timeoutMs: 'x'", () => C({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => C({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => C({ maxRetries: 1.5 })],
  ["retryDelayMs: 999999", () => C({ retryDelayMs: 999_999 })],
  ["baseUrl: 5", () => C({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => C({ userAgent: {} as unknown as string })],
  ["apiKey: {}", () => C({ apiKey: {} as unknown as string })],
  ["apiKey: 5", () => C({ apiKey: 5 as unknown as string })],
  ["defaultHeaders: 'x'", () => C({ defaultHeaders: "x" as unknown as Record<string, string> })],
  ["defaultHeaders: { X: 5 }", () => C({ defaultHeaders: { X: 5 as unknown as string } })],
  ["transport: 'fetch'", () => C({ transport: "fetch" as unknown as never })],
  ["sleep: 5", () => C({ sleep: 5 as unknown as never })],
  ["new Client('x')", () => new Client("x" as unknown as ConstructorParameters<typeof Client>[0])],
  ["obtainKey({ sourceUrl: 5 })", () => obtainKey({ sourceUrl: 5 as unknown as string, transport: offline })],
  ["obtainKey({ sourceUrl: 'ftp://h' })", () => obtainKey({ sourceUrl: "ftp://h", transport: offline })],
  ["obtainKey({ timeoutMs: -1 })", () => obtainKey({ timeoutMs: -1, transport: offline })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
