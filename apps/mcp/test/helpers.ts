// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of
// the Ausbildungssuche API on its own paths (the search and the details endpoints) answering with
// the client's recorded answers (recorded.ts, live on 2026-11-20), and the client's transport
// helpers. The generic harness (a connection, a config, a log recorder, the HTTP server) is
// harness.ts; it gives the server TEST_ENV, so no test reads a credentials file or obtains a key.

import { EMPTY_SEARCH, jsonResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/ausbildungssuche-client/test/helpers";
import {
  DETAILS_348375174,
  SEARCH_NRW_APPRENTICESHIP_P0,
  SEARCH_PFLEGEASSISTENZ_KOELN_P0,
  SEARCH_PFLEGEASSISTENZ_KOELN_P1,
  SEARCH_PFLEGEASSISTENZ_KOELN_P2,
} from "@maschinenlesbar.org/ausbildungssuche-client/test/recorded";

export * from "@maschinenlesbar.org/ausbildungssuche-client/test/helpers";
export * from "@maschinenlesbar.org/ausbildungssuche-client/test/recorded";
export type { JsonObject } from "@maschinenlesbar.org/ausbildungssuche-client";

/** The test key the server finds in its environment (harness.ts); never a real one. */
export const TEST_KEY = "test-key-only";

/** The environment every server of these tests sees, unless a test passes its own. */
export const TEST_ENV: Record<string, string> = { AUSBILDUNGSSUCHE_API_KEY: TEST_KEY };

const KOELN_PAGES = [SEARCH_PFLEGEASSISTENZ_KOELN_P0, SEARCH_PFLEGEASSISTENZ_KOELN_P1, SEARCH_PFLEGEASSISTENZ_KOELN_P2];

/** The recorded searches: with ids the Pflegeassistenz search around Köln by page, else the NRW apprenticeship sample. */
export function recordedSearch(query: URLSearchParams): unknown {
  return query.get("ids") !== null ? (KOELN_PAGES[Number(query.get("page") ?? 0)] ?? EMPTY_SEARCH) : SEARCH_NRW_APPRENTICESHIP_P0;
}

/**
 * The Ausbildungssuche API: `/infosysbub/absuche/pc/v1/ausbildungsangebot` answered by `search`
 * (default: recordedSearch), `.../ausbildungsangebot/<id>` by `details` (default: the recorded
 * offer; undefined is a 404), anything else 404.
 */
export function ausbildungApi(options: { search?: (query: URLSearchParams) => unknown; details?: (id: string) => unknown } = {}): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const id = url.pathname.match(/\/pc\/v1\/ausbildungsangebot\/(\d+)$/)?.[1];
    if (id !== undefined) {
      const answer = options.details === undefined ? DETAILS_348375174 : options.details(id);
      return answer === undefined ? jsonResponse({ message: "not found" }, 404) : jsonResponse(answer);
    }
    if (url.pathname.endsWith("/pc/v1/ausbildungsangebot")) return jsonResponse((options.search ?? recordedSearch)(url.searchParams));
    return jsonResponse({ message: "no such path" }, 404);
  });
}
