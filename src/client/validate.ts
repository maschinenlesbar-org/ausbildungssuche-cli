// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives here (or next to the type it checks) as a pure
// `…Problem(value)` function: it returns the reason a value is invalid, or
// undefined when the value is fine. The client enforces a rule with assertValid
// before any request; the CLI's commander value-parsers call the same function and
// turn the reason into a usage error, so the rule exists exactly once.

import { AusbildungValidationError } from "./errors.js";
import type { AusbildungSearchParams } from "./types.js";

/** Why `value` is invalid, or `undefined` if it is valid. */
export type Problem<T = string> = (value: T) => string | undefined;

/**
 * Throw an AusbildungValidationError (`Invalid <name>: <reason>`) when `problem`
 * finds something wrong with `value`; otherwise return `value` unchanged.
 *
 * Client methods that return a promise call this inside an `async` body, so a
 * rejected input surfaces as a rejected promise rather than a synchronous throw,
 * and no request is sent.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) {
    throw new AusbildungValidationError(`Invalid ${name}: ${reason}`);
  }
  return value;
}

/**
 * An integer in min..max (a safe integer; NaN, Infinity and fractions are
 * invalid). With min 0 and max Number.MAX_SAFE_INTEGER the reason reads "Expected a
 * non-negative integer.".
 */
export function intRangeProblem(min: number, max: number): Problem<number> {
  const reason =
    min === 0 && max === Number.MAX_SAFE_INTEGER
      ? "Expected a non-negative integer."
      : `Expected an integer between ${min} and ${max}.`;
  return (n) =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max ? undefined : reason;
}

/** True for a string that is empty or only whitespace. */
export function isBlank(value: string): boolean {
  return value.trim() === "";
}

/**
 * A blank value ("" or whitespace) is invalid: the API treats an empty parameter
 * as no filter at all, so a blank filter would silently return the unfiltered set.
 */
export const nonEmptyProblem: Problem = (value) =>
  isBlank(value) ? "Expected a non-empty value." : undefined;

/**
 * A value that can be sent in an HTTP header (User-Agent, X-API-Key, any
 * defaultHeaders value): non-blank, no C0 control character other than tab, no
 * DEL, nothing above U+00FF. Node's HTTP layer would otherwise throw an opaque
 * "Invalid character in header content" at request time, and a custom transport
 * would receive a CR/LF that injects a header. Checked by char code so the source
 * stays free of control bytes.
 */
export const headerValueProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  const blank = nonEmptyProblem(value);
  if (blank !== undefined) return blank;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** An HTTP header name: an RFC 9110 token. */
export const headerNameProblem: Problem = (name) =>
  typeof name === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
    ? undefined
    : "Expected an HTTP header name (letters, digits and !#$%&'*+-.^_`|~).";

/**
 * An offer id (`details`) is numeric, digits only. Anything else cannot name an
 * offer and, put into the path, could re-target the request (`..`, `12/34`, `?x`)
 * or be sent padded (`%20123%20`) with the API key attached.
 */
export const offerIdProblem: Problem = (id) => {
  const numeric = "Expected a numeric offer id (digits only).";
  // A JS caller may pass a non-string; reject it as invalid rather than throw a TypeError.
  if (typeof id !== "string") return numeric;
  return nonEmptyProblem(id) ?? (/^\d+$/.test(id) ? undefined : numeric);
};

/** Smallest and largest offer type (`sty`); the API answers `4` with HTTP 400. */
export const STY_MIN = 0;
export const STY_MAX = 3;

/** The offer type (`sty`): an integer in STY_MIN..STY_MAX. */
export const styProblem: Problem<number> = intRangeProblem(STY_MIN, STY_MAX);

/** The radii (`uk`) the API accepts; anything else gets HTTP 400. */
export const RADII = ["10", "25", "50", "100", "Bundesweit"] as const;

/** The radius (`uk`): one of RADII, exactly as listed. */
export const radiusProblem: Problem = (uk) =>
  nonEmptyProblem(uk) ??
  ((RADII as readonly string[]).includes(uk) ? undefined : "Expected 10, 25, 50, 100 (km) or Bundesweit.");

