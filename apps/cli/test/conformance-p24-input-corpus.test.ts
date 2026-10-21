// Conformance test P24 (trend analysis 2026-10-21; fix plan 2026-10-21, D8 and D10): an input
// is canonicalised or refused, never sent raw. One corpus of tricky values goes through every
// text filter, every token (id, code, enum, sort key) and every list the repo declares, on the
// CLI and in the library. Either both refuse it before any request (exit 2, the validation
// error), or both send the same request with the value in canonical form: a text without
// surrounding whitespace, in composed Unicode, never blank; a token as the adapter canonicalises
// it, never empty, a dot segment or with a "/"; a list item by item. A value that holds only
// invisible characters or combining marks is blank. A refusal shows an invisible or control
// character escaped (`\u200b`), never raw. Each value here was once sent raw by some *-cli and
// matched nothing, or the wrong thing, with exit 0. Shared across the *-cli repos; only the
// adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/ausbildungssuche-client/internal/http";

// ---- adapter (per repo) -------------------------------------------------------------
import type { Transport } from "@maschinenlesbar.org/ausbildungssuche-client/internal/http";
import { okResponse, parity as repoParity } from "./helpers.js";
/** The exit code of a usage error in this repo (commander's default is 1; most repos use 2). */
const USAGE_EXIT = 2;
import { AusbildungssucheClient as Client } from "@maschinenlesbar.org/ausbildungssuche-client/internal/client";
interface Input<T = string | null> {
  name: string;
  /** CLI argv that sends `value`. */
  argv: (value: string) => string[];
  /** The same in the library. */
  lib: (client: Client, value: string) => Promise<unknown>;
  /** The value as it went out, read from the request URL (null when it wasn't sent). */
  sent: (url: URL) => T;
}
/** A place's `_lon_lat` ending, appended to the name under test. */
const AT = "_6.957_50.938";
/**
 * Every text filter (sent as a query parameter): the search term `sw` (ignored by the API
 * today, still sent) and the name of an `orte` place (`Name_lon_lat`; a km radius with it).
 */
const textInputs: Input[] = [
  { name: "search --sw", argv: (v) => ["search", "--sw", v], lib: (c, v) => c.search({ sw: v }), sent: (u) => u.searchParams.get("sw") },
  {
    name: "search --orte (the name)",
    argv: (v) => ["search", "--orte", `${v}${AT}`, "--uk", "25"],
    lib: (c, v) => c.search({ orte: `${v}${AT}`, uk: "25" }),
    sent: (u) => u.searchParams.get("orte")?.replace(/_6\.957_50\.938$/, "") ?? null,
  },
];
/**
 * Every token: the offer id of `details` (digits only, in the path), and the single-value
 * codes the search sends as query parameters, the radius `uk` (an enum) and the training type
 * `bart`. None of the corpus's ids is a valid one of these, so they are all refused; the
 * REFUSED corpus checks that the refusal shows an invisible character escaped.
 */
const idInputs: Input[] = [
  { name: "details", argv: (v) => ["details", v], lib: (c, v) => c.details(v), sent: (u) => decodeURIComponent(u.pathname.slice(u.pathname.lastIndexOf("/") + 1)) },
  { name: "search --uk", argv: (v) => ["search", "--uk", v], lib: (c, v) => c.search({ uk: v }), sent: (u) => u.searchParams.get("uk") },
  { name: "search --bart", argv: (v) => ["search", "--bart", v], lib: (c, v) => c.search({ bart: v }), sent: (u) => u.searchParams.get("bart") },
];
/**
 * This API's lists hold codes, not free tokens: the corpus's `a1`, `a2` and `e\u0301` stand
 * for real codes, mapped item by item (surrounding whitespace kept; any other item as it is),
 * and mapped back when read from the request. For `re`, `e\u0301` stands for an NFD `THÜ`.
 */
