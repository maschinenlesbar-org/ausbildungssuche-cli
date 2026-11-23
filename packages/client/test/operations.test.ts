// The skills' use cases (src/operations.ts) against recorded answers (recorded.ts): each trap the
// skills document is a test here. No request reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AusbildungssucheClient } from "../src/client.js";
import { AusbildungValidationError } from "../src/errors.js";
import type { HttpRequest } from "../src/http.js";
import { berlinDate, findOccupations, findTraining, htmlToText, offerBrief, regionCode, scanMarket, searchOffers } from "../src/operations.js";
import type { AusbildungSearchResult, JsonObject } from "../src/types.js";
import { EMPTY_SEARCH, jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";
import { DETAILS_348375174, SEARCH_NRW_APPRENTICESHIP_P0, SEARCH_PFLEGEASSISTENZ_KOELN_P0, SEARCH_PFLEGEASSISTENZ_KOELN_P1, SEARCH_PFLEGEASSISTENZ_KOELN_P2 } from "./recorded.js";

const params = (request: HttpRequest): URLSearchParams => new URL(request.url).searchParams;
const searches = (mock: MockTransport): URLSearchParams[] => mock.calls.filter((r) => new URL(r.url).pathname.endsWith("/ausbildungsangebot")).map(params);
const KOELN_PAGES = [SEARCH_PFLEGEASSISTENZ_KOELN_P0, SEARCH_PFLEGEASSISTENZ_KOELN_P1, SEARCH_PFLEGEASSISTENZ_KOELN_P2];
const KOELN = { name: "Köln", longitude: 6.957, latitude: 50.938 };
const NOW = () => Date.parse("2026-11-20T08:00:00Z");

/** A mock of the search and details endpoints: `search` answers by the request's parameters, `details` by the id (undefined: 404). */
function api(search: (query: URLSearchParams) => unknown, details: (id: string) => unknown = () => DETAILS_348375174): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const id = url.pathname.match(/\/ausbildungsangebot\/(\d+)$/)?.[1];
    if (id !== undefined) {
      const answer = details(id);
      return answer === undefined ? jsonResponse({ message: "not found" }, 404) : jsonResponse(answer);
    }
    return jsonResponse(search(url.searchParams));
  });
}

const client = (mock: MockTransport): AusbildungssucheClient => new AusbildungssucheClient({ transport: mock.transport, apiKey: "test-key-only" });
/** The recorded Köln search by page; the NRW sample for anything without ids. */
const recorded = (q: URLSearchParams): unknown => (q.get("ids") !== null ? KOELN_PAGES[Number(q.get("page"))] ?? EMPTY_SEARCH : SEARCH_NRW_APPRENTICESHIP_P0);
const counted = (total: number): AusbildungSearchResult => ({ _links: {}, page: { number: 0, size: 1, totalElements: total, totalPages: total } });

test("dates are read in Europe/Berlin: an API midnight is not the day before (UTC)", () => {
  assert.equal(berlinDate(1791928800000), "2026-10-14");
  assert.equal(new Date(1791928800000).toISOString().slice(0, 10), "2026-10-13");
  assert.equal(berlinDate(undefined), undefined);
});

test("findTraining: every page of a small result read, the runs of one course merged, nearest first", async () => {
  const mock = api(recorded);
  const answer = await findTraining(client(mock), { occupationIds: [135349], place: KOELN, now: NOW });
  assert.equal(answer.status, "ok");
  assert.deepEqual([answer.total, answer.read, answer.complete, answer.capped, answer.sortedBy], [41, 41, true, false, "distance"]);
  assert.equal(searches(mock).length, 3, "41 offers: pages 0, 1 and 2 of 20");
  const picks = answer.picks ?? [];
  assert.equal(picks.length, 6, "41 runs of 6 courses");
  assert.equal(answer.runsMerged, 35);
  assert.deepEqual(picks.map((p) => p.distanceKm), [...picks.map((p) => p.distanceKm)].sort((a, b) => (a ?? 0) - (b ?? 0)));
  const tertia = picks[0];
  assert.equal(tertia?.offerId, 16319020);
  assert.equal(tertia?.town, "Köln");
  assert.equal(tertia?.moreRuns, 35, "the nearest run kept, the other 35 merged");
  assert.ok((tertia?.otherTowns ?? []).includes("Frechen"));
  assert.equal(tertia?.start, "2026-11-26");
  assert.ok(!JSON.stringify(answer).includes("suchworte"), "no synonym lists in a shortlist");
});

