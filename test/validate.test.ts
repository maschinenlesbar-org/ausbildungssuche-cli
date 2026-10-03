import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  isBlank,
  nonEmptyProblem,
  offerIdProblem,
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
