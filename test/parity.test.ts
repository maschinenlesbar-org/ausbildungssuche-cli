// CLI ↔ library parity: the same input through run() and through the library, on
// one recording mock transport, must give the same outcome — both reject before
// any request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AusbildungssucheClient } from "../src/client/client.js";
import { AusbildungValidationError } from "../src/client/errors.js";
import type { AusbildungSearchParams } from "../src/client/types.js";
import type { Transport } from "../src/client/http.js";
import { parity } from "./helpers.js";

type Parity = Awaited<ReturnType<typeof parity>>;

/** Both sides reject the input as a usage/validation error and send nothing. */
function assertBothReject({ cli, lib }: Parity, message?: RegExp): void {
  assert.equal(cli.code, 2, `CLI exit (stderr: ${cli.err})`);
  assert.equal(lib.ok, false, "the library must reject");
  assert.ok(lib.error instanceof AusbildungValidationError, `library error: ${String(lib.error)}`);
  assert.deepEqual(cli.requests, [], "the CLI must send no request");
  assert.deepEqual(lib.requests, [], "the library must send no request");
  if (message) {
    assert.match(cli.err, message);
    assert.match((lib.error as Error).message, message);
  }
}

/** Both sides succeed with the identical request. */
function assertSameRequest({ cli, lib }: Parity): void {
  assert.equal(cli.code, 0, `CLI exit (stderr: ${cli.err})`);
  assert.equal(lib.ok, true, `library error: ${String(lib.error)}`);
  assert.equal(cli.requests.length, 1);
  assert.deepEqual(lib.requests, cli.requests);
}

const KEY = "test-key";
const client = (transport: Transport) => new AusbildungssucheClient({ transport, apiKey: KEY });
const search = (argv: string[], params: AusbildungSearchParams) =>
  parity(["--api-key", KEY, "search", ...argv], (t) => client(t).search(params));

// The CLI sends parameters in its option order (sw, sty, orte, re, uk, ids, bart,
// bg, bt, page, size); the library params below follow it so the URLs compare equal.

// Finding #1 (PAT-9): a blank filter is an empty parameter the API ignores, so the
// search would silently run unfiltered.
for (const [name, value] of [
  ["sw", ""],
  ["sw", "  "],
  ["ids", ""],
  ["ids", " "],
  ["bart", " "],
  ["re", "\t"],
  ["bt", ""],
  ["uk", ""],
  ["orte", ""],
] as const) {
  test(`parity: a blank ${name} ${JSON.stringify(value)} is rejected by CLI and library alike`, async () => {
    assertBothReject(await search([`--${name}`, value], { [name]: value }), /non-empty/);
  });
}

test("parity: a non-blank filter is sent identically", async () => {
  assertSameRequest(await search(["--ids", "9162", "--sw", "Koch"], { sw: "Koch", ids: "9162" }));
});

// Finding #6 (PAT-10): offer ids are numeric; anything else re-targets or garbles
// the detail path and is sent with the API key.
const details = (id: string) =>
  parity(["--api-key", KEY, "details", "--", id], (t) => client(t).details(id));

for (const id of ["abc", " 123 ", "12/34", "%31%32", "12%2F3", "1.5", "-1", "0x10", "?x", "#x", "a\tb", "AB%20CD"]) {
  test(`parity: details ${JSON.stringify(id)} is rejected by CLI and library alike`, async () => {
    assertBothReject(await details(id), /numeric offer id/);
  });
}

for (const id of ["", "  "]) {
  test(`parity: details with a blank id ${JSON.stringify(id)} is rejected by CLI and library alike`, async () => {
    assertBothReject(await details(id), /non-empty/);
  });
}

test("parity: a numeric offer id is sent identically", async () => {
  assertSameRequest(await details("365241044"));
});

// Finding #4 (PAT-12): values outside the API's closed value sets, and a malformed
// place, are rejected by both sides before any request (the API answers 400/500).
const P = "Köln_6.957_50.938";
for (const [name, argv, params, message] of [
  ["sty 4", ["--sty", "4"], { sty: 4 }, /between 0 and 3/],
  ["re BW", ["--re", "BW"], { re: "BW" }, /Unknown Bundesland code "BW"/],
  ["re NRW,", ["--re", "NRW,"], { re: "NRW," }, /Unknown Bundesland code ""/],
  ["uk 30", ["--orte", P, "--uk", "30"], { orte: P, uk: "30" }, /10, 25, 50, 100 \(km\) or Bundesweit/],
  ["bt 113", ["--bt", "113"], { bt: "113" }, /start-date codes/],
  ["bt '101, 102'", ["--bt", "101, 102"], { bt: "101, 102" }, /start-date codes/],
  ["bt 2026-10-01", ["--bt", "2026-10-01"], { bt: "2026-10-01" }, /start-date codes/],
  ["orte Köln", ["--orte", "Köln", "--uk", "25"], { orte: "Köln", uk: "25" }, /Name_lon_lat/],
  ["orte Köln_6.9_95", ["--orte", "Köln_6.9_95", "--uk", "25"], { orte: "Köln_6.9_95", uk: "25" }, /Name_lon_lat/],
  ["orte _6.9_50.9", ["--orte", "_6.9_50.9", "--uk", "25"], { orte: "_6.9_50.9", uk: "25" }, /Name_lon_lat/],
] as const) {
  test(`parity: search ${name} is rejected by CLI and library alike`, async () => {
    assertBothReject(await search([...argv], params as AusbildungSearchParams), message);
  });
}