test("findTraining: the keyword filter is never sent; the place goes as Name_lon_lat with a radius, 25 km by default", async () => {
  const mock = api(recorded);
  await findTraining(client(mock), { occupationIds: ["135349"], place: KOELN, maxPages: 1 });
  const q = searches(mock)[0] as URLSearchParams;
  assert.equal(q.get("sw"), null);
  assert.equal(q.get("orte"), "Köln_6.957_50.938");
  assert.equal(q.get("uk"), "25");
  assert.equal(q.get("ids"), "135349");
});

test("findTraining: coordinates given the other way round (latitude first) are swapped back and said so", async () => {
  const mock = api(recorded);
  const answer = await findTraining(client(mock), { occupationIds: [135349], place: { name: "Köln", longitude: 50.938, latitude: 6.957 }, maxPages: 1 });
  assert.equal(searches(mock)[0]?.get("orte"), "Köln_6.957_50.938");
  assert.equal(answer.place?.swapped, true);
  assert.match(answer.place?.note ?? "", /other way round/);
});

test("the place's traps are usage errors before any request: a radius without a place, a radius the API refuses, bad coordinates", async () => {
  const mock = api(recorded);
  await assert.rejects(findTraining(client(mock), { occupationIds: [1], radiusKm: 25 }), (err: unknown) => err instanceof AusbildungValidationError && /radiusKm needs a place/.test(err.message));
  await assert.rejects(findTraining(client(mock), { occupationIds: [1], place: KOELN, radiusKm: 30 }), /only 10, 25, 50, 100 km/);
  await assert.rejects(findTraining(client(mock), { occupationIds: [1], place: { name: "X", longitude: 200, latitude: 50 } }), /longitude is -180\.\.180/);
  await assert.rejects(findTraining(client(mock), { occupationIds: [0] }), /0 is no usable id/);
  assert.equal(mock.calls.length, 0);
});

test("Bundesländer by name, code or the usual abbreviation, sent as the API's 3-letter code", async () => {
  assert.deepEqual(["Bayern", "BY", "bay", "Thüringen", "THU", "nrw", "Nordrhein-Westfalen", "SH"].map(regionCode), ["BAY", "BAY", "BAY", "THÜ", "THÜ", "NRW", "NRW", "SLH"]);
  assert.throws(() => regionCode("Bavaria-X"), /Unknown Bundesland/);
  const mock = api(() => EMPTY_SEARCH);
  await searchOffers(client(mock), { regions: ["BY", "Berlin"] });
  assert.equal(searches(mock)[0]?.get("re"), "BAY,BER");
});

test("nothing found is status empty with what to change, the coordinates' order first; never 'there are none'", async () => {
  const answer = await findTraining(client(api(() => EMPTY_SEARCH)), { occupationIds: [135349], place: KOELN });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /longitude comes first.*widen radiusKm/);
});

test("findOccupations: ids from a sample by name; dkzId 0 is no usable id; the sample is said to be one", async () => {
  const mock = api(recorded);
  const pflege = await findOccupations(client(mock), { word: "Pflege", regions: ["NRW"], trainingType: "apprenticeship", pages: 1 });
  assert.equal(pflege.status, "ok");
  assert.deepEqual(pflege.candidates?.filter((c) => c.matched === "name").map((c) => c.dkzId).sort(), [135349, 9063]);
  assert.deepEqual(pflege.candidates?.filter((c) => c.matched === "synonym").map((c) => c.dkzId), [14427], "Fußpflege, a search word of the Podologe, comes after the names");
  assert.match(pflege.note, /A sample: the occupations of the first 20 of 5333 offers/);
  assert.equal(searches(mock)[0]?.get("sw"), null, "the ignored keyword filter is not used");
  const tischler = await findOccupations(client(mock), { word: "tischler", pages: 1 });
  assert.equal(tischler.status, "empty");
  assert.deepEqual(tischler.withoutId, ["Tischler/Tischlerin"]);
  await assert.rejects(findOccupations(client(mock), { word: "ab" }), /at least 3 letters/);
});

