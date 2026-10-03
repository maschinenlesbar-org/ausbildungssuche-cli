// AusbildungssucheClient — a typed client over the open Ausbildungssuche API of
// the Bundesagentur für Arbeit (rest.arbeitsagentur.de/infosysbub/absuche).
//
// Auth: the API requires a static, publicly-documented `X-API-Key` header. The
// key is NOT bundled with this client — pass it via `apiKey` (the CLI maps this
// to `--api-key` / the AUSBILDUNGSSUCHE_API_KEY env var). When no key is supplied
// the header is omitted and the API answers 401/403. The public key can be
// fetched at run time via obtainKey() / the CLI's `obtain-key` command.
//
//   client.search({ ids: "9162", size: 10 })
//   client.details(id)

import { RequestEngine, type EngineOptions } from "./engine.js";
import {
  assertValid,
  headerValueProblem,
  normalizeSearchParams,
  offerIdProblem,
  validateSearchParams,
} from "./validate.js";
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
   * header is not sent. A key with a control character or a character above
   * U+00FF is rejected (AusbildungValidationError). Obtain the public key with obtainKey() (see obtain-key.ts).
   */
  apiKey?: string;
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
    // A key that cannot go into a header is rejected here, naming the option.
    if (key !== undefined) assertValid("apiKey", key, headerValueProblem);
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

  /**
   * Search apprenticeship offers (HAL+JSON result). `re` and `uk` are first put
   * into the form the API accepts (normalizeSearchParams: `" nrw"` → `NRW`,
   * `bundesweit` → `Bundesweit`). Rejects with an AusbildungValidationError, before
   * any request, when the parameters break a rule of validateSearchParams (e.g. a
   * blank filter).
   */
  async search(params: AusbildungSearchParams = {}): Promise<AusbildungSearchResult> {
    const normalized = validateSearchParams(normalizeSearchParams(params));
    // The search collection serves HAL+JSON and 406s on plain application/json.
    return this.engine.getJson(
      `${SERVICE}/pc/v1/ausbildungsangebot`,
      prune({ ...normalized }),
      "application/hal+json",
    );
  }

  /**
   * Full details for one apprenticeship offer by its numeric id. Rejects with an
   * AusbildungValidationError, before any request, for an id that is not digits
   * only (offerIdProblem).
   */
  async details(id: string): Promise<AusbildungDetails> {
    assertValid("id", id, offerIdProblem);
    // The detail endpoint serves application/json and 406s on HAL+JSON, so we
    // request JSON explicitly. A digits-only id needs no encoding.
    return this.engine.getJson(
      `${SERVICE}/pc/v1/ausbildungsangebot/${id}`,
      undefined,
      "application/json",
    );
  }
}
