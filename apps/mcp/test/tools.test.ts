// This server's tools against a mock of the Ausbildungssuche API (the client's answers recorded
// live on 2026-11-20), with the skills' traps as cases: each tool answers through the protocol (its
// structuredContent checked by the SDK against its output schema); an occupation word is resolved
// or reported as ambiguous, never sent as the ignored keyword; coordinates given the other way round
// are swapped back; nothing found is empty with what to change; a count of 10000 is capped; a gone
// offer is empty with the reason; a refused key says what to check; every request carries the key
// and every result the BA's terms. The rules every server follows are the conformance tests
// (M1–M11).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { TOOLS } from "../src/mcp/tools.js";
import { connect } from "./harness.js";
import { KEY_SOURCE_URL } from "@maschinenlesbar.org/ausbildungssuche-client/internal/obtain-key";
import type { HttpResponse } from "../src/mcp/api.js";
import { ausbildungApi, DETAILS_348375174, EMPTY_SEARCH, jsonResponse, makeMockTransport, TEST_KEY, type JsonObject } from "./helpers.js";

const API = "https://rest.arbeitsagentur.de/infosysbub/absuche";
const KOELN = { placeName: "Köln", longitude: 6.957, latitude: 50.938 };
const searches = (calls: { url: string }[]): URLSearchParams[] => calls.filter((c) => new URL(c.url).pathname.endsWith("/ausbildungsangebot")).map((c) => new URL(c.url).searchParams);

test("five tools: the three use cases, then occupation ids for a word and a slice of offers", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["findTraining", "scanMarket", "getOffer", "findOccupations", "searchOffers"]);
});

test("findTraining: a ranked, de-duplicated shortlist, its request as the source, the key sent, the BA's terms", async () => {
  const upstream = ausbildungApi();
  const connection = await connect({ transport: upstream });
  const result = await connection.call("findTraining", { occupationIds: [135349], ...KOELN, limit: 3 });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.deepEqual([content["total"], content["read"], content["complete"], content["runsMerged"]], [41, 41, true, 35]);
  const picks = content["picks"] as { offerId: number; moreRuns?: number; distanceKm: number }[];
  assert.equal(picks.length, 3);
  assert.deepEqual([picks[0]?.offerId, picks[0]?.moreRuns], [16319020, 35]);
  assert.equal(content["source"], `${API}/pc/v1/ausbildungsangebot?ids=135349&orte=K%C3%B6ln_6.957_50.938&uk=25&page=0&size=20`);
  assert.match(String(content["licence"]), /^Quelle: Bundesagentur für Arbeit \(BA\), Ausbildungssuche\. Not open data.*https:\/\/www\.arbeitsagentur\.de\/en\/terms-of-use/);
  assert.equal(upstream.calls.length, 3, "the three pages of 41 offers");
  assert.ok(upstream.calls.every((request) => request.headers?.["X-API-Key"] === TEST_KEY));
  await connection.close();
});

test("findTraining: an occupation word is resolved from a sample, never sent as the ignored keyword; several are ambiguous", async () => {
  const upstream = ausbildungApi();
  const connection = await connect({ transport: upstream });
  const one = (await connection.call("findTraining", { occupation: "Pflegeassistent", ...KOELN, maxPages: 1 })).structuredContent ?? {};
  assert.equal(one["status"], "ok", JSON.stringify(one).slice(0, 300));
  assert.deepEqual((one["occupation"] as { ids: unknown[] }).ids, [{ dkzId: 135349, name: "Pflegeassistent/Pflegeassistentin" }]);
  assert.ok(searches(upstream.calls).every((q) => q.get("sw") === null));
  const several = (await connection.call("findTraining", { occupation: "Pflege", ...KOELN, maxPages: 1 })).structuredContent ?? {};
  assert.equal(several["status"], "ambiguous");
  assert.ok((several["candidates"] as { dkzId: number }[]).some((c) => c.dkzId === 9063));
  await connection.close();
});