test("parity: valid closed-set values are sent identically", async () => {
  assertSameRequest(
    await search(
      ["--sty", "3", "--orte", P, "--re", "BAY,THÜ", "--uk", "Bundesweit", "--bt", "0,2,101,112"],
      { sty: 3, orte: P, re: "BAY,THÜ", uk: "Bundesweit", bt: "0,2,101,112" },
    ),
  );
});

// The CLI cannot express these (its parser takes digits only); the library must
// still reject them rather than send them.
test("the library rejects a sty that is not an integer in 0..3", async () => {
  for (const sty of [-1, 1.5, Number.NaN, 4]) {
    const { lib } = await search([], { sty });
    assert.ok(lib.error instanceof AusbildungValidationError, String(sty));
    assert.deepEqual(lib.requests, []);
  }
});

// Finding #3 (PAT-11): size 1..20, a non-negative integer page, and the
// 10,000-result window ((page + 1) × size ≤ 10000).
for (const [name, argv, params, message] of [
  ["size 0", ["--size", "0"], { size: 0 }, /between 1 and 20/],
  ["size 21", ["--size", "21"], { size: 21 }, /between 1 and 20/],
  ["size 50", ["--size", "50"], { size: 50 }, /between 1 and 20/],
  ["page 500", ["--page", "500"], { page: 500 }, /10000-result window.*last page is 499/],
  ["page 1000 size 10", ["--page", "1000", "--size", "10"], { page: 1000, size: 10 }, /10000-result window.*last page is 999/],
  ["page 10000 size 1", ["--page", "10000", "--size", "1"], { page: 10000, size: 1 }, /10000-result window/],
] as const) {
  test(`parity: search ${name} is rejected by CLI and library alike`, async () => {
    assertBothReject(await search([...argv], params), message);
  });
}

for (const [name, argv, params] of [
  ["page 499", ["--page", "499"], { page: 499 }],
  ["page 9999 size 1", ["--page", "9999", "--size", "1"], { page: 9999, size: 1 }],
  ["size 20", ["--size", "20"], { size: 20 }],
  ["page 0 size 1", ["--page", "0", "--size", "1"], { page: 0, size: 1 }],
] as const) {
  test(`parity: search ${name} is sent identically`, async () => {
    assertSameRequest(await search([...argv], params));
  });
}

// The CLI's parsers take digits only, so it cannot express these; the library must
// still reject them rather than send them.
test("the library rejects a page or size that is not a non-negative integer", async () => {
  for (const params of [
    { page: -1 }, { page: 1.5 }, { page: Number.NaN }, { page: Number.POSITIVE_INFINITY },
    { size: 1.5 }, { size: -1 }, { size: Number.NaN },
  ]) {
    const { lib } = await search([], params);
    assert.ok(lib.error instanceof AusbildungValidationError, JSON.stringify(params));
    assert.deepEqual(lib.requests, []);
  }
});

// Finding #2 (PAT-14): a km radius without a place is ignored by the API, and a
// place without a radius does not narrow the search; either alone would return the
// nationwide set.
test("parity: uk 25 without orte is rejected by CLI and library alike", async () => {
  assertBothReject(await search(["--uk", "25"], { uk: "25" }), /uk 25 needs (--)?orte/);
});

test("parity: orte without uk is rejected by CLI and library alike", async () => {
  assertBothReject(await search(["--orte", P], { orte: P }), /orte needs (--)?uk/);
});

for (const [name, argv, params] of [
  ["uk Bundesweit alone", ["--uk", "Bundesweit"], { uk: "Bundesweit" }],
  ["orte with uk 25", ["--orte", P, "--uk", "25"], { orte: P, uk: "25" }],
  ["orte with uk Bundesweit", ["--orte", P, "--uk", "Bundesweit"], { orte: P, uk: "Bundesweit" }],
] as const) {
  test(`parity: ${name} is sent identically`, async () => {
    assertSameRequest(await search([...argv], params));
  });
}
