import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { AusbildungssucheClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

const SERVICE = "/infosysbub/absuche";

function makeCli(
  responder: (req: HttpRequest) => HttpResponse,
  env: Record<string, string | undefined> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new AusbildungssucheClient({ ...opts, transport: mt.transport }),
    env,
  };
  return { deps, out, err, mt };
}

test("search builds the query and sends no key when none is configured", async () => {
  const cli = makeCli(() => jsonResponse({ page: {} }));
  const code = await run(["search", "--sw", "Informatik", "--size", "5"], cli.deps);
  assert.equal(code, 0);
  const req = cli.mt.last();
  // No key is bundled: without --api-key/env the header is omitted.
  assert.equal(req.headers?.["X-API-Key"], undefined);
  assert.equal(new URL(req.url).pathname, `${SERVICE}/pc/v1/ausbildungsangebot`);
});

test("--api-key overrides the header", async () => {
  const cli = makeCli(() => jsonResponse({}));
  await run(["--api-key", "custom", "search", "--sw", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "custom");
});

test("details builds the per-id path", async () => {
  const cli = makeCli(() => jsonResponse({}));
  await run(["details", "365241044"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    `${SERVICE}/pc/v1/ausbildungsangebot/365241044`,
  );
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { id: 12345, titel: `Koch${controls}`, beruf: String.fromCharCode(0x1b) + "[31m" };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "details", "12345"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) =>
      c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f,
    );
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Koch\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--timeout", "2147483647", "details", "12345"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--timeout", "2147483648", "details", "12345"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /between 0 and 2147483647/);
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["details", "999"], cli.deps);
  assert.equal(code, 4);
});

test("a 401 maps to exit code 3 with an auth hint", async () => {
  const cli = makeCli(() => jsonResponse({}, 401));
  const code = await run(["search", "--sw", "x"], cli.deps);
  assert.equal(code, 3);
  assert.ok(cli.err.some((line) => line.includes("X-API-Key")));
});

test("a 403 maps to exit code 3", async () => {
  const cli = makeCli(() => jsonResponse({}, 403));
  assert.equal(await run(["search", "--sw", "x"], cli.deps), 3);
});

test("a 406 maps to exit code 5 with an Accept hint", async () => {
  const cli = makeCli(() => jsonResponse({}, 406));
  const code = await run(["search", "--sw", "x"], cli.deps);
  assert.equal(code, 5);
  assert.ok(cli.err.some((line) => line.includes("Accept")));
});

test("AUSBILDUNGSSUCHE_API_KEY env var supplies the key when no --api-key", async () => {
  const cli = makeCli(() => jsonResponse({}), { AUSBILDUNGSSUCHE_API_KEY: "env-key" });
  await run(["search", "--sw", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "env-key");
});

test("--api-key overrides the env var (CLI flag > env > none)", async () => {
  const cli = makeCli(() => jsonResponse({}), { AUSBILDUNGSSUCHE_API_KEY: "env-key" });
  await run(["--api-key", "flag-key", "search", "--sw", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "flag-key");
});

test("no X-API-Key is sent when neither flag nor env is set (no bundled default)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  await run(["search", "--sw", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
});

test("--help does not leak the env API key (commander default disclosure)", async () => {
  // Regression for AUS-001: seeding the env key as the commander option DEFAULT
  // made --help render it verbatim. The env is set here, so if the key were
  // still the option default it would appear in the captured help text.
  const secret = "SUPER-SECRET-KEY-123";
  const cli = makeCli(() => jsonResponse({}), { AUSBILDUNGSSUCHE_API_KEY: secret });
  const code = await run(["--help"], cli.deps);
  assert.equal(code, 0);
  const printed = [...cli.out, ...cli.err].join("\n");
  assert.ok(printed.length > 0, "help output should not be empty");
  assert.ok(!printed.includes(secret), "the API key must not appear in --help output");
});

// A blank filter, query or id (often an unset shell variable) must be a usage
// error at parse time: otherwise it is sent as an empty parameter (`sw=`) and
// the command silently runs unfiltered and exits 0.
const blankCases: Array<[string, string[]]> = [
  ["--sw", ["search", "--sw", ""]],
  ["--sw (whitespace)", ["search", "--sw", "   "]],
  ["--orte", ["search", "--orte", ""]],
  ["--re", ["search", "--re", ""]],
  ["--uk", ["search", "--uk", ""]],
  ["--ids", ["search", "--ids", ""]],
  ["--bart", ["search", "--bart", ""]],
  ["--bt", ["search", "--bt", ""]],
  ["details <id>", ["details", ""]],
  ["details <id> (whitespace)", ["details", " \t "]],
];

for (const [name, argv] of blankCases) {
  test(`a blank ${name} is rejected before any request`, async () => {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["--api-key", "dummy", ...argv], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0, "no request may be sent");
    assert.match(cli.err.join("\n"), /non-empty/);
  });
}