/** The 3-letter Bundesland codes (`re`) the API accepts, in the uppercase it requires. */
export const REGION_CODES = [
  "BAW", "BAY", "BER", "BRA", "BRE", "HAM", "HES", "MBV",
  "NDS", "NRW", "RPF", "SAA", "SAC", "SAN", "SLH", "THÜ",
] as const;

/** One Bundesland code: a member of REGION_CODES, exactly as listed. */
export const regionCodeProblem: Problem = (code) =>
  (REGION_CODES as readonly string[]).includes(code)
    ? undefined
    : `Unknown Bundesland code "${code}". Expected one or more of ${REGION_CODES.join(", ")}, comma-separated.`;

/** The region filter (`re`): one or more comma-separated REGION_CODES. */
export const regionsProblem: Problem = (re) => nonEmptyProblem(re) ?? firstProblem(re.split(","), regionCodeProblem);

/** The start-date codes (`bt`) the API accepts: 0, 1, 2 and 101..112. */
export const START_CODES = ["0", "1", "2", ...Array.from({ length: 12 }, (_, i) => String(101 + i))] as const;

/** The start-date filter (`bt`): one or more comma-separated START_CODES. */
export const startCodesProblem: Problem = (bt) =>
  nonEmptyProblem(bt) ??
  (bt.split(",").every((code) => (START_CODES as readonly string[]).includes(code))
    ? undefined
    : "Expected start-date codes 0, 1, 2 or 101..112, comma-separated.");

/**
 * The place (`orte`): `Name_lon_lat` with the longitude in -180..180 first and the
 * latitude in -90..90 second. The API answers a bare place name with HTTP 400 and
 * out-of-range coordinates with HTTP 500.
 */
export const placeProblem: Problem = (orte) => {
  const blank = nonEmptyProblem(orte);
  if (blank !== undefined) return blank;
  const m = /^(.*\S.*)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)$/.exec(orte);
  const lon = m ? Number(m[2]) : NaN;
  const lat = m ? Number(m[3]) : NaN;
  return Math.abs(lon) <= 180 && Math.abs(lat) <= 90
    ? undefined
    : 'Expected "Name_lon_lat" with the longitude (-180..180) first and the latitude ' +
        '(-90..90) second, e.g. "Köln_6.957_50.938".';
};

/**
 * Largest page size (`size`) the API honours. Its OpenAPI description says 2000,
 * but the server clamps every larger `size` to 20 (it reports `page.size` 20), so
 * `page` would count in pages of 20 while a caller computes offsets from its own
 * size. `size=0` is silently overridden to 20 as well.
 */
export const MAX_PAGE_SIZE = 20;

/** Page size the API uses when `size` is not given. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * The API serves at most this many results of one query, over all pages; a page
 * beyond it (`(page + 1) * size > 10000`) gets HTTP 500.
 */
export const MAX_RESULT_WINDOW = 10_000;

/** The 0-based page (`page`): a non-negative integer. */
export const pageProblem: Problem<number> = intRangeProblem(0, Number.MAX_SAFE_INTEGER);

/** The page size (`size`): an integer in 1..MAX_PAGE_SIZE. */
export const sizeProblem: Problem<number> = intRangeProblem(1, MAX_PAGE_SIZE);

/**
 * The result window: `(page + 1) × size` (size defaulting to DEFAULT_PAGE_SIZE)
 * must be at most MAX_RESULT_WINDOW, or the API answers with a bare HTTP 500. The
 * reason names the last page that can be fetched.
 */
export const resultWindowProblem: Problem<Pick<AusbildungSearchParams, "page" | "size">> = ({
  page,
  size,
}) => {
  if (page === undefined) return undefined;
  const pageSize = size ?? DEFAULT_PAGE_SIZE;
  if ((page + 1) * pageSize <= MAX_RESULT_WINDOW) return undefined;
  return (
    `${page} is past the API's ${MAX_RESULT_WINDOW}-result window: ` +
    `(page + 1) × size must be at most ${MAX_RESULT_WINDOW}, so with size ${pageSize} ` +
    `the last page is ${Math.floor(MAX_RESULT_WINDOW / pageSize) - 1}.`
  );
};

