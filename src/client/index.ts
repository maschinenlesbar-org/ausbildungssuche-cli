// Public entry point for the API client library.

export { AusbildungssucheClient } from "./client.js";
export type { AusbildungssucheClientOptions } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL, MAX_RETRY_AFTER_MS, parseRetryAfter } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { obtainKey, API_KEY_ENV_VAR, KEY_SOURCE_URL } from "./obtain-key.js";
export type { ObtainKeyOptions, ObtainedKey } from "./obtain-key.js";
export { buildQueryString } from "./query.js";
export {
  assertValid,
  DEFAULT_PAGE_SIZE,
  isBlank,
  MAX_PAGE_SIZE,
  MAX_RESULT_WINDOW,
  nonEmptyProblem,
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
  redactUrl,
} from "./errors.js";

export * from "./types.js";
