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
export const styProblem: Problem<number> = (sty) =>
  Number.isSafeInteger(sty) && sty >= STY_MIN && sty <= STY_MAX
    ? undefined
    : `Expected an integer between ${STY_MIN} and ${STY_MAX}.`;

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
 *   be `Name_lon_lat` (placeProblem).
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
  return params;
}

/** The values a query parameter sends: none for undefined/null, each element of an array. */
function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((v) => v !== undefined && v !== null) : [value];
}