test("findOccupations: a word found only among an occupation's search words (the API sends them as { suchwort } objects) is a synonym match", async () => {
  const koeln = (q: URLSearchParams): unknown => KOELN_PAGES[Number(q.get("page"))] ?? EMPTY_SEARCH;
  const answer = await findOccupations(client(api(koeln)), { word: "Altenbetreuung", place: KOELN, pages: 3 });
  assert.equal(answer.status, "ok");
  assert.deepEqual(answer.candidates?.map((c) => [c.dkzId, c.matched]), [[9063, "synonym"]]);
  const french = await findOccupations(client(api(koeln)), { word: "aide soignant", place: KOELN, pages: 3 });
  assert.ok(french.candidates?.some((c) => c.matched === "synonym"), "an English or French term the BA lists is found too");
  const plain = await findOccupations(
    client(api(() => ({ _embedded: { termine: [{ id: 1, angebot: { id: 1, systematiken: [{ dkzId: 77, kurzbezeichnung: "Beruf X", suchworte: ["Altenbetreuung"] }] } }] }, page: { number: 0, size: 20, totalElements: 1, totalPages: 1 } }))),
    { word: "Altenbetreuung", pages: 1 },
  );
  assert.deepEqual(plain.candidates?.map((c) => c.dkzId), [77], "a plain string search word still counts");
  const viaTraining = await findTraining(client(api(koeln)), { occupation: "Altenbetreuung", place: KOELN, maxPages: 3 });
  assert.deepEqual(viaTraining.occupation?.ids, [{ dkzId: 9063, name: "Altenpflegehelfer/Altenpflegehelferin" }]);
});

test("findTraining with an occupation word: one occupation is resolved and searched by id; several are ambiguous", async () => {
  const mock = api(recorded);
  const one = await findTraining(client(mock), { occupation: "Pflegeassistent", place: KOELN, maxPages: 1 });
  assert.equal(one.status, "ok");
  assert.deepEqual(one.occupation?.ids, [{ dkzId: 135349, name: "Pflegeassistent/Pflegeassistentin" }]);
  assert.equal(searches(mock).at(-1)?.get("ids"), "135349");
  assert.equal(searches(mock)[0]?.get("bart"), "102", "without a training type the sample is of apprenticeships first");
  const several = await findTraining(client(api(recorded)), { occupation: "Pflege", place: KOELN, maxPages: 1 });
  assert.equal(several.status, "ambiguous");
  assert.equal(several.candidates?.length, 2);
  assert.match(several.reason ?? "", /ask which/);
});

test("findTraining: a word not among the sampled apprenticeships is looked for among all offers in the scope", async () => {
  const mock = api((q) => (q.get("ids") !== null ? recorded(q) : q.get("bart") === "102" ? EMPTY_SEARCH : SEARCH_NRW_APPRENTICESHIP_P0));
  const answer = await findTraining(client(mock), { occupation: "Pflegeassistent", place: KOELN, maxPages: 1 });
  assert.equal(answer.status, "ok");
  assert.deepEqual(searches(mock).map((q) => [q.get("bart"), q.get("ids")]), [["102", null], [null, null], [null, "135349"]]);
  const given = api((q) => (q.get("ids") !== null ? recorded(q) : EMPTY_SEARCH));
  const none = await findTraining(client(given), { occupation: "Pflegeassistent", trainingType: "further-training", place: KOELN, maxPages: 1 });
  assert.equal(none.status, "empty");
  assert.equal(searches(given).length, 1, "a training type given is kept: no second sample");
});

