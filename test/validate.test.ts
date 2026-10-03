import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiKeyProblem,
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  httpUrlProblem,
  intRangeProblem,
  isBlank,
  nonEmptyProblem,
  normalizeRadius,
  normalizeRegionCode,
  normalizeRegions,
  normalizeSearchParams,
  offerIdProblem,
  pageProblem,
  placeAndRadiusProblem,
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

test("normalizeRadius maps bundesweit in any case to Bundesweit and is idempotent", () => {
  for (const uk of ["bundesweit", "BUNDESWEIT", "BundesWeit", "Bundesweit"]) {
    assert.equal(normalizeRadius(uk), "Bundesweit", uk);
  }
  // Anything else is left as it is, for radiusProblem to judge.
  for (const uk of ["25", " 25", "30", ""]) assert.equal(normalizeRadius(uk), uk, uk);
  for (const uk of ["bundesweit", "25"]) assert.equal(normalizeRadius(normalizeRadius(uk)), normalizeRadius(uk));
});

test("normalizeRegions trims, NFC-normalises and uppercases each code, and is idempotent", () => {
  assert.equal(normalizeRegionCode(" nrw "), "NRW");
  assert.equal(normalizeRegionCode("TH" + "U\u0308"), "THÜ");
  assert.equal(normalizeRegions(" bay, nrw"), "BAY,NRW");
  assert.equal(normalizeRegions("nrw,thü"), "NRW,THÜ");
  assert.equal(normalizeRegions("NRW,"), "NRW,");
  assert.equal(normalizeRegions("\t"), "");
  for (const re of [" bay, nrw", "thu\u0308", "BW"]) {
    assert.equal(normalizeRegions(normalizeRegions(re)), normalizeRegions(re), re);
  }
});

