// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import { constants } from "node:buffer";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import type { AusbildungssucheClientOptions } from "@maschinenlesbar.org/ausbildungssuche-client/internal/client";
import { AusbildungError, AusbildungValidationError } from "@maschinenlesbar.org/ausbildungssuche-client/internal/errors";
import { API_KEY_ENV_VAR } from "@maschinenlesbar.org/ausbildungssuche-client/internal/obtain-key";
import { cleartextProblem, DEFAULT_BASE_URL, isBidiControl, type RetryEvent } from "@maschinenlesbar.org/ausbildungssuche-client/internal/engine";
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
  normalizePlaces,
  placeProblem,
  trainingTypeProblem,
  radiusProblem,
  regionCodeProblem,
  sizeProblem,
  startCodesProblem,
  type Problem,
} from "@maschinenlesbar.org/ausbildungssuche-client/internal/validate";

/** The name the API key is stored under in the credentials file (`ausbildungssuche config set api-key`). */
export const API_KEY_CREDENTIAL = "api-key";

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

/** commander value-parser for `--orte`: the library's placeProblem (`Name_lon_lat`), checked and sent as normalizePlaces makes it. */
export function parsePlace(value: string): string {
  return parserOf(placeProblem)(normalizePlaces(value));
}

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
 * Writing the output failed: an answer too deeply nested or too large to print. An ERROR
 * record of `ausbildungssuche.output`, exit 1.
 */
export class OutputError extends AusbildungError {}

/** The longest string V8 makes (2^29 - 24 characters on 64-bit): a longer JSON text can't be printed at once. */
const MAX_TEXT_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * JSON.stringify, pretty or compact. Printing can fail two ways, both an OutputError (exit 1)
 * that names the cause, never "Unexpected error":
 * - an answer nested too deeply (hostile or broken) overflows the stack: "nested too deeply";
 * - a text longer than V8's longest string ("Invalid string length"): "too large to print".
 * "try --compact" is added only when the compact form of this very answer prints: it is probed,
 * not assumed, because whether compact output survives deep nesting depends on the Node version
 * (on Node 26 only the fast path is iterative) and on the machine's stack.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? stringifyCompact(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const deep = /call stack/i.test(err.message);
    const cause = deep ? "nested too deeply" : `too large (more than ${MAX_TEXT_LENGTH} characters of JSON)`;
    const hint = !compact && compactPrints(value) ? "; try --compact" : "";
    throw new OutputError(`The answer is ${cause} to ${compact ? "print" : "pretty-print"}${hint}.`, { cause: err });
  }
}

/** Compact JSON: the fast path, or the gap path for an answer holding a huge string. */
function stringifyCompact(value: unknown): string {
  return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
}

/** Whether `--compact` prints this answer on this runtime (the hint after a failed pretty-print). */
function compactPrints(value: unknown): boolean {
  try {
    return stringifyCompact(value).length <= MAX_TEXT_LENGTH;
  } catch {
    return false;
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/**
 * Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting
 * costs no stack, linear, and without an allocation per value: an array is walked by index, an
 * object by `for…in` (own keys only: an answer's objects have none inherited), and only nested
 * objects and arrays are kept for later. (`Object.entries` made a pair per element: on an array
 * of 48M numbers that took 7 GB and crashed.)
 */
function holdsHugeString(value: unknown): boolean {
  if (typeof value === "string") return value.length >= HUGE_STRING_LENGTH;
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) pending.push(value);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const element: unknown = item[i];
        if (typeof element === "string") {
          if (element.length >= HUGE_STRING_LENGTH) return true;
        } else if (typeof element === "object" && element !== null) pending.push(element);
      }
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key.length >= HUGE_STRING_LENGTH) return true;
      const element = record[key];
      if (typeof element === "string") {
        if (element.length >= HUGE_STRING_LENGTH) return true;
      } else if (typeof element === "object" && element !== null) pending.push(element);
    }
  }
  return false;
}

