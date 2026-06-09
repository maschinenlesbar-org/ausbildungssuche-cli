// AusbildungssucheClient — a typed client over the open Ausbildungssuche API of
// the Bundesagentur für Arbeit (rest.arbeitsagentur.de/infosysbub/absuche).
//
// Auth: the API requires a static, publicly-documented `X-API-Key` header. The
// key is NOT bundled with this client — pass it via `apiKey` (the CLI maps this
// to `--api-key` / the AUSBILDUNGSSUCHE_API_KEY env var). When no key is supplied
// the header is omitted and the API answers 401/403. The public key can be
// fetched out-of-band for CI / live testing via scripts/fetch-api-key.mjs.
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

/** Options for the Ausbildungssuche client (engine options plus the API key). */
export interface AusbildungssucheClientOptions extends EngineOptions {
  /**
   * The `X-API-Key` to send. No key is bundled; when omitted (or blank) the
   * header is not sent. Obtain the public key via scripts/fetch-api-key.mjs.
   */
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
    // Only send X-API-Key when a non-blank key was supplied; never default one.
    // (An empty `X-API-Key` is rejected by the service with 403, so a blank value
    // is treated as absent rather than forwarded.)
    const key = apiKey?.trim() ? apiKey : undefined;
    this.engine = new RequestEngine({
      ...engineOptions,
      // Accept is negotiated per endpoint (see search/details below): the search
      // collection serves HAL+JSON and 406s on plain JSON, while the per-id
      // detail endpoint serves application/json and 406s on HAL+JSON.
      defaultHeaders: {
        ...(key ? { "X-API-Key": key } : {}),
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