test("normalizeSearchParams canonicalises re and uk only, without mutating its input", () => {
  const params = { re: " nrw", uk: "bundesweit", sw: " Koch " };
  assert.deepEqual(normalizeSearchParams(params), { re: "NRW", uk: "Bundesweit", sw: " Koch " });
  assert.deepEqual(params, { re: " nrw", uk: "bundesweit", sw: " Koch " });
  assert.deepEqual(normalizeSearchParams({ re: ["nrw", "bay"] as unknown as string }), { re: ["NRW", "BAY"] });
  assert.deepEqual(normalizeSearchParams({ uk: 25 as unknown as string }), { uk: 25 });
  assert.deepEqual(normalizeSearchParams({}), {});
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
  assert.doesNotThrow(() =>
    validateSearchParams({ orte: "K_6.9_50.9", uk: 25 as unknown as string, ids: 9162 as unknown as string }),
  );
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

test("placeAndRadiusProblem wants orte and a km uk together", () => {
  const P = "Köln_6.957_50.938";
  for (const p of [{}, { uk: "Bundesweit" }, { orte: P, uk: "25" }, { orte: P, uk: "Bundesweit" }]) {
    assert.equal(placeAndRadiusProblem(p), undefined, JSON.stringify(p));
  }
  assert.match(placeAndRadiusProblem({ uk: "25" }) ?? "", /^uk 25 needs orte: .* Leave uk out \(or use uk Bundesweit\)/);
  assert.match(placeAndRadiusProblem({ orte: P }) ?? "", /^orte needs uk: /);
  assert.match(placeAndRadiusProblem({ uk: "10" }, (p) => `--${p}`) ?? "", /^--uk 10 needs --orte: /);
});

test("search() names the pairing rule when orte or uk comes alone", () => {
  assert.throws(
    () => validateSearchParams({ uk: "25" }),
    (err) => err instanceof AusbildungValidationError && /^Invalid orte and uk: uk 25 needs orte/.test(err.message),
  );
});

test("intRangeProblem accepts safe integers in range only", () => {
  const p = intRangeProblem(0, 10);
  for (const n of [0, 5, 10]) assert.equal(p(n), undefined, String(n));
  for (const n of [-1, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(p(n), "Expected an integer between 0 and 10.", String(n));
  }
  assert.equal(p("5" as unknown as number), "Expected an integer between 0 and 10.");
  const nonNegative = intRangeProblem(0, Number.MAX_SAFE_INTEGER);
  assert.equal(nonNegative(-1), "Expected a non-negative integer.");
  assert.equal(nonNegative(2 ** 53), "Expected a non-negative integer.");
});

test("headerValueProblem rejects blank, control and non-Latin-1 values", () => {
  for (const v of ["ua", "a\tb", "é", "my-app/1.0 (+https://x)"]) assert.equal(headerValueProblem(v), undefined, v);
  assert.equal(headerValueProblem(""), "Expected a non-empty value.");
  assert.equal(headerValueProblem("  "), "Expected a non-empty value.");
  for (const code of [0x00, 0x0a, 0x0d, 0x1b, 0x7f]) {
    assert.equal(headerValueProblem(`a${String.fromCharCode(code)}b`), "Value contains control characters.", String(code));
  }
  assert.equal(headerValueProblem("€"), "Value contains characters outside Latin-1 (above U+00FF).");
  assert.equal(headerValueProblem(1 as unknown as string), "Expected a string.");
});

test("apiKeyProblem checks the trimmed key as a header value", () => {
  for (const key of ["k", " k ", "k\n", "\tk\t", "a b"]) assert.equal(apiKeyProblem(key), undefined, JSON.stringify(key));
  for (const key of ["", "  ", "\n"]) assert.equal(apiKeyProblem(key), "Expected a non-empty value.", JSON.stringify(key));
  assert.equal(apiKeyProblem(" a\nb "), "Value contains control characters.");
  assert.equal(apiKeyProblem("k€"), "Value contains characters outside Latin-1 (above U+00FF).");
  assert.equal(apiKeyProblem(42 as unknown as string), "Expected a string.");
});

test("httpUrlProblem wants an absolute http(s) URL, query allowed", () => {
  for (const url of ["https://h.example/a.md", "http://h/x?y=1"]) assert.equal(httpUrlProblem(url), undefined, url);
  assert.equal(httpUrlProblem(""), "Expected a non-empty value.");
  assert.equal(httpUrlProblem("notaurl"), "Expected an absolute http(s) URL.");
  assert.equal(httpUrlProblem("ftp://h/x"), 'Unsupported scheme "ftp:". Expected an http(s) URL.');
  assert.equal(httpUrlProblem(1 as unknown as string), "Expected an absolute http(s) URL.");
});

test("headerNameProblem wants an HTTP token", () => {
  for (const n of ["X-API-Key", "User-Agent", "x_y.z"]) assert.equal(headerNameProblem(n), undefined, n);
  for (const n of ["", "Bad Name", "a:b", "ä"]) assert.notEqual(headerNameProblem(n), undefined, n);
});

test("baseUrlProblem checks the raw value", () => {
  for (const u of ["https://h.test", "http://127.0.0.1:1/mirror/", "https://u:p@h.test/p"]) {
    assert.equal(baseUrlProblem(u), undefined, u);
  }
  const cases: Array<[string, string]> = [
    ["", "Expected a non-empty value."],
    [" https://h.test", "A base URL cannot have surrounding whitespace."],
    ["https://h.test/\n", "A base URL cannot have surrounding whitespace."],
    ["https://h.test/a b", "A base URL cannot contain whitespace or control characters."],
    ["https://h.te\u007fst", "A base URL cannot contain whitespace or control characters."],
    ["notaurl", "Expected an absolute http(s) URL."],
    ["file:///etc/passwd", 'Unsupported scheme "file:". Expected an http(s) URL.'],
    ["https://h.test/?a=1", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.test/#f", "A base URL cannot have a query (?) or fragment (#)."],
  ];
  for (const [u, reason] of cases) assert.equal(baseUrlProblem(u), reason, JSON.stringify(u));
});
