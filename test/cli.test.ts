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
  await run(["details", "abc123"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    `${SERVICE}/pc/v1/ausbildungsangebot/abc123`,
  );
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["details", "nope"], cli.deps);
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