test("findTraining: coordinates the other way round are swapped back and said so; a place without coordinates is refused before any request", async () => {
  const upstream = ausbildungApi();
  const connection = await connect({ transport: upstream });
  const swapped = (await connection.call("findTraining", { occupationIds: [135349], placeName: "Köln", longitude: 50.938, latitude: 6.957, maxPages: 1 })).structuredContent ?? {};
  assert.equal((swapped["place"] as { swapped: boolean }).swapped, true);
  assert.equal(searches(upstream.calls)[0]?.get("orte"), "Köln_6.957_50.938");
  const before = upstream.calls.length;
  const refused = await connection.call("findTraining", { occupationIds: [135349], placeName: "Köln" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /placeName, longitude and latitude together/);
  assert.equal(upstream.calls.length, before);
  await connection.close();
});

test("findTraining under a small size cap: the picks it drops are counted (shortlisted), so picks + dropped + more is every offer ranked", async () => {
  const termine = Array.from({ length: 60 }, (_, i) => ({ id: 5000 + i, angebot: { id: 7000 + i, titel: `Kurs ${i} ${"x".repeat(300)}`, bildungsanbieter: { name: `Anbieter ${i}` } }, beginn: null, individuellerEinstieg: true }));
  const search = (q: URLSearchParams): unknown => ({ _embedded: { termine: termine.slice(Number(q.get("page")) * 20, Number(q.get("page")) * 20 + 20) }, page: { number: Number(q.get("page")), size: 20, totalElements: 60, totalPages: 3 } });
  const connection = await connect({ transport: ausbildungApi({ search }), config: { maxResultChars: 4000 } });
  const content = (await connection.call("findTraining", { occupationIds: [135349], limit: 25, maxPages: 3 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["truncated"], true);
  const picks = content["picks"] as unknown[];
  assert.ok(picks.length < 25, `${picks.length} picks kept`);
  assert.equal(content["more"], 35, "offers ranked below the shortlist");
  assert.equal(content["shortlisted"], 25, "the picks before the cap: the model sees how many were dropped");
  assert.match(String(content["reason"]), /picks lost entries/);
  await connection.close();
});

test("a key lookup that fails says what to change for this server, not what to do by hand with the CLI", async () => {
  const doc = (body: string, status = 200): HttpResponse => ({ status, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from(body) });
  const sources: [string, HttpResponse][] = [
    ["404", doc("gone", 404)],
    ["no key", doc("# Ausbildungssuche\n\nno key here\n")],
    ["two keys", doc('curl -H "X-API-Key: infosysbub-absuche" …\ncurl -H "X-API-Key: infosysbub-other" …\n')],
    ["a placeholder", doc('curl -H "X-API-Key: YOUR-API-KEY" …\n')],
  ];
  for (const [what, answer] of sources) {
    const upstream = makeMockTransport((request) => (request.url === KEY_SOURCE_URL ? answer : jsonResponse(EMPTY_SEARCH)));
    const connection = await connect({ transport: upstream, env: {} });
    const result = await connection.call("searchOffers", { regions: ["NRW"] });
    const text = result.content[0]?.text ?? "";
    assert.equal(result.isError, true, what);
    assert.doesNotMatch(text, /by hand|this command/, `${what}: ${text}`);
    assert.match(text, /set AUSBILDUNGSSUCHE_API_KEY in the MCP client's configuration/, what);
    assert.match(text, /ausbildungssuche obtain-key/, what);
    assert.match(text, /next call tries the lookup again/, what);
    await connection.close();
  }
});

test("the deadline's advice fits every tool: each option it names is named with the tools that take it", async () => {
  const hanging = { transport: (): Promise<never> => new Promise<never>(() => {}) };
  const connection = await connect({ transport: hanging, config: { callTimeoutMs: 30 } });
  const text = (await connection.call("getOffer", { id: "1001" })).content[0]?.text ?? "";
  await connection.close();
  assert.match(text, /took longer than .* and was stopped/);
  assert.match(text, /try again shortly/);
  assert.match(text, /AUSBILDUNGSSUCHE_API_KEY/, "a slow key lookup at the first call is named too");
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  const pairs = [...text.matchAll(/(\w+(?: or \w+)*) \((\w+(?:, \w+)*)\)/g)];
  assert.ok(pairs.length >= 3, text);
  for (const [, options, tools] of pairs) {
    for (const tool of (tools as string).split(", ")) {
      for (const option of (options as string).split(" or ")) assert.ok(schemas.get(tool)?.includes(option), `${tool} takes no ${option}: ${text}`);
    }
  }
  const named = new Set(pairs.flatMap(([, options]) => (options as string).split(" or ")));
  for (const option of ["maxPages", "withFunding", "providers"]) {
    assert.ok(!new RegExp(`\\b${option}\\b`).test(text) || named.has(option), `${option} named without its tools`);
  }
});

test("findTraining: nothing found is empty with what to change, the coordinates' order first", async () => {
  const connection = await connect({ transport: ausbildungApi({ search: () => EMPTY_SEARCH }) });
  const content = (await connection.call("findTraining", { occupationIds: [135349], ...KOELN })).structuredContent ?? {};
  assert.equal(content["status"], "empty");
  assert.match(String(content["reason"]), /longitude comes first/);
  await connection.close();
});

test("scanMarket: one size-1 count per Bundesland and the total; 10000 is capped", async () => {
  const upstream = ausbildungApi({ search: (q) => ({ _links: {}, page: { number: 0, size: 1, totalElements: q.get("re") === "NRW" || q.get("re") === null ? 10000 : 50, totalPages: 1 } }) });
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("scanMarket", { occupationIds: [132173] })).structuredContent ?? {};
  assert.equal(content["status"], "ok", JSON.stringify(content).slice(0, 300));
  assert.equal(upstream.calls.length, 17);
  assert.ok(searches(upstream.calls).every((q) => q.get("size") === "1"));
  const cells = content["cells"] as { code: string; offers: number; capped: boolean }[];
  assert.deepEqual([cells[0]?.code, cells[0]?.capped, cells[1]?.capped], ["NRW", true, false]);
  assert.equal(content["capped"], true);
  assert.equal(content["source"], `${API}/pc/v1/ausbildungsangebot?ids=132173&page=0&size=1`);
  await connection.close();
});

test("getOffer: a clean briefing; a gone offer is empty with the reason, not an error", async () => {
  const connection = await connect({ transport: ausbildungApi({ details: () => undefined }) });
  const gone = await connection.call("getOffer", { id: "348375174" });
  assert.notEqual(gone.isError, true);
  assert.equal(gone.structuredContent?.["status"], "empty");
  assert.match(String(gone.structuredContent?.["reason"]), /ids change as the catalogue is updated/);
  await connection.close();
  const found = await connect({ transport: ausbildungApi() });
  const content = (await found.call("getOffer", { id: "348375174" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  const offer = content["offer"] as { venue: { town: string }; cost: { text: string }; start: string; content: string };
  assert.deepEqual([offer.venue.town, offer.cost.text, offer.start], ["Erkelenz", "2857 EUR", "2026-11-26"]);
  assert.ok(!offer.content.includes("<"));
  assert.equal(content["source"], `${API}/pc/v1/ausbildungsangebot/348375174`);
  await found.close();
});

test("getOffer passes a briefing section as the client made it: up to 3000 characters, never cut again at the server's 2000", async () => {
  const record = DETAILS_348375174[0] as JsonObject;
  const withContent = (inhalt: string): unknown => [{ ...record, angebot: { ...(record["angebot"] as JsonObject), inhalt } }];
  const call = async (inhalt: string): Promise<Record<string, unknown>> => {
    const connection = await connect({ transport: ausbildungApi({ details: () => withContent(inhalt) }) });
    const content = (await connection.call("getOffer", { id: "348375174" })).structuredContent ?? {};
    await connection.close();
    return content;
  };
  const long = await call(`<p>${"Inhalt ".repeat(400).trim()}</p>`);
  assert.equal((long["offer"] as { content: string }).content.length, 2799, "a 2799-character section whole");
  assert.equal(long["truncated"], undefined);
  const longer = await call(`<p>${"x".repeat(5000)}</p>`);
  assert.equal((longer["offer"] as { content: string }).content, `${"x".repeat(3000)}…`, "the client's cut, and only that");
});

test("findOccupations: candidates from a sample, with what was sampled", async () => {
  const connection = await connect({ transport: ausbildungApi() });
  const content = (await connection.call("findOccupations", { word: "Betreuung", regions: ["NRW"], trainingType: "apprenticeship", pages: 1 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  const candidates = content["candidates"] as { dkzId: number; matched: string }[];
  assert.deepEqual(candidates.filter((c) => c.matched === "name").map((c) => c.dkzId), [9066]);
  assert.equal(candidates[0]?.matched, "name", "a name match comes before the search-word ones");
  assert.equal(content["sampled"], 20);
  assert.equal(content["source"], `${API}/pc/v1/ausbildungsangebot?re=NRW&bart=102&page=0&size=20`);
  await connection.close();
});

test("searchOffers: a slice and where the next one starts", async () => {
  const connection = await connect({ transport: ausbildungApi() });
  const page = (await connection.call("searchOffers", { occupationIds: [135349], ...KOELN, limit: 5 })).structuredContent ?? {};
  assert.equal(page["status"], "ok");
  assert.equal(page["nextOffset"], 5);
  assert.equal((page["offers"] as unknown[]).length, 5);
  await connection.close();
});

test("a refused key (the gateway's bare 403) is a tool error that says what to check", async () => {
  const connection = await connect({ transport: makeMockTransport(() => ({ ...jsonResponse({}), status: 403, headers: { "content-type": "text/plain" }, body: Buffer.from(" ") })) });
  const result = await connection.call("searchOffers", { regions: ["NRW"] });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /403.*a wrong or outdated API key.*ausbildungssuche obtain-key/s);
  assert.ok(!(result.content[0]?.text ?? "").includes(TEST_KEY));
  await connection.close();
});
