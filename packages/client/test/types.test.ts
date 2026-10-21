// Compile-time checks of the exported library types, and the runtime rule they describe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AusbildungssucheClient, KEY_SOURCE_URL, obtainKey } from "../src/index.js";
import { EMPTY_SEARCH, jsonResponse, makeMockTransport, rawResponse } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ apiKey: process.env.AUSBILDUNGSSUCHE_API_KEY }` fails to
  // compile against an option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "ausbildungssuche-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        "import {",
        "  AusbildungssucheClient,",
        "  type AusbildungssucheClientOptions,",
        "  type AusbildungSearchParams,",
        "  type EngineOptions,",
        "  type ObtainKeyOptions,",
        "  type SearchOptions,",
        `} from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const a: AusbildungssucheClientOptions = allUndefined<AusbildungssucheClientOptions>();",
        "export const b: EngineOptions = allUndefined<EngineOptions>();",
        "export const c: AusbildungSearchParams = allUndefined<AusbildungSearchParams>();",
        "export const d: SearchOptions = allUndefined<SearchOptions>();",
        "export const e: ObtainKeyOptions = allUndefined<ObtainKeyOptions>();",
        "export const client = new AusbildungssucheClient({ apiKey: process.env.AUSBILDUNGSSUCHE_API_KEY, timeoutMs: 15_000 });",
        "export const page = client.search({ ids: process.env.IDS, size: 10 });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport(() => jsonResponse(EMPTY_SEARCH));
  const client = new AusbildungssucheClient({
    apiKey: undefined,
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.search(
    {
      sw: undefined, sty: undefined, ids: undefined, orte: undefined, re: undefined, uk: undefined,
      bart: undefined, bg: undefined, bt: undefined, page: undefined, size: undefined,
    },
    { allowUnknownFilters: undefined },
  );
  assert.equal(mt.last().url, "https://rest.arbeitsagentur.de/infosysbub/absuche/pc/v1/ausbildungsangebot");
  const headers = mt.last().headers ?? {};
  assert.equal(headers["User-Agent"], "ausbildungssuche-cli");
  assert.equal(Object.keys(headers).some((h) => h.toLowerCase() === "x-api-key"), false);

  const doc = makeMockTransport(() => rawResponse('curl -H "X-API-Key: infosysbub-absuche" https://x', "text/plain"));
  const got = await obtainKey({
    sourceUrl: undefined,
    timeoutMs: undefined,
    userAgent: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    transport: doc.transport,
  });
  assert.equal(got.key, "infosysbub-absuche");
  assert.equal(doc.last().url, KEY_SOURCE_URL);
});