function codes(map: Record<string, string>): { to: (value: string) => string; from: (sent: string | null) => string[] | null } {
  const back = new Map(Object.entries(map).map(([k, v]) => [v.normalize("NFC"), k.normalize("NFC")]));
  return {
    to: (value) => value.split(",").map((item) => item.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_m, a: string, core: string, b: string) => a + (map[core] ?? core) + b)).join(","),
    from: (sent) => (sent === null ? null : sent.split(",").map((item) => back.get(item) ?? item)),
  };
}
const IDS = codes({ a1: "9162", a2: "9106", "e\u0301": "123" });
const RE = codes({ a1: "NRW", a2: "BAY", "e\u0301": "THU\u0308" });
const BT = codes({ a1: "101", a2: "102", "e\u0301": "103" });
/** Every comma-separated list option; `sent` gives the items as they went out (mapped back). */
const listInputs: Array<Input<string[] | null>> = [
  { name: "search --ids", argv: (v) => ["search", "--ids", IDS.to(v)], lib: (c, v) => c.search({ ids: IDS.to(v) }), sent: (u) => IDS.from(u.searchParams.get("ids")) },
  { name: "search --re", argv: (v) => ["search", "--re", RE.to(v)], lib: (c, v) => c.search({ re: RE.to(v) }), sent: (u) => RE.from(u.searchParams.get("re")) },
  { name: "search --bt", argv: (v) => ["search", "--bt", BT.to(v)], lib: (c, v) => c.search({ bt: BT.to(v) }), sent: (u) => BT.from(u.searchParams.get("bt")) },
];
/** The id as the repo sends it: trimmed and in NFC (normalizeToken); leading zeros are kept. */
const canonicalId = (value: string): string => value.trim().normalize("NFC");
/** A valid answer to any of these requests: the search envelope, or an array with one offer. */
const respond = (req: HttpRequest): HttpResponse => okResponse(req);
/**
 * The shared body's parity(argv, call, responder) over this repo's parity(argv, call, { responder }),
 * with the library's error as { name, message }, as the shared body reads it.
 */
async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
) {
  const o = await repoParity(argv, call, responder === undefined ? {} : { responder });
  const e = o.lib.error;
  const error = e === undefined ? undefined : e instanceof Error ? { name: e.constructor.name, message: e.message } : { name: typeof e, message: String(e) };
  return { cli: o.cli, lib: { ok: o.lib.ok, value: o.lib.value, error, requests: o.lib.requests } };
}
// --------------------------------------------------------------------------------------

/** Values every input refuses: blank, only invisible characters or combining marks, a lone surrogate, a control or format character. */
const REFUSED = [
  "", " ", "\u00a0", "\n\t", "\u3000", "\u200b", "\u00ad", "\u200d", "\ufeff", "\u0301\u0308", " \u200b ",
  "a\u200bb", "M\u00fcl\u00adler", "\u202eabc", "a\u0000b", "a\u001bb", "a\u0085b", "\ud800", "a\udc00b", "x\ud83d",
];
const TEXT_CORPUS = [
  "Müller", "Mu\u0308ller", "  Müller  ", "\u00a0Müller\u00a0", "Müller\n", "\tMüller", "a  b", "A\u030a",
  "ﬁ", "x".repeat(5000), "\u3000x", "😀 smile", "a\u200db",
];
const ID_CORPUS = ["a1", " a1 ", "a1\n", " a1", ".", "..", " .. ", "a1/../a2", "a1/", "/a1", "%2e%2e", "a b", "e\u0301"];
const LIST_REFUSED = ["", ",", " , ", "a1,,a2", "a1,", ",a1", "a1,\u200b", "a1,a\u200bb", "\ud800,a1"];
const LIST_CORPUS = ["a1", "a1,a2", " a1 , a2 ", "e\u0301,a2", "a1,a1"];

type Outcome = Awaited<ReturnType<typeof parity>>;

