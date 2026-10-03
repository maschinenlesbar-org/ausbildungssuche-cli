import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  isBlank,
  nonEmptyProblem,
  offerIdProblem,
  pageProblem,
  placeProblem,
  radiusProblem,
  regionsProblem,
  resultWindowProblem,
  sizeProblem,
  startCodesProblem,
  styProblem,
  validateSearchParams,
  type Problem,
} from "../src/client/validate.js";
import { AusbildungError, AusbildungValidationError } from "../src/client/errors.js";
import * as lib from "../src/index.js";
import { run } from "../src/cli/run.js";
import type { AusbildungssucheClient } from "../src/client/client.js";
import { parity } from "./helpers.js";

const notBlank: Problem = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("ids", "9162", notBlank), "9162");
});

test("assertValid throws AusbildungValidationError naming the input and the reason", () => {
  assert.throws(
    () => assertValid("ids", " ", notBlank),
    (err) =>
      err instanceof AusbildungValidationError &&
      err instanceof AusbildungError &&
      err.message === "Invalid ids: Expected a non-empty value.",
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.AusbildungValidationError, AusbildungValidationError);
});

test("run() maps an AusbildungValidationError from an action to exit 2 with 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const fake = {
    search: async () => assertValid("ids", " ", notBlank),
  } as unknown as AusbildungssucheClient;
  const code = await run(["search"], {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () => fake,
    env: {},
  });
  assert.equal(code, 2);
  assert.deepEqual(err, ["Error: Invalid ids: Expected a non-empty value."]);
  assert.deepEqual(out, []);
});

test("parity() drives the same input through the CLI and the library on one transport", async () => {
  const { cli, lib: l } = await parity(
    ["--api-key", "k", "details", "365241044"],
    (transport) => new lib.AusbildungssucheClient({ transport, apiKey: "k" }).details("365241044"),
  );
  assert.equal(cli.code, 0);
  assert.equal(l.ok, true);
  assert.equal(cli.requests.length, 1);
  assert.deepEqual(l.requests, cli.requests);
});

test("nonEmptyProblem rejects empty and whitespace-only values, isBlank agrees", () => {
  for (const v of ["", " ", "\t", " \n "]) {
    assert.equal(isBlank(v), true, JSON.stringify(v));
    assert.equal(nonEmptyProblem(v), "Expected a non-empty value.");
  }
  for (const v of ["x", " x ", "0"]) {
    assert.equal(isBlank(v), false, JSON.stringify(v));
    assert.equal(nonEmptyProblem(v), undefined);
  }
});

test("validateSearchParams names the blank parameter and leaves undefined alone", () => {
  assert.deepEqual(validateSearchParams({ ids: "9162", sw: undefined }), { ids: "9162", sw: undefined });
  assert.throws(
    () => validateSearchParams({ ids: "9162", bart: " " }),
    (err) => err instanceof AusbildungValidationError && err.message === "Invalid bart: Expected a non-empty value.",
  );
});

test("offerIdProblem accepts digits only", () => {
  for (const id of ["0", "365241044", "007"]) assert.equal(offerIdProblem(id), undefined, id);
  for (const id of ["", "  "]) assert.equal(offerIdProblem(id), "Expected a non-empty value.");
  for (const id of ["abc", " 1", "1 ", "1.5", "-1", "1/2", "%31", "١٢"]) {
    assert.equal(offerIdProblem(id), "Expected a numeric offer id (digits only).", id);
  }
});

test("styProblem accepts integers 0..3 only", () => {
  for (const n of [0, 1, 2, 3]) assert.equal(styProblem(n), undefined, String(n));
  for (const n of [-1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(styProblem(n), "Expected an integer between 0 and 3.", String(n));
  }
});

test("radiusProblem accepts the listed radii exactly", () => {
  for (const uk of ["10", "25", "50", "100", "Bundesweit"]) assert.equal(radiusProblem(uk), undefined, uk);
  assert.equal(radiusProblem(" "), "Expected a non-empty value.");
  for (const uk of ["30", "150", " 25", "bundesweit", "25km"]) {
    assert.equal(radiusProblem(uk), "Expected 10, 25, 50, 100 (km) or Bundesweit.", uk);
  }
});

test("regionsProblem accepts comma-separated uppercase Bundesland codes", () => {
  for (const re of ["BAY", "NRW,THÜ", "BAW,BAY,BER"]) assert.equal(regionsProblem(re), undefined, re);
  assert.equal(regionsProblem(""), "Expected a non-empty value.");
  assert.match(regionsProblem("BW") ?? "", /^Unknown Bundesland code "BW"\. Expected one or more of BAW, /);
  assert.match(regionsProblem("NRW,") ?? "", /^Unknown Bundesland code ""/);
  assert.match(regionsProblem("nrw") ?? "", /^Unknown Bundesland code "nrw"/);
});

test("startCodesProblem accepts 0, 1, 2 and 101..112, comma-separated", () => {
  for (const bt of ["0", "2", "101", "112", "0,2,112"]) assert.equal(startCodesProblem(bt), undefined, bt);
  for (const bt of ["3", "100", "113", "02", "101, 102", "2026-10-01", "1,"]) {
    assert.equal(startCodesProblem(bt), "Expected start-date codes 0, 1, 2 or 101..112, comma-separated.", bt);
  }
});

test("placeProblem wants Name_lon_lat with the coordinates in range", () => {
  for (const orte of ["Köln_6.957_50.938", "X_-180_-90", "Bad Tölz_11.55_47.76"]) {
    assert.equal(placeProblem(orte), undefined, orte);
  }
  for (const orte of ["Köln", "_6.9_50.9", "X_200_10", "X_6.9_95", "X_6,9_50"]) {
    assert.match(placeProblem(orte) ?? "", /^Expected "Name_lon_lat"/, orte);
  }
});

test("validateSearchParams checks numbers and arrays in the form they are sent", () => {
  assert.throws(
    () => validateSearchParams({ uk: 30 as unknown as string }),
    (err) => err instanceof AusbildungValidationError && /^Invalid uk:/.test(err.message),
  );
  assert.throws(
    () => validateSearchParams({ re: ["BAY", "BW"] as unknown as string }),
    (err) => err instanceof AusbildungValidationError && /"BW"/.test(err.message),
  );
  assert.doesNotThrow(() => validateSearchParams({ uk: 25 as unknown as string, ids: 9162 as unknown as string }));
});

test("pageProblem wants a non-negative integer, sizeProblem an integer in 1..20", () => {
  for (const n of [0, 1, 499]) assert.equal(pageProblem(n), undefined, String(n));
  for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(pageProblem(n), "Expected a non-negative integer.", String(n));
  }
  for (const n of [1, 20]) assert.equal(sizeProblem(n), undefined, String(n));
  for (const n of [0, 21, 2000, 1.5, Number.NaN]) {
    assert.equal(sizeProblem(n), "Expected an integer between 1 and 20.", String(n));
  }
});

test("resultWindowProblem keeps (page + 1) × size within 10000 and names the last page", () => {
  for (const p of [{}, { page: 499 }, { page: 9999, size: 1 }, { page: 999, size: 10 }, { size: 20 }]) {
    assert.equal(resultWindowProblem(p), undefined, JSON.stringify(p));
  }
  assert.equal(
    resultWindowProblem({ page: 500 }),
    "500 is past the API's 10000-result window: (page + 1) × size must be at most 10000, " +
      "so with size 20 the last page is 499.",
  );
  assert.match(resultWindowProblem({ page: 1000, size: 10 }) ?? "", /last page is 999\.$/);
});