test("findTraining: a large result is ranked from a sample and says so; 10000 is capped", async () => {
  const answer = await findTraining(client(api(() => ({ ...SEARCH_NRW_APPRENTICESHIP_P0, page: { number: 0, size: 20, totalElements: 10000, totalPages: 500 } }))), { regions: ["NRW"], maxPages: 2 });
  assert.equal(answer.capped, true);
  assert.equal(answer.complete, false);
  assert.equal(answer.sortedBy, "start");
  assert.match(answer.note ?? "", /first 40 of 10000\+ runs/);
});

test("findTraining by start: rolling entry counts as now, not last; a run without a date comes last", async () => {
  const termine = [
    { id: 1, angebot: { id: 1, titel: "Later" }, beginn: Date.parse("2027-03-01T00:00:00+01:00"), individuellerEinstieg: false },
    { id: 2, angebot: { id: 2, titel: "Unknown" }, beginn: null, individuellerEinstieg: false },
    { id: 3, angebot: { id: 3, titel: "Anytime" }, beginn: null, individuellerEinstieg: true },
    { id: 4, angebot: { id: 4, titel: "Soon" }, beginn: Date.parse("2026-12-01T00:00:00+01:00"), individuellerEinstieg: false },
  ];
  const answer = await findTraining(client(api(() => ({ _embedded: { termine }, page: { number: 0, size: 20, totalElements: 4, totalPages: 1 } }))), { trainingType: "apprenticeship", now: NOW });
  assert.deepEqual(answer.picks?.map((p) => [p.title, p.start]), [["Anytime", "rolling"], ["Soon", "2026-12-01"], ["Later", "2027-03-01"], ["Unknown", undefined]]);
});

test("scanMarket: one size-1 count per Bundesland plus the total, ranked; a 10000 is capped and gets no share", async () => {
  const counts: Record<string, number> = { NRW: 10000, BAY: 103, BAW: 103, HES: 58 };
  const mock = api((q) => {
    if (q.get("bg") === "true") return counted(q.get("re") === "BAY" ? 79 : q.get("re") === "NRW" ? 6000 : 1);
    return counted(q.get("re") === null ? 10000 : counts[q.get("re") ?? ""] ?? 2);
  });
  const answer = await scanMarket(client(mock), { occupationIds: [132173], withFunding: true });
  assert.equal(answer.status, "ok");
  assert.ok(searches(mock).every((q) => q.get("size") === "1" && q.get("ids") === "132173"));
  assert.equal(answer.requests, 1 + 16 * 2);
  const cells = answer.cells ?? [];
  assert.equal(cells.length, 16);
  assert.deepEqual(cells.slice(0, 3).map((c) => [c.code, c.offers, c.capped]), [["NRW", 10000, true], ["BAW", 103, false], ["BAY", 103, false]]);
  assert.equal(cells[0]?.fundedShare, undefined, "no share from a capped count");
  assert.equal(cells.find((c) => c.code === "BAY")?.fundedShare, 0.767);
  assert.equal(answer.capped, true);
  assert.match(answer.note ?? "", /10000 or more.*need not add up/);
});

test("scanMarket: the sweep replaces the filter's own value; a provider tally from a sample says it is one", async () => {
  const mock = api((q) => (q.get("size") === "1" ? counted(5333) : { ...SEARCH_NRW_APPRENTICESHIP_P0, page: { number: 0, size: 20, totalElements: 5333, totalPages: 267 } }));
  const answer = await scanMarket(client(mock), { regions: ["NRW", "Bayern"], by: "trainingType", providers: true, maxPages: 1 });
  assert.deepEqual(answer.cells?.map((c) => c.code).sort(), ["101", "102", "104"]);
  assert.ok(searches(mock).every((q) => q.get("re") === "NRW,BAY"));
  assert.equal(answer.providers?.complete, false);
  assert.equal(answer.providers?.top[0]?.name, "Berufsbildungswerk Benediktushof Maria Veen");
  assert.match(answer.note ?? "", /tallied from the first 20 runs only/);
});

