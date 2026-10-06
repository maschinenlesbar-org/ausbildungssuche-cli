// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { AusbildungssucheClientOptions } from "../client/client.js";
import { AusbildungError, AusbildungValidationError } from "../client/errors.js";
import { API_KEY_ENV_VAR } from "../client/obtain-key.js";
import { cleartextProblem, DEFAULT_BASE_URL, isBidiControl } from "../client/engine.js";
import {
  apiKeyProblem,
  baseUrlProblem,
  headerValueProblem,
  intRangeProblem,
  nonEmptyProblem,
  normalizeRadius,
  normalizeRegionCode,
  normalizeRegions,
  idsProblem,
  normalizeIds,
  offerIdProblem,
  placeProblem,
  trainingTypeProblem,
  radiusProblem,
  regionCodeProblem,
  sizeProblem,
  startCodesProblem,
  type Problem,
} from "../client/validate.js";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals (`0x10`, `0b10`, `1e3`), signs, padding and decimals (`+5`, `5.0`).
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/**
 * commander value-parser: a value that is not blank (the library's
 * nonEmptyProblem). A blank filter would otherwise be sent empty and the command
 * would silently run unfiltered.
 */
export function parseNonEmpty(value: string): string {
  return parserOf(nonEmptyProblem)(value);
}

/**
 * commander value-parser for `--user-agent`: the library's headerValueProblem. A
 * blank value, and one Node cannot send, are usage errors rather than a request
 * without the header or an "Unexpected error" at request time.
 */
export function parseHeaderValue(value: string): string {
  return parserOf(headerValueProblem)(value);
}

/**
 * commander value-parser for `--api-key`: the library's apiKeyProblem (the trimmed
 * key must be a valid header value). The raw value is passed on; the client trims
 * it, as it does a key from the env var. A blank `--api-key` is a usage error so it
 * cannot override the env key and send no key at all.
 */
export function parseApiKey(value: string): string {
  return parserOf(apiKeyProblem)(value);
}

/**
 * commander value-parser for `--base-url`: the library's baseUrlProblem (an
 * absolute http(s) URL, no surrounding whitespace, control characters, query or
 * fragment). A bad value is a usage error at parse time.
 */
export function parseBaseUrl(value: string): string {
  return parserOf(baseUrlProblem)(value);
}

/**
 * Wrap a commander value-parser for a single-valued option so that a second
 * occurrence is a usage error. commander otherwise keeps only the last value, so
 * `--uk 10 --uk 50` silently dropped the first. (The option must have no default:
 * commander passes the default as `previous` on the first occurrence.)
 */
export function once<T>(parse: (value: string) => T): (value: string, previous: T | undefined) => T {
  return (value, previous) => {
    if (previous !== undefined) {
      throw new InvalidArgumentError("Given more than once; this option takes a single value.");
    }
    return parse(value);
  };
}

/**
 * Wrap a commander value-parser for an option whose API parameter takes a
 * comma-separated list (`--ids`, `--re`, `--bt`): repeats accumulate, joined with
 * ",", so `--ids 9162 --ids 9106` sends `ids=9162,9106` like `--ids 9162,9106`
 * instead of keeping only the last value.
 */
export function commaList(
  parse: (value: string) => string,
): (value: string, previous: string | undefined) => string {
  return (value, previous) => {
    const parsed = parse(value);
    return previous === undefined ? parsed : `${previous},${parsed}`;
  };
}

/**
 * Build a commander value-parser for a base-10 integer constrained to [min, max]
 * (the library's intRangeProblem).
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  const problem = intRangeProblem(min, max);
  return (value: string) => {
    const n = parseIntArg(value);
    const reason = problem(n);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return n;
  };
}

/**
 * commander value-parser for `--size`: a base-10 integer, then the library's
 * sizeProblem (1..MAX_PAGE_SIZE). `size=0` is silently overridden to 20 and a larger
 * size silently clamped to 20 server-side, so both are rejected up front.
 */