// A non-http(s) or malformed --base-url is a usage error at parse time: it must
// not reach the transport (an injected custom transport does no scheme check).
for (const bad of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
  test(`--base-url ${bad} is rejected before any request`, async () => {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(
      ["--api-key", "dummy", "--base-url", bad, "search", "--sw", "x"],
      cli.deps,
    );
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0, "no request may be sent");
    assert.match(cli.err.join("\n"), /--base-url/);
  });
}

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["1000000", false]] as const) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["--max-retries", value, "details", "12345"], cli.deps);
    assert.equal(code, ok ? 0 : 2, value);
    if (!ok) assert.match(cli.err.join("\n"), /between 0 and 10/);
  }
});

for (const id of ["..", ".", "%2e%2e", ".%2e"]) {
  test(`details ${id} exits 2 without a request instead of walking up the path`, async () => {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(["details", "--", id], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0, "no request may be sent");
  });
}

test("--uk with a km radius but no --orte is a usage error, before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["search", "--ids", "9162", "--uk", "10"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /--uk 10 needs --orte/);
});

test("--orte without --uk is a usage error, before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["search", "--orte", "Köln_6.957_50.938"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /--orte needs --uk/);
});

test("--uk Bundesweit alone, and --orte with --uk, are sent", async () => {
  for (const argv of [
    ["search", "--ids", "9162", "--uk", "Bundesweit"],
    ["search", "--orte", "Köln_6.957_50.938", "--uk", "25"],
    ["search", "--orte", "Köln_6.957_50.938", "--uk", "Bundesweit"],
  ]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 0, argv.join(" "));
    assert.equal(cli.mt.calls.length, 1);
  }
});

test("repeated list options (--ids, --re, --bt) accumulate into one comma-separated value", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(
    ["search", "--ids", "1", "--ids", "2,3", "--re", "NRW", "--re", "BAY", "--bt", "2", "--bt", "101"],
    cli.deps,
  );
  assert.equal(code, 0);
  const q = new URL(cli.mt.last().url).searchParams;
  assert.equal(q.get("ids"), "1,2,3");
  assert.equal(q.get("re"), "NRW,BAY");
  assert.equal(q.get("bt"), "2,101");
});

for (const [opt, a, b] of [
  ["--sw", "x", "y"],
  ["--sty", "0", "1"],
  ["--bart", "102", "104"],
  ["--page", "0", "1"],
  ["--size", "5", "10"],
] as const) {
  test(`repeating the single-valued ${opt} is a usage error, before any request`, async () => {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(["search", opt, a, opt, b], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /Given more than once/);
  });
}

test("repeating --orte or --uk is a usage error", async () => {
  for (const argv of [
    ["search", "--orte", "A_1_2", "--orte", "B_3_4", "--uk", "10"],
    ["search", "--orte", "A_1_2", "--uk", "10", "--uk", "50"],
  ]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
  }
});

// Values outside the API's closed value sets are usage errors at parse time (exit 2,
// nothing sent) instead of a bare HTTP 400/500 from the API.
const invalidValues: Array<[string, string[]]> = [
  ["--sty 4", ["search", "--sty", "4"]],
  ["--uk 30", ["search", "--orte", "K_6.9_50.9", "--uk", "30"]],
  ["--uk 150", ["search", "--orte", "K_6.9_50.9", "--uk", "150"]],
  ["--re BW", ["search", "--re", "BW"]],
  ["--re NRW,", ["search", "--re", "NRW,"]],
  ["--bt 7", ["search", "--bt", "7"]],
  ["--bt 113", ["search", "--bt", "113"]],
  ["--bt 2026-10-01", ["search", "--bt", "2026-10-01"]],
  ["--orte X_200_100", ["search", "--orte", "X_200_100", "--uk", "10"]],
  ["--orte Köln (no coordinates)", ["search", "--orte", "Köln", "--uk", "10"]],
  ["--orte _6.9_50.9 (no name)", ["search", "--orte", "_6.9_50.9", "--uk", "10"]],
  ["--page 500 (default size 20)", ["search", "--page", "500"]],
  ["--page 10000 --size 1", ["search", "--page", "10000", "--size", "1"]],
  ["details abc", ["details", "abc"]],
  ["details 12a", ["details", "12a"]],
];
for (const [name, argv] of invalidValues) {
  test(`${name} is a usage error, before any request`, async () => {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0, "no request may be sent");
  });
}

test("valid closed-set values are sent, normalised where the API is case-sensitive", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(
    ["search", "--sty", "3", "--re", "nrw,thü", "--bt", "0,2,112", "--orte", "Köln_6.957_50.938",
      "--uk", "bundesweit", "--page", "499"],
    cli.deps,
  );
  assert.equal(code, 0);
  const q = new URL(cli.mt.last().url).searchParams;
  assert.equal(q.get("re"), "NRW,THÜ");
  assert.equal(q.get("uk"), "Bundesweit");
  assert.equal(q.get("bt"), "0,2,112");
  assert.equal(q.get("page"), "499");

  const last = makeCli(() => jsonResponse({}));
  assert.equal(await run(["search", "--page", "9999", "--size", "1"], last.deps), 0);
});

test("a page past the 10000-result window names the last page", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["search", "--page", "500", "--size", "20"], cli.deps), 2);
  assert.match(cli.err.join("\n"), /10000-result window.*last page is 499/);
});
