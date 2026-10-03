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
