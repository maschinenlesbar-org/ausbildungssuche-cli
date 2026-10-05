// Public entry point for the API client library.

export { AusbildungssucheClient } from "./client.js";
export type { AusbildungssucheClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  decodeBody,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  intOption,
  validateBaseUrl,
  MAX_REDIRECTS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  isTransientNetworkError,
  parseRetryAfter,
} from "./engine.js";
export type { CredentialsDropped, EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { obtainKey, API_KEY_ENV_VAR, KEY_SOURCE_URL } from "./obtain-key.js";
export type { ObtainKeyOptions, ObtainedKey } from "./obtain-key.js";
export { buildQueryString } from "./query.js";
export {
  apiKeyProblem,
  assertValid,
  baseUrlProblem,
  DEFAULT_PAGE_SIZE,
  detailsProblem,
  headerNameProblem,
  headerValueProblem,
  httpUrlProblem,
  intRangeProblem,
  isBlank,
  MAX_PAGE_SIZE,
  MAX_RESULT_WINDOW,
  nonEmptyProblem,
  normalizeRadius,
  normalizeRegionCode,
  normalizeRegions,
  normalizeSearchParams,
  offerIdProblem,
  pageProblem,
  placeAndRadiusProblem,
  placeProblem,
  RADII,
  radiusProblem,
  REGION_CODES,
  regionCodeProblem,
  regionsProblem,
  resultWindowProblem,
  searchResultProblem,
  sizeProblem,
  START_CODES,
  startCodesProblem,
  STY_MAX,
  STY_MIN,
  styProblem,
  validateSearchParams,
} from "./validate.js";
export type { Problem } from "./validate.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  AusbildungError,
  AusbildungApiError,
  AusbildungNetworkError,
  AusbildungParseError,
  AusbildungValidationError,
  credentialsDroppedHint,
  credentialsIn,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";

export * from "./types.js";