test("scanMarket: an ambiguous word keeps the note that the coordinates were swapped back, as findTraining's does", async () => {
  const swapped = { name: "Köln", longitude: 50.938, latitude: 6.957 };
  const scan = await scanMarket(client(api(recorded)), { occupation: "Pflege", place: swapped, maxPages: 1 });
  assert.equal(scan.status, "ambiguous");
  assert.equal(scan.place?.swapped, true);
  assert.match(scan.place?.note ?? "", /other way round/);
  const training = await findTraining(client(api(recorded)), { occupation: "Pflege", place: swapped, maxPages: 1 });
  assert.deepEqual(scan.place, training.place);
});

test("scanMarket: total counts without the swept filter, so a cell over total is its share; a filter the sweep replaces is named", async () => {
  // 400 offers: 320 apprenticeships, 80 further training; 134 eligible for a voucher; 120 in Bayern, 80 in NRW.
  const world = (q: URLSearchParams): unknown => {
    if (q.get("bg") === "true") return counted(134);
    const bart = q.get("bart");
    if (bart !== null) return counted(bart === "102" ? 320 : bart === "104" ? 80 : 0);
    const re = q.get("re");
    if (re !== null) return counted(re === "BAY" ? 120 : re === "NRW" ? 80 : re === "BAY,NRW" ? 200 : 0);
    return counted(400);
  };
  const byType = await scanMarket(client(api(world)), { by: "trainingType", trainingType: "apprenticeship" });
  assert.equal(byType.total, 400);
  assert.deepEqual(byType.cells?.map((c) => c.offers), [320, 80, 0]);
  assert.match(byType.note ?? "", /trainingType given is replaced by the sweep/);
  const byFunding = await scanMarket(client(api(world)), { by: "funding", voucherOnly: true });
  assert.equal(byFunding.total, 400);
  assert.equal(byFunding.cells?.[0]?.fundedShare, 0.335);
  assert.match(byFunding.note ?? "", /voucherOnly given is replaced by the sweep/);
  const byRegion = await scanMarket(client(api(world)), { by: "region", regions: ["Bayern", "NRW"] });
  assert.equal(byRegion.total, 400, "every Land, not only those swept");
  assert.deepEqual(byRegion.cells?.map((c) => c.offers), [120, 80]);
  assert.doesNotMatch(byRegion.note ?? "", /replaced by the sweep/, "regions choose the cells; nothing is replaced");
});

test("scanMarket by region sweeps only the Länder given", async () => {
  const mock = api(() => counted(7));
  const answer = await scanMarket(client(mock), { regions: ["Berlin", "HH"] });
  assert.deepEqual(answer.cells?.map((c) => c.code).sort(), ["BER", "HAM"]);
});

test("offerBrief: the array's first record; HTML as plain lines; the venue, not the provider's office; dates in Berlin", async () => {
  const brief = await offerBrief(client(api(recorded)), "348375174");
  assert.equal(brief.status, "ok");
  const offer = brief.offer;
  assert.equal(offer?.venue?.town, "Erkelenz", "the provider's office is in Alfter");
  assert.equal(offer?.provider?.phone, "0228 648070");
  assert.deepEqual([offer?.start, offer?.end, offer?.rolling], ["2026-11-26", "2027-02-03", false]);
  assert.equal(offer?.cost.text, "2857 EUR");
  assert.equal(offer?.fundingOptions, "Förderung mit Bildungsgutschein");
  assert.match(offer?.content ?? "", /^Betreuungsassistent: Struktur.*\n• Einführung, Organisation, Ablaufplanung\n• Kommunikation\n/s);
  assert.ok(!/[<>]/.test(JSON.stringify(offer)), "no HTML left");
  assert.equal(offer?.qualification, "TERTIA-Zertifikat");
  assert.ok(!("entryRequirements" in (offer ?? {})), "an empty field is left out, never null");
});