/** True for a UTF-16 unit `escapeControlChars` writes as `\uXXXX`. */
function escaped(c: number): boolean {
  return (c >= 0x7f && c <= 0x9f) || isBidiControl(c);
}

/** How many input characters `escapeControlChars` turns into one piece of output at a time. */
const ESCAPE_CHUNK = 1 << 16;

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them.
 * It escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is
 * the 8-bit form of CSI) or the bidi formatting characters (isBidiControl), which
 * reorder the text that follows. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 *
 * Each such character becomes six, so the output is measured first: one longer than V8's
 * longest string is an OutputError ("too large to print"), before anything is built. Then the
 * output is built in chunks of ESCAPE_CHUNK characters, each made flat at once, and joined
 * once: one `+=` per character made a rope of 100 M pieces on an answer of DEL characters, and
 * the process died of a heap out-of-memory crash.
 */
function escapeControlChars(json: string): string {
  let count = 0;
  for (let i = 0; i < json.length; i++) if (escaped(json.charCodeAt(i))) count++;
  if (count === 0) return json;
  const length = json.length + 5 * count;
  if (length > MAX_TEXT_LENGTH) {
    throw new OutputError(`The answer is too large to print (${length} characters once its control characters are escaped).`);
  }
  const chunks: string[] = [];
  for (let start = 0; start < json.length; start += ESCAPE_CHUNK) {
    const end = Math.min(start + ESCAPE_CHUNK, json.length);
    const parts: string[] = [];
    let from = start;
    for (let i = start; i < end; i++) {
      const c = json.charCodeAt(i);
      if (!escaped(c)) continue;
      parts.push(json.slice(from, i), "\\u" + c.toString(16).padStart(4, "0"));
      from = i + 1;
    }
    parts.push(json.slice(from, end));
    chunks.push(parts.join(""));
  }
  return chunks.join("");
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

/**
 * Log one warning (a WARN record of `ausbildungssuche.http`) when the effective base URL is plain `http:` to
 * a host other than loopback (cleartextProblem): requests travel unencrypted, and with
 * them the API key (from --api-key, AUSBILDUNGSSUCHE_API_KEY or the credentials file) and any credentials in
 * the URL — named, never printed. Called once per run, after the options are parsed and
 * before the first request; stdout and the exit code are untouched.
 */
export function warnOnCleartext(deps: CliDeps, global: GlobalOptions): void {
  const secrets = global.apiKey !== undefined && global.apiKey.trim() !== "" ? ["the API key"] : [];
  const problem = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL, secrets);
  if (problem !== undefined) logOf(deps).warn("http", problem);
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
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
    let global = command.optsWithGlobals() as GlobalOptions;
    // A --api-key flag went through parseApiKey; a key seeded from the env var did
    // not. The client rejects it too (as apiKey); checking it here with the same
    // library rule names the env variable in the message instead.
    const keyProblem = global.apiKey === undefined ? undefined : apiKeyProblem(global.apiKey);
    if (keyProblem !== undefined) {
      throw new AusbildungValidationError(`${API_KEY_ENV_VAR}: ${keyProblem}`);
    }
    // flag > AUSBILDUNGSSUCHE_API_KEY > the credentials file (`ausbildungssuche config
    // set api-key`) > none. The file is read only here, when no key came from the
    // first two, so a problem with it never stands in the way of a key given another
    // way. Set before the cleartext warning, which then names the key too.
    if (global.apiKey === undefined && deps.credentials !== undefined) {
      const store = deps.credentials();
      const stored = store.get(API_KEY_CREDENTIAL);
      if (stored !== undefined) {
        deps.addSecret?.(stored);
        const storedProblem = apiKeyProblem(stored);
        if (storedProblem !== undefined) {
          throw new AusbildungValidationError(`${API_KEY_CREDENTIAL} in ${store.path}: ${storedProblem}`);
        }
        global = { ...global, apiKey: stored };
      }
    }
    warnOnCleartext(deps, global);
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    // An answer delivered changed (invalid text replaced with U+FFFD) is never silent.
    options.onWarning = (message) => logOf(deps).warn("api", message);
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