/** Both sides refused before any request, or both sent the same requests. Returns the one sent URL, if any. */
function sameOutcome(o: Outcome, label: string): URL | undefined {
  if (o.cli.code === USAGE_EXIT) {
    assert.deepEqual(o.cli.requests, [], `${label}: the CLI refused but sent a request`);
    assert.equal(o.lib.ok, false, `${label}: the CLI refused, the library resolved`);
    assert.deepEqual(o.lib.requests, [], `${label}: the library sent a request`);
    assert.match(o.lib.error?.name ?? "", /ValidationError$/, `${label}: ${String(o.lib.error)}`);
    return undefined;
  }
  assert.equal(o.cli.code, 0, `${label}: CLI exit ${o.cli.code}: ${o.cli.err}`);
  assert.equal(o.lib.ok, true, `${label}: the library rejected: ${String(o.lib.error?.message)}`);
  assert.deepEqual(o.lib.requests.map((r) => r.url), o.cli.requests.map((r) => r.url), `${label}: different requests`);
  assert.equal(o.cli.requests.length, 1, label);
  return new URL(o.cli.requests[0]!.url);
}

/** A control, format or lone-surrogate character in `value`, or undefined. */
const INVISIBLE = /[\p{Cc}\p{Cf}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

/** A refusal of `value` shows its invisible character as an escape on both sides, never raw (D10). */
function refusedVisibly(o: Outcome, value: string, label: string): void {
  const blank = value.replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, "") === "";
  const ch = INVISIBLE.exec(value.trim())?.[0];
  if (ch === undefined || blank) return;
  const escape = `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  assert.ok(o.cli.err.toLowerCase().includes(escape), `${label}: the CLI's refusal doesn't show ${escape}: ${o.cli.err}`);
  assert.ok(!o.cli.err.includes(ch), `${label}: the CLI's refusal shows the character raw`);
  assert.ok((o.lib.error?.message ?? "").toLowerCase().includes(escape), `${label}: the library's refusal doesn't show ${escape}: ${o.lib.error?.message}`);
}

const short = (value: string): string => JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value);

test("P24: a text filter is sent trimmed and in composed Unicode, or refused; never blank", async () => {
  for (const input of textInputs) {
    for (const value of TEXT_CORPUS) {
      const label = `${input.name} ${short(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      if (url === undefined) continue;
      const sent = input.sent(url);
      assert.ok(sent !== null && sent !== "", `${label}: not sent`);
      const canonical = [value.trim().normalize("NFC"), value.trim().normalize("NFKC")];
      assert.ok(canonical.includes(sent), `${label}: sent ${JSON.stringify(sent)}`);
    }
  }
});

test("P24: every input refuses a blank, invisible, control or half character, before any request, showing it escaped", async () => {
  const inputs = [...textInputs, ...idInputs];
  for (const input of inputs) {
    for (const value of REFUSED) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const o = await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond);
      assert.equal(o.cli.code, USAGE_EXIT, `${label}: CLI exit ${o.cli.code}, sent ${o.cli.requests.map((r) => r.url).join(" ")}`);
      assert.equal(sameOutcome(o, label), undefined, label);
      refusedVisibly(o, value, label);
    }
  }
});

test("P24: an id is sent in its canonical form, or refused; never empty, a dot segment or with a slash", async () => {
  for (const input of idInputs) {
    for (const value of ID_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      const id = canonicalId(value);
      if (id === "" || id === "." || id === ".." || id.includes("/")) {
        assert.equal(url, undefined, `${label}: sent although it would re-target the request`);
        continue;
      }
      if (url === undefined) continue;
      assert.equal(input.sent(url), id, label);
    }
  }
});

test("P24: a list is canonicalised item by item; an empty or invisible item refuses the whole list", async () => {
  for (const input of listInputs) {
    for (const value of LIST_REFUSED) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const o = await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond);
      assert.equal(o.cli.code, USAGE_EXIT, `${label}: CLI exit ${o.cli.code}`);
      assert.equal(sameOutcome(o, label), undefined, label);
      refusedVisibly(o, value.split(",").find((item) => INVISIBLE.test(item)) ?? "", label);
    }
    for (const value of LIST_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      assert.ok(url !== undefined, `${label}: refused`);
      assert.deepEqual(input.sent(url), value.split(",").map(canonicalId), label);
    }
  }
});