export function parseSizeArg(value: string): number {
  const size = parseIntArg(value);
  const problem = sizeProblem(size);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return size;
}

/** Turn a library Problem into a commander value-parser (a usage error, exit 2). */
function parserOf(problem: Problem): (value: string) => string {
  return (value) => {
    const reason = problem(value);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return value;
  };
}

/**
 * commander value-parser for `--uk`: the library's normalizeRadius (`bundesweit` in
 * any case becomes the `Bundesweit` the API expects; lowercase gets HTTP 400), then
 * its radiusProblem.
 */
export function parseRadius(value: string): string {
  return parserOf(radiusProblem)(normalizeRadius(value));
}

/**
 * commander value-parser for `--re`: one or more comma-separated Bundesland codes
 * in any case, each normalised by the library's normalizeRegionCode (the API wants
 * uppercase and answers `nrw` with a bare HTTP 400) and checked by its
 * regionCodeProblem. The message names the code as the user typed it.
 */
export function parseRegions(value: string): string {
  parseNonEmpty(value);
  for (const item of value.split(",")) {
    if (regionCodeProblem(normalizeRegionCode(item)) !== undefined) {
      throw new InvalidArgumentError(regionCodeProblem(item) ?? "");
    }
  }
  return normalizeRegions(value);
}

/** commander value-parser for `--bt`: the library's startCodesProblem (0, 1, 2 or 101..112). */
export const parseStartCodes = parserOf(startCodesProblem);

/** commander value-parser for `--orte`: the library's placeProblem (`Name_lon_lat`). */
export const parsePlace = parserOf(placeProblem);

/**
 * commander value-parser for `--ids`: the library's idsProblem (numeric dkzIds,
 * comma-separated, no empty item), sent as normalizeIds makes them (items trimmed).
 */
export function parseIds(value: string): string {
  return normalizeIds(parserOf(idsProblem)(value));
}

/** commander value-parser for `--bart`: the library's trainingTypeProblem (one numeric id), trimmed. */
export function parseTrainingType(value: string): string {
  return parserOf(trainingTypeProblem)(value).trim();
}

/** commander value-parser for an offer id: the library's offerIdProblem (digits only). */
export const parseOfferId = parserOf(offerIdProblem);

export interface GlobalOptions {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): AusbildungssucheClientOptions {
  const options: AusbildungssucheClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.apiKey !== undefined) options.apiKey = global.apiKey;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them.
 * It escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is
 * the 8-bit form of CSI) or the bidi formatting characters (isBidiControl), which
 * reorder the text that follows. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes an
 * AusbildungError so the CLI prints a clear message instead of "Unexpected error:
 * Maximum call stack size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new AusbildungError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

/**
 * Write one `warning: …` line to stderr when the effective base URL is plain `http:` to
 * a host other than loopback (cleartextProblem): requests travel unencrypted, and with
 * them the API key (from --api-key or AUSBILDUNGSSUCHE_API_KEY) and any credentials in
 * the URL — named, never printed. Called once per run, after the options are parsed and
 * before the first request; stdout and the exit code are untouched.
 */
export function warnOnCleartext(deps: CliDeps, global: GlobalOptions): void {
  const secrets = global.apiKey !== undefined && global.apiKey.trim() !== "" ? ["the API key"] : [];
  const problem = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL, secrets);
  if (problem !== undefined) deps.io.err(`warning: ${problem}`);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // A --api-key flag went through parseApiKey; a key seeded from the env var did
    // not. The client rejects it too (as apiKey); checking it here with the same
    // library rule names the env variable in the message instead.
    const keyProblem = global.apiKey === undefined ? undefined : apiKeyProblem(global.apiKey);
    if (keyProblem !== undefined) {
      throw new AusbildungValidationError(`${API_KEY_ENV_VAR}: ${keyProblem}`);
    }
    warnOnCleartext(deps, global);
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
