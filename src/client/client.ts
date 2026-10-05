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
  isPlainObject,
  detailsProblem,
  headerValueProblem,
  normalizeSearchParams,
  offerIdProblem,
  searchResultProblem,
  validateSearchParams,
  type Problem,
} from "./validate.js";
import { AusbildungParseError, AusbildungValidationError } from "./errors.js";
import type { QueryParams } from "./query.js";
import type {
  AusbildungSearchResult,
  AusbildungDetails,
  AusbildungSearchParams,
} from "./types.js";

const SERVICE = "/infosysbub/absuche";

/** `value` when `problem` accepts it, else an AusbildungParseError naming the endpoint. */
function expectShape<T>(value: unknown, problem: Problem<unknown>, path: string): T {
  const reason = problem(value);
  if (reason !== undefined) throw new AusbildungParseError(`Unexpected response from ${path}: ${reason}.`);
  return value as T;
}

/** Options for the Ausbildungssuche client (engine options plus the API key). */
export interface AusbildungssucheClientOptions extends EngineOptions {
  /**
   * The `X-API-Key` to send, trimmed. No key is bundled; when omitted (or blank)
   * the header is not sent. A key with an inner control character or a character
   * above U+00FF is rejected (AusbildungValidationError, apiKeyProblem). Obtain the
   * public key with obtainKey() (see obtain-key.ts).
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
    // A JavaScript caller may pass null for "no options"; anything else must be an object.
    if (options !== undefined && options !== null && !isPlainObject(options)) {
      throw new AusbildungValidationError("Invalid options: Expected an object of client options.");
    }
    const { apiKey, ...engineOptions } = options ?? {};
    // Checked before the merge below: `{..."x"}` is `{0: "x"}`, a header named "0".
    if (engineOptions.defaultHeaders !== undefined && !isPlainObject(engineOptions.defaultHeaders)) {
      throw new AusbildungValidationError("Invalid defaultHeaders: Expected an object of header names and values.");
    }
    // Only send X-API-Key when a non-blank key was supplied; never default one.
    // (An empty `X-API-Key` is rejected by the service with 403, so a blank value
    // is treated as absent rather than forwarded.) The key is sent trimmed, so a
    // key read from a file with its trailing newline works, and --api-key, the env
    // var and this option all send the same header.
    const key = typeof apiKey === "string" ? apiKey.trim() || undefined : apiKey;
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
   * blank filter). A 2xx answer that is not the search envelope (searchResultProblem)
   * is an AusbildungParseError.
   */
  async search(params: AusbildungSearchParams = {}): Promise<AusbildungSearchResult> {
    const normalized = validateSearchParams(normalizeSearchParams(params));
    const path = `${SERVICE}/pc/v1/ausbildungsangebot`;
    // The search collection serves HAL+JSON and 406s on plain application/json.
    const result = await this.engine.getJson(path, prune({ ...normalized }), "application/hal+json");
    return expectShape<AusbildungSearchResult>(result, searchResultProblem, path);
  }

  /**
   * Full details for one apprenticeship offer by its numeric id. Rejects with an
   * AusbildungValidationError, before any request, for an id that is not digits
   * only (offerIdProblem). The API answers a JSON array of offer records (one for
   * one id), not the search envelope; a 2xx answer that is not such an array
   * (detailsProblem) is an AusbildungParseError.
   */
  async details(id: string): Promise<AusbildungDetails> {
    assertValid("id", id, offerIdProblem);
    const path = `${SERVICE}/pc/v1/ausbildungsangebot/${id}`;
    // The detail endpoint serves application/json and 406s on HAL+JSON, so we
    // request JSON explicitly. A digits-only id needs no encoding.
    const result = await this.engine.getJson(path, undefined, "application/json");
    return expectShape<AusbildungDetails>(result, detailsProblem, path);
  }
}