test("offerBrief: the cost is stated honestly: none is 'not stated', 0 is 'listed as 0 EUR' with the provider's note", async () => {
  const record = (patch: JsonObject): unknown => [{ ...(DETAILS_348375174[0] as JsonObject), ...patch }];
  const none = await offerBrief(client(api(recorded, () => record({ kostenWert: null }))), "1");
  assert.equal(none.offer?.cost.text, "not stated");
  const zero = await offerBrief(client(api(recorded, () => record({ kostenWert: "0", kostenBemerkung: "<p>Wir erheben kein Schulgeld!</p>" }))), "1");
  assert.deepEqual(zero.offer?.cost, { text: "listed as 0 EUR; see the provider's note", amount: "0", currency: "EUR", note: "Wir erheben kein Schulgeld!" });
  const rolling = await offerBrief(client(api(recorded, () => record({ individuellerEinstieg: true }))), "1");
  assert.equal(rolling.offer?.start, "rolling");
});

test("offerBrief: a gone id (404) is status empty with what to do; a non-numeric id is refused before any request", async () => {
  const mock = api(recorded, () => undefined);
  const gone = await offerBrief(client(mock), "999");
  assert.equal(gone.status, "empty");
  assert.match(gone.reason ?? "", /ids change as the catalogue is updated/);
  await assert.rejects(offerBrief(client(mock), "12/34"), AusbildungValidationError);
  assert.equal(mock.calls.length, 1);
});

test("htmlToText: list items as bullets, entities decoded, 'Keine Angabe' is nothing", () => {
  assert.equal(htmlToText("<ul><li>A &amp; B</li><li>C&nbsp;&reg;</li></ul><p>&#8222;D&#x201c;</p>"), "• A & B\n• C ®\n„D“");
  assert.equal(htmlToText("<p>Keine Angabe</p>"), undefined);
});

test("htmlToText is linear: an opening bracket with no closing one never rescans the rest of the text", () => {
  // `/<[^>]*>/` and `/<\s*li[^>]*>/` tried every "<" against the rest of the text: quadratic, so
  // 120 000 characters of "<li" took seconds, and an offer of a few MiB held the event loop for hours.
  const text = "<li".repeat(40_000);
  const start = performance.now();
  const out = htmlToText(text);
  const ms = performance.now() - start;
  assert.ok(ms < 500, `${Math.round(ms)} ms`);
  assert.ok(out?.startsWith("<li<li"), "a bracket that closes no tag is text, as before");
  assert.equal(htmlToText("a < b <p>c</p> d > e"), "a c\nd > e", "a tag runs from < to the next >, as before");
  assert.equal(htmlToText("x<br  /  >y<br>z<brx>w< / h2 >v<li-x>u"), "x\ny\nzw\nv\n• u");
  assert.equal(htmlToText("<P>Ein</P><BR/>Zwei<UL><LI>Drei</LI></UL>< /div >Vier"), "Ein\nZwei\n• Drei\nVier");
});

test("searchOffers: a slice across the API's pages of 20 and where the next starts", async () => {
  const mock = api(recorded);
  const slice = await searchOffers(client(mock), { occupationIds: [135349], place: KOELN, offset: 15, limit: 10 });
  assert.equal(slice.status, "ok");
  assert.deepEqual(searches(mock).map((q) => q.get("page")), ["0", "1"]);
  assert.equal(slice.offers?.length, 10);
  assert.equal(slice.offers?.[0]?.id, (SEARCH_PFLEGEASSISTENZ_KOELN_P0._embedded?.["termine"] as JsonObject[])[15]?.["id"]);
  assert.equal(slice.nextOffset, 25);
  const last = await searchOffers(client(api(recorded)), { occupationIds: [135349], place: KOELN, offset: 40, limit: 10 });
  assert.equal(last.offers?.length, 1);
  assert.equal(last.nextOffset, undefined);
  await assert.rejects(searchOffers(client(mock), { offset: 10000 }), /offset: expected a whole number from 0 to 9999/);
});
