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
 * Check search parameters before any request: every string parameter (`sw`, `ids`,
 * `orte`, `re`, `uk`, `bart`, `bt`) must be non-blank. `undefined` means "not
 * set". Throws AusbildungValidationError naming the parameter.
 */
export function validateSearchParams(params: AusbildungSearchParams): AusbildungSearchParams {
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === "string") assertValid(name, value, nonEmptyProblem);
  }
  return params;
}
