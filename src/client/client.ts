// AusbildungssucheClient — a typed client over the open Ausbildungssuche API of
// the Bundesagentur für Arbeit (rest.arbeitsagentur.de/infosysbub/absuche).
//
// Auth: a static, publicly-documented `X-API-Key` header ("infosysbub-absuche")
// is applied automatically; override via `apiKey`.
//
//   client.search({ sw: "Informatik", size: 10 })
//   client.details(id)

import { RequestEngine, type EngineOptions } from "./engine.js";
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
    this.engine = new RequestEngine({
      ...engineOptions,
      // The service serves HAL+JSON and rejects a plain `application/json` Accept
      // with 406, so request HAL explicitly (overridable via defaultHeaders).
      defaultHeaders: {
        "X-API-Key": apiKey ?? DEFAULT_API_KEY,
        Accept: "application/hal+json",
        ...engineOptions.defaultHeaders,
      },
    });
  }

  /** Search apprenticeship offers (HAL+JSON result). */
  search(params: AusbildungSearchParams = {}): Promise<AusbildungSearchResult> {
    return this.engine.getJson(`${SERVICE}/pc/v1/ausbildungsangebot`, prune({ ...params }));
  }

  /** Full details for one apprenticeship offer by id. */
  details(id: string): Promise<AusbildungDetails> {
    return this.engine.getJson(`${SERVICE}/pc/v1/ausbildungsangebot/${encodeURIComponent(id)}`);
  }
}