/**
 * `orte` and a km radius `uk` only filter together: the API ignores a numeric
 * radius without a place, and a place without a radius does not restrict the
 * search at all (it only adds distances). Either alone would silently return the
 * nationwide set. `uk: "Bundesweit"` alone is fine: it asks for exactly what the
 * API returns without a place.
 *
 * `label` names a parameter in the reason; the CLI passes `(p) => "--" + p` so the
 * reason names its flags.
 */
export function placeAndRadiusProblem(
  params: Pick<AusbildungSearchParams, "orte" | "uk">,
  label: (param: "orte" | "uk") => string = (param) => param,
): string | undefined {
  const { orte, uk } = params;
  const [ORTE, UK] = [label("orte"), label("uk")];
  if (uk !== undefined && orte === undefined && String(uk).toLowerCase() !== "bundesweit") {
    return (
      `${UK} ${uk} needs ${ORTE}: a radius is measured around a place, and without one the ` +
      `API ignores it. Leave ${UK} out (or use ${UK} Bundesweit) for a nationwide search.`
    );
  }
  if (orte !== undefined && uk === undefined) {
    return (
      `${ORTE} needs ${UK}: without a radius the API does not restrict the search to the ` +
      `place. Add ${UK} 10, 25, 50 or 100 (km), or ${UK} Bundesweit to search nationwide ` +
      "with distances."
    );
  }
  return undefined;
}

function firstProblem(values: readonly string[], problem: Problem): string | undefined {
  for (const value of values) {
    const reason = problem(value);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * Check search parameters before any request, and throw an
 * AusbildungValidationError naming the first parameter that breaks a rule:
 *
 * - every string parameter (`sw`, `ids`, `orte`, `re`, `uk`, `bart`, `bt`) must be
 *   non-blank (nonEmptyProblem);
 * - `sty`, `re`, `uk` and `bt` must come from the API's closed value sets
 *   (styProblem, regionsProblem, radiusProblem, startCodesProblem), and `orte` must
 *   be `Name_lon_lat` (placeProblem);
 * - `orte` and a km radius `uk` must be given together (placeAndRadiusProblem);
 * - `page` must be a non-negative integer, `size` an integer in 1..MAX_PAGE_SIZE,
 *   and the page must lie inside the MAX_RESULT_WINDOW (pageProblem, sizeProblem,
 *   resultWindowProblem).
 *
 * `undefined` means "not set" and is never checked.
 */
export function validateSearchParams(params: AusbildungSearchParams): AusbildungSearchParams {
  for (const [name, value] of Object.entries(params)) {
    for (const item of listOf(value)) {
      if (typeof item === "string") assertValid(name, item, nonEmptyProblem);
    }
  }
  if (params.sty !== undefined) assertValid("sty", params.sty, styProblem);
  const textRules: Array<[keyof AusbildungSearchParams, Problem]> = [
    ["orte", placeProblem],
    ["re", regionsProblem],
    ["uk", radiusProblem],
    ["bt", startCodesProblem],
  ];
  for (const [name, problem] of textRules) {
    // A JS caller may pass a number (`uk: 25`) or an array; each value is checked
    // in the form the query builder sends it.
    for (const item of listOf(params[name])) assertValid(name, String(item), problem);
  }
  if (params.page !== undefined) assertValid("page", params.page, pageProblem);
  if (params.size !== undefined) assertValid("size", params.size, sizeProblem);
  assertValid("orte and uk", params, (p) => placeAndRadiusProblem(p));
  assertValid("page", params, resultWindowProblem);
  return params;
}

/** The values a query parameter sends: none for undefined/null, each element of an array. */
function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((v) => v !== undefined && v !== null) : [value];
}
