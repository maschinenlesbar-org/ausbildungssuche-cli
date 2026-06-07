// AusbildungssucheClient — a typed client over the open Ausbildungssuche API of
// the Bundesagentur für Arbeit (rest.arbeitsagentur.de/infosysbub/absuche).
//
// Auth: a static, publicly-documented `X-API-Key` header ("infosysbub-absuche")
// is applied automatically; override via `apiKey`.
//
//   client.search({ sw: "Informatik", size: 10 })
//   client.details(id)

import { RequestEngine, type EngineOptions } from "./engine.js";
import { AusbildungValidationError } from "./errors.js";
import type { QueryParams } from "./query.js";
import type {
  AusbildungSearchResult,
  AusbildungDetails,
  AusbildungSearchParams,
} from "./types.js";

const SERVICE = "/infosysbub/absuche";
/** The static, publicly-documented API key for the Ausbildungssuche service. */
export const DEFAULT_API_KEY = "infosysbub-absuche";

/** Options for the Ausbildungssuche client (engine options plus the API key). */
export interface AusbildungssucheClientOptions extends EngineOptions {
  /** Overrides the default `X-API-Key`. */
  apiKey?: string;
}

/**
 * Encode a single URL path segment, but leave an already-percent-encoded id
 * untouched so an id copied from a `_links` href is not double-encoded
 * (`%20` -> `%2520`). An id counts as "already encoded" when every `%` in it
 * introduces a valid `%XX` hex escape.
 */
function encodePathSegment(id: string): string {
  const isAlreadyEncoded = /%[0-9A-Fa-f]{2}/.test(id) && !/%(?![0-9A-Fa-f]{2})/.test(id);
  return isAlreadyEncoded ? id : encodeURIComponent(id);
}

/** Drop undefined values so only the parameters the caller set are sent. */
function prune(params: Record<string, unknown>): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v as QueryParams[string];
  }
  return out;
}

export class AusbildungssucheClient {
  private readonly engine: RequestEngine;

  constructor(options: AusbildungssucheClientOptions = {}) {
    const { apiKey, ...engineOptions } = options;
    // Treat an empty/whitespace-only key as absent and fall back to the public
    // default — an empty `X-API-Key` is rejected by the service with 403.
    const resolvedKey = apiKey && apiKey.trim() !== "" ? apiKey : DEFAULT_API_KEY;
    this.engine = new RequestEngine({
      ...engineOptions,
      // Accept is negotiated per endpoint (see search/details below): the search
      // collection serves HAL+JSON and 406s on plain JSON, while the per-id
      // detail endpoint serves application/json and 406s on HAL+JSON.
      defaultHeaders: {
        "X-API-Key": resolvedKey,
        ...engineOptions.defaultHeaders,
      },
    });
  }

  /** Search apprenticeship offers (HAL+JSON result). */
  search(params: AusbildungSearchParams = {}): Promise<AusbildungSearchResult> {
    // The search collection serves HAL+JSON and 406s on plain application/json.
    return this.engine.getJson(
      `${SERVICE}/pc/v1/ausbildungsangebot`,
      prune({ ...params }),
      "application/hal+json",
    );
  }

  /** Full details for one apprenticeship offer by id. */
  details(id: string): Promise<AusbildungDetails> {
    if (id.trim() === "") {
      throw new AusbildungValidationError("details: id must not be empty.");
    }
    // The detail endpoint serves application/json and 406s on HAL+JSON, so we
    // request JSON explicitly. The id may already be percent-encoded (e.g. when
    // copied from a `_links` href), so encode only an id that is not already
    // encoded to avoid double-encoding `%xx` sequences.
    return this.engine.getJson(
      `${SERVICE}/pc/v1/ausbildungsangebot/${encodePathSegment(id)}`,
      undefined,
      "application/json",
    );
  }
}
