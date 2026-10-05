// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { AusbildungssucheClient as Client } from "../src/client/client.js";
import { AusbildungValidationError as ValidationError } from "../src/client/errors.js";
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> => client.search(query as never);
/** A valid query, and the filters it sends (read back from the request by `sentFilter`). */
const GOOD = { query: { ids: "9162,9106", re: "NRW" } };
const GOOD_SENT = "ids=9162,9106 re=NRW";
/** What a data request carries as its filters (to compare with GOOD_SENT). */
const sentFilter = (req: HttpRequest): string | null => {
  const q = new URL(req.url).searchParams;
  return `ids=${q.get("ids")} re=${q.get("re")}`;
};
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { bundesland: "NRW" }],
  ["misspelled key", { idss: "9162" }],
  ["wrong-case key", { IDS: "9162" }],
  ["__proto__ key", JSON.parse('{"__proto__": {"ids": "9162"}}') as Record<string, unknown>],
  ["constructor key", { constructor: "9162" }],
];
/**
 * Values outside the API's closed value sets, which it answers with HTTP 400/500 (this
 * API's filters are parameters, not filter names inside a value).
 */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [
  ["unknown Bundesland code", { re: "XYZ" }],
  ["unknown start-date code", { bt: "999" }],
  ["unknown radius", { orte: "Köln_6.957_50.938", uk: "30" }],
  ["a place without coordinates", { orte: "Köln", uk: "10" }],
  ["offer type out of range", { sty: 4 }],
  ["non-numeric occupation id", { ids: "abc" }],
  ["occupation ids with a trailing comma", { ids: "9162," }],
  ["non-numeric training type", { bart: "10x" }],
];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array ids", { ids: ["9162", "9106"] }],
  ["array re", { re: ["NRW", "BAY"] }],
  ["object ids", { ids: { a: "9162" } }],
  ["NaN page", { page: Number.NaN }],
  ["NaN size", { size: Number.NaN }],
  ["array page", { page: [1, 2] }],
];
/**
 * Queries that differ from GOOD only in how a value is spelled (case, padding, NFD): the
 * API answers lowercase `re` with HTTP 400. "normalise" = sent as GOOD_SENT.
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [
  ["lower case re", { ids: "9162,9106", re: "nrw" }],
  ["padded re", { ids: "9162,9106", re: " NRW " }],
  ["mixed case re", { ids: "9162,9106", re: "Nrw" }],
  ["padded ids", { ids: " 9162 , 9106 ", re: "NRW" }],
];
const UNNORMALISED_POLICY = "normalise" as "normalise" | "reject";
/** The CLI's filter flag given twice (the two halves of GOOD), and what the repo does with it. */
const REPEATED_FLAG_ARGV = ["search", "--re", "NRW", "--ids", "9162", "--ids", "9106"];
const REPEATED_POLICY = "combine" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["search", "--orte", "Köln_6.957_50.938", "--uk", "10", "--uk", "50"];
const USAGE_EXIT = 2;
/** True for a request that fetches data (every request does here). */
const isDataRequest = (_req: HttpRequest): boolean => true;
/** The answer to any request. */
const respond = (_req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/hal+json" },
  body: Buffer.from(JSON.stringify({ _links: {}, page: { size: 20, totalElements: 5, totalPages: 1, number: 0 } })),
});
/** CliDeps for this repo. */
const makeDeps = (io: CliDeps["io"], transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io,
  env: {},
  createClient: (opts) => new Client({ ...opts, transport }),
  transport,
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
